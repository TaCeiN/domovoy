import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { poi } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { parseAddress } from '../address/normalize.ts';
import { mapHouses, nearby } from './houses.ts';
import { saveReview } from './reviews.ts';
import { resident } from './fixtures.ts';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы';
after(async () => { await closeTestDb(); });
beforeEach(async () => { if (available) await resetTables(); });

const ADDR = (n: string) => `обл Ростовская, г Аксай, ул Мира, д. ${n}`;
const BOX = { west: 39.8, south: 47.2, east: 39.9, north: 47.3 };

async function seed() {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: parseAddress(ADDR('1')).houseKey, addressRaw: ADDR('1'), garFlats: 60, lat: 47.27, lon: 39.86 });
  await insertRegistryHouse(db, { houseKey: parseAddress(ADDR('2')).houseKey, addressRaw: ADDR('2'), garMkd: true, lat: 47.2701, lon: 39.8601 });
  await insertRegistryHouse(db, { houseKey: parseAddress(ADDR('3')).houseKey, addressRaw: ADDR('3'), lat: 47.271, lon: 39.861 });
  await insertRegistryHouse(db, { houseKey: parseAddress(ADDR('4')).houseKey, addressRaw: ADDR('4'), garFlats: 60, lat: 48.5, lon: 39.86 });
  return db;
}

test('на крупном масштабе — дома рамки с оценкой, частные и чужие не попадают', { skip }, async () => {
  const db = await seed();
  const key = parseAddress(ADDR('1')).houseKey;
  const me = await resident(db, key);
  await saveReview(db, me.userId, key, { stars: { uk: 4, clean: 4, neighbors: 4, quiet: 4, yard: 4 }, pros: null, cons: null });

  const answer = await mapHouses(db, BOX, 16);
  assert.equal(answer.kind, 'houses');
  if (answer.kind !== 'houses') return;
  assert.deepEqual(answer.houses.map((h) => h.address).sort(), [ADDR('1'), ADDR('2')]);
  assert.equal(answer.houses.find((h) => h.houseKey === key)?.rating, 4);
  assert.equal(answer.houses.find((h) => h.houseKey === key)?.reviews, 1);
});

test('на мелком масштабе — кружки с числом домов', { skip }, async () => {
  const db = await seed();
  const answer = await mapHouses(db, BOX, 11);
  assert.equal(answer.kind, 'clusters');
  if (answer.kind !== 'clusters') return;
  assert.equal(answer.clusters.length, 1, 'два соседних дома — одна клетка');
  assert.equal(answer.clusters[0].count, 2);
});

test('слишком широкая рамка — просьба приблизить', { skip }, async () => {
  const db = await seed();
  assert.deepEqual(await mapHouses(db, { west: 36, south: 46, east: 40, north: 49 }, 8), { kind: 'zoom_in' });
});

test('рядом: ближайшая точка каждого вида в пределах 1,5 км', { skip }, async () => {
  const db = testDb();
  const at = { lat: 47.27, lon: 39.86 };
  await db.insert(poi).values([
    { id: newId('poi'), regionCode: '61', kind: 'shop', name: 'далёкий', lat: 47.2745, lon: 39.86 },
    { id: newId('poi'), regionCode: '61', kind: 'shop', name: 'ближний', lat: 47.2711, lon: 39.86 },
    { id: newId('poi'), regionCode: '61', kind: 'school', name: null, lat: 47.29, lon: 39.86 },
  ]);
  const near = await nearby(db, at);
  assert.ok(near.shop! > 110 && near.shop! < 135, String(near.shop));
  assert.equal(near.school, null, 'школа в 2,2 км — «дальше 1,5 км»');
  assert.equal(near.pharmacy, null);
});
