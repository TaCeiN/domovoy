import { and, desc, eq, gt, isNull, or } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { post } from '../../db/schema.ts';
import type { Button, OpenAppButton } from '../max/bot-api.ts';
import { listBills } from '../bills/service.ts';
import { formatKopecks } from '../qr/receipt.ts';
import { listForUser } from '../requests/service.ts';
import { listMeters, windowState } from '../meters/service.ts';
import { contactsForResident } from '../house/contacts.ts';
import { addresseeForProperty } from '../requests/addressee.ts';
import { houseFeed, listPolls } from '../house/service.ts';
import { chairmanOf } from '../auth/session.ts';
import { claimsForChairman } from '../auth/claims.ts';
import type { Intent } from './prompt.ts';
import { SCREENS, type ScreenKey } from './screens.ts';

/**
 * Каталог: что бот отвечает на каждое намерение.
 *
 * Данные — из тех же сервисов, что у маршрутов мини-приложения, и с теми
 * же проверками прав: сервис сам отвечает null, если квартира не своя.
 * Уровень (своё / дом / председатель) проверяет код, а не модель.
 * Каждый ответ ведёт кнопкой в мини-приложение — там полная картина.
 *
 * Жалоба в каталог не входит: у неё свой путь с уточнением, проверкой
 * на повтор и черновиком (lib/bot/complaint.ts).
 */

/**
 * Какую анимацию Домового показать в мини-приложении. Боту MAX не нужно:
 * туда уходят только текст и кнопки. Нет поля — обычный ответ (talk).
 */
export type Mood = 'alert' | 'done' | 'confused';

export interface Reply {
  text: string;
  buttons?: Button[][];
  mood?: Mood;
  /**
   * Экран, который мини-приложение открывает само, без нажатия (payload
   * как у кнопки `open_app`). Боту MAX не нужно: там остаётся кнопка.
   */
  open?: string;
  /**
   * Ответ написала модель (Домовёнок-агент): под ним пометка «Ответ
   * сгенерирован ИИ». Ответы кода — опасность, шаблоны — без неё.
   */
  ai?: boolean;
}

export interface IntentContext {
  db: Database;
  userId: string;
  propertyId: string;
  houseKey: string;
  /** self — квартира ждёт подтверждения, full — подтверждена */
  level: 'self' | 'full';
  requestNumber: string | null;
  /** Экран из разбора модели — уже проверенный по списку SCREENS */
  screen: ScreenKey | null;
  app: (text: string, payload?: string) => OpenAppButton;
  now: Date;
}

type Answer = (ctx: IntentContext) => Promise<Reply>;

const DAY = 24 * 3600 * 1000;

/** «Лента откроется после подтверждения» — как в мини-приложении. */
function locked(what: string, ctx: IntentContext): Reply {
  return {
    text: `${what} откроется, когда председатель или управляющая компания подтвердит вашу квартиру.`,
    buttons: [[ctx.app('Открыть приложение')]],
  };
}

/** id обращения в payload кнопки — без префикса типа (см. public/app/deeplink.js). */
export function requestPayload(id: string): string {
  return `r_${id.replace(/^req_/, '')}`;
}

export function day(date: Date | string | null): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
}

const greeting: Answer = async (ctx) => ({
  text: [
    'Здравствуйте! Я Домовёнок, бот вашего дома.',
    'Спросите, сколько начислено, что с обращением, телефон аварийной службы.',
    'Или просто опишите проблему своими словами — я подготовлю обращение в управляющую компанию.',
  ].join('\n'),
  buttons: [[ctx.app('Открыть приложение')]],
});

const bills: Answer = async (ctx) => {
  const data = await listBills(ctx.db, ctx.userId, ctx.propertyId, ctx.now);
  if (!data || data.bills.length === 0) {
    return {
      text: 'Квитанций в приложении пока нет. Отсканируйте QR-код квитанции в приложении — и я смогу подсказать суммы.',
      buttons: [[ctx.app('Открыть приложение')]],
    };
  }

  const latest = data.bills[0].period;
  const current = data.bills.filter((b) => b.period === latest);
  const total = current.reduce((sum, b) => sum + b.sumKopecks, 0);
  const lines = [`Начислено за ${data.bills[0].periodLabel.toLowerCase()}: ${formatKopecks(total)}`];
  if (current.length > 1) for (const b of current) lines.push(`• ${b.serviceLabel}: ${b.sum}`);

  // Сравнение считает код: модель цифр не касается
  const previous = data.bills.find((b) => b.period < latest)?.period;
  if (previous) {
    const before = data.bills.filter((b) => b.period === previous).reduce((sum, b) => sum + b.sumKopecks, 0);
    const diff = total - before;
    if (diff !== 0) {
      lines.push(`Это на ${formatKopecks(Math.abs(diff))} ${diff > 0 ? 'больше' : 'меньше'}, чем месяцем раньше.`);
    }
  }
  if (data.outstandingKopecks > 0) {
    lines.push('', `Не отмечено оплаченным: ${data.outstanding} — по вашим отметкам в приложении.`);
  }
  return {
    text: lines.join('\n'),
    buttons: [[ctx.app('Оплатить', 's_payment'), ctx.app('Расход', 's_analytics')]],
  };
};

