import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../../test-db.ts';
import { mockComplex, mockComplexPhoto } from '../../../db/schema.ts';
import { loadMock, clearMock } from './load.ts';
import { SAMPLE } from './fixtures.ts';
import type { MockFile } from './format.ts';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await closeTestDb(); });

const file = (slugs: string[]): MockFile => ({
  ...structuredClone(SAMPLE),
  complexes: slugs.map((slug) => ({ ...structuredClone(SAMPLE.complexes[0]), slug })),
});

test('загрузка заменяет содержимое целиком', { skip }, async () => {
  assert.equal(await loadMock(testDb(), file(['a', 'b'])), 2);
  assert.equal(await loadMock(testDb(), file(['c'])), 1);
  const rows = await testDb().select({ slug: mockComplex.slug }).from(mockComplex);
  assert.deepEqual(rows.map((r) => r.slug), ['c']);
});

test('очистка оставляет таблицу пустой', { skip }, async () => {
  await loadMock(testDb(), file(['a']));
  await clearMock(testDb());
  assert.equal((await testDb().select().from(mockComplex)).length, 0);
});

test('фото ЖК заливаются вместе с ЖК и уходят при очистке', { skip }, async () => {
  const f = file(['a', 'b']);
  f.complexes[0].photo = { file: 'a.webp', credit: '© Застройщик А', sourceUrl: 'https://example.ru/a' };
  await loadMock(testDb(), f, new Map([['a', { bytes: Buffer.from([1, 2, 3]), mime: 'image/webp' }]]));
  const rows = await testDb().select().from(mockComplexPhoto);
  assert.deepEqual(rows.map((r) => [r.slug, r.mime, r.credit, [...r.bytes]]), [['a', 'image/webp', '© Застройщик А', [1, 2, 3]]]);

  // Повторная загрузка без фото — старые фото не остаются висеть
  await loadMock(testDb(), file(['a']));
  assert.equal((await testDb().select().from(mockComplexPhoto)).length, 0);

  await loadMock(testDb(), f, new Map([['a', { bytes: Buffer.from([1]), mime: 'image/webp' }]]));
  await clearMock(testDb());
  assert.equal((await testDb().select().from(mockComplexPhoto)).length, 0);
});
