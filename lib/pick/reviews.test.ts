import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { admin, houseReview } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { parseAddress } from '../address/normalize.ts';
import {
  validateReview, canReview, saveReview, houseReviews, ratingsFor, hideReview, type ReviewInput,
} from './reviews.ts';
import { resident } from './fixtures.ts';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы';
after(async () => { await closeTestDb(); });
beforeEach(async () => { if (available) await resetTables(); });

const A = 'обл Ростовская, г Аксай, ул Мира, д. 1';
const B = 'обл Ростовская, г Аксай, ул Мира, д. 3';
const KEY_A = parseAddress(A).houseKey;
const KEY_B = parseAddress(B).houseKey;

const five = (n: number, over: Partial<ReviewInput['stars']> = {}): ReviewInput => ({
  stars: { uk: n, clean: n, neighbors: n, quiet: n, yard: n, ...over }, pros: null, cons: null,
});

test('проверка отзыва: пять оценок от 1 до 5, тексты необязательны и не длиннее 1000', () => {
  const ok = validateReview({ stars: { uk: 5, clean: 4, neighbors: 3, quiet: 2, yard: 1 }, pros: '  тихо  ', cons: '' });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.value.pros, 'тихо');
    assert.equal(ok.value.cons, null);
  }
  assert.equal(validateReview({ stars: { uk: 5, clean: 4, neighbors: 3, quiet: 2 } }).ok, false, 'нет двора');
  assert.equal(validateReview({ stars: { uk: 6, clean: 4, neighbors: 3, quiet: 2, yard: 1 } }).ok, false);
  assert.equal(validateReview({ stars: { uk: 5, clean: 4, neighbors: 3, quiet: 2, yard: 1 }, pros: 'x'.repeat(1001) }).ok, false);
});

test('писать может только подтверждённый житель этого дома', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY_A, addressRaw: A, garFlats: 60 });
  await insertRegistryHouse(db, { houseKey: KEY_B, addressRaw: B, garFlats: 60 });
  const active = await resident(db, KEY_A);
  const pending = await resident(db, KEY_A, { status: 'pending' });
  assert.equal(await canReview(db, active.userId, KEY_A), true);
  assert.equal(await canReview(db, active.userId, KEY_B), false, 'чужой дом');
  assert.equal(await canReview(db, pending.userId, KEY_A), false, 'квитанция — заявка, а не пропуск');
});

test('отзыв один на человека: повторное сохранение правит, а не множит', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY_A, addressRaw: A, garFlats: 60 });
  const me = await resident(db, KEY_A);
  await saveReview(db, me.userId, KEY_A, five(2));
  await saveReview(db, me.userId, KEY_A, { ...five(4), pros: 'двор' });

  const rows = await db.select().from(houseReview);
  assert.equal(rows.length, 1);
  const { reviews, summary } = await houseReviews(db, KEY_A, null);
  assert.equal(reviews[0].pros, 'двор');
  assert.equal(reviews[0].overall, 4);
  assert.equal(reviews[0].mine, false, 'посторонний — не автор');
  assert.equal(summary.rating, 4);
  assert.equal(summary.count, 1);
  assert.equal('userId' in reviews[0], false, 'кто автор — наружу не уходит');
});

test('оценка дома — среднее отзывов; скрытый не входит и виден только автору', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY_A, addressRaw: A, garFlats: 60 });
  const one = await resident(db, KEY_A);
  const two = await resident(db, KEY_A);
  await saveReview(db, one.userId, KEY_A, five(5));
  await saveReview(db, two.userId, KEY_A, five(1, { uk: 2 }));

  const adminId = newId('adm');
  await db.insert(admin).values({ id: adminId, login: 'op', passwordHash: 'x', name: 'Оператор' });
  const [bad] = await db.select().from(houseReview).where(eq(houseReview.userId, two.userId));
  assert.deepEqual(await hideReview(db, bad.id, adminId, 'персональные данные соседа'), { houseKey: KEY_A });
  assert.equal(await hideReview(db, bad.id, adminId, 'ещё раз'), null, 'второй раз скрыть нечего');

  const outside = await houseReviews(db, KEY_A, null);
  assert.equal(outside.reviews.length, 1);
  assert.equal(outside.summary.rating, 5);

  const author = await houseReviews(db, KEY_A, two.userId);
  const mine = author.reviews.find((r) => r.mine);
  assert.equal(mine?.hiddenReason, 'персональные данные соседа');
  assert.equal(author.summary.count, 1, 'автору оценка дома та же, что всем');

  const ratings = await ratingsFor(db, [KEY_A, KEY_B]);
  assert.deepEqual(ratings.get(KEY_A), { rating: 5, count: 1 });
  assert.equal(ratings.has(KEY_B), false);
});
