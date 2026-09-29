import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import { testDb, resetTables, closeTestDb, isDbAvailable, TEST_URL, insertRegistryHouse } from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';
import { createSession } from '../../lib/auth/session.ts';
import { parseAddress } from '../../lib/address/normalize.ts';
import { resident } from '../../lib/pick/fixtures.ts';
import { loadMock } from '../../lib/pick/mock/load.ts';
import { SAMPLE } from '../../lib/pick/mock/fixtures.ts';

/**
 * Подбор дома: смотреть может любой вошедший — по сессии или по подписи MAX
 * без квитанции; писать отзыв — только подтверждённый житель этого дома.
 */

process.env.DATABASE_URL = TEST_URL;
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';
const app = buildApp();
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await app.close(); await closeTestDb(); await closeDb(); });

const A = 'обл Ростовская, г Аксай, ул Мира, д. 1';
const KEY = parseAddress(A).houseKey;
const STARS = { uk: 5, clean: 4, neighbors: 4, quiet: 3, yard: 4 };

function maxHeaders(id: number) {
  return {
    'x-max-init-data': signInitDataForTesting({
      auth_date: String(Math.floor(Date.now() / 1000)),
      chat: JSON.stringify({ id: 700000 + id, type: 'DIALOG' }),
      query_id: `q-${id}`,
      user: JSON.stringify({ id, first_name: 'Гость', last_name: 'Переезжающий', username: null, language_code: 'ru', photo_url: null }),
    }, BOT_TOKEN),
  };
}

async function sessionHeaders(userId: string) {
  const { token } = await createSession(testDb(), userId, 'max');
  return { authorization: `Bearer ${token}` };
}

async function seed() {
  await insertRegistryHouse(testDb(), { houseKey: KEY, addressRaw: A, garFlats: 60, lat: 47.27, lon: 39.86 });
}

test('без сессии и без подписи MAX — 401', { skip }, async () => {
  await seed();
  const res = await app.inject({ method: 'GET', url: `/api/pick/house/${KEY}` });
  assert.equal(res.statusCode, 401);
});

test('человек из MAX без квитанции видит карточку и карту', { skip }, async () => {
  await seed();
  const card = await app.inject({ method: 'GET', url: `/api/pick/house/${KEY}`, headers: maxHeaders(4242) });
  assert.equal(card.statusCode, 200);
  assert.equal(card.json().address, A);
  assert.equal(card.json().canReview, false);

  const map = await app.inject({ method: 'GET', url: '/api/pick/houses?bbox=39.8,47.2,39.9,47.3&zoom=16', headers: maxHeaders(4242) });
  assert.equal(map.statusCode, 200);
  assert.equal(map.json().kind, 'houses');
  assert.equal(map.json().houses.length, 1);

  const bad = await app.inject({ method: 'GET', url: '/api/pick/houses?bbox=abc&zoom=16', headers: maxHeaders(4242) });
  assert.equal(bad.statusCode, 400);

  const missing = await app.inject({ method: 'GET', url: `/api/pick/house/${'0'.repeat(32)}`, headers: maxHeaders(4242) });
  assert.equal(missing.statusCode, 404);
});

test('«♥» без квитанции заводит человека по подписи MAX, и дом попадает в «Мои дома»', { skip }, async () => {
  await seed();
  const put = await app.inject({ method: 'POST', url: `/api/pick/favorites/${KEY}`, headers: maxHeaders(4343) });
  assert.equal(put.statusCode, 200);
  const list = await app.inject({ method: 'GET', url: '/api/pick/favorites', headers: maxHeaders(4343) });
  assert.deepEqual(list.json().houses.map((h: { houseKey: string }) => h.houseKey), [KEY]);

  const login = await app.inject({ method: 'POST', url: '/api/auth/max', headers: maxHeaders(4343) });
  assert.equal(login.json().status, 'needs_receipt', 'сессии без квитанции по-прежнему нет');
});

test('отзыв: неподтверждённому 403, подтверждённому — сохраняется и виден без имени', { skip }, async () => {
  await seed();
  const pending = await resident(testDb(), KEY, { status: 'pending' });
  const denied = await app.inject({
    method: 'POST', url: `/api/pick/house/${KEY}/review`, headers: await sessionHeaders(pending.userId),
    payload: { stars: STARS },
  });
  assert.equal(denied.statusCode, 403);

  const me = await resident(testDb(), KEY);
  const headers = await sessionHeaders(me.userId);
  const bad = await app.inject({ method: 'POST', url: `/api/pick/house/${KEY}/review`, headers, payload: { stars: { uk: 5 } } });
  assert.equal(bad.statusCode, 400);

  const ok = await app.inject({
    method: 'POST', url: `/api/pick/house/${KEY}/review`, headers, payload: { stars: STARS, pros: 'двор' },
  });
  assert.equal(ok.statusCode, 200);

  const card = await app.inject({ method: 'GET', url: `/api/pick/house/${KEY}`, headers: maxHeaders(4444) });
  assert.equal(card.json().summary.count, 1);
  assert.equal(card.json().reviews[0].pros, 'двор');
  assert.equal(card.body.includes('Житель'), false);
});

