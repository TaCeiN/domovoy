import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import {
  appUser, assistantDialog, botDialog, botDraft, botMiss, botSeen, botUsage, property, userProperty,
} from '../../db/schema.ts';
import { newId } from '../ids.ts';
import type { OpenAppButton } from '../max/bot-api.ts';
import type { ChatMessage, ChatTurn, FunctionDef } from '../gigachat/client.ts';
import { runAgent, type AgentResult } from '../agent/loop.ts';
import { checkFacts } from '../agent/guard.ts';
import { TOOLS } from '../agent/tools.ts';
import { contactsForResident } from '../house/contacts.ts';
import { addresseeForProperty } from '../requests/addressee.ts';
import { detectDanger, dangerReply } from './emergency.ts';
import { CATALOG, activeOutages, outageText, type IntentContext, type Reply } from './intents.ts';
import { quickIntent, outageTopic } from './quick.ts';
import { CLASSIFY, INTENTS, SYSTEM_PROMPT, type Intent } from './prompt.ts';
import { SCREEN_KEYS, type ScreenKey } from './screens.ts';
import {
  AS_IS, NEW_ANYWAY, draftReply, duplicateReply, findDuplicate, normaliseComplaint, type ComplaintDraft,
} from './complaint.ts';

/**
 * Сообщение жителя боту MAX → ответ.
 *
 *   повтор события? → опасность (словарь) → кто пишет → какая квартира
 *   → лимиты → GigaChat разбирает → каталог или путь жалобы
 *
 * Бот никогда не молчит: сбой модели, конец квоты, наша ошибка — у всего
 * есть ответ с кнопкой в мини-приложение. И жалоба не зависит от модели:
 * после сбоя человеку предлагают оформить её его же словами.
 *
 */

export interface Llm {
  callFunction(messages: ChatMessage[], fn: FunctionDef): Promise<{ args: Record<string, unknown>; totalTokens: number }>;
  /**
   * Свободный разговор с функциями — Домовёнок-агент (lib/agent/). Есть —
   * отвечает агент; нет (старые подделки в тестах) — прежний классификатор.
   */
  chat?(messages: ChatMessage[], functions: FunctionDef[]): Promise<ChatTurn>;
}

/** Строка под ответом модели в боте MAX; в приложении — отдельной подписью */
export const AI_NOTE = 'Ответ сгенерирован ИИ. Проверяйте важное.';

export interface BotDeps {
  db: Database;
  send: (maxUserId: number, reply: Reply) => Promise<void>;
  /** null — ключа GigaChat нет: бот отвечает без разбора («глухой» режим) */
  llm: Llm | null;
  botUsername: string;
  now?: () => Date;
  /** Сообщений жителя в сутки, которые идут в модель */
  dailyMessages?: number;
  /** Потолок токенов бота в сутки */
  dailyTokens?: number;
}

/** Что нужно разговору без канала MAX — и Домовёнку в приложении */
export type ConverseDeps = Omit<BotDeps, 'send' | 'botUsername'>;

export interface Incoming {
  maxUserId: number;
  text: string;
  /** id сообщения MAX; у bot_started — свой, собранный вебхуком */
  mid: string;
}

/**
 * Откуда пришло сообщение и куда отвечать.
 *
 * Бот MAX и Домовёнок в мини-приложении — один разговор: разбор, каталог,
 * жалоба черновиком. Разные у них только память (по аккаунту MAX или по
 * жителю), способ ответа и то, знает ли канал текущую квартиру.
 */
interface Channel {
  load(now: Date): Promise<DialogState>;
  save(state: DialogState): Promise<void>;
  reply(r: Reply): Promise<void>;
  app: (label: string, payload?: string) => OpenAppButton;
  /** Квартира, открытая сейчас в приложении, — о ней и говорим */
  propertyId?: string;
}

type Home = Awaited<ReturnType<typeof homesOf>>[number];

