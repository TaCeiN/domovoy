import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { submitReading, listMeters, addMeter, windowState, currentPeriod } from './service.ts';
import { consumptionAnalytics } from '../analytics/service.ts';
import { bindByReceipt } from '../auth/bind.ts';
import { meter, meterReading } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { testDb, resetTables, closeTestDb, grantAccess, isDbAvailable } from '../test-db.ts';

/**
 * Показания и аналитика.
 *
 * Главные проверки — те, что защищают деньги жителя: опечатка на порядок,
 * просроченная поверка, окно приёма. В исходном прототипе не было ничего
 * из этого, кроме «не меньше предыдущего».
 */

const QR =
  'ST00011|Name=ООО "УК Пример"|PayeeINN=6100000001|Sum=485000|paymPeriod=082026|' +
  'lastName=Смирнова|firstName=Анна|middleName=И|' +
  'payerAddress=344038, г Ростов-на-Дону, пр-кт Ленина, д 85, к 3, кв 15|persAcc=4460153';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const db = () => testDb();
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await closeTestDb(); });

async function setup() {
  /**
   * Квитанция заводит ЗАЯВКУ, доступ открывает председатель или УК.
   * Здесь это фикстура: файл про счётчики, а не про модель доступа —
   * её проверяют lib/auth/bind.test.ts и server/routes/auth.test.ts.
   */
  const bound = await bindByReceipt(db(), { qrString: QR });
  if (bound.status !== 'pending') throw new Error('ожидали заявку на доступ');
  await grantAccess();

  const meterId = newId('mtr');
  await db().insert(meter).values({
    id: meterId,
    propertyId: bound.propertyId,
    kind: 'cold',
  });

  return { userId: bound.userId, propertyId: bound.propertyId, meterId };
}

/** Заполняет историю ровным расходом по 5 м³ в месяц. */
async function seedHistory(meterId: string, userId: string, months: string[], step = 5) {
  let value = 200;
  for (const period of months) {
    await db().insert(meterReading).values({
      id: newId('rdg'), meterId, period, value: String(value), createdBy: userId,
    });
    value += step;
  }
  return value;
}

test('окно напоминает о сроке УК с 20 по 25 число', () => {
  assert.equal(windowState(new Date('2026-08-22T10:00:00')).open, true);
  assert.equal(windowState(new Date('2026-08-20T10:00:00')).open, true);
  assert.equal(windowState(new Date('2026-08-25T10:00:00')).open, true);

  const early = windowState(new Date('2026-08-05T10:00:00'));
  assert.equal(early.open, false);
  assert.equal(early.daysLeft, 15);
  assert.match(early.message, /с 20 по 25/);

  const late = windowState(new Date('2026-08-28T10:00:00'));
  assert.equal(late.open, false);
  // Обещать за УК, что показания «учтут в следующем месяце», мы не можем:
  // ни своего приёма, ни договора с ней у приложения нет
  assert.match(late.message, /уточните в квитанции/);
});

test('первые показания принимаются без истории', { skip }, async () => {
  const { userId, meterId } = await setup();
  const r = await submitReading(db(), { userId, meterId, value: '214.3' });

  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.consumption, 0, 'без предыдущих показаний расход неизвестен');
});

test('показания меньше предыдущих отвергаются', { skip }, async () => {
  const { userId, meterId } = await setup();
  await seedHistory(meterId, userId, ['2026-06', '2026-07']);

  const r = await submitReading(db(), { userId, meterId, value: '100', period: '2026-08' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'below_previous');
  assert.equal(r.previous, 205);
});

test('ОПЕЧАТКА НА ПОРЯДОК ловится и объясняется', { skip }, async () => {
  const { userId, meterId } = await setup();
  // История: расход ровно по 5 м³ в месяц, последнее показание 215
  await seedHistory(meterId, userId, ['2026-05', '2026-06', '2026-07']);

  // Человек имел в виду 221.4, но забыл запятую
  const r = await submitReading(db(), { userId, meterId, value: '2214', period: '2026-08' });

  assert.equal(r.ok, false, 'опечатка не должна проходить молча');
  if (r.ok) return;
  assert.match(r.message, /Вы имели в виду 221,4, а не 2214/);
  assert.equal(r.suggested, 221.4, 'исправленное значение — для кнопки «Да, 221,4»');
  assert.ok((r.ratio ?? 0) > 3, 'во сколько раз расход выше обычного');

  /**
   * Код отличается от «введите число»: интерфейс реагирует на них
   * противоположно — там надо чистить поле, здесь показать кнопку
   * «всё верно». По тексту сообщения их не различить.
   */
  assert.equal(r.reason, 'needs_confirmation');

  const notANumber = await submitReading(db(), {
    userId, meterId, value: 'абв', period: '2026-08',
  });
  assert.equal(notANumber.ok, false);
  if (notANumber.ok) return;
  assert.equal(notANumber.reason, 'not_a_number');
});

test('подтверждённый скачок всё-таки принимается', { skip }, async () => {
  const { userId, meterId } = await setup();
  await seedHistory(meterId, userId, ['2026-05', '2026-06', '2026-07']);

  const blocked = await submitReading(db(), { userId, meterId, value: '2214', period: '2026-08' });
  assert.equal(blocked.ok, false);

  // Человек посмотрел и подтвердил: бывает прорыв или приезд родни
  const confirmed = await submitReading(db(), {
    userId, meterId, value: '2214', period: '2026-08', confirmed: true,
  });
  assert.equal(confirmed.ok, true);
});

test('повторная передача за тот же период не проходит', { skip }, async () => {
  const { userId, meterId } = await setup();
  const period = currentPeriod();

  await submitReading(db(), { userId, meterId, value: '214.3', period });
  const second = await submitReading(db(), { userId, meterId, value: '220', period });

  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, 'already_submitted');
  assert.match(second.message, /214\.3/);
});

