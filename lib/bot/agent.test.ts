import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../../server/app.ts';
import { signInitDataForTesting } from '../max/init-data.ts';
import { testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL } from '../test-db.ts';
import { closeDb } from '../../db/client.ts';
import { botMiss, post, property } from '../../db/schema.ts';
import { handleMessage, resetCleanupClock, AI_NOTE, type BotDeps, type Llm } from './handle.ts';
import type { Reply } from './intents.ts';
import type { ChatMessage, ChatTurn } from '../gigachat/client.ts';

/**
 * Домовёнок-агент через бота MAX целиком, с поддельной моделью.
 *
 * Главное: модель пишет ответ сама, но данные берёт только из инструментов
 * с правами приложения; выдуманную сумму ловит проверка фактов; кнопки
 * даёт только код; под ответом модели — пометка ИИ; опасность до модели
 * не доходит.
 */

process.env.DATABASE_URL = TEST_URL;
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;
const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const app = buildApp();
beforeEach(async () => {
  if (!available) return;
  await resetTables();
  resetCleanupClock();
});
after(async () => { await app.close(); await closeTestDb(); await closeDb(); });

function initData(id: number) {
  return signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: 800000 + id, type: 'DIALOG' }),
    query_id: `q-${id}`,
    user: JSON.stringify({ id, first_name: 'Анна', last_name: 'Смирнова', username: null, language_code: 'ru', photo_url: null }),
  }, BOT_TOKEN);
}

/** Житель, вошедший через MAX: квитанция на 4 850 ₽ за август. */
async function resident(maxId: number, { confirmed = true } = {}) {
  const qr = [
    'ST00011', 'Name=ООО "УК Пример"', 'PayeeINN=6100000001', 'KPP=610001001',
    'Sum=485000', 'paymPeriod=082026', 'lastName=Смирнова', 'firstName=Анна', 'middleName=Т',
    `payerAddress=${HOUSE}, кв. 15`, 'persAcc=4460153',
  ].join('|');
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr', headers: { 'x-max-init-data': initData(maxId) }, payload: { qr },
  });
  assert.ok(res.statusCode < 300, `вход по квитанции: ${res.body}`);
  if (confirmed) await grantAccess();
}

type Step = Omit<ChatTurn, 'totalTokens'> | Error;
let mids = 0;

/**
 * Классификатор (callFunction) стоит перед агентом: жалобу оформляет он,
 * всё остальное уходит агенту (chat). По умолчанию он отвечает «unknown».
 */
function harness(steps: Step[], extra: Partial<BotDeps> = {}, classify: Array<Record<string, unknown> | Error> = []) {
  const sent: Reply[] = [];
  const seen: ChatMessage[][] = [];
  const llm: Llm = {
    async callFunction() {
      const next = classify.shift() ?? { intent: 'unknown' };
      if (next instanceof Error) throw next;
      return { args: next, totalTokens: 300 };
    },
    async chat(messages) {
      seen.push(structuredClone(messages));
      const next = steps.shift();
      if (!next) throw new Error('лишнее обращение к модели');
      if (next instanceof Error) throw next;
      return { ...next, totalTokens: 500 };
    },
  };
  const deps: BotDeps = {
    db: testDb(), llm, botUsername: 'test_bot',
    send: async (_id, reply) => { sent.push(reply); },
    ...extra,
  };
  // mid уникален на весь файл: бот отбрасывает повтор события с тем же mid
  const say = (maxUserId: number, text: string) => handleMessage(deps, { maxUserId, text, mid: `mid-${++mids}` });
  return { sent, seen, say };
}

const payloads = (r: Reply) => (r.buttons ?? []).flat().map((b) => (b.type === 'open_app' ? b.payload ?? '' : b.text));
/** Что модель получила от инструмента — последнее сообщение role=function */
const toolData = (seen: ChatMessage[][], i: number) => seen[i].at(-1)!.content;

test('«скока платить»: сумма из инструмента, ответ модели с пометкой ИИ', { skip }, async () => {
  await resident(92001);
  const h = harness([{ call: { name: 'my_bills', args: {} } }, { content: 'За август начислено 4 850,00 ₽.' }]);
  await h.say(92001, 'скока платить');

  assert.equal(h.seen[1].at(-1)!.role, 'function');
  assert.match(toolData(h.seen, 1), /4\s850,00/);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].ai, true);
  assert.ok(h.sent[0].text.startsWith('За август начислено 4 850,00 ₽.'));
  assert.ok(h.sent[0].text.endsWith(AI_NOTE), 'в MAX пометка — последней строкой текста');
});

