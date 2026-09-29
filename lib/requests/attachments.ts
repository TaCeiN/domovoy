import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { requestPhoto, request } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { MAX_FILE_BYTES, detectType, uploadsRoot } from '../files/storage.ts';
import type { Database } from '../../db/client.ts';

/**
 * Вложения к обращению: фотография протечки, скан акта, предписание.
 *
 * ПОЧЕМУ ЭТО ХРАНИЛИЩЕ, А НЕ ССЫЛКА. Приём `photoUrls` от клиента убрали
 * в аудит 25 августа: без своего места для файлов это был способ
 * подсунуть диспетчеру ссылку на что угодно — от чужой картинки
 * до страницы, считающей его переходы. Теперь файл лежит у нас, а наружу
 * уходит маршрут с проверкой доступа, а не адрес файла.
 *
 * ГРАНИЦЫ, КОТОРЫЕ ДЕРЖАТ ЭТО МЕСТО ОТ ПРЕВРАЩЕНИЯ В ПОМОЙКУ:
 *   — только изображения и PDF, тип проверяем по СОДЕРЖИМОМУ, а не по
 *     имени и не по заголовку от клиента;
 *   — не больше 10 МБ на файл и 5 файлов на обращение;
 *   — имя на диске своё, из идентификатора: присланное имя человека
 *     не попадает в путь и не может из него выйти.
 */

export const MAX_FILES_PER_REQUEST = 5;

/**
 * Потолок размера, определение типа по содержимому и корень хранилища
 * переехали в `lib/files/storage.ts`: те же правила нужны фотографиям
 * объявлений, а двух копий правила безопасности быть не должно.
 *
 * Реэкспортируем то, что импортируют маршруты обращений, — чтобы
 * переезд не потянул за собой правку каждого места вызова.
 */
export { MAX_FILE_BYTES, detectType, uploadsRoot };

export type SaveProblem = 'too_large' | 'bad_type' | 'too_many' | 'not_found';

export type SaveResult =
  | { ok: true; id: string; mime: string; sizeBytes: number; originalName: string }
  | { ok: false; reason: SaveProblem };

export const ATTACH_CODES: Record<SaveProblem, number> = {
  too_large: 413,
  bad_type: 415,
  too_many: 409,
  not_found: 404,
};

export const ATTACH_MESSAGES: Record<SaveProblem, string> = {
  too_large: 'Файл больше 10 МБ. Сфотографируйте ещё раз или пришлите поменьше',
  bad_type: 'Можно приложить фотографию или PDF — другие файлы мы не принимаем',
  too_many: 'К одному обращению можно приложить не больше пяти файлов',
  not_found: 'Обращение не найдено',
};

/** Сохранить вложение. Права проверяет маршрут — сюда приходит уже своё. */
export async function saveAttachment(
  db: Database,
  input: {
    requestId: string;
    bytes: Buffer;
    originalName?: string;
    userId?: string;
    dispatcherId?: string;
  },
): Promise<SaveResult> {
  if (input.bytes.length > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };

  const type = detectType(input.bytes);
  if (!type) return { ok: false, reason: 'bad_type' };

  const [found] = await db
    .select({ id: request.id })
    .from(request)
    .where(eq(request.id, input.requestId))
    .limit(1);
  if (!found) return { ok: false, reason: 'not_found' };

  const already = await db
    .select({ id: requestPhoto.id })
    .from(requestPhoto)
    .where(eq(requestPhoto.requestId, input.requestId));
  if (already.length >= MAX_FILES_PER_REQUEST) return { ok: false, reason: 'too_many' };

  const id = newId('pht');
  const storedName = `${id}.${type.ext}`;
  const dir = join(uploadsRoot(), input.requestId);

  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, storedName), input.bytes);

  /**
   * Имя от человека сохраняем только как ПОДПИСЬ и обрезаем: в путь
   * оно не попадает, поэтому «../../etc/passwd» здесь безвреден, но
   * показывать такое в интерфейсе всё равно незачем.
   */
  const originalName = (input.originalName ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .slice(0, 120)
    .trim() || `Файл.${type.ext}`;

  await db.insert(requestPhoto).values({
    id,
    requestId: input.requestId,
    // Колонка осталась от прежней схемы со ссылками: наружу отдаём маршрут
    url: `/api/requests/${input.requestId}/files/${id}`,
    storedName,
    originalName,
    mime: type.mime,
    sizeBytes: input.bytes.length,
    uploadedBy: input.userId ?? null,
    uploadedByDispatcher: input.dispatcherId ?? null,
  });

  return {
    ok: true, id, mime: type.mime, sizeBytes: input.bytes.length, originalName,
  };
}

/** Список вложений обращения — то, что показывают обе стороны. */
export async function listAttachments(db: Database, requestId: string) {
  const rows = await db
    .select()
    .from(requestPhoto)
    .where(eq(requestPhoto.requestId, requestId))
    .orderBy(requestPhoto.createdAt);

  return rows.map((r) => ({
    id: r.id,
    name: r.originalName ?? 'Файл',
    mime: r.mime ?? 'application/octet-stream',
    sizeBytes: r.sizeBytes ?? 0,
    byDispatcher: Boolean(r.uploadedByDispatcher),
    at: r.createdAt,
    url: `/api/requests/${requestId}/files/${r.id}`,
  }));
}

/** Прочитать файл с диска. Доступ проверяет маршрут. */
export async function readAttachment(
  db: Database,
  requestId: string,
  attachmentId: string,
): Promise<{ bytes: Buffer; mime: string; name: string } | null> {
  const [row] = await db
    .select()
    .from(requestPhoto)
    .where(and(eq(requestPhoto.id, attachmentId), eq(requestPhoto.requestId, requestId)))
    .limit(1);

  if (!row?.storedName) return null;

  const path = join(uploadsRoot(), requestId, row.storedName);
  try {
    await stat(path);
  } catch {
    return null;
  }

  return {
    bytes: await readFile(path),
    mime: row.mime ?? 'application/octet-stream',
    name: row.originalName ?? row.storedName,
  };
}
