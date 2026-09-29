import type { Database } from '../../db/client.ts';
import { listForUser } from '../requests/service.ts';
import { addresseeForProperty } from '../requests/addressee.ts';
import { houseFeed } from '../house/service.ts';
import { createDraft } from './drafts.ts';
import { requestPayload, type IntentContext, type Reply } from './intents.ts';
import { CATEGORIES } from './prompt.ts';

/**
 * Путь жалобы: уточнение → проверка на повтор → черновик.
 *
 * Заявку бот не создаёт. Он кладёт черновик и шлёт кнопку, которая
 * открывает форму жалобы заполненной; отправляет житель. Жалоба не ждёт
 * подтверждения квартиры — черновик кладётся и на ожидающую.
 */

/** Текст кнопки «Всё равно оформить новое» — её нажатие приходит сообщением. */
export const NEW_ANYWAY = 'Всё равно оформить новое';
/** Кнопка после сбоя разбора: оформить словами самого человека. */
export const AS_IS = 'Оформить как есть';

const DAY = 24 * 3600 * 1000;

export interface ComplaintDraft {
  category: string;
  text: string;
}

export function normaliseComplaint(args: Record<string, unknown>, original: string): ComplaintDraft {
  const category = CATEGORIES.includes(args.category as never) ? String(args.category) : 'Другое';
  const text = typeof args.text === 'string' && args.text.trim().length >= 5 ? args.text.trim() : original.trim();
  return { category, text: text.slice(0, 2000) };
}

/**
 * Слова жалобы, которые ничего не говорят о её ТЕМЕ: просьбы, сроки,
 * место («подъезд», «квартира»), «не работает», «сломан». По ним две
 * разные беды казались одной. Основы — первые пять букв (см. `stems`).
 */
const GENERIC = new Set([
  'прошу', 'проси', 'сообщ', 'причи', 'срок', 'восст', 'орган', 'устра', 'почин', 'сдела', 'помог',
  'прове', 'решит', 'работ', 'слома', 'подъе', 'кварт', 'доме', 'дома', 'дому', 'нашем', 'наш',
  'дней', 'день', 'дня', 'недел', 'месяц', 'трети', 'второ', 'сегод', 'вчера', 'завтр', 'давно',
  'опять', 'снова', 'очень', 'никто', 'также', 'когда', 'почем', 'пожал', 'уже', 'есть', 'около',
]);

/** Основы значимых слов: без «ё», от четырёх букв, первые пять букв */
function stems(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/ё/g, 'е')
    .split(/[^а-яa-z0-9]+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.slice(0, 5))
    .filter((s) => !GENERIC.has(s)));
}

/**
 * Про одно ли это: общая значимая основа — «мусор», «лифт», «горяч».
 * Грубо, но без модели и без токенов: ошибка здесь стоит одного
 * лишнего вопроса, а не потерянной жалобы — кнопка «Всё равно
 * оформить новое» остаётся.
 */
export function sameTopic(a: string, b: string): boolean {
  const left = stems(a);
  for (const s of stems(b)) if (left.has(s)) return true;
  return false;
}

/**
 * Открытая заявка про ТО ЖЕ САМОЕ за 30 дней — вместо второй такой же.
 *
 * Раньше хватало совпадения категории, и на «не вывозят мусор» бот
 * предлагал открытую заявку про сломанную дверь: обе — «Общее
 * имущество» (владелец 28.09). Теперь нужна и общая тема (`sameTopic`).
 */
export async function findDuplicate(ctx: IntentContext, draft: ComplaintDraft) {
  const since = ctx.now.getTime() - 30 * DAY;
  const all = await listForUser(ctx.db, ctx.userId, ctx.propertyId);
  return all.find((r) => !r.closed && r.category === draft.category
    && new Date(r.createdAt).getTime() >= since
    && sameTopic(draft.text, `${r.title ?? ''} ${r.description ?? ''}`)) ?? null;
}

export async function duplicateReply(ctx: IntentContext, dup: { id: string; number: number; createdAt: Date; statusLabel: string; title: string }): Promise<Reply> {
  const number = String(dup.number).padStart(5, '0');
  const date = new Date(dup.createdAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
  return {
    text: `У вас уже есть обращение № ${number} от ${date}: «${dup.title}». Статус: ${dup.statusLabel.toLowerCase()}.`,
    buttons: [
      [ctx.app(`Открыть № ${number}`, requestPayload(dup.id))],
      [{ type: 'message', text: NEW_ANYWAY }],
    ],
  };
}

/** Объявление об отключении за 14 дней: возможно, человек его просто пропустил. */
async function outageHint(db: Database, ctx: IntentContext): Promise<string | null> {
  if (ctx.level !== 'full') return null;
  const since = ctx.now.getTime() - 14 * DAY;
  const post = (await houseFeed(db, ctx.userId, 'outage'))
    .find((p) => p.publishedAt && new Date(p.publishedAt).getTime() >= since);
  if (!post?.publishedAt) return null;
  const date = new Date(post.publishedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' });
  return `Кстати, ${date} в ленте дома было объявление: «${post.title}». Обращение подать можно всё равно.`;
}

export async function draftReply(ctx: IntentContext, draft: ComplaintDraft): Promise<Reply> {
  const id = await createDraft(ctx.db, { userId: ctx.userId, propertyId: ctx.propertyId, ...draft });
  const who = await addresseeForProperty(ctx.db, ctx.propertyId);
  const to = who.kind === 'org' ? ` в ${who.name}` : who.kind === 'chairman' ? ' председателю совета дома' : '';
  const hint = await outageHint(ctx.db, ctx);

  return {
    text: [
      `Подготовил обращение${to}:`,
      '',
      draft.category,
      `«${draft.text}»`,
      '',
      'Проверьте и отправьте — текст можно поправить. Само оно не отправится.',
      ...(hint ? ['', hint] : []),
    ].join('\n'),
    buttons: [[ctx.app('Подтвердить заявку', `d_${id.replace(/^bdr_/, '')}`)]],
  };
}
