import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import {
  appUser, managingOrg, dispatcher, property, userProperty, chairman,
  notification,
} from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { createChairman, revokeChairman, chairmanOfHouse } from './chairman.ts';

const HOUSE = 'ростовская обл|ростов-на-дону|ленина пр-кт|85/3';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

/** Житель дома с неподтверждённой привязкой — обычное начальное состояние. */
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
  return { userId, propertyId };
}

test('оператор назначает председателя дому, которого нет в реестре', async () => {
  const db = testDb();
  const { userId } = await resident('12', 'Петров Пётр');

  const res = await createChairman(db, {
    houseKey: HOUSE, userId, by: { kind: 'operator', who: 'владелец' },
  });

  assert.equal(res.ok, true, 'дома нет в реестре, но это больше не препятствие');
  if (!res.ok) return;
  assert.equal(res.name, 'Петров Пётр');
});

test('назначение подтверждает и собственную привязку председателя', async () => {
  const db = testDb();
  const { userId, propertyId } = await resident('12', 'Петров Пётр');

  await createChairman(db, { houseKey: HOUSE, userId, by: { kind: 'operator', who: 'владелец' } });

  const [binding] = await db
    .select({ status: userProperty.status })
    .from(userProperty)
    .where(eq(userProperty.propertyId, propertyId));
  assert.equal(binding.status, 'active', 'иначе он не может войти в собственный дом');
});

test('диспетчер по-прежнему не может назначить председателя чужому дому', async () => {
  const db = testDb();
  const { userId } = await resident('12', 'Петров Пётр');
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000003', name: 'ООО УК «Чужая»', regionCode: '61',
  });

  const res = await createChairman(db, {
    houseKey: HOUSE, userId, by: { kind: 'dispatcher', orgId, id: newId('dsp') },
  });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'foreign_house');
});

test('диспетчер назначает председателя своему дому', async () => {
  const db = testDb();
  const { userId } = await resident('12', 'Петров Пётр');
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000004', name: 'ООО УК «Своя»', regionCode: '61',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская',
  });
  const dispatcherId = newId('dsp');
  await db.insert(dispatcher).values({
    id: dispatcherId, orgId, login: 'dispatcher-svoya', passwordHash: 'x', name: 'Диспетчер',
  });

  const res = await createChairman(db, {
    houseKey: HOUSE, userId, by: { kind: 'dispatcher', orgId, id: dispatcherId },
  });
  assert.equal(res.ok, true);
});

test('председателем может стать только житель этого дома', async () => {
  const db = testDb();
  const strangerId = newId('usr');
  await db.insert(appUser).values({ id: strangerId, fullName: 'Посторонний' });

  const res = await createChairman(db, {
    houseKey: HOUSE, userId: strangerId, by: { kind: 'operator', who: 'владелец' },
  });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'not_a_resident');
});

test('второго действующего председателя дом не получает', async () => {
  const db = testDb();
  const a = await resident('12', 'Петров Пётр');
  const b = await resident('14', 'Сидоров Сидор');

  await createChairman(db, { houseKey: HOUSE, userId: a.userId, by: { kind: 'operator', who: 'владелец' } });
  const res = await createChairman(db, { houseKey: HOUSE, userId: b.userId, by: { kind: 'operator', who: 'владелец' } });

  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'already_exists');
});

/**
 * ДЕФЕКТ 3: председателя дома без УК было невозможно снять.
 *
 * `revokeChairman` искала строку с условием `chairman.orgId = ukId`.
 * У председателя, назначенного оператором в доме без организации,
 * `orgId` пуст, и условие не совпадало никогда — назначение оператором
 * было необратимым, чинилось только правкой в базе руками.
 */