/** Кнопка под справкой: «ответ не про то» — сообщение уходит в bot_miss. */
export const NOT_IT = 'Не то';
/** Текст, которым вебхук передаёт нажатие «Начать» (событие bot_started). */
export const START = '/start';
/**
 * Стикер, фото, голосовое — сообщение без текста. Раньше вебхук его
 * отбрасывал, и бот молчал; «бот никогда не молчит» (спека) — просим
 * написать словами.
 */
export const NO_TEXT = '/no-text';

const MEMORY_MS = 30 * 60 * 1000;
const HISTORY = 6;

interface DialogState {
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  propertyId?: string;
  /** Текст, пришедший до выбора квартиры, — разберём его после выбора */
  awaitingText?: string;
  askedOnce?: boolean;
  /**
   * Жалоба, по которой задан уточняющий вопрос. Ответ человека модель
   * получает вместе с УЖЕ очищенным текстом, а не с его первым сообщением:
   * иначе она переписывает мат из истории обратно в жалобу (проверено
   * на живом GigaChat Lite).
   */
  clarify?: { category: string; text: string; ask: string; options: string[] };
  /** Черновик, ждущий «Всё равно оформить новое» или «Оформить как есть» */
  pending?: ComplaintDraft;
}

function moscowDay(now: Date): string {
  return now.toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
}

export async function handleMessage(deps: BotDeps, msg: Incoming): Promise<void> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const text = msg.text.trim().slice(0, 2000);
  if (!text) return;

  // MAX повторяет событие, если не дождался ответа: второй раз не отвечаем
  const fresh = await db.insert(botSeen).values({ mid: msg.mid }).onConflictDoNothing().returning({ mid: botSeen.mid });
  if (fresh.length === 0) return;
  await cleanup(db, now);

  const app = (label: string, payload?: string): OpenAppButton =>
    ({ type: 'open_app', text: label, webApp: deps.botUsername, ...(payload ? { payload } : {}) });
  // Кнопки MAX не несут подписей: пометку ИИ дописываем в сам текст
  const reply = (r: Reply) => deps.send(msg.maxUserId, r.ai ? { ...r, text: `${r.text}

${AI_NOTE}` } : r);

  if (text === NO_TEXT) {
    await reply({
      text: 'Я понимаю только текст — картинки и голосовые пока не разбираю. Напишите словами, что случилось или что хотите узнать.',
      buttons: [[app('Открыть приложение')]],
    });
    return;
  }

  // ── Кто пишет ────────────────────────────────────────────────
  const [user] = await db.select({ id: appUser.id }).from(appUser).where(eq(appUser.maxUserId, msg.maxUserId));
  const homes = user ? await homesOf(db, user.id) : [];

  // ── Опасность — первой и для всех, без модели и лимитов ─────
  const danger = detectDanger(text);
  if (danger) {
    const contacts = user && homes[0] ? await contactsForResident(db, user.id, homes[0].propertyId) ?? [] : [];
    await reply({ text: dangerReply(danger, contacts), mood: 'alert' });
    // Человеку плохо, драка — нужны скорая и полиция, а не обращение в УК: разговор на этом всё
    if (danger === 'medical' || danger === 'violence') return;
  }

  if (!user || homes.length === 0) {
    await reply({
      text: [
        'Здравствуйте! Я Домовёнок — бот приложения вашего дома.',
        'Чтобы я отвечал по вашей квартире — начислениям, обращениям, телефонам дома, — войдите в приложение: откройте его и отсканируйте QR-код с квитанции ЖКХ.',
      ].join('\n'),
      buttons: [[app('Открыть приложение')]],
    });
    return;
  }

  await converse(deps, {
    load: (at) => loadState(db, msg.maxUserId, at),
    save: (state) => saveState(db, msg.maxUserId, state),
    reply,
    app,
  }, user.id, homes, text, now);
}

/**
 * Домовой в мини-приложении: то же, что бот, но по сессии жителя.
 *
 * Возвращает ответы, а не шлёт их: приложение показывает их в шторке.
 * Кнопки `open_app` здесь — переходы внутри приложения по тому же payload.
 */
