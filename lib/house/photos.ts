import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { postPhoto } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { MAX_FILE_BYTES, detectImage, uploadsRoot } from '../files/storage.ts';
import type { Database } from '../../db/client.ts';

/**
 * Фотография объявления: карточка товара у соседей, обложка объявления дома.
 *
 * ОДНА на объявление. Повторная загрузка ЗАМЕНЯЕТ прежнюю и стирает старый
 * файл с диска — иначе «переснять фото» означало бы копить мусор в томе.
 *
 * Только изображения: PDF на месте карточки товара не показывает ничего,
 * человек приложил бы его и решил, что приложение сломалось. Тип
 * определяем по СОДЕРЖИМОМУ — ни имени файла, ни заголовку от клиента
 * верить нельзя, они приходят из того же запроса.
 *
 * Публичных ссылок нет: наружу уходит маршрут с проверкой доступа,
 * а не путь к файлу. Права проверяет маршрут — сюда приходит уже своё.
 */

export type PhotoProblem = 'too_large' | 'bad_type';

export const PHOTO_CODES: Record<PhotoProblem, number> = {
  too_large: 413,
  bad_type: 415,
};

export const PHOTO_MESSAGES: Record<PhotoProblem, string> = {
  too_large: 'Фотография больше 10 МБ. Сфотографируйте ещё раз или пришлите поменьше',
  bad_type: 'Нужна фотография — другие файлы мы не принимаем',
};

/** Каталог объявлений отделён от вложений обращений, чтобы не столкнуться */
function dirFor(postId: string): string {
  return join(uploadsRoot(), 'posts', postId);
}

export type SavePhotoResult =
  | { ok: true; id: string; mime: string; sizeBytes: number }
  | { ok: false; reason: PhotoProblem };

export async function savePostPhoto(
  db: Database,
  input: { postId: string; bytes: Buffer; userId?: string },
): Promise<SavePhotoResult> {
  if (input.bytes.length > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };

  const type = detectImage(input.bytes);
  if (!type) return { ok: false, reason: 'bad_type' };

  const dir = dirFor(input.postId);
  const id = newId('pph');
  const storedName = `${id}.${type.ext}`;

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, storedName), input.bytes);

  /**
   * Прежнюю убираем ПОСЛЕ записи новой: упади мы на записи — у объявления
   * останется старая фотография, а не пустое место.
   */
  const [old] = await db.select().from(postPhoto).where(eq(postPhoto.postId, input.postId));
  if (old) {
    await db.delete(postPhoto).where(eq(postPhoto.postId, input.postId));
    await rm(join(dir, old.storedName), { force: true });
  }

  await db.insert(postPhoto).values({
    id,
    postId: input.postId,
    storedName,
    mime: type.mime,
    sizeBytes: input.bytes.length,
    uploadedBy: input.userId ?? null,
  });

  return { ok: true, id, mime: type.mime, sizeBytes: input.bytes.length };
}

/** Прочитать файл с диска. Доступ проверяет маршрут. */
export async function readPostPhoto(
  db: Database,
  postId: string,
): Promise<{ bytes: Buffer; mime: string } | null> {
  const [row] = await db.select().from(postPhoto).where(eq(postPhoto.postId, postId));
  if (!row) return null;

  try {
    return { bytes: await readFile(join(dirFor(postId), row.storedName)), mime: row.mime };
  } catch {
    // Строка есть, файла нет: том мог не подключиться. Молчим, а не падаем
    return null;
  }
}

/** Снять фотографию: и с диска, и из базы. Само объявление остаётся. */
export async function removePostPhoto(db: Database, postId: string): Promise<boolean> {
  const [row] = await db.select().from(postPhoto).where(eq(postPhoto.postId, postId));
  if (!row) return false;

  await db.delete(postPhoto).where(eq(postPhoto.postId, postId));
  await rm(join(dirFor(postId), row.storedName), { force: true });
  return true;
}

/**
 * У каких объявлений есть фотография.
 *
 * Одним запросом на весь список: спрашивать по строке значило бы полсотни
 * запросов на открытие ленты.
 */
export async function postsWithPhoto(db: Database, postIds: string[]): Promise<Set<string>> {
  if (postIds.length === 0) return new Set();

  const rows = await db
    .select({ postId: postPhoto.postId })
    .from(postPhoto)
    .where(inArray(postPhoto.postId, postIds));

  return new Set(rows.map((r) => r.postId));
}
