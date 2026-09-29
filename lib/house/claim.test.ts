import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';
import { appUser, property, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { openHouseClaim, openHouseClaims, decideHouseClaim } from './claim.ts';

const HOUSE = 'ростовская обл|ростов-на-дону|ленина пр-кт|85/3';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

async function resident(flat: string, name: string) {
  const db = testDb();
  const userId = newId('usr');
  const propertyId = newId('prp');
  await db.insert(appUser).values({ id: userId, fullName: name });
  await db.insert(property).values({
    id: propertyId, addressRaw: 'пр-кт Ленина, д. 85/3', houseKey: HOUSE, flat,
  });
  await db.insert(userProperty).values({
    id: newId('ubd'), userId, propertyId, role: 'owner', status: 'pending',
  });
  return userId;
}

test('житель дома подаёт заявку', async () => {
  const db = testDb();
  const userId = await resident('12', 'Петров Пётр');

  const res = await openHouseClaim(db, { houseKey: HOUSE, userId, note: 'У нас ТСЖ «Ленина 85»' });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.created, true);

  const list = await openHouseClaims(db);
  assert.equal(list.length, 1);
  assert.equal(list[0].userName, 'Петров Пётр');
  assert.equal(list[0].note, 'У нас ТСЖ «Ленина 85»');
  assert.equal(list[0].address, 'пр-кт Ленина, д. 85/3', 'дома нет в реестре — адрес из квитанции жителя');
});

test('повторная заявка от того же человека не плодит строк', async () => {
  const db = testDb();
  const userId = await resident('12', 'Петров Пётр');

  await openHouseClaim(db, { houseKey: HOUSE, userId });
  const second = await openHouseClaim(db, { houseKey: HOUSE, userId });

  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.created, false, 'двойной тап не должен множить очередь');
  assert.equal((await openHouseClaims(db)).length, 1);
});

test('посторонний заявку по чужому дому не подаёт', async () => {
  const db = testDb();
  const OTHER_HOUSE = 'ростовская обл|ростов-на-дону|садовая ул|1';
  const strangerId = newId('usr');
  const strangerPropertyId = newId('prp');
  await db.insert(appUser).values({ id: strangerId, fullName: 'Посторонний' });
  await db.insert(property).values({
    id: strangerPropertyId, addressRaw: 'ул. Садовая, д. 1', houseKey: OTHER_HOUSE, flat: '1',
  });
  await db.insert(userProperty).values({
    id: newId('ubd'), userId: strangerId, propertyId: strangerPropertyId, role: 'owner', status: 'pending',
  });

  const res = await openHouseClaim(db, { houseKey: HOUSE, userId: strangerId });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'not_a_resident');
});

test('человек без единой привязки заявку не подаёт', async () => {
  const db = testDb();
  const strangerId = newId('usr');
  await db.insert(appUser).values({ id: strangerId, fullName: 'Посторонний' });

  const res = await openHouseClaim(db, { houseKey: HOUSE, userId: strangerId });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'not_a_resident');
});

test('гонка двойного тапа: параллельные заявки не падают и не плодят строк', async () => {
  const db = testDb();
  const userId = await resident('12', 'Петров Пётр');

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => openHouseClaim(db, { houseKey: HOUSE, userId })),
  );

  for (const r of results) assert.equal(r.status, 'fulfilled', 'ни один вызов не должен упасть исключением');

  const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof openHouseClaim>>>).value);
  for (const v of values) assert.equal(v.ok, true);

  const createdCount = values.filter((v) => v.ok && v.created).length;
  assert.equal(createdCount, 1, 'ровно один вызов должен завести новую заявку');

  const list = await openHouseClaims(db);
  assert.equal(list.length, 1, 'в базе должна остаться одна открытая заявка');
});

test('решённая заявка уходит из очереди, а новая подаётся снова', async () => {
  const db = testDb();
  const userId = await resident('12', 'Петров Пётр');
  const first = await openHouseClaim(db, { houseKey: HOUSE, userId });
  assert.equal(first.ok, true);
  if (!first.ok) return;

  assert.equal(await decideHouseClaim(db, first.id, 'done', 'владелец'), true);
  assert.equal((await openHouseClaims(db)).length, 0);

  const again = await openHouseClaim(db, { houseKey: HOUSE, userId });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.created, true, 'дом снова осиротел — заявка снова возможна');
});
