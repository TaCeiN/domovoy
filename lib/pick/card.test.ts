import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { managingOrg, poi } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { parseAddress } from '../address/normalize.ts';
import { pickCard } from './card.ts';
import { saveReview } from './reviews.ts';
import { setFavorite } from './favorites.ts';
import { resident } from './fixtures.ts';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы';
after(async () => { await closeTestDb(); });
beforeEach(async () => { if (available) await resetTables(); });

const A = 'обл Ростовская, г Аксай, ул Мира, д. 1';
const KEY = parseAddress(A).houseKey;

test('карточка: паспорт, управление, отзывы, окружение, ссылки, избранное', { skip }, async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6102017830', name: 'ООО УК «Мира»', shortName: 'УК «Мира»', regionCode: '61',
    licenseNumber: '061-000123', phone: '+78630000000',
  });
  await insertRegistryHouse(db, {
    houseKey: KEY, addressRaw: A, orgId, garFlats: 60, flatCount: 58, lat: 47.27, lon: 39.86, builtYear: 1975, floors: 5,
  });
  await db.insert(poi).values({ id: newId('poi'), regionCode: '61', kind: 'stop', name: null, lat: 47.2705, lon: 39.86 });
  const me = await resident(db, KEY);
  await saveReview(db, me.userId, KEY, { stars: { uk: 3, clean: 3, neighbors: 3, quiet: 3, yard: 3 }, pros: 'тихо', cons: null });
  await setFavorite(db, me.userId, KEY, true);

  const outside = await pickCard(db, KEY, null);
  assert.ok(outside);
  assert.equal(outside.address, A);
  assert.equal(outside.passport.builtYear, 1975);
  assert.equal(outside.passport.flats, 58);
  assert.equal(outside.management.form, 'uk');
  assert.equal(outside.management.orgName, 'УК «Мира»');
  assert.equal(outside.management.license, '061-000123');
  assert.equal(outside.management.hasChairman, false);
  assert.equal(outside.summary.rating, 3);
  assert.equal(outside.reviews[0].pros, 'тихо');
  assert.ok(outside.near && outside.near.stop! < 100);
  assert.equal(outside.listings.length, 4);
  assert.equal(outside.favorite, false);
  assert.equal(outside.canReview, false);
  assert.equal(outside.complaints.enough, false);
  assert.equal(outside.payment, null);
  assert.equal(JSON.stringify(outside).includes('Житель'), false, 'имени жителя в карточке нет');

  const mine = await pickCard(db, KEY, me.userId);
  assert.equal(mine?.favorite, true);
  assert.equal(mine?.canReview, true);
});

test('частного дома и неизвестного ключа в подборе нет', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: A, registryForm: 'private' });
  assert.equal(await pickCard(db, KEY, null), null);
  assert.equal(await pickCard(db, 'нет-такого', null), null);
});

test('регион без точек окружения: блока «Рядом» нет, а не «дальше 1,5 км» у всего', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: A, garFlats: 60, lat: 47.27, lon: 39.86 });
  const card = await pickCard(db, KEY, null);
  assert.equal(card?.near, null, 'набор региона собран без OSM-точек — мы не знаем, что рядом');

  await db.insert(poi).values({ id: newId('poi'), regionCode: '61', kind: 'school', name: null, lat: 47.9, lon: 39.9 });
  const loaded = await pickCard(db, KEY, null);
  assert.equal(loaded?.near?.shop, null, 'точки есть, но рядом магазина нет — это уже знание');
});