export async function handleAppMessage(
  deps: ConverseDeps,
  msg: { userId: string; propertyId?: string; text: string },
): Promise<Reply[]> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const text = msg.text.trim().slice(0, 2000);
  if (!text) return [];
  await cleanup(db, now);

  const replies: Reply[] = [];
  const reply = async (r: Reply) => { replies.push(r); };
  const app = (label: string, payload?: string): OpenAppButton =>
    ({ type: 'open_app', text: label, webApp: '', ...(payload ? { payload } : {}) });

  const homes = await homesOf(db, msg.userId);
  const danger = detectDanger(text);
  if (danger) {
    const home = homes.find((h) => h.propertyId === msg.propertyId) ?? homes[0];
    const contacts = home ? await contactsForResident(db, msg.userId, home.propertyId) ?? [] : [];
    await reply({ text: dangerReply(danger, contacts), mood: 'alert' });
    if (danger === 'medical' || danger === 'violence') return replies;
  }
  if (homes.length === 0) {
    await reply({
      text: 'Чтобы я отвечал по вашей квартире, добавьте её в приложение по QR-коду с квитанции.',
      mood: 'confused',
    });
    return replies;
  }

  await converse(deps, {
    load: (at) => loadAppState(db, msg.userId, at),
    save: (state) => saveAppState(db, msg.userId, state),
    reply,
    app,
    // Чужая квартира в запросе не принимается: говорим только о своих
    propertyId: homes.some((h) => h.propertyId === msg.propertyId) ? msg.propertyId : undefined,
  }, msg.userId, homes, text, now);
  return replies;
}

/** Квартиры жителя, о которых можно говорить: подтверждённые и ждущие. */
async function homesOf(db: Database, userId: string) {
  return db.select({
    propertyId: property.id, houseKey: property.houseKey, status: userProperty.status,
    street: property.street, house: property.house, block: property.block, flat: property.flat,
    addressRaw: property.addressRaw,
  }).from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .where(and(eq(userProperty.userId, userId), inArray(userProperty.status, ['active', 'pending'])));
}