const paid: Answer = async (ctx) => {
  const data = await listBills(ctx.db, ctx.userId, ctx.propertyId, ctx.now);
  if (!data || data.bills.length === 0) {
    return { text: 'Квитанций в приложении пока нет.', buttons: [[ctx.app('Открыть приложение')]] };
  }
  const lines = data.bills.slice(0, 4).map((b) => `• ${b.periodLabel}, ${b.serviceLabel.toLowerCase()}: ${b.sum} — ${b.statusLabel.toLowerCase()}`);
  lines.push('', 'Это ваши отметки в приложении: прошёл ли платёж, приложение не знает. Точный долг — в квитанции или у УК.');
  return { text: lines.join('\n'), buttons: [[ctx.app('История оплат', 's_payment-history')]] };
};

const requestStatus: Answer = async (ctx) => {
  const all = await listForUser(ctx.db, ctx.userId, ctx.propertyId);
  const wanted = ctx.requestNumber ? Number(ctx.requestNumber) : null;
  const picked = wanted
    ? all.filter((r) => r.number === wanted)
    : all.filter((r) => !r.closed).slice(0, 3);

  if (picked.length === 0) {
    return {
      text: wanted
        ? `Обращения № ${String(wanted).padStart(5, '0')} среди ваших нет.`
        : 'Открытых обращений у вас нет. Если что-то сломалось — опишите, я подготовлю обращение.',
      buttons: [[ctx.app('Все обращения', 's_requests')]],
    };
  }

  const lines = picked.map((r) => {
    const parts = [`№ ${String(r.number).padStart(5, '0')} · ${r.category} · ${r.statusLabel}`];
    if (r.assigneeName) parts.push(`исполнитель: ${r.assigneeName}`);
    if (r.slaDueAt && !r.closed) parts.push(`срок по регламенту: ${day(r.slaDueAt)}`);
    if (r.awaitingResident) parts.push('ждут вашего ответа — откройте обращение');
    return `${parts.join('\n')}\n«${r.title}»`;
  });
  return {
    text: lines.join('\n\n'),
    buttons: [
      ...picked.map((r) => [ctx.app(`Открыть № ${String(r.number).padStart(5, '0')}`, requestPayload(r.id))]),
      [ctx.app('Все обращения', 's_requests')],
    ],
  };
};

const master: Answer = async (ctx) => ({
  text: [
    'Если сломалось в самой квартире — помогу найти мастера рядом.',
    '',
    'Но стояки, щитки на площадке и всё, что до первого крана и автомата в квартире, — общее имущество дома. '
      + 'Его ремонт входит в плату за содержание, платить мастеру не нужно: опишите проблему, и я подготовлю обращение в УК.',
  ].join('\n'),
  buttons: [[ctx.app('Найти мастера', 's_master')]],
});

const meters: Answer = async (ctx) => {
  const list = await listMeters(ctx.db, ctx.userId, ctx.propertyId);
  const window = windowState(ctx.now);
  const lines: string[] = [];
  if (!list || list.length === 0) {
    lines.push('Счётчиков в приложении пока нет — их можно завести на экране счётчиков.');
  } else {
    for (const m of list) {
      lines.push(m.previous === null
        ? `• ${m.label}: отметок пока нет`
        : `• ${m.label}: ${String(m.previous).replace('.', ',')} ${m.unit}${m.submittedThisPeriod ? ' — в этом месяце отмечено' : ''}`);
    }
  }
  lines.push('', `${window.message}.`, 'Показания в приложении — ваш дневник: в УК они сами не уходят.');
  return { text: lines.join('\n'), buttons: [[ctx.app('Счётчики', 's_meters')]] };
};

/**
 * Лицевые счета — только кнопкой на экран приложения, номеров в переписке нет.
 *
 * Номер счёта, адрес и ФИО из квитанции — персональные данные. Модель их
 * и так не видит (она разбирает только текст жителя), но переписка с
 * ботом хранится у мессенджера, и лишний раз выносить туда номера счетов
 * незачем: на экране приложения они под сессией жителя (27.09.2026).
 */
