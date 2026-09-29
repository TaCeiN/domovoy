import { and, desc, eq } from 'drizzle-orm';
import { house, houseFavorite } from '../../db/schema.ts';
import { ratingsFor } from './reviews.ts';
import type { Database } from '../../db/client.ts';

/**
 * «Мои дома» в подборе.
 *
 * Существование дома проверяет маршрут: ссылка на несуществующий дом
 * упала бы на внешнем ключе с «внутренней ошибкой».
 */

export async function setFavorite(db: Database, userId: string, houseKey: string, on: boolean): Promise<void> {
  if (on) {
    await db.insert(houseFavorite).values({ userId, houseKey }).onConflictDoNothing();
  } else {
    await db.delete(houseFavorite).where(and(eq(houseFavorite.userId, userId), eq(houseFavorite.houseKey, houseKey)));
  }
}

export async function isFavorite(db: Database, userId: string | null, houseKey: string): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db.select({ houseKey: houseFavorite.houseKey }).from(houseFavorite)
    .where(and(eq(houseFavorite.userId, userId), eq(houseFavorite.houseKey, houseKey)))
    .limit(1);
  return Boolean(row);
}

export async function listFavorites(db: Database, userId: string) {
  const rows = await db
    .select({ houseKey: houseFavorite.houseKey, address: house.addressRaw })
    .from(houseFavorite)
    .innerJoin(house, eq(house.houseKey, houseFavorite.houseKey))
    .where(eq(houseFavorite.userId, userId))
    .orderBy(desc(houseFavorite.createdAt));
  const ratings = await ratingsFor(db, rows.map((r) => r.houseKey));
  return rows.map((r) => ({
    houseKey: r.houseKey,
    address: r.address ?? '',
    rating: ratings.get(r.houseKey)?.rating ?? null,
    reviews: ratings.get(r.houseKey)?.count ?? 0,
  }));
}