/** Квартира → лимиты → разбор → каталог или жалоба. Общее у бота и Домового. */
async function converse(
  deps: ConverseDeps,
  ch: Channel,
  userId: string,
  homes: Home[],
  text: string,
  now: Date,
): Promise<void> {
  const { db } = deps;
  const { reply, app } = ch;

  // ── Память и квартира ───────────────────────────────────────
  const state = await ch.load(now);
  const label = (h: typeof homes[number]) =>
    [h.street, h.house && `д. ${h.house}${h.block ? ` к. ${h.block}` : ''}`, h.flat && `кв. ${h.flat}`]
      .filter(Boolean).join(', ') || h.addressRaw;

  let input = text;
  if (!homes.some((h) => h.propertyId === state.propertyId)) state.propertyId = undefined;
  if (homes.length === 1) state.propertyId = homes[0].propertyId;
  if (ch.propertyId) state.propertyId = ch.propertyId;
  if (!state.propertyId) {
    const chosen = homes.find((h) => label(h) === text);
    if (!chosen) {
      state.awaitingText = text;
      await ch.save(state);
      await reply({
        text: 'По какому адресу?',
        buttons: homes.slice(0, 6).map((h) => [{ type: 'message' as const, text: label(h) }]),
      });
      return;
    }
    state.propertyId = chosen.propertyId;
    input = state.awaitingText ?? '';
    state.awaitingText = undefined;
    if (!input) {
      await ch.save(state);
      await reply({ text: `Хорошо, говорим про ${label(chosen)}. Что случилось?` });
      return;
    }
  }
  const home = homes.find((h) => h.propertyId === state.propertyId)!;
  const ctx: IntentContext = {
    db, userId, propertyId: home.propertyId, houseKey: home.houseKey,
    level: home.status === 'active' ? 'full' : 'self',
    requestNumber: null, screen: null, app, now,
  };

  try {
    // ── Кнопки-ответы, которым модель не нужна ────────────────
    if ((input === NEW_ANYWAY || input === AS_IS) && state.pending) {
      const draft = state.pending;
      state.pending = undefined;
      state.askedOnce = false;
      await ch.save(state);
      await reply({ ...await draftReply(ctx, draft), mood: 'done' });
      return;
    }
    // Кнопка «Начать» в MAX: приветствие без модели
    if (input === START) {
      await reply(await CATALOG.greeting(ctx));
      return;
    }
    if (input === NOT_IT) {
      const last = [...state.history].reverse().find((h) => h.role === 'user');
      if (last) await db.insert(botMiss).values({ id: newId('bms'), text: last.content, reason: 'not_it' });
      await reply({
        text: 'Понял, запомнил — буду учиться. Скажите иначе или опишите проблему, и я подготовлю обращение.',
        buttons: [[app('Открыть приложение')]],
      });
      return;
    }

    // Номера служб и отключения — по словам, без модели и её лимитов (quick.ts)
    const quick = quickIntent(input, { flat: home.flat });
    if (quick === 'thanks') {
      await reply({ text: 'Пожалуйста! Если что-то понадобится — пишите.', mood: 'done' });
      return;
    }
    if (quick === 'foreign') {
      await reply({
        text: 'Про чужие квартиры не рассказываю: начисления, долги и жильцы — личные данные соседей. '
          + `Могу рассказать про вашу${home.flat ? ` — кв. ${home.flat}` : ''}: начисления, обращения, счётчики.`,
        buttons: [[app('Открыть приложение')]],
      });
      return;
    }
    // Законы с живой моделью отвечает агент (общей справкой); без модели — как раньше
    const agentReady = Boolean(deps.llm?.chat) && await withinLimits(deps, db, userId, now);
    if (quick === 'law' && !agentReady) {
      const who = await addresseeForProperty(db, home.propertyId);
      await reply({
        text: [
          'По законам не консультирую — с этим лучше к юристу.',
          'Могу оформить обращение в управляющую компанию: опишите, что случилось.',
          who.kind === 'org' && who.phone ? `Или позвоните в УК: ${who.name}, ${who.phone}.` : '',
        ].filter(Boolean).join('\n'),
        buttons: [[app('Новое обращение', 's_complaint')]],
      });
      return;
    }
    /**
     * «Нет горячей воды», а УК уже объявила отключение — сначала объявление:
     * это ответ на «почему», а обращение про плановое отключение УК только
     * отклонит. Оформить всё равно можно — кнопкой, словами человека (форму
     * можно поправить). До модели: так работает и без ключа GigaChat.
     */
    // Вопрос о законе («имеют право отключать воду?») — не жалоба на отключение
    const planned = quick === 'law' ? null : await plannedOutage(ctx, input);
    if (planned) {
      state.pending = planned.draft;
      state.askedOnce = false;
      state.clarify = undefined;
      remember(state, 'user', input);
      remember(state, 'assistant', '[показано объявление об отключении]');
      await ch.save(state);
      await reply({
        text: `Управляющая компания объявила отключение:\n\n${outageText(planned.posts)}\n\n`
          + 'Если у вас другое или срок уже прошёл — оформлю обращение.',
        buttons: [[{ type: 'message', text: NEW_ANYWAY }], [app('Лента дома', 's_feed')]],
      });
      return;
    }

    if (quick && quick !== 'law') {
      remember(state, 'user', input);
      remember(state, 'assistant', `[намерение: ${quick}]`);
      state.clarify = undefined;
      await ch.save(state);
      const answer = await CATALOG[quick](ctx);
      answer.buttons = [...(answer.buttons ?? []), [{ type: 'message', text: NOT_IT }]];
      await reply(answer);
      return;
    }

    // ── Лимиты ────────────────────────────────────────────────
    const day = moscowDay(now);
    const used = await usage(db, day, userId);
    if (used >= (deps.dailyMessages ?? 30)) {
      await reply({
        text: 'На сегодня я ответил на все вопросы, которые мог. Приложение работает как обычно — там всё то же самое.',
        buttons: [[app('Открыть приложение')]],
      });
      return;
    }
    const tokensToday = await usage(db, day, 'tokens');
    if (!deps.llm || tokensToday >= (deps.dailyTokens ?? Infinity)) {
      await fallback(db, ch, state, input, deps.llm ? 'quota' : 'no_llm');
      return;
    }

    // ── Разбор ────────────────────────────────────────────────
    await bump(db, day, userId, 1);
    // Ответ на уточнение — вариант с кнопки или короткая фраза; длинное
    // сообщение после вопроса — это уже о другом, разбираем как обычно
    const clarify = state.clarify && (state.clarify.options.includes(input) || input.length <= 40)
      ? state.clarify : undefined;
    state.clarify = undefined;
    // Ответ на уточнение: запасной текст жалобы — уже очищенный, с ответом
    const plain = clarify ? `${clarify.text} (${clarify.ask} — ${input})` : input;
    let args: Record<string, unknown>;
    try {
      const messages: ChatMessage[] = clarify
        ? [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `Жалоба: ${clarify.text}\nНа вопрос «${clarify.ask}» житель ответил: ${input}\n`
                +'Собери итоговый text: исходная жалоба плюс это уточнение, ничего не теряя. Больше ничего не спрашивай.',
            },
          ]
        : [
            { role: 'system', content: SYSTEM_PROMPT },
            ...state.history,
            { role: 'user', content: input },
          ];
      const result = await deps.llm.callFunction(messages, CLASSIFY);
      await bump(db, day, 'tokens', result.totalTokens);
      args = result.args;
    } catch (error) {
      const spent = (error as { totalTokens?: number }).totalTokens ?? 0;
      if (spent) await bump(db, day, 'tokens', spent);
      if ((error as { code?: string }).code === 'blacklist') {
        await calmReply(ch, state);
        return;
      }
      await fallback(db, ch, state, plain, 'llm_error');
      return;
    }

    let intent: Intent = clarify
      ? 'complaint'
      : INTENTS.includes(args.intent as Intent) ? args.intent as Intent : 'unknown';
    // «Когда капремонт» — вопрос, а не поломка: Lite иногда кладёт такое в жалобу
    if (intent === 'complaint' && !clarify && deps.llm.chat && questionNotProblem(input)) intent = 'unknown';
    remember(state, 'user', input);

    if (intent === 'complaint') {
      const draft = clarify
        ? normaliseComplaint({ category: clarify.category, ...args }, plain)
        : normaliseComplaint(args, input);
      const options = Array.isArray(args.options)
        ? args.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).slice(0, 4)
        : [];

      if (typeof args.ask === 'string' && args.ask.trim() && options.length >= 2 && !state.askedOnce) {
        state.askedOnce = true;
        state.clarify = { category: draft.category, text: draft.text, ask: args.ask.trim(), options };
        remember(state, 'assistant', args.ask.trim());
        await ch.save(state);
        await reply({
          text: args.ask.trim(),
          buttons: chunk(options.map((o) => ({ type: 'message' as const, text: o.slice(0, 60) })), 2),
        });
        return;
      }

      state.askedOnce = false;
      remember(state, 'assistant', '[подготовлено обращение]');
      const dup = await findDuplicate(ctx, draft);
      if (dup) {
        state.pending = draft;
        await ch.save(state);
        await reply(await duplicateReply(ctx, dup));
        return;
      }
      state.pending = undefined;
      await ch.save(state);
      await reply({ ...await draftReply(ctx, draft), mood: 'done' });
      return;
    }

    /**
     * Всё, что не жалоба, — Домовёнку-агенту: он отвечает живым языком
     * и на то, что мимо намерений («когда капремонт», «салам»). Жалоба
     * остаётся за классификатором: на Lite он надёжнее оформляет её
     * черновиком и задаёт уточняющий вопрос (прогон bot:agent-eval 30.09).
     */
    if (deps.llm.chat) {
      state.history.pop();
      // «Открой счётчики»: экран открывает код — модель пересказывала вместо открытия
      const screen = typeof args.screen === 'string' && SCREEN_KEYS.includes(args.screen as ScreenKey) ? args.screen as ScreenKey : null;
      if (intent === 'navigate' && screen) {
        ctx.screen = screen;
        remember(state, 'user', input);
        remember(state, 'assistant', `[открыт экран: ${screen}]`);
        await ch.save(state);
        await reply(await CATALOG.navigate(ctx));
        return;
      }
      await agentAnswer(deps.llm as Required<Llm>, ch, state, ctx, input, day, agentHint(intent, args), agentFirstCall(intent, args));
      return;
    }

    if (intent === 'unknown') {
      await db.insert(botMiss).values({ id: newId('bms'), text: input, reason: 'unknown' });
    }
    remember(state, 'assistant', `[намерение: ${intent}]`);
    await ch.save(state);

    ctx.requestNumber = typeof args.requestNumber === 'string' && /^\d{1,8}$/.test(args.requestNumber.trim())
      ? args.requestNumber.trim() : null;
    ctx.screen = typeof args.screen === 'string' && SCREEN_KEYS.includes(args.screen as ScreenKey)
      ? args.screen as ScreenKey : null;
    const answer = await CATALOG[intent](ctx);
    if (intent === 'unknown') answer.mood = 'confused';
    if (intent !== 'greeting' && intent !== 'unknown') {
      answer.buttons = [...(answer.buttons ?? []), [{ type: 'message', text: NOT_IT }]];
    }
    await reply(answer);
  } catch (error) {
    await reply({
      text: 'Что-то пошло не так. Попробуйте чуть позже — а приложение работает как обычно.',
      buttons: [[app('Открыть приложение')]],
    });
    throw error;
  }
}

