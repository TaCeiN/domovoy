import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';
import { account, appUser, bill, property, uk, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { consumptionAnalytics } from './service.ts';

/**
 * Аналитика при НЕСКОЛЬКИХ ЛИЦЕВЫХ СЧЕТАХ.
 *
 * У квартиры столько счетов, сколько квитанций приходит: ЖКУ и свет —
 * разные деньги разным организациям. Пока начисления отдавались строками
 * `bill` как есть, один месяц с двумя квитанциями давал два столбца
 * с одинаковой подписью, «изменение» сравнивало ЖКУ со светом
 * («снизилось на 48%», хотя не снизилось ничего), а прогноз считался
 * по смеси счетов. Это единственное место аудита, где приложение
 * не «неудобно», а врёт.
 */

const HOUSE = 'ростовская обл|ростов-на-дону|ленина пр-кт|85/3';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

/** Квартира с жителем и двумя лицевыми счетами: ЖКУ и свет. */
async function seedFlat() {
  const db = testDb();

  const ukId = newId('uk');
  await db.insert(uk).values({ id: ukId, name: 'ООО УК «Трианон»', inn: '6168108630' });

  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Петров Пётр' });

  const propertyId = newId('prp');
  await db.insert(property).values({
    id: propertyId,
    addressRaw: 'Ростов-на-Дону, пр-кт Ленина, д. 85/3, кв. 33',
    houseKey: HOUSE,
    flat: '33',
    addressSource: 'receipt',
  });

  await db.insert(userProperty).values({
    id: newId('ubd'), userId, propertyId, role: 'owner', status: 'active',
  });

  const housingId = newId('acc');
  const powerId = newId('acc');
  await db.insert(account).values([
    { id: housingId, propertyId, ukId, persAcc: '1234567890', service: 'housing' },
    { id: powerId, propertyId, ukId, persAcc: '9876543210', service: 'electricity' },
  ]);

  return { userId, propertyId, housingId, powerId };
}

async function addBill(accountId: string, propertyId: string, period: string, kopecks: number) {
  await testDb().insert(bill).values({
    id: newId('bil'), accountId, propertyId, period, sumKopecks: kopecks, source: 'qr_scan',
  });
}

test('два счёта за один месяц дают ОДНУ точку с суммой', async () => {
  const { userId, propertyId, housingId, powerId } = await seedFlat();

  await addBill(housingId, propertyId, '2026-03', 580_000);
  await addBill(powerId, propertyId, '2026-03', 300_000);
  await addBill(housingId, propertyId, '2026-04', 600_000);
  await addBill(powerId, propertyId, '2026-04', 309_000);

  const data = await consumptionAnalytics(testDb(), userId, propertyId);
  assert.ok(data);

  const points = data.payments.points;
  assert.equal(points.length, 2, 'месяцев два, а не четыре квитанции');
  assert.deepEqual(points.map((p) => p.period), ['2026-03', '2026-04']);
  assert.equal(points[0].value, 880_000);
  assert.equal(points[1].value, 909_000);

  /**
   * До правки здесь было −48%: сравнивались две последние КВИТАНЦИИ
   * (ЖКУ 6000 ₽ и свет 3090 ₽), а не два месяца.
   */
  assert.equal(data.payments.change, 3, 'сравниваются месяцы, а не счета');
});

test('разбивка последнего месяца показывает, из чего сложилась сумма', async () => {
  const { userId, propertyId, housingId, powerId } = await seedFlat();

  await addBill(housingId, propertyId, '2026-04', 600_000);
  await addBill(powerId, propertyId, '2026-04', 309_000);

  const data = await consumptionAnalytics(testDb(), userId, propertyId);
  assert.ok(data?.payments.latest);

  const latest = data.payments.latest;
  assert.equal(latest.period, '2026-04');
  assert.equal(latest.accountsTotal, 2);
  assert.equal(latest.partial, false, 'квитанции есть по обоим счетам');
  assert.deepEqual(
    latest.parts.map((p) => [p.label, p.kopecks]),
    [['ЖКУ', 600_000], ['Электроэнергия', 309_000]],
    'части идут по убыванию суммы',
  );
  assert.equal(latest.parts[0].persAcc, '1234567890');
});

/**
 * Пропущенный скан не должен выглядеть как «стало дешевле»: это та же
 * ложь, что и два столбца за один месяц, только с другой стороны.
 */
test('месяц без второй квитанции помечен неполным', async () => {
  const { userId, propertyId, housingId, powerId } = await seedFlat();

  await addBill(housingId, propertyId, '2026-03', 580_000);
  await addBill(powerId, propertyId, '2026-03', 300_000);
  await addBill(housingId, propertyId, '2026-04', 600_000);

  const data = await consumptionAnalytics(testDb(), userId, propertyId);
  assert.ok(data?.payments.latest);

  assert.equal(data.payments.latest.partial, true);
  assert.equal(data.payments.latest.accountsTotal, 2);
  assert.equal(data.payments.latest.parts.length, 1);
});

test('прогноз считается по месяцам, а не по отдельным квитанциям', async () => {
  const { userId, propertyId, housingId, powerId } = await seedFlat();

  for (const [period, housing, power] of [
    ['2026-02', 500_000, 300_000],
    ['2026-03', 500_000, 300_000],
    ['2026-04', 500_000, 300_000],
  ] as const) {
    await addBill(housingId, propertyId, period, housing);
    await addBill(powerId, propertyId, period, power);
  }

  const data = await consumptionAnalytics(testDb(), userId, propertyId);
  assert.ok(data?.forecast);

  // Ряд ровный: 8000 ₽ каждый месяц — прогноз обязан быть тем же
  assert.equal(data.forecast.kopecks, 800_000);
});

test('один лицевой счёт: разбивки нет, считать нечего', async () => {
  const { userId, propertyId, housingId } = await seedFlat();
  await testDb().delete(account).where(eq(account.service, 'electricity'));

  await addBill(housingId, propertyId, '2026-04', 600_000);

  const data = await consumptionAnalytics(testDb(), userId, propertyId);
  assert.ok(data?.payments.latest);
  assert.equal(data.payments.latest.accountsTotal, 1);
  assert.equal(data.payments.latest.partial, false);
});
