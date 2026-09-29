import { and, eq, gte, sql } from 'drizzle-orm';
import { bill, property, request, requestEvent } from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';

/**
 * Сводки из своих данных для карточки дома.
 *
 * КОРОТКО, БЕЗ ЦИФР. Посторонний видит две строки: как быстро УК
 * отвечает и на что чаще жалуются. Ни числа обращений, ни текстов,
 * ни квартир. Ниже порогов не показывается ничего: при двух квартирах
 * с квитанциями «средний платёж» — это платёж соседа.
 */

export type ResponseSpeed = 'day' | 'days' | 'slow';

export const MIN_COMPLAINTS = 5;
export const MIN_FLATS = 3;
export const TOP_SHARE = 0.3;
const YEAR_MS = 365 * 24 * 3_600_000;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function responseSpeed(hours: number[]): ResponseSpeed | null {
  const m = median(hours);
  if (m === null) return null;
  return m <= 24 ? 'day' : m <= 72 ? 'days' : 'slow';
}

export function topCategory(categories: string[]): string | null {
  const counts = new Map<string, number>();
  for (const c of categories) if (c !== 'Другое') counts.set(c, (counts.get(c) ?? 0) + 1);
  let best: string | null = null;
  let most = 0;
  for (const [c, n] of counts) if (n > most) { best = c; most = n; }
  return best && most / categories.length >= TOP_SHARE ? best : null;
}

export interface BillRow { propertyId: string; period: string; sumKopecks: number }

/** Рубли в месяц за квартиру, округлённые до сотни; `null` ниже порога */
export function monthlyPayment(bills: BillRow[]): number | null {
  const byFlat = new Map<string, Map<string, number>>();
  for (const b of bills) {
    const periods = byFlat.get(b.propertyId) ?? new Map<string, number>();
    periods.set(b.period, (periods.get(b.period) ?? 0) + b.sumKopecks);
    byFlat.set(b.propertyId, periods);
  }
  if (byFlat.size < MIN_FLATS) return null;

  const perFlat = [...byFlat.values()].map((periods) => {
    const sums = [...periods.values()];
    return sums.reduce((s, v) => s + v, 0) / sums.length;
  });
  return Math.round(median(perFlat)! / 100 / 100) * 100;
}

export interface ComplaintSummary { enough: boolean; speed: ResponseSpeed | null; topCategory: string | null }

export async function complaintSummary(db: Database, houseKey: string, now = new Date()): Promise<ComplaintSummary> {
  const firstAnswer = db
    .select({
      requestId: requestEvent.requestId,
      at: sql<string>`min(${requestEvent.createdAt})`.as('at'),
    })
    .from(requestEvent)
    .where(eq(requestEvent.actor, 'dispatcher'))
    .groupBy(requestEvent.requestId)
    .as('first_answer');

  const rows = await db
    .select({ category: request.category, createdAt: request.createdAt, answeredAt: firstAnswer.at })
    .from(request)
    .innerJoin(property, eq(property.id, request.propertyId))
    .leftJoin(firstAnswer, eq(firstAnswer.requestId, request.id))
    .where(and(
      eq(property.houseKey, houseKey),
      eq(request.kind, 'complaint'),
      gte(request.createdAt, new Date(now.getTime() - YEAR_MS)),
    ));

  if (rows.length < MIN_COMPLAINTS) return { enough: false, speed: null, topCategory: null };

  const hours = rows
    .filter((r) => r.answeredAt)
    .map((r) => (new Date(r.answeredAt!).getTime() - r.createdAt.getTime()) / 3_600_000);
  return { enough: true, speed: responseSpeed(hours), topCategory: topCategory(rows.map((r) => r.category)) };
}

export async function paymentSummary(db: Database, houseKey: string, now = new Date()): Promise<number | null> {
  const from = new Date(now);
  from.setMonth(from.getMonth() - 12);
  const cutoff = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;

  const rows = await db
    .select({ propertyId: bill.propertyId, period: bill.period, sumKopecks: bill.sumKopecks })
    .from(bill)
    .innerJoin(property, eq(property.id, bill.propertyId))
    .where(and(eq(property.houseKey, houseKey), gte(bill.period, cutoff)));
  return monthlyPayment(rows);
}