const QUESTION = /^(когда|как|где|сколько|почему|зачем|кто|куда|можно|могу|имеют|правда|что делать|что будет|надо ли|нужно ли)(\s|$)/;
const PROBLEM = /(^|\s)(нет|не\s|сломал|слома|теч|протек|засор|гряз|холодн|вонь|воня|пахн|шум|затоп|отвалил|разбит)/;

/** Вопрос без признаков поломки: «когда капремонт», а не «почему нет воды» */
export function questionNotProblem(text: string): boolean {
  const t = text.toLowerCase().replaceAll('ё', 'е').trim();
  return QUESTION.test(t) && !PROBLEM.test(t);
}

/** Какой инструмент подсказать агенту по разбору классификатора */
const HINT_TOOL: Partial<Record<Intent, string>> = {
  bills: 'my_bills', paid: 'my_bills', request_status: 'my_requests', meters: 'my_meters',
  accounts: 'my_accounts', contacts: 'house_info', feed: 'house_feed', polls: 'house_feed',
  council: 'council_tasks', analytics: 'analytics', outage: 'outages',
};

export function agentHint(intent: Intent, args: Record<string, unknown>): string | undefined {
  const screen = typeof args.screen === 'string' && SCREEN_KEYS.includes(args.screen as ScreenKey) ? args.screen : null;
  if (intent === 'navigate' && screen) return `Подсказка разбора: житель хочет открыть экран. Вызови open с target "screen:${screen}".`;
  const tool = HINT_TOOL[intent];
  if (!tool) return undefined;
  const number = typeof args.requestNumber === 'string' && /^\d{1,8}$/.test(args.requestNumber.trim()) ? args.requestNumber.trim() : null;
  return `Подсказка разбора: вызови ${tool}${tool === 'my_requests' && number ? ` с number "${number}"` : ''} и ответь по данным.`;
}

