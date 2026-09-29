import type { FunctionDef } from '../gigachat/client.ts';
import type { Button } from '../max/bot-api.ts';
import { listBills } from '../bills/service.ts';
import { formatKopecks } from '../qr/receipt.ts';
import { listForUser } from '../requests/service.ts';
import { listMeters, windowState } from '../meters/service.ts';
import { contactsForResident } from '../house/contacts.ts';
import { addresseeForProperty } from '../requests/addressee.ts';
import { houseFeed, listPolls } from '../house/service.ts';
import { chairmanOf } from '../auth/session.ts';
import { claimsForChairman } from '../auth/claims.ts';
import { mockCard, mockSearch } from '../pick/mock/query.ts';
import { activeOutages, day, requestPayload, until, type CATALOG, type IntentContext } from '../bot/intents.ts';
import { normaliseComplaint, type ComplaintDraft } from '../bot/complaint.ts';
import { CATEGORIES } from '../bot/prompt.ts';
import { SCREENS, SCREEN_KEYS, type ScreenKey } from '../bot/screens.ts';

/**
 * Инструменты Домовёнка-агента.
 *
 * Модель вызывает их, чтобы узнать что-то о жителе или подготовить
 * действие. Кто житель и какая квартира — из сессии (IntentContext),
 * модель их не передаёт и подменить не может. Данные — теми же
 * сервисами, что у приложения: неподтверждённый увидит ровно то же,
 * что в приложении.
 *
 * Суммы и даты отдаются готовыми строками: модель повторяет их как есть,
 * а lib/agent/guard.ts потом сверяет ответ с этими строками.
 *
 * Кнопки создают только `open` и `draft_complaint`: адрес кнопки
 * собирает код после проверки, придумать ссылку модели нечем.
 */

export interface ToolResult {
  data: unknown;
  buttons?: Button[][];
  /** Экран, который мини-приложение откроет само */
  open?: string;
  /** draft_complaint: разговор завершается, дальше — draftReply */
  draft?: ComplaintDraft;
}

export interface Tool {
  def: FunctionDef;
  /** Шаблон кода по той же теме — запасной ответ, если проверка фактов не прошла */
  topic?: keyof typeof CATALOG;
  run(ctx: IntentContext, args: Record<string, unknown>): Promise<ToolResult>;
}

const noParams = { type: 'object', properties: {} };
const num = (n: number) => String(n).padStart(5, '0');
const LOCKED_FULL = 'откроется после подтверждения квартиры председателем или управляющей компанией';

const myBills: Tool = {
  topic: 'bills',
  def: {
    name: 'my_bills',
    description: 'Начисления жителя по квитанциям за последние месяцы: сколько платить, из чего сумма, сравнение с прошлым месяцем, что не отмечено оплаченным',
    parameters: noParams,
  },
  async run(ctx) {
    const data = await listBills(ctx.db, ctx.userId, ctx.propertyId, ctx.now);
    if (!data || data.bills.length === 0) return { data: { empty: 'квитанций в приложении пока нет' } };
    const byMonth = new Map<string, { month: string; totalKopecks: number; services: Array<{ service: string; sum: string; status: string }> }>();
    for (const b of data.bills) {
      const m = byMonth.get(b.period) ?? { month: b.periodLabel, totalKopecks: 0, services: [] };
      m.totalKopecks += b.sumKopecks;
      m.services.push({ service: b.serviceLabel, sum: b.sum, status: b.statusLabel });
      byMonth.set(b.period, m);
    }
    const months = [...byMonth.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 6).map(([, m]) => m);
    const [last, previous] = months;
    const diff = previous ? last.totalKopecks - previous.totalKopecks : 0;
    return {
      data: {
        months: months.map((m) => ({ month: m.month, total: formatKopecks(m.totalKopecks), services: m.services })),
        changeVsPreviousMonth: previous && diff !== 0 ? `на ${formatKopecks(Math.abs(diff))} ${diff > 0 ? 'больше' : 'меньше'}` : null,
        notMarkedPaid: data.outstandingKopecks > 0 ? data.outstanding : null,
        note: 'статус оплаты — только по отметкам жителя в приложении, прошёл ли платёж, приложение не знает',
      },
    };
  },
};

