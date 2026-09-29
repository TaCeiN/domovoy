import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { houseReview, property, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import type { Database } from '../../db/client.ts';

/**
 * Отзывы жителей о доме.
 *
 * ПИШЕТ ТОЛЬКО ПОДТВЕРЖДЁННЫЙ ЖИТЕЛЬ ЭТОГО ДОМА. Поддельную квитанцию
 * не отличить от настоящей (см. lib/auth/access.ts), поэтому отзыв требует
 * уровня `full`, как лента и соседи. Иначе отзывы накручиваются фотографией
 * чужой квитанции.
 *
 * АВТОР НАРУЖУ НЕ УХОДИТ. Ни имени, ни квартиры, ни идентификатора:
 * «Житель дома, подтверждён». Соседи узнают друг друга по мелочам,
 * и честный отзыв о соседе не должен стоить ссоры.
 */

export const ASPECTS = ['uk', 'clean', 'neighbors', 'quiet', 'yard'] as const;
export type Aspect = (typeof ASPECTS)[number];
export type Stars = Record<Aspect, number>;

export const REVIEW_TEXT_MAX = 1000;

export interface ReviewInput { stars: Stars; pros: string | null; cons: string | null }

export function validateReview(body: unknown): { ok: true; value: ReviewInput } | { ok: false; message: string } {
  const b = (body ?? {}) as { stars?: Record<string, unknown>; pros?: unknown; cons?: unknown };
  const stars = {} as Stars;
  for (const aspect of ASPECTS) {
    const value = Number(b.stars?.[aspect]);
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      return { ok: false, message: 'Поставьте от 1 до 5 звёзд в каждой строке' };
    }
    stars[aspect] = value;
  }
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const pros = text(b.pros);
  const cons = text(b.cons);
  if ((pros?.length ?? 0) > REVIEW_TEXT_MAX || (cons?.length ?? 0) > REVIEW_TEXT_MAX) {
    return { ok: false, message: `Не больше ${REVIEW_TEXT_MAX} знаков в каждом поле` };
  }
  return { ok: true, value: { stars, pros, cons } };
}

export const round1 = (n: number) => Math.round(n * 10) / 10;

const meanOf = (stars: Stars) => ASPECTS.reduce((s, a) => s + stars[a], 0) / ASPECTS.length;

type Row = typeof houseReview.$inferSelect;
const starsOf = (r: Row): Stars => ({
  uk: r.starsUk, clean: r.starsClean, neighbors: r.starsNeighbors, quiet: r.starsQuiet, yard: r.starsYard,
});

export async function canReview(db: Database, userId: string, houseKey: string): Promise<boolean> {
  const [row] = await db
    .select({ id: userProperty.id })
    .from(userProperty)
    .innerJoin(property, eq(property.id, userProperty.propertyId))
    .where(and(eq(userProperty.userId, userId), eq(userProperty.status, 'active'), eq(property.houseKey, houseKey)))
    .limit(1);
  return Boolean(row);
}

/** Создать или поправить свой отзыв. Отзыв, скрытый оператором, остаётся скрытым. */
export async function saveReview(db: Database, userId: string, houseKey: string, input: ReviewInput): Promise<void> {
  const columns = {
    starsUk: input.stars.uk,
    starsClean: input.stars.clean,
    starsNeighbors: input.stars.neighbors,
    starsQuiet: input.stars.quiet,
    starsYard: input.stars.yard,
    pros: input.pros,
    cons: input.cons,
    updatedAt: new Date(),
  };
  await db.insert(houseReview)
    .values({ id: newId('rev'), houseKey, userId, ...columns })
    .onConflictDoUpdate({ target: [houseReview.houseKey, houseReview.userId], set: columns });
}

export interface PublicReview {
  id: string;
  stars: Stars;
  overall: number;
  pros: string | null;
  cons: string | null;
  createdAt: Date;
  updatedAt: Date;
  mine: boolean;
  /** Только автору: почему оператор скрыл отзыв */
  hiddenReason: string | null;
}

export interface RatingSummary { rating: number | null; count: number; aspects: Record<Aspect, number | null> }

export function summarize(list: Stars[]): RatingSummary {
  const aspects = {} as Record<Aspect, number | null>;
  for (const a of ASPECTS) aspects[a] = list.length ? round1(list.reduce((s, x) => s + x[a], 0) / list.length) : null;
  const rating = list.length ? round1(list.reduce((s, x) => s + meanOf(x), 0) / list.length) : null;
  return { rating, count: list.length, aspects };
}

export async function houseReviews(
  db: Database,
  houseKey: string,
  viewerId: string | null,
): Promise<{ reviews: PublicReview[]; summary: RatingSummary }> {
  const rows = await db.select().from(houseReview)
    .where(eq(houseReview.houseKey, houseKey))
    .orderBy(desc(houseReview.updatedAt));

  const visible = rows.filter((r) => !r.hiddenAt || r.userId === viewerId);
  return {
    reviews: visible.map((r) => ({
      id: r.id,
      stars: starsOf(r),
      overall: round1(meanOf(starsOf(r))),
      pros: r.pros,
      cons: r.cons,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      mine: r.userId === viewerId,
      hiddenReason: r.hiddenAt ? r.hiddenReason : null,
    })),
    summary: summarize(rows.filter((r) => !r.hiddenAt).map(starsOf)),
  };
}

/** Оценка и число нескрытых отзывов по списку домов — для карты и кабинета УК */
export async function ratingsFor(db: Database, keys: string[]): Promise<Map<string, { rating: number; count: number }>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({
      houseKey: houseReview.houseKey,
      rating: sql<number>`round(avg((${houseReview.starsUk} + ${houseReview.starsClean} + ${houseReview.starsNeighbors}
        + ${houseReview.starsQuiet} + ${houseReview.starsYard}) / 5.0), 1)::float`,
      count: sql<number>`count(*)::int`,
    })
    .from(houseReview)
    .where(and(inArray(houseReview.houseKey, keys), isNull(houseReview.hiddenAt)))
    .groupBy(houseReview.houseKey);
  return new Map(rows.map((r) => [r.houseKey, { rating: Number(r.rating), count: r.count }]));
}

/** Скрыть отзыв. `null` — отзыва нет или он уже скрыт. Журнал пишет маршрут. */
export async function hideReview(
  db: Database,
  reviewId: string,
  adminId: string,
  reason: string,
): Promise<{ houseKey: string } | null> {
  const [row] = await db.update(houseReview)
    .set({ hiddenAt: new Date(), hiddenBy: adminId, hiddenReason: reason })
    .where(and(eq(houseReview.id, reviewId), isNull(houseReview.hiddenAt)))
    .returning({ houseKey: houseReview.houseKey });
  return row ?? null;
}

/** Отзывы дома для кабинета оператора — вместе со скрытыми и причинами */
export async function reviewsForAdmin(db: Database, houseKey: string) {
  const rows = await db.select().from(houseReview)
    .where(eq(houseReview.houseKey, houseKey))
    .orderBy(desc(houseReview.updatedAt));
  return rows.map((r) => ({
    id: r.id,
    overall: round1(meanOf(starsOf(r))),
    pros: r.pros,
    cons: r.cons,
    updatedAt: r.updatedAt,
    hiddenAt: r.hiddenAt,
    hiddenReason: r.hiddenReason,
  }));
}