test('чужой счётчик недоступен', { skip }, async () => {
  const { meterId } = await setup();
  const r = await submitReading(db(), { userId: newId('usr'), meterId, value: '300' });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'no_access');
});

test('список счётчиков показывает предыдущие показания и среднее', { skip }, async () => {
  const { userId, propertyId, meterId } = await setup();
  await seedHistory(meterId, userId, ['2026-05', '2026-06', '2026-07']);

  const meters = await listMeters(db(), userId, propertyId);
  assert.ok(meters);
  assert.equal(meters!.length, 1);
  assert.equal(meters![0].label, 'Холодная вода');
  assert.equal(meters![0].unit, 'м³');
  assert.equal(meters![0].previous, 210);
  assert.equal(meters![0].averageConsumption, 5);
  assert.equal(meters![0].submittedThisPeriod, false);
});

test('аналитика строится на реальных квитанциях', { skip }, async () => {
  const { userId, propertyId } = await setup();

  /**
   * Три месяца квитанций через привязку — как это происходит при сканах.
   * Второй и третий раз сканирует уже вошедший собственник, поэтому
   * передаём его id: без него занятый счёт справедливо спросит, кто это.
   */
  for (const [period, sum] of [['062026', 451000], ['072026', 470500], ['082026', 485000]]) {
    const r = await bindByReceipt(db(), {
      qrString: QR.replace('Sum=485000', `Sum=${sum}`).replace('paymPeriod=082026', `paymPeriod=${period}`),
      existingUserId: userId,
    });
    assert.equal(r.status, 'ok', `квитанция за ${period} должна привязаться`);
  }

  const data = await consumptionAnalytics(db(), userId, propertyId);
  assert.ok(data);
  assert.equal(data!.payments.months, 3);
  assert.equal(data!.payments.points[2].formatted.replace(/ /g, ' '), '4 850,00 ₽');
  assert.equal(data!.payments.change, 3, 'рост с 4705 до 4850 — это 3%');
  assert.ok(data!.forecast, 'прогноз должен быть');
  assert.equal(data!.hint, null, 'данных хватает, подсказка не нужна');
});

test('пустая аналитика объясняет себя, а не выглядит поломкой', { skip }, async () => {
  const { userId, propertyId } = await setup();

  const data = await consumptionAnalytics(db(), userId, propertyId);
  assert.ok(data);
  assert.equal(data!.payments.months, 1, 'только квитанция со входа');
  assert.match(data!.hint!, /Отсканируйте квитанции за прошлые месяцы/);
});

test('расход считается как разница показаний, а не как само показание', { skip }, async () => {
  const { userId, propertyId, meterId } = await setup();
  await seedHistory(meterId, userId, ['2026-05', '2026-06', '2026-07']);

  const data = await consumptionAnalytics(db(), userId, propertyId);
  const series = data!.meters[0];

  assert.equal(series.label, 'Холодная вода');
  // Три показания 200/205/210 дают два месяца расхода по 5
  assert.equal(series.points.length, 2);
  assert.deepEqual(series.points.map((p) => p.value), [5, 5]);
  assert.equal(series.change, 0, 'расход не менялся');
});

test('аналитика чужого объекта недоступна', { skip }, async () => {
  const { propertyId } = await setup();
  assert.equal(await consumptionAnalytics(db(), newId('usr'), propertyId), null);
});

/** Второй счётчик на той же квартире: у каждого своя история. */
async function secondMeter(meterId: string, kind: string) {
  const [row] = await db().select().from(meter).where(eq(meter.id, meterId));
  const id = newId('mtr');
  await db().insert(meter).values({ id, propertyId: row.propertyId, kind });
  return id;
}

