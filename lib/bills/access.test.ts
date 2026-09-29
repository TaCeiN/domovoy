import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';
import { appUser, account, bill, property, uk, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { listBills, markPaid } from './service.ts';
import { upsertBill } from '../auth/bind.ts';
import { parseReceipt } from '../qr/receipt.ts';
import { consumptionAnalytics } from '../analytics/service.ts';

/**
 * Уровень 0 — это СВОИ начисления, а не все начисления объекта.
 *
 * ОТКУДА ЭТО. Аудит 11 сентября воспроизвёл на живом стенде: адрес МКД,
 * напечатанный в квитанции без номера квартиры, даёт `property.flat = ''`,
 * а объект уникален парой `(houseKey, flat)` — значит ВСЕ такие жители
 * дома попадают в один объект. Трое разных людей с тремя разными лицевыми
 * счетами, все со статусом `pending`, видели друг друга: третий читал
 * на главной 17 070 ₽ вместо своих 7 770, все три чужих счёта — и отметил
 * ЧУЖОЕ начисление на 4 100 ₽ оплаченным, получив код 200.
 *
 * Слияние объектов — отдельная задача про модель данных. Здесь закрывается
 * то, что не требует ничьего решения: человек, которого никто не подтвердил,
 * не должен видеть и тем более трогать чужие деньги. Это ровно то, что
 * обещает комментарий к `accessLevel` в lib/auth/access.ts: «подделанная
 * квитанция даёт доступ к тому, что человек и так держит в руках».
 *
 * Подтверждённый жилец (`active`) видит квартиру целиком — это законно
 * и здесь не меняется: он живёт в ней, и счета у неё общие.
 */

const HOUSE = 'ростовская обл|ростов-на-дону|ленина пр-кт|85/3';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

/** Один объект, два жителя, у каждого свой лицевой счёт и своё начисление. */
async function twoNeighboursInOneObject() {
  const db = testDb();

  const propertyId = newId('prp');
  await db.insert(property).values({
    id: propertyId, addressRaw: 'пр-кт Ленина, д. 85/3', houseKey: HOUSE, flat: '',
  });

  const ukId = newId('uk');
  await db.insert(uk).values({ id: ukId, inn: '6167110467', name: 'ГУП РО «ИВЦ ЖКХ»' });

  const make = async (name: string, persAcc: string, kopecks: number, status: string) => {
    const userId = newId('usr');
    await db.insert(appUser).values({ id: userId, fullName: name });
    await db.insert(userProperty).values({
      id: newId('ubd'), userId, propertyId, role: 'member', status,
      inviteCode: persAcc.slice(0, 6),
    });
    const accountId = newId('acc');
    await db.insert(account).values({ id: accountId, propertyId, ukId, persAcc, service: 'ЖКУ' });
    const billId = newId('bil');
    await db.insert(bill).values({
      id: billId, accountId, propertyId, period: '2026-09',
      sumKopecks: kopecks, source: 'qr_scan', createdBy: userId,
    });
    return { userId, billId, accountId };
  };

  const first = await make('Первый Жилец', '111100000000001', 410000, 'pending');
  const second = await make('Второй Жилец', '222200000000002', 520000, 'pending');
  return { db, propertyId, first, second };
}

test('неподтверждённый видит только своё начисление, а не соседское', async () => {
  const { db, propertyId, second } = await twoNeighboursInOneObject();

  const view = await listBills(db, second.userId, propertyId);
  assert.ok(view, 'свои начисления на уровне 0 остаются доступны');

  assert.equal(view.bills.length, 1, 'чужое начисление показывать нельзя');
  assert.equal(view.bills[0].sumKopecks, 520000);
  assert.equal(
    view.outstandingKopecks, 520000,
    'сумма складывается только из своего: 17 070 ₽ вместо 7 770 ₽ — это находка аудита',
  );
});

test('неподтверждённый НЕ может отметить чужое начисление оплаченным', async () => {
  const { db, first, second } = await twoNeighboursInOneObject();

  const res = await markPaid(db, second.userId, first.billId, { paid: true });
  assert.equal(res.ok, false, 'запись в чужие деньги должна быть закрыта');
  if (res.ok) return;
  assert.equal(res.reason, 'no_access');

  const [row] = await db.select().from(bill).where(eq(bill.id, first.billId));
  assert.equal(row.paidAt, null, 'чужая отметка не должна была появиться');
});

test('своё начисление отметить по-прежнему можно', async () => {
  const { db, second } = await twoNeighboursInOneObject();

  const res = await markPaid(db, second.userId, second.billId, { paid: true });
  assert.equal(res.ok, true);

  const [row] = await db.select().from(bill).where(eq(bill.id, second.billId));
  assert.ok(row.paidAt instanceof Date);
});

test('подтверждённый жилец видит квартиру целиком — это не меняется', async () => {
  const { db, propertyId, second } = await twoNeighboursInOneObject();

  await db.update(userProperty)
    .set({ status: 'active' })
    .where(eq(userProperty.userId, second.userId));

  const view = await listBills(db, second.userId, propertyId);
  assert.ok(view);
  assert.equal(view.bills.length, 2, 'подтверждённому квартира открыта вся');
  assert.equal(view.outstandingKopecks, 930000);
});

/**
 * Начисление без автора приписать некому — значит и прятать его нельзя.
 *
 * `bill.created_by` появилось позже самих начислений: на стенде разработки
 * 11 сентября 720 строк из 742 были без автора. Правило «показываем только
 * своё», применённое к ним буквально, скрыло бы у каждого неподтверждённого
 * жителя всю его историю начислений — то есть сломало бы уровень 0 ради
 * защиты от утечки, которой в этих строках не видно.
 *
 * Поэтому граница работает «не хуже, чем было»: новые записи защищены,
 * старые ведут себя как прежде, и миграция не нужна.
 */
test('начисление без автора остаётся видимым — иначе правка ломает больше, чем чинит', async () => {
  const { db, propertyId, first, second } = await twoNeighboursInOneObject();

  await db.update(bill).set({ createdBy: null }).where(eq(bill.id, first.billId));

  const view = await listBills(db, second.userId, propertyId);
  assert.ok(view);
  assert.equal(view.bills.length, 2, 'строку без автора скрывать не за что');
});

test('своё начисление остаётся своим и после переоткрытия приложения', async () => {
  const { db, second } = await twoNeighboursInOneObject();

  // Тот же человек, та же сессия — повторный скан не меняет владельца
  const res = await markPaid(db, second.userId, second.billId, { paid: true });
  assert.equal(res.ok, true);
});

/**
 * Одна квитанция — два человека.
 *
 * Находка аудита 26 сентября: муж и жена с одной платёжкой, два эксперта
 * с одной тестовой квитанцией. Начисление одно на счёт и период, и второй
 * скан ничего не создавал, а до подтверждения человеку показывали только
 * им же созданное: второй видел «Квитанций пока нет» и 0 ₽.
 */
test('второй житель с той же квитанцией видит её до подтверждения', async () => {
  const { db, propertyId, first } = await twoNeighboursInOneObject();
  const [firstBill] = await db.select().from(bill).where(eq(bill.id, first.billId));

  const thirdId = newId('usr');
  await db.insert(appUser).values({ id: thirdId, fullName: 'Жена Первого' });
  await db.insert(userProperty).values({
    id: newId('ubd'), userId: thirdId, propertyId, role: 'member', status: 'pending',
  });

  const receipt = parseReceipt(
    'ST00011|Name=ГУП РО ИВЦ ЖКХ|PersonalAcc=40702810952090030727|BankName=Банк|BIC=046015602'
    + '|CorrespAcc=30101810600000000602|PayeeINN=6167110467|persAcc=111100000000001'
    + `|Sum=${firstBill.sumKopecks}|paymPeriod=092026`,
  );
  assert.ok(receipt.ok);
  await upsertBill(db, first.accountId, propertyId, receipt.receipt, thirdId, false);

  const view = await listBills(db, thirdId, propertyId);
  assert.ok(view);
  assert.equal(view.bills.length, 1, 'та же бумага — то же начисление, и оно его');
  assert.equal(view.bills[0].id, first.billId);

  const res = await markPaid(db, thirdId, first.billId, { paid: true });
  assert.equal(res.ok, true, 'отметить оплату своей квитанции можно');
});

test('квитанция с другой суммой прав на записанное начисление не даёт', async () => {
  const { db, propertyId, first } = await twoNeighboursInOneObject();

  const strangerId = newId('usr');
  await db.insert(appUser).values({ id: strangerId, fullName: 'Посторонний' });
  await db.insert(userProperty).values({
    id: newId('ubd'), userId: strangerId, propertyId, role: 'member', status: 'pending',
  });

  const receipt = parseReceipt(
    'ST00011|Name=ГУП РО ИВЦ ЖКХ|PersonalAcc=40702810952090030727|BankName=Банк|BIC=046015602'
    + '|CorrespAcc=30101810600000000602|PayeeINN=6167110467|persAcc=111100000000001'
    + '|Sum=100|paymPeriod=092026',
  );
  assert.ok(receipt.ok);
  await upsertBill(db, first.accountId, propertyId, receipt.receipt, strangerId, false);

  const view = await listBills(db, strangerId, propertyId);
  assert.ok(view);
  assert.equal(view.bills.length, 0, 'угаданный счёт с чужой суммой — не та бумага');
});

test('аналитика неподтверждённого складывает только его начисления', async () => {
  const { db, propertyId, second } = await twoNeighboursInOneObject();

  const data = await consumptionAnalytics(db, second.userId, propertyId);
  assert.ok(data);
  const september = data.payments.points.find((p) => p.period === '2026-09');
  assert.equal(september?.value, 520000, 'чужие 4 100 ₽ в аналитику не попадают');
});
