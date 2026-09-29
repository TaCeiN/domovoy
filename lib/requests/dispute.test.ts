import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { appUser, dispatcher, managingOrg, property, request, requestEvent, userProperty } from '../../db/schema.ts';
import { createRequest, changeStatus, disputeDone } from './service.ts';
import { newId } from '../ids.ts';

/**
 * «Проблема не решена» — находка аудита 26 сентября.
 *
 * УК жала «Выполнено», и у жителя оставалось только «заведите новую»:
 * срок начинался заново, а прежняя заявка числилась выполненной. Для
 * жалобы — ядра продукта — это значит, что закрыть её можно, ничего
 * не сделав. Теперь автор возвращает заявку в работу с объяснением.
 */

const HOUSE = 'ростовская обл|ростов-на-дону|ленина пр-кт|85/3';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

async function doneRequest() {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({ id: orgId, inn: '6100000011', name: 'ООО УК «Спорная»', regionCode: '61' });
  await db.insert(dispatcher).values({ id: newId('dsp'), orgId, login: 'spor', passwordHash: 'x', name: 'Диспетчер' });
  await insertRegistryHouse(db, { houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская' });
  const propertyId = newId('prp');
  await db.insert(property).values({ id: propertyId, addressRaw: 'пр-кт Ленина, д. 85/3, кв. 5', houseKey: HOUSE, flat: '5' });
  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Жалобщица Нина' });
  await db.insert(userProperty).values({ id: newId('ubd'), userId, propertyId, role: 'owner', status: 'active' });

  const res = await createRequest(db, {
    userId, propertyId, kind: 'complaint', category: 'Сантехника',
    title: 'Течёт кран', description: 'Течёт кран в подвале, лужа',
  });
  if (!res.ok) throw new Error('заявка не создалась');
  await changeStatus(db, { requestId: res.id, to: 'in_work', actor: 'dispatcher', ukId: orgId });
  await changeStatus(db, { requestId: res.id, to: 'done', actor: 'dispatcher', ukId: orgId });
  return { db, userId, requestId: res.id };
}

test('автор возвращает выполненную заявку в работу с объяснением', async () => {
  const { db, userId, requestId } = await doneRequest();

  const res = await disputeDone(db, { userId, requestId, text: 'Кран всё так же течёт' });
  assert.equal(res.ok, true);

  const [row] = await db.select().from(request).where(eq(request.id, requestId));
  assert.equal(row.status, 'in_work');
  assert.equal(row.closedAt, null);
  assert.ok(row.slaDueAt instanceof Date, 'у вернувшейся заявки снова идёт срок');

  const events = await db.select().from(requestEvent).where(eq(requestEvent.requestId, requestId));
  assert.ok(events.some((e) => e.actor === 'resident' && e.text === 'Кран всё так же течёт'));
  assert.ok(events.some((e) => /не решена/.test(e.text)));
});

test('без объяснения и чужому вернуть нельзя', async () => {
  const { db, userId, requestId } = await doneRequest();

  const empty = await disputeDone(db, { userId, requestId, text: ' ' });
  assert.equal(empty.ok, false);

  const strangerId = newId('usr');
  await db.insert(appUser).values({ id: strangerId, fullName: 'Посторонний' });
  const stranger = await disputeDone(db, { userId: strangerId, requestId, text: 'Не сделано' });
  assert.equal(stranger.ok, false);
});

/**
 * Переписка говорит, кто и как закрыл заявку.
 *
 * Просьба владельца 27 сентября: в закрытой заявке это было видно только
 * по статусу, а в переписке стояло «Работы выполнены» — без слова о том,
 * что заявка закрыта и кем.
 */
test('события статуса называют закрытие и отклонение прямо', async () => {
  const { db, requestId } = await doneRequest();
  const events = await db.select().from(requestEvent).where(eq(requestEvent.requestId, requestId));
  assert.ok(events.some((e) => e.actor === 'dispatcher' && /взята в работу/i.test(e.text)));
  assert.ok(events.some((e) => e.actor === 'dispatcher' && /закрыта.*выполнен/i.test(e.text)));
});
