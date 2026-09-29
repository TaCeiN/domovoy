import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import {
  admin, appUser, chairman, dispatcher, houseClaim, managingOrg, property, request, userProperty,
} from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { setHouseForm } from '../house/form.ts';
import { operatorEvents, markEventsSeen } from './events.ts';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

const KNOWN = 'дом-в-реестре';
const UNKNOWN = 'дом-вне-реестра';
const PRIVATE = 'частный-дом';

async function resident(houseKey: string, address: string, status = 'pending') {
  const db = testDb();
  const userId = newId('usr');
  const propertyId = newId('prp');
  await db.insert(appUser).values({ id: userId, fullName: `Житель ${houseKey}` });
  await db.insert(property).values({ id: propertyId, houseKey, addressRaw: address, flat: '1' });
  const bindingId = newId('ubd');
  await db.insert(userProperty).values({ id: bindingId, userId, propertyId, role: 'member', status });
  return { userId, propertyId, bindingId };
}

async function seed() {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KNOWN, addressRaw: 'обл Ростовская, г Аксай, ул Мира, д. 1', registryForm: 'unknown' });
  await insertRegistryHouse(db, { houseKey: PRIVATE, addressRaw: 'обл Ростовская, г Аксай, ул Мира, д. 3', registryForm: 'private' });
}

test('житель из дома вне реестра и из дома без организации — два разных события', async () => {
  await seed();
  const outside = await resident(UNKNOWN, 'г Аксай, ул Новая, д. 9, кв. 1');
  const noOrg = await resident(KNOWN, 'обл Ростовская, г Аксай, ул Мира, д. 1, кв. 1');
  await resident(PRIVATE, 'обл Ростовская, г Аксай, ул Мира, д. 3');

  const { rows, unseen } = await operatorEvents(testDb(), {});
  const byKind = new Map(rows.map((r) => [r.kind, r]));

  assert.equal(byKind.get('unknown_house')?.refId, outside.bindingId);
  assert.equal(byKind.get('unknown_house')?.address, 'г Аксай, ул Новая, д. 9, кв. 1');
  assert.equal(byKind.get('no_org')?.refId, noOrg.bindingId);
  assert.equal(rows.filter((r) => r.kind === 'no_org').length, 1, 'частному дому организация не положена — это не событие');
  assert.equal(unseen.unknown_house, 1);
  assert.equal(unseen.no_org, 1);
});

test('у дома с организацией события «без организации» нет', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({ id: orgId, inn: '6100000001', name: 'УК', regionCode: '61', licenseNumber: '1' });
  await insertRegistryHouse(db, { houseKey: KNOWN, orgId, addressRaw: 'обл Ростовская, г Аксай, ул Мира, д. 1' });
  await resident(KNOWN, 'обл Ростовская, г Аксай, ул Мира, д. 1, кв. 1');

  const { rows } = await operatorEvents(db, {});
  assert.equal(rows.length, 0);
});

test('открытая заявка «Подключить дом» — событие, решённая — нет', async () => {
  await seed();
  const db = testDb();
  const { userId } = await resident(KNOWN, 'обл Ростовская, г Аксай, ул Мира, д. 1, кв. 1', 'active');
  await setHouseForm(db, KNOWN, { form: 'tsj', source: 'operator', setBy: 'оп' });
  await db.insert(houseClaim).values({ id: newId('hcl'), houseKey: KNOWN, userId, note: 'подключите' });
  await db.insert(houseClaim).values({ id: newId('hcl'), houseKey: KNOWN, userId, status: 'done' });

  const { rows } = await operatorEvents(db, { kind: 'house_claim' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].detail, 'подключите');
});

test('жалоба без адресата: ни организации с кабинетом, ни председателя', async () => {
  await seed();
  const db = testDb();
  const lonely = await resident(KNOWN, 'обл Ростовская, г Аксай, ул Мира, д. 1, кв. 1', 'active');
  const base = { kind: 'complaint', category: 'water', title: 'Течёт крыша', description: '…', status: 'new' };
  const requestId = newId('req');
  await db.insert(request).values({ id: requestId, number: 1, numberScope: `house:${KNOWN}`, propertyId: lonely.propertyId, authorId: lonely.userId, ...base });
  // Закрытая жалоба событием не считается
  await db.insert(request).values({ id: newId('req'), number: 2, numberScope: `house:${KNOWN}`, propertyId: lonely.propertyId, authorId: lonely.userId, ...base, status: 'done' });

  let events = await operatorEvents(db, { kind: 'orphan_request' });
  assert.deepEqual(events.rows.map((r) => r.refId), [requestId]);
  assert.equal(events.rows[0].detail, '№1 · Течёт крыша');

  // Появился председатель — жалобу есть кому прочитать
  await db.insert(chairman).values({ id: newId('chr'), houseKey: KNOWN, userId: lonely.userId, name: 'Председатель', orgId: null });
  events = await operatorEvents(db, { kind: 'orphan_request' });
  assert.equal(events.rows.length, 0);
});

test('жалоба в организацию без кабинета — тоже без адресата; с кабинетом — нет', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({ id: orgId, inn: '6100000002', name: 'УК', regionCode: '61', licenseNumber: '2' });
  await insertRegistryHouse(db, { houseKey: KNOWN, orgId, addressRaw: 'обл Ростовская, г Аксай, ул Мира, д. 1' });
  const who = await resident(KNOWN, 'обл Ростовская, г Аксай, ул Мира, д. 1, кв. 1', 'active');
  await db.insert(request).values({
    id: newId('req'), number: 1, numberScope: orgId, orgId, propertyId: who.propertyId, authorId: who.userId,
    kind: 'complaint', category: 'water', title: 'Нет воды', description: '…', status: 'new',
  });

  assert.equal((await operatorEvents(db, { kind: 'orphan_request' })).rows.length, 1);
  await db.insert(dispatcher).values({ id: newId('dsp'), orgId, login: 'uk', passwordHash: 'x', name: 'Диспетчер' });
  assert.equal((await operatorEvents(db, { kind: 'orphan_request' })).rows.length, 0);
});

test('просмотренное событие не считается новым и прячется фильтром', async () => {
  await seed();
  const db = testDb();
  const outside = await resident(UNKNOWN, 'г Аксай, ул Новая, д. 9, кв. 1');
  const adminId = newId('adm');
  await db.insert(admin).values({ id: adminId, login: 'op', passwordHash: 'x', name: 'Оператор' });

  await markEventsSeen(db, adminId, [{ kind: 'unknown_house', refId: outside.bindingId }]);

  const all = await operatorEvents(db, {});
  assert.equal(all.rows[0].seen, true);
  assert.equal(all.unseen.unknown_house, 0);
  assert.equal((await operatorEvents(db, { unseenOnly: true })).rows.length, 0);
});
