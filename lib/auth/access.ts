import { and, eq } from 'drizzle-orm';
import { userProperty } from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';

/**
 * Что человеку открыто по этой квартире.
 *
 * ЗАЧЕМ ТРИ УРОВНЯ, А НЕ ДВА. Раньше проверка была одна и та же везде:
 * `status === 'active'`. Значит до подтверждения председателем человек
 * не мог вообще ничего — включая то, ради чего продукт существует:
 *
 *   «Всё общение жителя с УК сводится к тому, чтобы у жителя было
 *    доказательство того, что он на что-то пожаловался, а потом это
 *    проигнорировали, и чтобы это осталось в архиве диспетчерской,
 *    из которого он удалить не может».
 *
 * Если ядро ждёт чужого одобрения — продукта нет. Особенно когда
 * подтверждающий это председатель, которого у дома может не быть.
 *
 * Отсюда разделение по признаку «чьи это данные»:
 *
 *   'self' — только его собственное: свои квитанции, свои счётчики,
 *            своя аналитика и ЖАЛОБА В УК. Подделанная квитанция даёт
 *            доступ к тому, что человек и так держит в руках.
 *
 *   'full' — всё, что про ДРУГИХ людей: соседи, лента дома, опросы,
 *            состав жильцов. Здесь чужие данные, и здесь нужен живой
 *            человек, который подтвердит.
 */
export type AccessLevel = 'none' | 'self' | 'full';

export async function accessLevel(
  db: Database,
  userId: string,
  propertyId: string,
): Promise<AccessLevel> {
  const rows = await db
    .select({ status: userProperty.status })
    .from(userProperty)
    .where(and(
      eq(userProperty.userId, userId),
      eq(userProperty.propertyId, propertyId),
    ))
    .limit(1);

  const status = rows[0]?.status;
  if (status === 'active') return 'full';
  if (status === 'pending') return 'self';
  return 'none';
}

/** Свои данные: квитанции, счётчики, аналитика, жалоба в УК. */
export async function canSeeOwn(
  db: Database,
  userId: string,
  propertyId: string,
): Promise<boolean> {
  return (await accessLevel(db, userId, propertyId)) !== 'none';
}

/** Данные о доме и соседях. */
export async function canSeeHouse(
  db: Database,
  userId: string,
  propertyId: string,
): Promise<boolean> {
  return (await accessLevel(db, userId, propertyId)) === 'full';
}

/**
 * Объекты, по которым человеку открыто хотя бы своё.
 *
 * Нужен выборкам, которые собирают данные сразу по всем квартирам
 * человека: заявки, начисления.
 */
export async function propertyIdsFor(
  db: Database,
  userId: string,
  level: 'self' | 'full',
): Promise<string[]> {
  const rows = await db
    .select({ propertyId: userProperty.propertyId, status: userProperty.status })
    .from(userProperty)
    .where(eq(userProperty.userId, userId));

  return rows
    .filter((r) => (level === 'full' ? r.status === 'active' : r.status !== 'revoked'))
    .map((r) => r.propertyId);
}
