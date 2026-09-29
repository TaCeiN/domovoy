import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import {
  appUser, chairman, dispatcher, managingOrg, property,
  request, requestEvent, userProperty,
} from '../../db/schema.ts';
import { eq } from 'drizzle-orm';
import { createRequest, startClockForOrg } from './service.ts';
import { newId } from '../ids.ts';
import { addresseeForProperty } from './addressee.ts';

const HOUSE = 'ростовская обл|ростов-на-дону|ленина пр-кт|85/3';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

async function makeProperty(flat = '12') {
  const db = testDb();
  const propertyId = newId('prp');
  await db.insert(property).values({
    id: propertyId, addressRaw: 'пр-кт Ленина, д. 85/3', houseKey: HOUSE, flat,
  });
  return propertyId;
}

test('есть управляющая организация — адресат она', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000005', name: 'ООО УК «Пример»', regionCode: '61',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская',
  });
  const propertyId = await makeProperty();

  const who = await addresseeForProperty(db, propertyId);
  assert.equal(who.kind, 'org');
  if (who.kind !== 'org') return;
  assert.equal(who.orgId, orgId);
  assert.equal(who.name, 'ООО УК «Пример»');
});

test('организации нет, но есть председатель — адресат совет дома', async () => {
  const db = testDb();
  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Петров Пётр' });
  await db.insert(chairman).values({
    id: newId('chr'), houseKey: HOUSE, userId, name: 'Петров Пётр', orgId: null,
  });
  const propertyId = await makeProperty();

  const who = await addresseeForProperty(db, propertyId);
  assert.equal(who.kind, 'chairman');
  if (who.kind !== 'chairman') return;
  assert.equal(who.name, 'Петров Пётр');
});

test('нет никого — адресата нет, и это отдельное состояние', async () => {
  const db = testDb();
  const propertyId = await makeProperty();

  const who = await addresseeForProperty(db, propertyId);
  assert.equal(who.kind, 'none');
});

test('организация сильнее председателя: жалобу чинит тот, кто обязан', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000006', name: 'ООО УК «Обе»', regionCode: '61',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская',
  });
  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Петров Пётр' });
  await db.insert(chairman).values({
    id: newId('chr'), houseKey: HOUSE, userId, name: 'Петров Пётр', orgId,
  });
  const propertyId = await makeProperty();

  const who = await addresseeForProperty(db, propertyId);
  assert.equal(who.kind, 'org');
});

/* ─────────── контакт адресата и наличие кабинета ─────────── */

/**
 * Телефон адресата обязан приходить с сервера.
 *
 * До аудита 11 сентября в карточке обращения стоял литерал
 * «+7 (495) 123-45-67 · будни 8:00–20:00» — выдуманный московский номер,
 * при том что настоящий телефон организации лежит в реестре. Заглушка
 * в приложении, где правило «данные — только настоящие», хуже
 * отсутствующей строки: по ней звонят.
 */
test('адресат-организация отдаёт свой настоящий телефон', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000005', name: 'ООО УК «Пример»', regionCode: '61',
    phone: '+7(863)310-16-70',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская',
  });
  const propertyId = await makeProperty();

  const who = await addresseeForProperty(db, propertyId);
  assert.equal(who.kind, 'org');
  if (who.kind !== 'org') return;
  assert.equal(who.phone, '+7(863)310-16-70');
});

test('телефона у организации нет — поле пустое, а не выдуманное', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000006', name: 'ООО УК «Без телефона»', regionCode: '61',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская',
  });
  const propertyId = await makeProperty();

  const who = await addresseeForProperty(db, propertyId);
  assert.equal(who.kind, 'org');
  if (who.kind !== 'org') return;
  assert.equal(who.phone, null);
});

/**
 * Организация из реестра ≠ живой адресат.
 *
 * Измерено 11 сентября: в реестре 14 221 дом области, кабинет диспетчера
 * есть у восьми. Остальным приложение обещало «диспетчер увидит заявку
 * сразу, статус придёт уведомлением» — и молчало навсегда. Отличить
 * одно от другого можно только наличием строки в `dispatcher`.
 */
test('организация есть, кабинета нет — адресат это знает', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000007', name: 'ООО «Элита-сервис»', regionCode: '61',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская',
  });
  const propertyId = await makeProperty();

  const who = await addresseeForProperty(db, propertyId);
  assert.equal(who.kind, 'org');
  if (who.kind !== 'org') return;
  assert.equal(who.hasCabinet, false, 'кабинета нет — обещать диспетчера нельзя');
});