/** Инструмент, который код вызывает сам до ответа модели: тема понятна классификатору */
export function agentFirstCall(intent: Intent, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } | undefined {
  const name = HINT_TOOL[intent];
  if (!name) return undefined;
  const number = typeof args.requestNumber === 'string' && /^\d{1,8}$/.test(args.requestNumber.trim()) ? args.requestNumber.trim() : null;
  return { name, args: name === 'my_requests' && number ? { number } : {} };
}

/** Грубость или тема под фильтром GigaChat: его заготовку жителю не показываем */
async function calmReply(ch: Channel, state: DialogState) {
  await ch.save(state);
  await ch.reply({
    text: 'Понимаю, бывает досадно. Расскажите, что случилось, — помогу оформить обращение или подскажу, где что в приложении.',
    buttons: [[ch.app('Открыть приложение')]],
  });
}

/** Лимиты модели ещё не исчерпаны — сообщения жителя и токены бота за сутки */
async function withinLimits(deps: ConverseDeps, db: Database, userId: string, now: Date): Promise<boolean> {
  const day = moscowDay(now);
  return await usage(db, day, userId) < (deps.dailyMessages ?? 30)
    && await usage(db, day, 'tokens') < (deps.dailyTokens ?? Infinity);
}

/**
 * Ответ агента (спека 2026-09-30-agent-design.md): модель ⇄ инструменты,
 * потом проверка фактов кодом. Не прошла — шаблон по теме последнего
 * инструмента, а в bot_miss — что именно модель выдумала.
 */
