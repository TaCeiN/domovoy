import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../../test-db.ts';
import { loadMock } from './load.ts';
import { mockActive, mockMap, mockSearch, mockCard, mockDistricts } from './query.ts';
import { DISTRICTS, districtBbox } from './districts.ts';
import { SAMPLE } from './fixtures.ts';
import type { MockFile } from './format.ts';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await closeTestDb(); });

const base = SAMPLE.complexes[0];
const FILE: MockFile = {
  ...structuredClone(SAMPLE),
  complexes: [
    { ...structuredClone(base), slug: 'a', name: 'ЖК «Альфа»', district: 'Первомайский район', lat: 47.27, lon: 39.70,
      reviews: [{ ...base.reviews[0], stars: 5 }, { ...base.reviews[0], stars: 3 }] },
    { ...structuredClone(base), slug: 'b', name: 'ЖК «Бета»', district: 'Первомайский район', lat: 47.28, lon: 39.71,
      reviews: [{ ...base.reviews[0], stars: 4 }] },
    { ...structuredClone(base), slug: 'c', name: 'ЖК «Гамма»', district: 'Советский район', lat: 47.22, lon: 39.62,
      address: 'ул. Малиновского, 33б', reviews: [{ ...base.reviews[0], stars: 5 }] },
  ],
};

test('режим заглушки — пока в таблице есть ЖК', { skip }, async () => {
  assert.equal(await mockActive(testDb()), false);
  await loadMock(testDb(), FILE);
  assert.equal(await mockActive(testDb()), true);
});

test('карта отдаёт ЖК рамки с рейтингом из отзывов', { skip }, async () => {
  await loadMock(testDb(), FILE);
  const r = await mockMap(testDb(), { west: 39.65, south: 47.25, east: 39.75, north: 47.3 });
  assert.equal(r.kind, 'complexes');
  assert.deepEqual(r.complexes.map((c) => c.key).sort(), ['mock:a', 'mock:b']);
  const a = r.complexes.find((c) => c.key === 'mock:a')!;
  assert.equal(a.rating, 4);
  assert.equal(a.reviews, 2);
  assert.equal(a.quote, base.reviews[0].plus);
});

test('поиск по названию и по адресу — с начала слова', { skip }, async () => {
  await loadMock(testDb(), FILE);
  assert.deepEqual((await mockSearch(testDb(), 'бета')).houses.map((h) => h.houseKey), ['mock:b']);
  assert.deepEqual((await mockSearch(testDb(), 'малиновск')).houses.map((h) => h.houseKey), ['mock:c']);
  assert.deepEqual((await mockSearch(testDb(), 'ета')).houses, [], 'середина слова не находится');
  assert.deepEqual(await mockSearch(testDb(), 'ж'), { houses: [], streets: [], districts: [] });
});

test('латинское название находится по внутреннему русскому, а наружу оно не уходит', { skip }, async () => {
  const f = structuredClone(FILE);
  f.complexes[0].name = 'ЖК «GreenSide»';
  f.complexes[0].aliases = ['Грин Сайд', 'Гринсайд'];
  await loadMock(testDb(), f);
  assert.deepEqual((await mockSearch(testDb(), 'грин')).houses.map((h) => h.houseKey), ['mock:a']);
  assert.deepEqual((await mockSearch(testDb(), 'сайд')).houses.map((h) => h.houseKey), ['mock:a']);
  const card = await mockCard(testDb(), 'mock:a');
  assert.equal(JSON.stringify(card).includes('Грин'), false);
  const map = await mockMap(testDb(), { west: 39.65, south: 47.25, east: 39.75, north: 47.3 });
  assert.equal(JSON.stringify(map).includes('Грин'), false);
});

test('поиск по району: сколько ЖК и рамка района для карты', { skip }, async () => {
  await loadMock(testDb(), FILE);
  const r = await mockSearch(testDb(), 'первомай');
  const own = DISTRICTS.find((d) => d.name === 'Первомайский район')!;
  assert.deepEqual(r.districts, [{ district: 'Первомайский район', count: 2, bbox: districtBbox(own) }]);
  assert.deepEqual((await mockSearch(testDb(), 'жд')).districts.map((d) => [d.district, d.count]),
    [['Железнодорожный район', 0]], 'район без ЖК тоже находится — по народному названию');
  assert.deepEqual(r.houses, [], 'ЖК района сами по себе не подсказываются');
  assert.equal((await mockSearch(testDb(), '(')).districts.length, 0, 'знаки регулярного выражения не ломают поиск');
});

test('районы для карты: все восемь с границей, подписью и числом ЖК', { skip }, async () => {
  assert.deepEqual(await mockDistricts(testDb()), { districts: [] }, 'без заглушки ЖК районов нет');
  await loadMock(testDb(), FILE);
  const { districts } = await mockDistricts(testDb());
  assert.equal(districts.length, 8);
  const own = districts.find((d) => d.name === 'Первомайский район')!;
  assert.equal(own.count, 2);
  assert.ok(Math.abs(own.focus!.lat - 47.275) < 1e-9 && Math.abs(own.focus!.lon - 39.705) < 1e-9, 'середина двух ЖК района');
  assert.equal(districts.find((d) => d.name === 'Кировский район')!.focus, null);
  assert.ok(own.geometry.coordinates.length > 0);
  assert.deepEqual(own.bbox, districtBbox(DISTRICTS.find((d) => d.name === own.name)!));
  assert.equal(districts.find((d) => d.name === 'Советский район')!.count, 1);
  assert.equal(districts.find((d) => d.name === 'Кировский район')!.count, 0, 'район без ЖК тоже на карте');
});

test('карточка: похожие — сначала тот же район, без самого ЖК', { skip }, async () => {
  await loadMock(testDb(), FILE);
  const card = await mockCard(testDb(), 'mock:a');
  assert.equal(card?.kind, 'mock');
  assert.equal(card?.reviewCount, 2);
  assert.deepEqual(card?.similar.map((s) => s.key), ['mock:b', 'mock:c']);
  assert.equal(card?.listings.length, 1);
  assert.equal(card?.listings[0].site, 'avito');
  assert.equal(await mockCard(testDb(), 'mock:nope'), null);
  assert.equal(await mockCard(testDb(), 'не ключ'), null);
});