test('выдуманная сумма: шаблон кода вместо ответа модели, промах в журнале', { skip }, async () => {
  await resident(92002);
  const h = harness([{ call: { name: 'my_bills', args: {} } }, { content: 'К оплате 9 999 ₽.' }]);
  await h.say(92002, 'скока платить');

  assert.equal(h.sent[0].ai, undefined);
  assert.match(h.sent[0].text, /4\s850,00/, 'шаблон начислений с настоящей суммой');
  assert.doesNotMatch(h.sent[0].text, /9 999/);
  const misses = await testDb().select().from(botMiss);
  assert.ok(misses.some((m) => m.reason.startsWith('guard: 9 999')), JSON.stringify(misses));
});

test('неподтверждённый: лента дома закрыта и для агента', { skip }, async () => {
  await resident(92003, { confirmed: false });
  const h = harness([{ call: { name: 'house_feed', args: {} } }, { content: 'Лента откроется после подтверждения.' }]);
  await h.say(92003, 'чо нового в доме');
  assert.match(toolData(h.seen, 1), /locked/);
});

test('открыть чужое обращение нельзя, свой экран — можно', { skip }, async () => {
  await resident(92004);
  const h = harness([
    { call: { name: 'open', args: { target: 'request:99999' } } }, { content: 'Такого обращения не нашёл.' },
    { call: { name: 'open', args: { target: 'screen:meters' } } }, { content: 'Открываю счётчики.' },
  ]);
  await h.say(92004, 'открой заявку 99999');
  assert.match(toolData(h.seen, 1), /not_found/);
  assert.equal(h.sent[0].buttons, undefined, 'без кнопок: открывать нечего');

  await h.say(92004, 'открой счётчики');
  assert.deepEqual(payloads(h.sent[1]), ['s_meters']);
  assert.equal(h.sent[1].open, 's_meters');
});

test('председательский раздел — только председателю', { skip }, async () => {
  await resident(92005);
  const h = harness([{ call: { name: 'council_tasks', args: {} } }, { content: 'Это раздел председателя.' }]);
  await h.say(92005, 'кого подтвердить');
  assert.match(toolData(h.seen, 1), /locked/);
});

test('жалоба: черновик кодом, кнопка в форму, без пометки ИИ', { skip }, async () => {
  await resident(92006);
  const h = harness([{ call: { name: 'draft_complaint', args: { category: 'Лифт', text: 'Лифт не работает третий день. Прошу восстановить.' } } }]);
  await h.say(92006, 'лифт опять сдох третий день');
  assert.equal(h.seen.length, 1, 'после черновика модель не зовётся');
  assert.ok(payloads(h.sent[0]).some((p) => p.startsWith('d_')), JSON.stringify(h.sent[0]));
  assert.equal(h.sent[0].ai, undefined);
});

test('человеку плохо — скорая, модель не зовётся', { skip }, async () => {
  await resident(92007);
  const h = harness([]);
  await h.say(92007, 'соседу плохо без сознания');
  assert.match(h.sent[0].text, /103/);
  assert.equal(h.sent.length, 1);
  assert.equal(h.seen.length, 0);
});

test('законы: с моделью — агент, без модели — прежний отказ', { skip }, async () => {
  await resident(92008);
  const h = harness([{ content: 'По закону перерыв в горячей воде — не больше 14 дней в год. Если дольше — жалоба в жилищную инспекцию.' }]);
  await h.say(92008, 'имеют право отключать воду на месяц?');
  assert.equal(h.seen.length, 1);
  assert.equal(h.sent[0].ai, true);

  const deaf = harness([], { llm: null });
  await deaf.say(92008, 'имеют право отключать воду на месяц?');
  assert.match(deaf.sent[0].text, /По законам не консультирую/);
});

test('сбой модели — запасной ответ, а не молчание', { skip }, async () => {
  await resident(92009);
  const h = harness([new Error('GigaChat лежит')]);
  await h.say(92009, 'расскажи что-нибудь');
  assert.match(h.sent[0].text, /Не получилось разобрать/);
});