async function agentAnswer(
  llm: Required<Llm>, ch: Channel, state: DialogState, ctx: IntentContext, input: string, day: string,
  hint?: string, firstCall?: { name: string; args: Record<string, unknown> },
) {
  const { db } = ctx;
  state.clarify = undefined;
  state.askedOnce = false;
  let result: AgentResult;
  try {
    result = await runAgent({ llm, ctx, history: state.history, input, hint, firstCall });
  } catch (error) {
    const spent = (error as { totalTokens?: number }).totalTokens ?? 0;
    if (spent) await bump(db, day, 'tokens', spent);
    // Грубость или тема под фильтром GigaChat: его заготовку про «языковые
    // модели» жителю не показываем — спокойно возвращаем к делу
    if ((error as { code?: string }).code === 'blacklist') {
      await calmReply(ch, state);
      return;
    }
    await fallback(db, ch, state, input, 'llm_error');
    return;
  }
  await bump(db, day, 'tokens', result.tokens);
  remember(state, 'user', input);

  if (result.kind === 'draft') {
    remember(state, 'assistant', '[подготовлено обращение]');
    const dup = await findDuplicate(ctx, result.draft);
    if (dup) {
      state.pending = result.draft;
      await ch.save(state);
      await ch.reply(await duplicateReply(ctx, dup));
      return;
    }
    state.pending = undefined;
    await ch.save(state);
    await ch.reply({ ...await draftReply(ctx, result.draft), mood: 'done' });
    return;
  }

  const facts = result.kind === 'answer' ? checkFacts(result.text, result.sources) : null;
  if (result.kind === 'give_up' || !facts?.ok) {
    const reason = result.kind === 'give_up' ? 'agent_give_up' : `guard: ${facts!.unknown.join(', ')}`;
    await db.insert(botMiss).values({ id: newId('bms'), text: input, reason: reason.slice(0, 200) });
    const topic = [...result.used].reverse().map((name) => TOOLS[name]?.topic).find(Boolean);
    const answer: Reply = topic
      ? await CATALOG[topic](ctx)
      : { text: 'Точно ответить не могу. Посмотрите в приложении — там всё то же самое.', buttons: [[ch.app('Открыть приложение')]] };
    remember(state, 'assistant', answer.text.slice(0, 300));
    await ch.save(state);
    await ch.reply(answer);
    return;
  }

  remember(state, 'assistant', result.text);
  await ch.save(state);
  await ch.reply({
    text: result.text,
    ...(result.buttons.length ? { buttons: result.buttons } : {}),
    ...(result.open ? { open: result.open } : {}),
    ai: true,
  });
}

const OUTAGE_CATEGORY = { water: 'Сантехника', heat: 'Сантехника', power: 'Электрика', gas: 'Другое' } as const;

/**
 * Жалоба на то, что УК уже объявила отключенным: «нет воды», «пропал свет».
 * Объявление должно быть о том же ресурсе — или без узнаваемого ресурса
 * («плановые работы»): отключение света не отвечает на «нет воды».
 */
