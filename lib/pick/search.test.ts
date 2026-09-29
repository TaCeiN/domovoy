import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { addressObject, region } from '../../db/schema.ts';
import { parseAddress } from '../address/normalize.ts';
import { splitQuery, searchPick } from './search.ts';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы';
after(async () => { await closeTestDb(); });
beforeEach(async () => { if (available) await resetTables(); });

test('запрос делится на улицу и номер дома', () => {
  assert.deepEqual(splitQuery('ленина 12'), { street: 'ленина', number: '12' });
  assert.deepEqual(splitQuery('пр-кт Ленина, д. 85к3'), { street: 'пр-кт Ленина', number: '85к3' });
  assert.deepEqual(splitQuery('Мира, 10а'), { street: 'Мира', number: '10а' });
  assert.deepEqual(splitQuery('мира'), { street: 'мира', number: null });
  assert.deepEqual(splitQuery('12'), { street: '12', number: null }, 'одно число — не дом без улицы');
});

const ADDR = (n: string) => `обл Ростовская, г Аксай, ул Мира, д. ${n}`;

async function seed() {
  const db = testDb();
  await db.insert(region).values({ code: '61', name: 'Ростовская обл', status: 'loaded', placeCount: 1, streetCount: 1 });
  await db.insert(addressObject).values([
    { guid: 'g-r', regionCode: '61', parentGuid: null, level: 1, type: 'обл', name: 'Ростовская', searchName: 'ростовская' },
    { guid: 'g-c', regionCode: '61', parentGuid: 'g-r', level: 5, type: 'г', name: 'Аксай', searchName: 'аксай' },
    { guid: 'g-s', regionCode: '61', parentGuid: 'g-c', level: 8, type: 'ул', name: 'Мира', searchName: 'мира' },
  ]);
  await insertRegistryHouse(db, { houseKey: parseAddress(ADDR('1')).houseKey, addressRaw: ADDR('1'), streetGuid: 'g-s', garFlats: 60, lat: 47.27, lon: 39.86 });
  await insertRegistryHouse(db, { houseKey: parseAddress(ADDR('10')).houseKey, addressRaw: ADDR('10'), streetGuid: 'g-s', garFlats: 40, lat: 47.28, lon: 39.87 });
  await insertRegistryHouse(db, { houseKey: parseAddress(ADDR('12')).houseKey, addressRaw: ADDR('12'), streetGuid: 'g-s', registryForm: 'private' });
  await insertRegistryHouse(db, { houseKey: parseAddress(ADDR('1, к. 2')).houseKey, addressRaw: ADDR('1, к. 2'), streetGuid: 'g-s', garFlats: 30 });
  return db;
}

test('поиск: дома по номеру на найденной улице, частные не попадают', { skip }, async () => {
  const db = await seed();
  const res = await searchPick(db, 'мира 1');
  assert.deepEqual(
    res.houses.map((h) => h.address),
    [ADDR('1'), ADDR('1, к. 2'), ADDR('10')],
    'точный номер, затем его корпуса, затем номера длиннее',
  );
  assert.equal(res.houses[0].lat, 47.27);
  assert.equal((await searchPick(db, 'мира 12')).houses.length, 0, 'частный дом не в подборе');
});

test('поиск: улица с рамкой своих домов', { skip }, async () => {
  const db = await seed();
  const res = await searchPick(db, 'мира');
  assert.equal(res.houses.length, 0);
  assert.equal(res.streets[0].guid, 'g-s');
  assert.equal(res.streets[0].label, 'ул Мира, г Аксай');
  assert.deepEqual(res.streets[0].bbox, { south: 47.27, north: 47.28, west: 39.86, east: 39.87 });
});