const myRequests: Tool = {
  topic: 'request_status',
  def: {
    name: 'my_requests',
    description: 'Обращения (заявки) жителя в УК: номера, статусы, исполнитель, срок. С number — одно обращение',
    parameters: { type: 'object', properties: { number: { type: 'string', description: 'Номер обращения, только цифры' } } },
  },
  async run(ctx, args) {
    const all = await listForUser(ctx.db, ctx.userId, ctx.propertyId);
    const shape = (r: typeof all[number]) => ({
      number: num(r.number), category: r.category, title: r.title, status: r.statusLabel,
      created: day(r.createdAt), assignee: r.assigneeName ?? null,
      deadline: r.slaDueAt && !r.closed ? day(r.slaDueAt) : null,
      waitingForResident: Boolean(r.awaitingResident),
    });
    const wanted = typeof args.number === 'string' && /^\d{1,8}$/.test(args.number.trim()) ? Number(args.number) : null;
    if (wanted) {
      const one = all.find((r) => r.number === wanted);
      return { data: one ? shape(one) : { error: 'not_found' } };
    }
    return {
      data: {
        open: all.filter((r) => !r.closed).slice(0, 10).map(shape),
        recentlyClosed: all.filter((r) => r.closed).slice(0, 5).map(shape),
      },
    };
  },
};

const myMeters: Tool = {
  topic: 'meters',
  def: {
    name: 'my_meters',
    description: 'Счётчики жителя в приложении: последние отметки и когда передавать показания',
    parameters: noParams,
  },
  async run(ctx) {
    const list = await listMeters(ctx.db, ctx.userId, ctx.propertyId) ?? [];
    return {
      data: {
        meters: list.map((m) => ({
          meter: m.label,
          last: m.previous === null ? null : `${String(m.previous).replace('.', ',')} ${m.unit}`,
          markedThisMonth: m.submittedThisPeriod,
        })),
        window: windowState(ctx.now).message,
        note: 'показания в приложении — дневник жителя, в УК они сами не уходят',
      },
    };
  },
};

const myAccounts: Tool = {
  topic: 'accounts',
  def: {
    name: 'my_accounts',
    description: 'По каким услугам у жителя квитанции и кто получатель платежа. Номеров лицевых счетов здесь нет',
    parameters: noParams,
  },
  async run(ctx) {
    const data = await listBills(ctx.db, ctx.userId, ctx.propertyId, ctx.now);
    const services = [...new Set((data?.bills ?? []).map((b) => b.serviceLabel))];
    return {
      data: {
        services,
        note: 'номера лицевых счетов — личные данные, в переписку не пишем; они в приложении, экран «Лицевые счета»',
      },
    };
  },
};

const houseInfo: Tool = {
  topic: 'contacts',
  def: {
    name: 'house_info',
    description: 'Управляющая компания дома и её телефон, телефоны дома (диспетчерская, аварийная, лифт, домофон), есть ли председатель совета дома',
    parameters: noParams,
  },
  async run(ctx) {
    const who = await addresseeForProperty(ctx.db, ctx.propertyId);
    const phones = await contactsForResident(ctx.db, ctx.userId, ctx.propertyId) ?? [];
    return {
      data: {
        managingCompany: who.kind === 'org' ? { name: who.name, phone: who.phone ?? null } : null,
        requestsGoTo: who.kind === 'org' ? 'управляющая компания' : who.kind === 'chairman' ? 'председатель совета дома' : 'оператор сервиса',
        phones: phones.map((c) => ({ title: c.title, phone: c.phone, note: c.note ?? null })),
        emergency: 'единый номер 112, пожарные 101, полиция 102, скорая 103, газ 104',
      },
    };
  },
};

