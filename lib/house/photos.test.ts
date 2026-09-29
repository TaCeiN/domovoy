import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';
import { post, postPhoto } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { uploadsRoot } from '../files/storage.ts';
import { savePostPhoto, readPostPhoto, removePostPhoto, postsWithPhoto } from './photos.ts';

/**
 * Фотография объявления.
 *
 * Главное, что здесь проверяется, — не «файл сохранился», а две границы,
 * которые легко потерять при правке: тип определяется по содержимому,
 * и фотография на объявление ровно одна.
 */

const HOUSE = 'ростовская обл|ростов-на-дону|ленина пр-кт|85к3';

/** Настоящий однопиксельный PNG: сигнатура важна, тип берём из байтов */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 3)]);

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

async function makePost(): Promise<string> {
  const id = newId('pst');
  await testDb().insert(post).values({
    id,
    houseKey: HOUSE,
    type: 'resident',
    category: 'market',
    title: 'Отдам детский велосипед',
    body: 'Стоял в подъезде, колёса целы',
  });
  return id;
}

test('PDF под видом фотографии не принимается', async () => {
  const id = await makePost();

  const result = await savePostPhoto(testDb(), { postId: id, bytes: PDF });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, 'bad_type',
    'тип берётся из содержимого: имя файла и Content-Type приходят из того же запроса');

  const rows = await testDb().select().from(postPhoto).where(eq(postPhoto.postId, id));
  assert.equal(rows.length, 0, 'отвергнутый файл не оставляет строки в базе');
});

test('вторая фотография заменяет первую, а не добавляется', async () => {
  const id = await makePost();

  const first = await savePostPhoto(testDb(), { postId: id, bytes: PNG });
  assert.equal(first.ok, true);
  const firstName = (await testDb().select().from(postPhoto)
    .where(eq(postPhoto.postId, id)))[0].storedName;

  const second = await savePostPhoto(testDb(), { postId: id, bytes: JPEG });
  assert.equal(second.ok, true);

  const rows = await testDb().select().from(postPhoto).where(eq(postPhoto.postId, id));
  assert.equal(rows.length, 1, 'фотография на объявление ровно одна');
  assert.equal(rows[0].mime, 'image/jpeg', 'осталась последняя');

  // Прежний файл убран с диска, а не брошен в томе
  await assert.rejects(
    () => readFile(join(uploadsRoot(), 'posts', id, firstName)),
    'старый файл обязан исчезнуть — иначе «переснять фото» копит мусор',
  );
});

test('фотографии нет — чтение отвечает пустотой, а не падает', async () => {
  const id = await makePost();
  assert.equal(await readPostPhoto(testDb(), id), null);
  assert.equal(await removePostPhoto(testDb(), id), false);
});

test('снятая фотография исчезает, объявление остаётся', async () => {
  const id = await makePost();
  await savePostPhoto(testDb(), { postId: id, bytes: PNG });

  assert.equal(await removePostPhoto(testDb(), id), true);
  assert.equal(await readPostPhoto(testDb(), id), null);

  const posts = await testDb().select().from(post).where(eq(post.id, id));
  assert.equal(posts.length, 1, 'объявление не удаляется вместе с фотографией');
});

test('список знает, у каких объявлений есть фотография', async () => {
  const withPhoto = await makePost();
  const without = await makePost();
  await savePostPhoto(testDb(), { postId: withPhoto, bytes: PNG });

  const found = await postsWithPhoto(testDb(), [withPhoto, without]);

  assert.equal(found.has(withPhoto), true);
  assert.equal(found.has(without), false);
});

/**
 * Срок актуальности в сообщении бота.
 *
 * Ради него срок и вводят: «нет воды до 18:00» — главное, что нужно
 * знать человеку, а раньше он был вынужден открывать мини-приложение.
 */
test('срок актуальности приписывается к сообщению словами', async () => {
  const { expiryLine } = await import('./service.ts');

  const thisYear = new Date();
  thisYear.setMonth(8, 15);
  thisYear.setHours(18, 30, 0, 0);
  assert.equal(expiryLine(thisYear), 'Актуально до 15 сентября, 18:30');

  // Другой год пишем с годом — как и на экранах
  const nextYear = new Date(thisYear);
  nextYear.setFullYear(thisYear.getFullYear() + 1);
  assert.match(expiryLine(nextYear), /^Актуально до 15 сентября \d{4}, 18:30$/);

  // Без срока строки нет: у новости и собрания его не ставят
  assert.equal(expiryLine(null), '');
  assert.equal(expiryLine(undefined), '');
});