test('скачок втрое выше обычного переспрашивается, вдвое — нет', { skip }, async () => {
  const { userId, meterId } = await setup();
  // 200, 205, 210: обычный расход 5 м³
  await seedHistory(meterId, userId, ['2026-05', '2026-06', '2026-07']);

  const twice = await submitReading(db(), { userId, meterId, value: '220', period: '2026-08' });
  assert.equal(twice.ok, true, 'расход 10 при обычных 5 — не повод переспрашивать');

  const hot = await secondMeter(meterId, 'hot');
  await seedHistory(hot, userId, ['2026-05', '2026-06', '2026-07']);

  const fourTimes = await submitReading(db(), { userId, meterId: hot, value: '230', period: '2026-08' });
  assert.equal(fourTimes.ok, false, 'расход 20 при обычных 5 — вопрос');
  if (fourTimes.ok) return;
  assert.equal(fourTimes.reason, 'needs_confirmation');
  assert.equal(fourTimes.suggested, undefined, 'это не опечатка с запятой — исправлять нечего');
});

test('нулевой расход воды подсказывает проверить счётчик, но записывается', { skip }, async () => {
  const { userId, meterId } = await setup();
  await seedHistory(meterId, userId, ['2026-06', '2026-07']); // последнее 205

  const r = await submitReading(db(), { userId, meterId, value: '205', period: '2026-08' });
  assert.equal(r.ok, true, 'ноль не блокирует запись');
  if (!r.ok) return;
  assert.equal(r.warnings[0]?.code, 'zero_consumption', 'и стоит первым: тост показывает первое');
  assert.match(r.warnings[0].message, /крутится ли счётчик/);
});

test('нулевой расход отопления — норма, без подсказки', { skip }, async () => {
  const { userId, meterId } = await setup();
  const heat = await secondMeter(meterId, 'heat');
  await seedHistory(heat, userId, ['2026-06', '2026-07']);

  const r = await submitReading(db(), { userId, meterId: heat, value: '205', period: '2026-08' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(!r.warnings.some((w) => w.code === 'zero_consumption'), 'летом отопление стоит');
});

/**
 * Дневник счётчиков до подтверждения — только свой.
 *
 * Находка аудита 26 сентября: счётчик общий на квартиру, и неподтверждённый
 * человек со строкой QR видел чужие показания и писал в чужой счётчик.
 * Показание одно на месяц — записав первым, посторонний закрывал хозяину
 * его же месяц. А условие `status <> 'revoked'` пускало даже отклонённых.
 */
test('неподтверждённый не видит чужой счётчик и не пишет в него', { skip }, async () => {
  const { userId: ownerId, propertyId } = await setup();
  const ownerMeter = newId('mtr');
  await db().insert(meter).values({ id: ownerMeter, propertyId, kind: 'hot', createdBy: ownerId });

  const stranger = await bindByReceipt(db(), {
    qrString: QR.replace('lastName=Смирнова', 'lastName=Чужой').replace('firstName=Анна', 'firstName=Пётр'),
  });
  assert.equal(stranger.status, 'pending');
  if (stranger.status !== 'pending') return;

  const seen = await listMeters(db(), stranger.userId, propertyId);
  assert.deepEqual(seen, [], 'чужих счётчиков до подтверждения не видно');

  const write = await submitReading(db(), { userId: stranger.userId, meterId: ownerMeter, value: '10' });
  assert.equal(write.ok, false);
  if (!write.ok) assert.equal(write.reason, 'no_access');
});

test('свой счётчик неподтверждённый ведёт, второй такой же — с подписью места', { skip }, async () => {
  const bound = await bindByReceipt(db(), { qrString: QR });
  assert.equal(bound.status, 'pending');
  if (bound.status !== 'pending') return;

  const kitchen = await addMeter(db(), { userId: bound.userId, propertyId: bound.propertyId, kind: 'cold', place: 'Кухня' });
  assert.equal(kitchen.ok, true);
  const bath = await addMeter(db(), { userId: bound.userId, propertyId: bound.propertyId, kind: 'cold', place: 'Ванная' });
  assert.equal(bath.ok, true, 'две холодных воды в квартире — норма');
  const again = await addMeter(db(), { userId: bound.userId, propertyId: bound.propertyId, kind: 'cold', place: 'кухня' });
  assert.equal(again.ok, false, 'та же вода в том же месте — дубль');

  const mine = await listMeters(db(), bound.userId, bound.propertyId);
  assert.equal(mine?.length, 2);
  assert.deepEqual(mine?.map((m) => m.place).sort(), ['Ванная', 'Кухня']);

  if (!kitchen.ok) return;
  const write = await submitReading(db(), { userId: bound.userId, meterId: kitchen.meterId, value: '12' });
  assert.equal(write.ok, true, 'в свой счётчик — можно и до подтверждения');
});