const outages: Tool = {
  topic: 'outage',
  def: {
    name: 'outages',
    description: 'Плановые отключения воды, света, газа, отопления, объявленные в доме',
    parameters: noParams,
  },
  async run(ctx) {
    if (ctx.level !== 'full') return { data: { locked: `объявления дома ${LOCKED_FULL}` } };
    const list = await activeOutages(ctx);
    return {
      data: list.length
        ? list.map((o) => ({ title: o.title, text: o.body.slice(0, 400), until: o.expiresAt ? until(o.expiresAt) : null }))
        : { none: 'действующих объявлений об отключениях нет' },
    };
  },
};

const houseFeedTool: Tool = {
  topic: 'feed',
  def: {
    name: 'house_feed',
    description: 'Новости дома: объявления за две недели и открытые голосования',
    parameters: noParams,
  },
  async run(ctx) {
    if (ctx.level !== 'full') return { data: { locked: `лента дома ${LOCKED_FULL}` } };
    const since = ctx.now.getTime() - 14 * 24 * 3600 * 1000;
    const posts = (await houseFeed(ctx.db, ctx.userId))
      .filter((p) => p.category !== 'market' && p.publishedAt && new Date(p.publishedAt).getTime() >= since)
      .slice(0, 5);
    const polls = (await listPolls(ctx.db, ctx.userId)).filter((p) => !p.closed);
    return {
      data: {
        posts: posts.map((p) => ({ date: day(p.publishedAt), title: p.title })),
        openPolls: polls.map((p) => ({ title: p.title, until: p.closesAt ? day(p.closesAt) : null })),
      },
    };
  },
};

const councilTasks: Tool = {
  topic: 'council',
  def: {
    name: 'council_tasks',
    description: 'Дела председателя совета дома: сколько соседей ждут подтверждения',
    parameters: noParams,
  },
  async run(ctx) {
    if (!(await chairmanOf(ctx.db, ctx.userId, ctx.houseKey))) {
      return { data: { locked: 'только председателю совета дома' } };
    }
    return { data: { waitingClaims: (await claimsForChairman(ctx.db, ctx.houseKey)).length } };
  },
};

const analyticsTool: Tool = {
  topic: 'analytics',
  def: {
    name: 'analytics',
    description: 'Сколько житель тратит на ЖКУ: итоги по месяцам и среднее',
    parameters: noParams,
  },
  async run(ctx) {
    const data = await listBills(ctx.db, ctx.userId, ctx.propertyId, ctx.now);
    if (!data || data.bills.length === 0) return { data: { empty: 'квитанций пока нет' } };
    const months = new Map<string, { label: string; sum: number }>();
    for (const b of data.bills) {
      const m = months.get(b.period) ?? { label: b.periodLabel, sum: 0 };
      m.sum += b.sumKopecks;
      months.set(b.period, m);
    }
    const list = [...months.entries()].sort(([a], [b]) => (a < b ? 1 : -1)).slice(0, 6).map(([, m]) => m);
    const avg = Math.round(list.reduce((s, m) => s + m.sum, 0) / list.length);
    return { data: { months: list.map((m) => ({ month: m.label, total: formatKopecks(m.sum) })), average: formatKopecks(avg) } };
  },
};

const findComplex: Tool = {
  def: {
    name: 'find_complex',
    description: 'Найти жилые комплексы (ЖК) Ростова для подбора дома: по названию или району. Данные примерные',
    parameters: { type: 'object', properties: { query: { type: 'string', description: 'Название ЖК или района' } }, required: ['query'] },
  },
  async run(ctx, args) {
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 60) : '';
    if (!query) return { data: { error: 'empty_query' } };
    const found = await mockSearch(ctx.db, query);
    const cards = [];
    for (const h of found.houses.slice(0, 5)) {
      const c = await mockCard(ctx.db, h.houseKey);
      if (c) {
        cards.push({
          name: c.name, district: c.district, developer: c.developer,
          priceFrom: c.priceFrom ? `от ${String(c.priceFrom / 1e6).replace('.', ',')} млн ₽` : null,
          rating: c.rating, slug: c.key.replace(/^mock:/, ''),
        });
      }
    }
    return {
      data: cards.length
        ? { complexes: cards, districts: found.districts.map((d) => d.district), note: 'цены и отзывы примерные, для показа' }
        : { none: 'ничего не нашлось', districts: found.districts.map((d) => d.district) },
    };
  },
};