test('просьба об отзыве: есть у подтверждённого, закрывается', { skip }, async () => {
  await seed();
  const me = await resident(testDb(), KEY);
  const headers = await sessionHeaders(me.userId);
  const prompt = await app.inject({ method: 'GET', url: '/api/pick/prompt', headers });
  assert.equal(prompt.json().prompt.houseKey, KEY);

  const dismissed = await app.inject({ method: 'POST', url: `/api/pick/prompt/${KEY}/dismiss`, headers });
  assert.equal(dismissed.statusCode, 200);
  const again = await app.inject({ method: 'GET', url: '/api/pick/prompt', headers });
  assert.equal(again.json().prompt, null);

  const guest = await app.inject({ method: 'GET', url: '/api/pick/prompt', headers: maxHeaders(4545) });
  assert.equal(guest.json().prompt, null, 'гостю из MAX просить не о чем');
});

test('поиск отвечает и гостю из MAX', { skip }, async () => {
  const res = await app.inject({ method: 'GET', url: `/api/pick/search?q=${encodeURIComponent('мира 1')}`, headers: maxHeaders(4646) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { houses: [], streets: [] }, 'регион не загружен — пусто, а не ошибка');
});

test('заглушка ЖК: карта, поиск и карточка отдают ЖК, пока таблица не пуста', { skip }, async () => {
  await seed();
  await loadMock(testDb(), structuredClone(SAMPLE));
  const h = maxHeaders(4747);

  const map = await app.inject({ method: 'GET', url: '/api/pick/houses?bbox=39.6,47.2,39.8,47.3&zoom=12', headers: h });
  assert.equal(map.json().kind, 'complexes');
  assert.deepEqual(map.json().complexes.map((c: { key: string }) => c.key), ['mock:novyy-selmash']);

  const search = await app.inject({ method: 'GET', url: `/api/pick/search?q=${encodeURIComponent('сельмаш')}`, headers: h });
  assert.equal(search.json().houses[0].houseKey, 'mock:novyy-selmash');

  const card = await app.inject({ method: 'GET', url: `/api/pick/house/${encodeURIComponent('mock:novyy-selmash')}`, headers: h });
  assert.equal(card.statusCode, 200);
  assert.equal(card.json().kind, 'mock');
  assert.equal(card.json().name, 'ЖК «Новый Сельмаш»');

  const missing = await app.inject({ method: 'GET', url: `/api/pick/house/${encodeURIComponent('mock:nope')}`, headers: h });
  assert.equal(missing.statusCode, 404);

  const fav = await app.inject({ method: 'POST', url: `/api/pick/favorites/${encodeURIComponent('mock:novyy-selmash')}`, headers: h });
  assert.equal(fav.statusCode, 404, '♥ заглушки живёт на устройстве, а не в house_favorite');

  const real = await app.inject({ method: 'GET', url: `/api/pick/house/${KEY}`, headers: h });
  assert.equal(real.statusCode, 200, 'карточка настоящего дома по-прежнему открывается');
});

test('пустая заглушка — карта прежняя', { skip }, async () => {
  await seed();
  const map = await app.inject({ method: 'GET', url: '/api/pick/houses?bbox=39.8,47.2,39.9,47.3&zoom=16', headers: maxHeaders(4848) });
  assert.equal(map.json().kind, 'houses');
});
test('заглушка ЖК: фото отдаётся по slug без входа, карточка знает его адрес и подпись', { skip }, async () => {
  await seed();
  const f = structuredClone(SAMPLE);
  f.complexes[0].photo = { file: 'x.webp', credit: '© Застройщик', sourceUrl: 'https://example.ru' };
  await loadMock(testDb(), f, new Map([[f.complexes[0].slug, { bytes: Buffer.from('RIFF'), mime: 'image/webp' }]]));

  const card = (await app.inject({
    method: 'GET', url: `/api/pick/house/${encodeURIComponent(`mock:${f.complexes[0].slug}`)}`, headers: maxHeaders(4848),
  })).json();
  assert.deepEqual(card.photo, { url: `/api/pick/mock-photo/${f.complexes[0].slug}`, credit: '© Застройщик' });

  // Картинку грузит <img> — заголовка MAX у него нет, поэтому маршрут открыт
  const img = await app.inject({ method: 'GET', url: card.photo.url });
  assert.equal(img.statusCode, 200);
  assert.equal(img.headers['content-type'], 'image/webp');
  assert.equal(img.body, 'RIFF');

  assert.equal((await app.inject({ method: 'GET', url: '/api/pick/mock-photo/..%2Fetc' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/pick/mock-photo/nope' })).statusCode, 404);
});

test('заглушка ЖК: карточка отдаёт примерную оплату ЖКУ', { skip }, async () => {
  await seed();
  const f = structuredClone(SAMPLE);
  f.complexes[0].utilities = 5200;
  await loadMock(testDb(), f);
  const card = (await app.inject({
    method: 'GET', url: `/api/pick/house/${encodeURIComponent(`mock:${f.complexes[0].slug}`)}`, headers: maxHeaders(4949),
  })).json();
  assert.equal(card.utilities, 5200);
});
