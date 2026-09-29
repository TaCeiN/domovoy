import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { parseAddress } from '../address/normalize.ts';
import { responseSpeed, topCategory, monthlyPayment, complaintSummary, paymentSummary } from './stats.ts';
import { resident, complaint, billFor } from './fixtures.ts';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы';
after(async () => { await closeTestDb(); });
beforeEach(async () => { if (available) await resetTables(); });

const ADDRESS = 'обл Ростовская, г Аксай, ул Мира, д. 1';
const KEY = parseAddress(ADDRESS).houseKey;
const NOW = new Date('2026-09-23T12:00:00Z');

test('скорость ответа — по медиане часов', () => {
  assert.equal(responseSpeed([1, 5, 30]), 'day');
  assert.equal(responseSpeed([20, 50, 70]), 'days');
  assert.equal(responseSpeed([80, 100, 2]), 'slow');
  assert.equal(responseSpeed([]), null, 'никто не ответил — сказать нечего');
});

test('частая тема — от 30 % обращений, «Другое» темой не считается', () => {
  assert.equal(topCategory(['Лифт', 'Лифт', 'Сантехника', 'Электрика', 'Электрика', 'Другое']), 'Лифт');
  assert.equal(topCategory(['Лифт', 'Сантехника', 'Электрика', 'Другое']), null, 'у каждой четверть');
  assert.equal(topCategory(['Другое', 'Другое', 'Лифт']), 'Лифт');
});

test('платёж: сумма за период по квартире, среднее по месяцам, медиана по квартирам', () => {
  const bills = [
    { propertyId: 'a', period: '2026-07', sumKopecks: 300_000 },
    { propertyId: 'a', period: '2026-07', sumKopecks: 200_000 },
    { propertyId: 'a', period: '2026-08', sumKopecks: 600_000 },
    { propertyId: 'b', period: '2026-08', sumKopecks: 540_000 },
    { propertyId: 'c', period: '2026-08', sumKopecks: 530_000 },
  ];
  assert.equal(monthlyPayment(bills), 5400);
  assert.equal(monthlyPayment(bills.filter((b) => b.propertyId !== 'c')), null, 'две квартиры — видна чужая квитанция');
});

test('сводка обращений: меньше пяти жалоб — мало данных', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: ADDRESS, garFlats: 60 });
  const who = await resident(db, KEY);
  for (let i = 0; i < 4; i++) await complaint(db, who, { at: new Date('2026-09-01'), answerAfterHours: 2 });
  assert.deepEqual(await complaintSummary(db, KEY, NOW), { enough: false, speed: null, topCategory: null });
});

test('сводка обращений: медиана первого ответа диспетчера и частая тема за год', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: ADDRESS, garFlats: 60 });
  const who = await resident(db, KEY);
  await complaint(db, who, { category: 'Лифт', at: new Date('2026-09-01'), answerAfterHours: 30 });
  await complaint(db, who, { category: 'Лифт', at: new Date('2026-08-01'), answerAfterHours: 40 });
  await complaint(db, who, { category: 'Лифт', at: new Date('2026-07-01'), answerAfterHours: 50 });
  await complaint(db, who, { category: 'Сантехника', at: new Date('2026-06-01'), answerAfterHours: null });
  await complaint(db, who, { category: 'Электрика', at: new Date('2026-05-01'), answerAfterHours: 1 });
  await complaint(db, who, { category: 'Лифт', at: new Date('2025-01-01'), answerAfterHours: 900 });

  assert.deepEqual(await complaintSummary(db, KEY, NOW), { enough: true, speed: 'days', topCategory: 'Лифт' });
});

test('платёж по дому: квитанции за 12 месяцев, от трёх квартир', { skip }, async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: KEY, addressRaw: ADDRESS, garFlats: 60 });
  const a = await resident(db, KEY);
  const b = await resident(db, KEY);
  await billFor(db, a.propertyId, '2026-08', 5000);
  await billFor(db, b.propertyId, '2026-08', 6000);
  assert.equal(await paymentSummary(db, KEY, NOW), null);

  const c = await resident(db, KEY);
  await billFor(db, c.propertyId, '2026-08', 5500);
  await billFor(db, c.propertyId, '2024-01', 90000);
  assert.equal(await paymentSummary(db, KEY, NOW), 5500, 'старая квитанция не в счёт');
});