test('грубость, на которую сработал фильтр GigaChat, — спокойный ответ кода', { skip }, async () => {
  await resident(92010);
  const blocked = Object.assign(new Error('фильтр'), { code: 'blacklist', totalTokens: 40 });
  const h = harness([blocked]);
  await h.say(92010, 'ты тупой');
  assert.match(h.sent[0].text, /Расскажите, что случилось/);
  assert.doesNotMatch(h.sent[0].text, /Не получилось разобрать/);
  assert.equal(h.sent[0].ai, undefined);
});

test('жалобу оформляет классификатор с уточнением, агент не зовётся', { skip }, async () => {
  await resident(92011);
  const h = harness([], {}, [{
    intent: 'complaint', category: 'Сантехника', text: 'В квартире нет воды.',
    ask: 'Какой воды нет?', options: ['Горячей', 'Холодной'],
  }]);
  await h.say(92011, 'нет воды');
  assert.equal(h.sent[0].text, 'Какой воды нет?');
  assert.equal(h.seen.length, 0);
});


test('агент получает подсказку классификатора: какой инструмент вызвать', { skip }, async () => {
  await resident(92012);
  const h = harness([{ content: 'Смотрю ваши обращения.' }], {}, [{ intent: 'request_status', requestNumber: '12' }]);
  await h.say(92012, 'что с заявкой 12');
  assert.equal(h.seen[0].filter((m) => m.role === 'system').length, 1, 'системное у GigaChat одно');
  assert.match(h.seen[0][0].content, /Подсказка разбора: вызови my_requests с number "12"/);
});

test('вопрос о законе не перехватывает правило отключений', { skip }, async () => {
  await resident(92013);
  const [home] = await testDb().select().from(property);
  await testDb().insert(post).values({
    id: 'pst_outage_law', houseKey: home.houseKey!, type: 'uk', category: 'outage',
    title: 'Отключение горячей воды', body: 'Замена задвижки', expiresAt: new Date(Date.now() + 86_400_000),
  });
  const h = harness([{ content: 'Обычно перерыв не больше 14 дней. Иначе — жалоба в жилищную инспекцию.' }]);
  await h.say(92013, 'имеют право отключать воду на месяц?');
  assert.equal(h.sent[0].ai, true);
  assert.doesNotMatch(h.sent[0].text, /объявила отключение/);
});

test('фильтр GigaChat на классификаторе — тоже спокойный ответ', { skip }, async () => {
  await resident(92014);
  const blocked = Object.assign(new Error('фильтр'), { code: 'blacklist', totalTokens: 30 });
  const h = harness([], {}, [blocked]);
  await h.say(92014, 'ты тупой');
  assert.match(h.sent[0].text, /Расскажите, что случилось/);
  assert.equal(h.seen.length, 0);
});

test('вопрос, который классификатор принял за жалобу, уходит агенту', { skip }, async () => {
  await resident(92015);
  const h = harness([{ content: 'Сроки капремонта знает фонд капремонта региона и УК.' }], {}, [
    { intent: 'complaint', category: 'Общее имущество', text: 'Когда будет проведен капремонт?' },
  ]);
  await h.say(92015, 'когда капремонт');
  assert.equal(h.seen.length, 1, 'агент позван');
  assert.equal(h.sent[0].ai, true);
});

test('вопрос с поломкой остаётся жалобой', { skip }, async () => {
  await resident(92016);
  const h = harness([], {}, [{ intent: 'complaint', category: 'Сантехника', text: 'В квартире нет воды. Прошу сообщить причину.' }]);
  await h.say(92016, 'почему нет воды?');
  assert.equal(h.seen.length, 0);
  assert.ok((h.sent[0].buttons ?? []).flat().some((b) => b.type === 'open_app' && b.payload?.startsWith('d_')));
});

test('понятая тема: код сам вызывает инструмент до ответа модели', { skip }, async () => {
  await resident(92017);
  const h = harness([{ content: 'Открытых обращений нет.' }], {}, [{ intent: 'request_status' }]);
  await h.say(92017, 'что с моей заявкой');
  assert.equal(h.seen[0].at(-1)!.role, 'function');
  assert.equal(h.seen[0].at(-1)!.name, 'my_requests');
});

test('«открой счётчики» — кнопку и экран даёт код, модель не зовётся', { skip }, async () => {
  await resident(92018);
  const h = harness([], {}, [{ intent: 'navigate', screen: 'meters' }]);
  await h.say(92018, 'открой счётчики');
  assert.equal(h.seen.length, 0);
  assert.equal(h.sent[0].open, 's_meters');
});