test('оператор снимает председателя дома без организации', async () => {
  const db = testDb();
  const { userId } = await resident('12', 'Петров Пётр');
  const created = await createChairman(db, {
    houseKey: HOUSE, userId, by: { kind: 'operator', who: 'владелец' },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const ok = await revokeChairman(db, { kind: 'operator', who: 'владелец' }, created.id);
  assert.equal(ok, true, 'оператор обязан уметь снять то, что сам назначил');

  const [row] = await db
    .select({ revokedAt: chairman.revokedAt })
    .from(chairman)
    .where(eq(chairman.id, created.id));
  assert.ok(row.revokedAt, 'запись должна быть помечена снятой');
});

test('диспетчер по-прежнему не может снять председателя чужого дома', async () => {
  const db = testDb();
  const { userId } = await resident('12', 'Петров Пётр');
  const created = await createChairman(db, {
    houseKey: HOUSE, userId, by: { kind: 'operator', who: 'владелец' },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  // У дома нет организации вовсе — значит право диспетчера снимать
  // «председателя своей УК» распространяться на него не должно
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000005', name: 'ООО УК «Соседняя»', regionCode: '61',
  });
  const dispatcherId = newId('dsp');

  const ok = await revokeChairman(db, { kind: 'dispatcher', orgId, id: dispatcherId }, created.id);
  assert.equal(ok, false, 'право диспетчера не должно расшириться на дом без своей организации');

  const [row] = await db
    .select({ revokedAt: chairman.revokedAt })
    .from(chairman)
    .where(eq(chairman.id, created.id));
  assert.equal(row.revokedAt, null, 'председатель остаётся действующим');
});

test('снятый председатель теряет доступ', async () => {
  const db = testDb();
  const { userId } = await resident('12', 'Петров Пётр');
  const created = await createChairman(db, {
    houseKey: HOUSE, userId, by: { kind: 'operator', who: 'владелец' },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  await revokeChairman(db, { kind: 'operator', who: 'владелец' }, created.id);

  /**
   * Права проверяются ПО ЭТОЙ таблице на каждом запросе, а не зашиты
   * в сессию, — поэтому доступ закрывается в ту же секунду, без выхода
   * из аккаунта. `chairmanOfHouse` — ровно та функция, которой сверяют
   * права председателя, и снятого она видеть не должна.
   */
  const found = await chairmanOfHouse(db, HOUSE);
  assert.equal(found, null, 'снятый председатель не должен находиться как действующий');
});

/**
 * Назначение обязано дойти до человека.
 *
 * До 11 сентября `createChairman` не звал `notify` ни разу. Проверено
 * на живом стенде: оператор назначает председателя, сервер отвечает
 * `status: active` и `isChairman: true`, а экран у человека в ту же
 * секунду показывает «ожидает» и «у дома нет председателя». Уведомление
 * бота — единственный канал до того, кто приложение сейчас не открыл.
 */
test('назначение председателя доходит до него уведомлением', async () => {
  const db = testDb();
  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Аудитова Мария' });
  const propertyId = newId('prp');
  await db.insert(property).values({
    id: propertyId, addressRaw: 'пр-кт Ленина, д. 85/3, кв. 45', houseKey: HOUSE, flat: '45',
  });
  await db.insert(userProperty).values({
    id: newId('ubd'), userId, propertyId, role: 'member', status: 'pending', inviteCode: 'CHR001',
  });

  const res = await createChairman(db, {
    houseKey: HOUSE, userId, by: { kind: 'operator', who: 'Оператор' },
  });
  assert.equal(res.ok, true);

  const notes = await db.select().from(notification).where(eq(notification.userId, userId));
  assert.equal(notes.length, 1, 'человек должен узнать, что его назначили');
  assert.match(notes[0].title, /председател/i);
});

/**
 * Назначение даёт права председателя, но не собственность.
 *
 * Находка аудита 26 сентября: у квартиры без подтверждённого собственника
 * назначение ставило председателю роль `owner`. А назначить можно и
 * неподтверждённого — того, кто ввёл строку QR руками. Цепочка давала ему
 * чужую квартиру: приглашать домочадцев, видеть все её деньги, отклонять
 * настоящего хозяина. Права председателя живут в таблице `chairman`,
 * собственность подтверждает другой человек — как у всех.
 */
test('назначение не делает председателя собственником квартиры', async () => {
  const db = testDb();
  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Претендент Пётр' });
  const propertyId = newId('prp');
  await db.insert(property).values({
    id: propertyId, addressRaw: 'пр-кт Ленина, д. 85/3, кв. 46', houseKey: HOUSE, flat: '46',
  });
  await db.insert(userProperty).values({
    id: newId('ubd'), userId, propertyId, role: 'member', status: 'pending',
  });

  const res = await createChairman(db, { houseKey: HOUSE, userId, by: { kind: 'operator', who: 'Оператор' } });
  assert.equal(res.ok, true);

  const [binding] = await db.select().from(userProperty).where(eq(userProperty.propertyId, propertyId));
  assert.equal(binding.status, 'active', 'в свой дом он войти должен');
  assert.equal(binding.role, 'member', 'собственность назначением не выдаётся');
});
