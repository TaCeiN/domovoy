import { and, eq, inArray } from 'drizzle-orm';
import { postRead } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import type { Database } from '../../db/client.ts';

/**
 * Отметки «объявление прочитано».
 *
 * Прочитанным считается открытая КАРТОЧКА, а не показанная строка списка:
 * человек, пролиставший ленту, ничего не прочитал, и объявлять за него
 * обратное — та же ложь, что и «оплачено» вместо «отмечено вами».
 */

/**
 * Какие из этих объявлений человек уже открывал.
 *
 * Одним запросом на весь список: спрашивать по строке значило бы полсотни
 * запросов на открытие ленты.
 */
export async function readPostIds(
  db: Database,
  userId: string,
  postIds: string[],
): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();

  const rows = await db
    .select({ postId: postRead.postId })
    .from(postRead)
    .where(and(eq(postRead.userId, userId), inArray(postRead.postId, postIds)));

  return new Set(rows.map((r) => r.postId));
}

/**
 * Отметить прочитанным.
 *
 * `onConflictDoNothing` обязателен, а не «на всякий случай». Гонка
 * «сначала SELECT, потом INSERT» встречалась в проекте четырежды: два
 * одновременных открытия не находят строки и вставляют её оба, второго
 * не пускает уникальный индекс, и наружу это выходит ошибкой сервера
 * на ровном месте.
 */
export async function markPostRead(
  db: Database,
  userId: string,
  postId: string,
): Promise<void> {
  await db
    .insert(postRead)
    .values({ id: newId('prd'), postId, userId })
    .onConflictDoNothing();
}