async function plannedOutage(ctx: IntentContext, input: string) {
  const topic = outageTopic(input);
  if (!topic || ctx.level !== 'full') return null;
  if (!/(^|[^а-я])(нет|не\s|пропал|отключ|выключ)/.test(input.toLowerCase().replaceAll('ё', 'е'))) return null;
  const posts = (await activeOutages(ctx)).filter((o) => {
    const about = outageTopic(`${o.title} ${o.body}`);
    return about === topic || about === null;
  });
  if (posts.length === 0) return null;
  return { posts, draft: { category: OUTAGE_CATEGORY[topic], text: input } satisfies ComplaintDraft };
}

/** Модель недоступна: жалоба всё равно оформляется — словами человека. */
async function fallback(db: Database, ch: Channel, state: DialogState, input: string, reason: string) {
  await db.insert(botMiss).values({ id: newId('bms'), text: input, reason });
  state.pending = { category: 'Другое', text: input };
  await ch.save(state);
  await ch.reply({
    mood: 'confused',
    text: 'Не получилось разобрать сообщение. Если это жалоба — оформлю её вашими словами, текст можно будет поправить.',
    buttons: [[{ type: 'message', text: AS_IS }], [ch.app('Открыть приложение')]],
  });
}

function remember(state: DialogState, role: 'user' | 'assistant', content: string) {
  state.history.push({ role, content });
  state.history = state.history.slice(-HISTORY);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadState(db: Database, maxUserId: number, now: Date): Promise<DialogState> {
  const [row] = await db.select().from(botDialog).where(eq(botDialog.maxUserId, maxUserId));
  if (!row || now.getTime() - row.updatedAt.getTime() > MEMORY_MS) return { history: [] };
  const state = row.state as DialogState;
  return { ...state, history: Array.isArray(state.history) ? state.history : [] };
}

async function saveState(db: Database, maxUserId: number, state: DialogState) {
  await db.insert(botDialog).values({ maxUserId, state, updatedAt: new Date() })
    .onConflictDoUpdate({ target: botDialog.maxUserId, set: { state, updatedAt: new Date() } });
}

async function loadAppState(db: Database, userId: string, now: Date): Promise<DialogState> {
  const [row] = await db.select().from(assistantDialog).where(eq(assistantDialog.userId, userId));
  if (!row || now.getTime() - row.updatedAt.getTime() > MEMORY_MS) return { history: [] };
  const state = row.state as DialogState;
  return { ...state, history: Array.isArray(state.history) ? state.history : [] };
}

async function saveAppState(db: Database, userId: string, state: DialogState) {
  await db.insert(assistantDialog).values({ userId, state, updatedAt: new Date() })
    .onConflictDoUpdate({ target: assistantDialog.userId, set: { state, updatedAt: new Date() } });
}

async function usage(db: Database, day: string, key: string): Promise<number> {
  const [row] = await db.select({ count: botUsage.count }).from(botUsage)
    .where(and(eq(botUsage.day, day), eq(botUsage.key, key)));
  return row?.count ?? 0;
}

async function bump(db: Database, day: string, key: string, by: number) {
  await db.insert(botUsage).values({ day, key, count: by })
    .onConflictDoUpdate({ target: [botUsage.day, botUsage.key], set: { count: sql`${botUsage.count} + ${by}` } });
}

/** Сроки хранения из спеки; раз в час, а не на каждое сообщение. */
let lastCleanup = 0;
async function cleanup(db: Database, now: Date) {
  if (now.getTime() - lastCleanup < 3600_000) return;
  lastCleanup = now.getTime();
  const ago = (days: number) => new Date(now.getTime() - days * 24 * 3600_000);
  await db.delete(botSeen).where(lt(botSeen.createdAt, ago(2)));
  await db.delete(botMiss).where(lt(botMiss.createdAt, ago(30)));
  await db.delete(botDialog).where(lt(botDialog.updatedAt, ago(1)));
  await db.delete(assistantDialog).where(lt(assistantDialog.updatedAt, ago(1)));
  await db.delete(botDraft).where(lt(botDraft.createdAt, ago(7)));
  await db.delete(botUsage).where(lt(botUsage.day, moscowDay(ago(7))));
}

/** Для тестов: следующая уборка — сразу. */
export function resetCleanupClock() {
  lastCleanup = 0;
}
