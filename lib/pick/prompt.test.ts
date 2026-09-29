import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { notification } from '../../db/schema.ts';
import { parseAddress } from '../address/normalize.ts';
import { setTransport, type Transport } from '../notify/index.ts';
import { promptVisible, reviewPrompt, dismissPrompt, sendReviewInvites } from './prompt.ts';
import { setFavorite, listFavorites, isFavorite } from './favorites.ts';
import { saveReview } from './reviews.ts';
import { resident } from './fixtures.ts';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы';
const sent: string[] = [];
const fake: Transport = { async sendToMax(_chat, text) { sent.push(text); } };
setTransport(fake);
after(async () => { setTransport(null); await closeTestDb(); });
beforeEach(async () => { sent.length = 0; if (available) await resetTables(); });

const A = 'обл Ростовская, г Аксай, ул Мира, д. 1';
const KEY = parseAddress(A).houseKey;
const DAY = 86_400_000;
const NOW = new Date('2026-09-23T12:00:00Z');

test('карточка-просьба: закрыта — вернётся через 30 дней, закрыта дважды — никогда', () => {
  assert.equal(promptVisible(undefined, NOW), true);
  assert.equal(promptVisible({ dismissedAt: new Date(NOW.getTime() - 5 * DAY), dismissCount: 1 }, NOW), false);
  assert.equal(promptVisible({ dismissedAt: new Date(NOW.getTime() - 31 * DAY), dismissCount: 1 }, NOW), true);
  assert.equal(promptVisible({ dismissedAt: new Date(NOW.getTime() - 400 * DAY), dismissCount: 2 }, NOW), false);
  assert.equal(promptVisible({ dismissedAt: null, dismissCount: 0 }, NOW), true, 'бот писал, карточку не трогали');
});

test('просьба показывается подтверждённому жителю без отзыва и пропадает после отзыва', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: A, garFlats: 60 });
  const me = await resident(db, KEY);
  const pending = await resident(db, KEY, { status: 'pending' });

  assert.deepEqual(await reviewPrompt(db, me.userId, NOW), { houseKey: KEY, address: A, reviews: 0 });
  assert.equal(await reviewPrompt(db, pending.userId, NOW), null, 'неподтверждённому писать нельзя — и просить незачем');

  await saveReview(db, me.userId, KEY, { stars: { uk: 4, clean: 4, neighbors: 4, quiet: 4, yard: 4 }, pros: null, cons: null });
  assert.equal(await reviewPrompt(db, me.userId, NOW), null);
});

test('просьба не появляется в первые дни после подтверждения', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: A, garFlats: 60 });
  const fresh = await resident(db, KEY, { decidedAt: new Date(NOW.getTime() - 1 * DAY) });
  assert.equal(await reviewPrompt(db, fresh.userId, NOW), null, 'о доме он ещё ничего не знает');
  assert.ok(await reviewPrompt(db, fresh.userId, new Date(NOW.getTime() + 3 * DAY)));
});

test('частный дом об отзыве не просит', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: A, registryForm: 'private' });
  const me = await resident(db, KEY);
  assert.equal(await reviewPrompt(db, me.userId, NOW), null);
});

test('закрытие просьбы: пауза 30 дней, после второго — навсегда', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: A, garFlats: 60 });
  const me = await resident(db, KEY);
  await dismissPrompt(db, me.userId, KEY, NOW);
  assert.equal(await reviewPrompt(db, me.userId, new Date(NOW.getTime() + 10 * DAY)), null);
  const later = new Date(NOW.getTime() + 31 * DAY);
  assert.ok(await reviewPrompt(db, me.userId, later));
  await dismissPrompt(db, me.userId, KEY, later);
  assert.equal(await reviewPrompt(db, me.userId, new Date(later.getTime() + 100 * DAY)), null);
});

test('бот просит один раз и не раньше трёх дней после подтверждения', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: A, garFlats: 60 });
  const old = await resident(db, KEY, { maxUserId: 5001, decidedAt: new Date(NOW.getTime() - 4 * DAY) });
  await resident(db, KEY, { maxUserId: 5002, decidedAt: new Date(NOW.getTime() - 1 * DAY) });

  assert.equal(await sendReviewInvites(db, NOW), 1);
  assert.equal(await sendReviewInvites(db, NOW), 0, 'второй раз не пишем');

  const rows = await db.select().from(notification).where(eq(notification.kind, 'review_invite'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].userId, old.userId);
  assert.equal(sent.length, 1);
});

test('избранное: поставить, повторить, снять', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: A, garFlats: 60 });
  const me = await resident(db, KEY);
  await setFavorite(db, me.userId, KEY, true);
  await setFavorite(db, me.userId, KEY, true);
  assert.deepEqual(await listFavorites(db, me.userId), [{ houseKey: KEY, address: A, rating: null, reviews: 0 }]);
  assert.equal(await isFavorite(db, me.userId, KEY), true);
  assert.equal(await isFavorite(db, null, KEY), false);
  await setFavorite(db, me.userId, KEY, false);
  assert.deepEqual(await listFavorites(db, me.userId), []);
});
