import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { bill, billBringer } from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';

/**
 * «Это начисление принёс он сам» — одно условие на всё приложение.
 *
 * Главная, список начислений и аналитика до подтверждения показывают
 * только принесённое самим человеком. Раньше каждое место писало условие
 * заново, и аналитика его забыла: неподтверждённый житель видел там
 * все деньги квартиры, включая чужой газ.
 *
 * Принёс — значит создал строку, ИЛИ принёс ту же квитанцию позже
 * (`bill_bringer`), ИЛИ у строки нет автора. Последнее — наследство:
 * `created_by` появилось позже самих начислений, и прятать строку,
 * которую некому приписать, значит стереть человеку его историю.
 */
export function broughtBy(userId: string) {
  return or(
    eq(bill.createdBy, userId),
    isNull(bill.createdBy),
    sql`exists (select 1 from ${billBringer}
      where ${billBringer.billId} = ${bill.id} and ${billBringer.userId} = ${userId})`,
  );
}

/** Принёс ли человек это начисление — для записи в него (отметка, QR). */
export async function isBringer(
  db: Database,
  row: { id: string; createdBy: string | null },
  userId: string,
): Promise<boolean> {
  if (row.createdBy === userId) return true;
  const found = await db
    .select({ billId: billBringer.billId })
    .from(billBringer)
    .where(and(eq(billBringer.billId, row.id), eq(billBringer.userId, userId)))
    .limit(1);
  return found.length > 0;
}

/**
 * Запомнить, что человек принёс уже записанную квитанцию.
 *
 * Только при совпадении суммы: та же сумма за тот же период и счёт —
 * та же бумага. Иная сумма — иная квитанция, и права на эту строку
 * она не даёт (переписать сумму неподтверждённый и так не может).
 */
export async function rememberBringer(
  db: Database,
  input: { accountId: string; period: string; sumKopecks: number; userId: string },
): Promise<void> {
  const [row] = await db
    .select({ id: bill.id, createdBy: bill.createdBy, sumKopecks: bill.sumKopecks })
    .from(bill)
    .where(and(eq(bill.accountId, input.accountId), eq(bill.period, input.period)))
    .limit(1);

  if (!row || row.createdBy === input.userId || row.sumKopecks !== input.sumKopecks) return;

  await db
    .insert(billBringer)
    .values({ billId: row.id, userId: input.userId })
    .onConflictDoNothing();
}