const accounts: Answer = async (ctx) => ({
  text: 'Лицевые счета по всем вашим квитанциям — свет, вода, газ, содержание дома — '
    + 'собраны в приложении. Номера счетов в переписку не пишу: это личные данные.',
  buttons: [[ctx.app('Мои лицевые счета', 's_accounts')]],
});

const contacts: Answer = async (ctx) => {
  const who = await addresseeForProperty(ctx.db, ctx.propertyId);
  const house = await contactsForResident(ctx.db, ctx.userId, ctx.propertyId) ?? [];
  const lines: string[] = [];
  if (who.kind === 'org') lines.push(`Управляющая компания: ${who.name}${who.phone ? `, телефон ${who.phone}` : ''}.`);
  if (house.length) {
    lines.push('', 'Телефоны дома:');
    for (const c of house) lines.push(`• ${c.title}: ${c.phone}${c.note ? ` (${c.note})` : ''}`);
  }
  lines.push('', 'Экстренные службы: единый номер — 112, пожарные — 101, полиция — 102, скорая — 103, газ — 104.');
  return { text: lines.join('\n').trim(), buttons: [[ctx.app('Аварийные службы', 's_emergency')]] };
};

const invite: Answer = async (ctx) => {
  if (ctx.level !== 'full') return locked('Приглашение домочадцев', ctx);
  return {
    text: 'Домочадца добавляют приглашением: в разделе «Доступ» создайте код и перешлите ссылку. Человек нажмёт её в MAX — и квартира появится у него в приложении.',
    buttons: [[ctx.app('Доступ', 's_access')]],
  };
};

const feed: Answer = async (ctx) => {
  if (ctx.level !== 'full') return locked('Лента дома', ctx);
  const since = ctx.now.getTime() - 14 * DAY;
  const posts = (await houseFeed(ctx.db, ctx.userId))
    .filter((p) => p.category !== 'market' && p.publishedAt && new Date(p.publishedAt).getTime() >= since)
    .slice(0, 5);
  return {
    text: posts.length
      ? ['Объявления дома за две недели:', ...posts.map((p) => `• ${day(p.publishedAt)} — ${p.title}`)].join('\n')
      : 'За две недели объявлений в доме не было.',
    buttons: [[ctx.app('Лента дома', 's_feed')]],
  };
};

const polls: Answer = async (ctx) => {
  if (ctx.level !== 'full') return locked('Голосования дома', ctx);
  const open = (await listPolls(ctx.db, ctx.userId)).filter((p) => !p.closed);
  return {
    text: open.length
      ? ['Идут голосования:', ...open.map((p) => `• ${p.title}${p.closesAt ? ` — до ${day(p.closesAt)}` : ''}`)].join('\n')
      : 'Сейчас голосований в доме нет.',
    buttons: [[ctx.app('Опросы', 's_polls')]],
  };
};

const council: Answer = async (ctx) => {
  const role = await chairmanOf(ctx.db, ctx.userId, ctx.houseKey);
  if (!role) {
    return {
      text: 'Это раздел председателя совета дома — в этом доме вы не председатель.',
      buttons: [[ctx.app('Открыть приложение')]],
    };
  }
  const waiting = (await claimsForChairman(ctx.db, ctx.houseKey)).length;
  return {
    text: waiting
      ? `Ждут подтверждения квартиры: ${waiting}. Подтвердить можно в разделе «Совет дома».`
      : 'Жителей, ждущих подтверждения, нет.',
    buttons: [[ctx.app('Совет дома', 's_council')]],
  };
};

/**
 * Итоги начислений по месяцам. Складывает код, модель цифр не касается.
 * До подтверждения квартиры — только то, что человек принёс сам
 * (`listBills` сам решает, что ему видно).
 */
const analytics: Answer = async (ctx) => {
  const data = await listBills(ctx.db, ctx.userId, ctx.propertyId, ctx.now);
  if (!data || data.bills.length === 0) {
    return {
      text: 'Чтобы посчитать расходы, нужны квитанции: отсканируйте их в приложении — хотя бы за пару месяцев.',
      buttons: [[ctx.app('Аналитика', 's_analytics')]],
    };
  }
  const months = new Map<string, { label: string; sum: number }>();
  for (const b of data.bills) {
    const m = months.get(b.period) ?? { label: b.periodLabel, sum: 0 };
    m.sum += b.sumKopecks;
    months.set(b.period, m);
  }
  const list = [...months.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 6);
  const lines = ['Начисления по месяцам:', ...list.map(([, m]) => `• ${m.label}: ${formatKopecks(m.sum)}`)];
  if (list.length >= 2) {
    const avg = Math.round(list.reduce((s, [, m]) => s + m.sum, 0) / list.length);
    lines.push('', `В среднем ${formatKopecks(avg)} в месяц.`);
  }
  return { text: lines.join('\n'), buttons: [[ctx.app('Аналитика', 's_analytics')]] };
};