const open: Tool = {
  def: {
    name: 'open',
    description: 'Открыть в приложении экран, обращение или карточку ЖК. '
      + `target: screen:<экран> (экраны: ${SCREEN_KEYS.join(', ')}), request:<номер обращения>, complex:<slug из find_complex>`,
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
    few_shot_examples: [
      { request: 'открой счётчики', params: { target: 'screen:meters' } },
      { request: 'где мои заявки', params: { target: 'screen:requests' } },
      { request: 'покажи заявку 12', params: { target: 'request:12' } },
      { request: 'хочу отключить уведомления', params: { target: 'screen:notify_settings' } },
    ],
  },
  async run(ctx, args) {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    const [kind, value = ''] = target.split(':');
    const button = (label: string, payload: string): ToolResult => ({
      data: { opened: label }, buttons: [[ctx.app(label, payload)]], open: payload,
    });

    if (kind === 'screen' && SCREEN_KEYS.includes(value as ScreenKey)) {
      const screen = SCREENS[value as ScreenKey] as { label: string; payload: string; need?: 'full' | 'chairman' };
      if (screen.need === 'full' && ctx.level !== 'full') return { data: { error: 'locked', why: LOCKED_FULL } };
      if (screen.need === 'chairman' && !(await chairmanOf(ctx.db, ctx.userId, ctx.houseKey))) {
        return { data: { error: 'locked', why: 'только председателю совета дома' } };
      }
      return button(screen.label, screen.payload);
    }
    if (kind === 'request' && /^\d{1,8}$/.test(value)) {
      const mine = (await listForUser(ctx.db, ctx.userId, ctx.propertyId)).find((r) => r.number === Number(value));
      return mine ? button(`Обращение № ${num(mine.number)}`, requestPayload(mine.id)) : { data: { error: 'not_found' } };
    }
    if (kind === 'complex' && /^[a-z0-9-]{1,60}$/.test(value)) {
      const card = await mockCard(ctx.db, `mock:${value}`);
      return card ? button(card.name, `p_${value}`) : { data: { error: 'not_found' } };
    }
    return { data: { error: 'not_found' } };
  },
};

const draftComplaint: Tool = {
  def: {
    name: 'draft_complaint',
    description: 'Подготовить обращение в УК о проблеме в доме или квартире. Житель проверит и отправит сам',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: [...CATEGORIES] },
        text: { type: 'string', description: 'Жалоба деловым языком от первого лица: все факты жителя, без мата и эмоций, ничего своего' },
      },
      required: ['category', 'text'],
    },
    few_shot_examples: [
      { request: 'лифт опять сдох третий день пешком на 9 этаж', params: { category: 'Лифт', text: 'Лифт не работает третий день. Прошу восстановить его работу.' } },
      { request: 'в подъезде срач никто не убирает месяц', params: { category: 'Общее имущество', text: 'В подъезде не проводится уборка около месяца. Прошу возобновить уборку.' } },
      { request: 'батареи холодные дома дубак', params: { category: 'Сантехника', text: 'В квартире холодные батареи. Прошу проверить отопление.' } },
    ],
  },
  async run(_ctx, args) {
    const original = typeof args.text === 'string' ? args.text : '';
    return { data: { drafted: true }, draft: normaliseComplaint(args, original) };
  },
};

export const TOOLS: Record<string, Tool> = Object.fromEntries([
  myBills, myRequests, myMeters, myAccounts, houseInfo, outages, houseFeedTool,
  councilTasks, analyticsTool, findComplex, open, draftComplaint,
].map((t) => [t.def.name, t]));