test('у организации есть кабинет — тогда диспетчер действительно увидит', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000008', name: 'ООО «УК Трианон»', regionCode: '61',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская',
  });
  await db.insert(dispatcher).values({
    id: newId('dsp'), orgId, login: 'uk-trianon', passwordHash: 'x', name: 'Диспетчер',
  });
  const propertyId = await makeProperty();

  const who = await addresseeForProperty(db, propertyId);
  assert.equal(who.kind, 'org');
  if (who.kind !== 'org') return;
  assert.equal(who.hasCabinet, true);
});

/* ─────────── срок реакции ─────────── */

/**
 * Срок реакции — это время, за которое адресат обязан ответить.
 *
 * Когда адресата нет, обязываться некому, и таймер превращается
 * в обвинение: через сутки житель видел красное «Срок вышел ·
 * просрочено на 3 часа» у дома, о заявке которого никто не знает.
 * Проверено на живом стенде 11 сентября.
 */
test('кабинета нет — срок реакции не назначается', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000009', name: 'ООО «Без кабинета»', regionCode: '61',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская',
  });
  const propertyId = await makeProperty('31');
  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Жалобщик Иван' });
  await db.insert(userProperty).values({
    id: newId('ubd'), userId, propertyId, role: 'member', status: 'pending', inviteCode: 'AAA111',
  });

  const res = await createRequest(db, {
    userId, propertyId, kind: 'complaint', category: 'Сантехника',
    title: 'Течёт труба', description: 'Течёт труба под раковиной на кухне',
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const [row] = await db.select().from(request).where(eq(request.id, res.id));
  assert.equal(row.slaDueAt, null, 'срока быть не должно — реагировать некому');

  const [event] = await db.select().from(requestEvent).where(eq(requestEvent.requestId, res.id));
  assert.ok(
    !event.text.includes('диспетчером'),
    `первая строка истории не должна обещать диспетчера, а она: «${event.text}»`,
  );
});

test('кабинет есть — срок реакции назначается как прежде', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000010', name: 'ООО «С кабинетом»', regionCode: '61',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская',
  });
  await db.insert(dispatcher).values({
    id: newId('dsp'), orgId, login: 'uk-live', passwordHash: 'x', name: 'Диспетчер',
  });
  const propertyId = await makeProperty('32');
  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Жалобщик Пётр' });
  await db.insert(userProperty).values({
    id: newId('ubd'), userId, propertyId, role: 'member', status: 'active', inviteCode: 'BBB222',
  });

  const res = await createRequest(db, {
    userId, propertyId, kind: 'complaint', category: 'Сантехника',
    title: 'Течёт труба', description: 'Течёт труба под раковиной на кухне',
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const [row] = await db.select().from(request).where(eq(request.id, res.id));
  assert.ok(row.slaDueAt instanceof Date, 'у живого адресата срок обязан быть');

  const [event] = await db.select().from(requestEvent).where(eq(requestEvent.requestId, res.id));
  assert.equal(event.text, 'Заявка принята диспетчером');
});

/**
 * Кабинет появился — срок пошёл.
 *
 * Находка аудита 26 сентября: заявка «Авария: течёт стояк», поданная
 * до подключения УК, так и висела у диспетчера «без срока» — срок
 * ставился только в момент подачи. Теперь он стартует, когда адресат
 * появился: считается от подключения кабинета, а не задним числом.
 */
test('когда у УК появляется кабинет, у её открытых заявок стартует срок', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({ id: orgId, inn: '6100000009', name: 'ООО УК «Поздняя»', regionCode: '61' });
  await insertRegistryHouse(db, { houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская' });
  const propertyId = await makeProperty();
  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Житель Дома' });
  await db.insert(userProperty).values({ id: newId('ubd'), userId, propertyId, role: 'member', status: 'pending' });

  const res = await createRequest(db, {
    userId, propertyId, kind: 'complaint', category: 'Авария',
    title: 'Течёт стояк', description: 'Течёт стояк в подъезде, заливает',
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;

  const connectedAt = new Date('2026-09-26T10:00:00Z');
  await startClockForOrg(db, orgId, connectedAt);

  const [row] = await db.select().from(request).where(eq(request.id, res.id));
  assert.equal(row.slaDueAt?.toISOString(), '2026-09-26T12:00:00.000Z', 'авария — два часа от подключения');
});