/**
 * Открыть экран приложения. Права — те же, что у экрана: лента дома после
 * подтверждения, «Совет дома» председателю. Экран, которого нет в списке,
 * модель выдумать может, а открыть — нет.
 */
const navigate: Answer = async (ctx) => {
  if (!ctx.screen) {
    return {
      text: 'Не понял, какой экран открыть. Скажите иначе — например, «открой счётчики» или «где мои обращения».',
      buttons: [[ctx.app('Открыть приложение')]],
    };
  }
  const screen = SCREENS[ctx.screen];
  if ('need' in screen && screen.need === 'full' && ctx.level !== 'full') return locked(`Раздел «${screen.label}»`, ctx);
  if ('need' in screen && screen.need === 'chairman') {
    const answer = await council(ctx);
    if (!(await chairmanOf(ctx.db, ctx.userId, ctx.houseKey))) return answer;
  }
  return {
    text: `Открываю «${screen.label}».`,
    buttons: [[ctx.app(screen.label, screen.payload)]],
    open: screen.payload,
  };
};

/**
 * Действующие отключения в доме — то же, что баннер на главной: объявления
 * УК и председателя с категорией «Отключение», срок которых не вышел.
 * Бессрочные — только свежие: без срока «нет воды» от прошлой весны
 * отвечало бы на сегодняшний вопрос.
 */
export async function activeOutages(ctx: IntentContext) {
  const rows = await ctx.db
    .select({ title: post.title, body: post.body, expiresAt: post.expiresAt, publishedAt: post.publishedAt })
    .from(post)
    .where(and(
      eq(post.houseKey, ctx.houseKey), eq(post.category, 'outage'), isNull(post.removedAt),
      or(gt(post.expiresAt, ctx.now), and(isNull(post.expiresAt), gt(post.publishedAt, new Date(ctx.now.getTime() - 14 * DAY)))),
    ))
    .orderBy(desc(post.publishedAt))
    .limit(3);
  return rows;
}

export function until(date: Date): string {
  return new Date(date).toLocaleString('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
  });
}

/** Текст объявлений об отключении — словами УК, срок пишет код */
export function outageText(list: Awaited<ReturnType<typeof activeOutages>>): string {
  return list.map((o) => [
    `• ${o.title}`,
    o.body.length > 400 ? `${o.body.slice(0, 400)}…` : o.body,
    o.expiresAt ? `Объявление действует до ${until(o.expiresAt)}.` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

/**
 * «Когда отключение воды», «когда дадут свет». Объявления дома видны
 * после подтверждения квартиры — как лента и баннер на главной; до него
 * честно говорим, где узнать: телефон УК.
 */
const outage: Answer = async (ctx) => {
  if (ctx.level !== 'full') {
    const who = await addresseeForProperty(ctx.db, ctx.propertyId);
    return {
      text: 'Объявления дома об отключениях откроются, когда председатель или управляющая компания подтвердит вашу квартиру.'
        + (who.kind === 'org' && who.phone ? `\nА пока про отключения можно узнать в УК: ${who.name}, ${who.phone}.` : ''),
      buttons: [[ctx.app('Открыть приложение')]],
    };
  }
  const list = await activeOutages(ctx);
  if (list.length === 0) {
    return {
      text: 'Сейчас действующих объявлений об отключениях нет. '
        + 'Если воды, света или тепла нет — опишите, что случилось, и я подготовлю обращение в управляющую компанию.',
      buttons: [[ctx.app('Лента дома', 's_feed')]],
    };
  }
  return {
    text: `Объявления об отключениях в вашем доме:\n\n${outageText(list)}`,
    buttons: [[ctx.app('Лента дома', 's_feed')]],
  };
};

const unknown: Answer = async (ctx) => ({
  text: [
    'Я отвечаю по данным вашего дома в приложении: начисления, обращения, счётчики, телефоны.',
    'Если что-то сломалось или не устраивает — опишите проблему, и я подготовлю обращение в управляющую компанию.',
  ].join('\n'),
  buttons: [[ctx.app('Открыть приложение')]],
});

export const CATALOG: Record<Exclude<Intent, 'complaint'>, Answer> = {
  greeting, bills, paid, request_status: requestStatus, master, meters, accounts,
  contacts, invite, feed, polls, council, analytics, navigate, outage, unknown,
};
