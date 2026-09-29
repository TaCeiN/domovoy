import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, and } from 'drizzle-orm';
import {
  bindByReceipt, approveBinding, listHousehold, revokeBinding,
  PRIVATE_HOUSE_GRANT, type MaxIdentity,
} from './bind.ts';
import { houseState, setHouseForm } from '../house/form.ts';
import {
  saveClaim, approveClaim, rejectClaim, claimsForChairman, claimsForDispatcher,
  decidersForHouse,
} from './claims.ts';
import { createSession, resolveSession, destroyAllSessionsForUser } from './session.ts';
import { hashPassword } from './password.ts';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { parseAddress } from '../address/normalize.ts';
import { newId } from '../ids.ts';
import {
  property, userProperty, bill, appUser, account, house, uk as ukTable,
  managingOrg, chairman, dispatcher,
} from '../../db/schema.ts';

/**
 * Привязка жителя к квартире.
 *
 * ГЛАВНОЕ ПРАВИЛО, которое проверяет весь файл: квитанция — это заявка,
 * а не пропуск. Раньше первый предъявивший становился собственником
 * на месте, и захват дома стоил одного скрипта: строку платёжного QR
 * можно набрать руками, а сервер отличить её от снятой камерой не может.
 */

const REAL_QR =
  'ST00011|Name=ООО "УК Трианон"|PersonalAcc=40702810952090030727|BankName=ПАО Сбербанк|' +
  'BIC=046015602|CorrespAcc=30101810600000000602|Sum=381630|Purpose=Оплата за ЖКУ|' +
  'PayeeINN=6168108630|PayerINN=|KPP=616801001|lastName=Крутых|firstName=Сергей|' +
  'middleName=Валерьевич|payerAddress=344038, Ростовская обл, г Ростов-на-Дону, ' +
  'пр-кт Ленина, д. 85, к. 3, кв. 27|persAcc=987654331|paymPeriod=042026|category=001';

/** Та же УК и тот же дом, но другая квартира и другой лицевой счёт. */
const NEIGHBOUR_QR = REAL_QR
  .replace('кв. 27', 'кв. 54')
  .replace('persAcc=987654331', 'persAcc=987654332')
  .replace('lastName=Крутых', 'lastName=Иванова')
  .replace('firstName=Сергей', 'firstName=Мария')
  .replace('middleName=Валерьевич', 'middleName=Петровна')
  .replace('Sum=381630', 'Sum=402100');

const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

const sergey: MaxIdentity = {
  maxUserId: 1001, firstName: 'Сергей', lastName: 'Крутых',
  username: 'skrutyh', photoUrl: null, chatId: 5001,
};
const maria: MaxIdentity = {
  maxUserId: 1002, firstName: 'Мария', lastName: 'Иванова',
  username: null, photoUrl: null, chatId: 5002,
};

/**
 * Доступность базы выясняем ДО объявления тестов.
 * Опция { skip } вычисляется в момент объявления, то есть раньше любого
 * хука before — если проверять там, все тесты молча превратятся в пропущенные.
 */
const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await closeTestDb(); });

const db = () => testDb();

/* ─────────────── помощники ─────────────── */

/** Заявка плюс заполненные данные о себе — обычный путь жителя. */
async function claim(qrString: string, identity: MaxIdentity, name: string, flat: string) {
  const r = await bindByReceipt(db(), { qrString, identity });
  assert.equal(r.status, 'pending', 'квитанция должна заводить заявку');
  if (r.status !== 'pending') throw new Error('unreachable');

  const saved = await saveClaim(db(), r.userId, r.bindingId, { name, flat });
  assert.equal(saved.ok, true);
  return r;
}

/** Дом в реестре плюс председатель — тот, кто решает. */
async function seedChairman(address = HOUSE) {
  const houseKey = parseAddress(address).houseKey;

  const [org] = await db().insert(managingOrg).values({
    id: newId('org'), inn: '6168108630', name: 'ООО «УК Трианон»', regionCode: '61',
  }).onConflictDoNothing().returning({ id: managingOrg.id });

  const orgId = org?.id ?? (await db()
    .select({ id: managingOrg.id }).from(managingOrg)
    .where(eq(managingOrg.inn, '6168108630')).limit(1))[0].id;

  await insertRegistryHouse(db(), {
    houseKey, orgId, regionCode: '61', addressRaw: address,
  });

  /**
   * Председатель — это житель дома, поэтому у него должен быть аккаунт.
   * Заводим отдельного человека: в реальности УК выбирает его из тех,
   * кто уже предъявил квитанцию по этому дому.
   */
  const [user] = await db().insert(appUser).values({
    id: newId('usr'), fullName: 'Председатель Пётр',
  }).returning({ id: appUser.id });

  const chairmanId = newId('chr');
  await db().insert(chairman).values({
    id: chairmanId, orgId, houseKey, userId: user.id, name: 'Председатель Пётр',
  });

  return { chairmanId, chairmanUserId: user.id, orgId, houseKey };
}

/* ─────────────── квитанция как заявка ─────────────── */

test('первый скан свободного счёта НЕ делает человека собственником', { skip }, async () => {
  const r = await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });

  assert.equal(r.status, 'pending', 'квитанция даёт заявку, а не доступ');
  if (r.status !== 'pending') return;

  const rows = await db().select().from(userProperty)
    .where(eq(userProperty.userId, r.userId));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.notEqual(rows[0].role, 'owner');
});

/**
 * Ровно тот сценарий, который проверялся на живом стенде: посторонний
 * набирает строку QR руками, зная только номер счёта и ИНН получателя.
 */
test('придуманная квитанция не открывает квартиру', { skip }, async () => {
  const forged = REAL_QR.replace('persAcc=987654331', 'persAcc=100000001');

  const r = await bindByReceipt(db(), { qrString: forged });
  assert.equal(r.status, 'pending');
  if (r.status !== 'pending') return;

  const active = await db().select().from(userProperty)
    .where(and(eq(userProperty.userId, r.userId), eq(userProperty.status, 'active')));

  assert.equal(active.length, 0, 'ни одной активной привязки быть не должно');
});

test('ответ на занятый и на свободный счёт неотличим', { skip }, async () => {
  const first = await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  const second = await bindByReceipt(db(), { qrString: REAL_QR, identity: maria });

  /**
   * Раньше здесь были разные ответы: «этот счёт уже привязан» против
   * молчаливого входа. По ним перебирались номера счетов — сервер сам
   * сообщал, какой из них занят.
   */
  assert.equal(first.status, 'pending');
  assert.equal(second.status, 'pending');
});

test('повторный скан той же квитанции не плодит заявки', { skip }, async () => {
  const first = await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });

  assert.equal(first.status, 'pending');
  if (first.status !== 'pending') return;

  const rows = await db().select().from(userProperty)
    .where(eq(userProperty.userId, first.userId));
  assert.equal(rows.length, 1);
});

test('квитанция сохраняется, сумма остаётся копейками', { skip }, async () => {
  await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });

  const bills = await db().select().from(bill);
  assert.equal(bills.length, 1);
  assert.equal(bills[0].sumKopecks, 381630);
  assert.equal(bills[0].period, '2026-04');
});

/**
 * Неподтверждённый может добавить период, которого нет, но не переписать
 * известную сумму: иначе посторонний правил бы деньги в чужой квартире.
 */
test('неподтверждённый не переписывает чужие начисления', { skip }, async () => {
  await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });

  const forged = REAL_QR.replace('Sum=381630', 'Sum=99999900');
  await bindByReceipt(db(), { qrString: forged, identity: maria });

  const bills = await db().select().from(bill);
  assert.equal(bills.length, 1);
  assert.equal(bills[0].sumKopecks, 381630, 'сумма осталась прежней');
});

/**
 * Лицевой счёт не переезжает на объект того, кто прислал запрос.
 * Раньше конфликт по паре «организация + счёт» безусловно переписывал
 * property_id: у жертвы счёт исчезал из кабинета, у постороннего появлялся.
 */
test('чужой лицевой счёт не переезжает на другой адрес', { skip }, async () => {
  const victim = await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  assert.equal(victim.status, 'pending');
  if (victim.status !== 'pending') return;

  const hijack = REAL_QR.replace('д. 85, к. 3, кв. 27', 'д. 99, кв. 7');
  await bindByReceipt(db(), { qrString: hijack, identity: maria });

  const accounts = await db().select().from(account)
    .where(eq(account.persAcc, '987654331'));

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].propertyId, victim.propertyId, 'счёт остался на своей квартире');
});

test('битый QR не создаёт ничего', { skip }, async () => {
  const r = await bindByReceipt(db(), { qrString: 'просто текст', identity: sergey });

  assert.equal(r.status, 'invalid_qr');
  assert.equal((await db().select().from(property)).length, 0);
  assert.equal((await db().select().from(appUser)).length, 0);
});

test('соседи по дому получают один houseKey, но разные объекты', { skip }, async () => {
  await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  await bindByReceipt(db(), { qrString: NEIGHBOUR_QR, identity: maria });

  const rows = await db().select().from(property);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].houseKey, rows[1].houseKey, 'дом один');
  assert.notEqual(rows[0].flat, rows[1].flat, 'квартиры разные');
});

/* ─────────────── данные о себе ─────────────── */

test('без имени и квартиры заявку подтвердить нельзя', { skip }, async () => {
  const { chairmanId, houseKey } = await seedChairman();

  const r = await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  assert.equal(r.status, 'pending');
  if (r.status !== 'pending') return;

  const decided = await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, r.bindingId, 'owner',
  );

  assert.equal(decided.ok, false);
  if (decided.ok) return;
  assert.equal(decided.reason, 'incomplete');
});

test('данные о себе можно поправить, пока заявка не решена', { skip }, async () => {
  const r = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  if (r.status !== 'pending') return;

  const again = await saveClaim(db(), r.userId, r.bindingId, {
    name: 'Крутых Сергей Валерьевич', flat: '27', note: 'живу с 2019 года',
  });
  assert.equal(again.ok, true);

  const [row] = await db().select().from(userProperty)
    .where(eq(userProperty.id, r.bindingId));
  assert.equal(row.claimName, 'Крутых Сергей Валерьевич');
  assert.equal(row.claimNote, 'живу с 2019 года');
});

test('чужую заявку не отредактировать', { skip }, async () => {
  const mine = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  const other = await claim(NEIGHBOUR_QR, maria, 'Иванова Мария', '54');
  if (mine.status !== 'pending' || other.status !== 'pending') return;

  const result = await saveClaim(db(), other.userId, mine.bindingId, {
    name: 'Захватчик Захар', flat: '27',
  });

  assert.equal(result.ok, false);
});

/* ─────────────── решение председателя ─────────────── */

test('ПЕТЛЯ: заявка → председатель подтверждает → житель внутри', { skip }, async () => {
  const { chairmanId, houseKey } = await seedChairman();
  const r = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  if (r.status !== 'pending') return;

  const queue = await claimsForChairman(db(), houseKey);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].claimedName, 'Крутых Сергей');
  assert.equal(queue[0].claimedFlat, '27');
  assert.equal(queue[0].viaMax, true, 'личность подтверждена платформой');
  assert.equal(queue[0].complete, true);

  const decided = await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, r.bindingId, 'owner',
  );
  assert.equal(decided.ok, true);

  const [row] = await db().select().from(userProperty)
    .where(eq(userProperty.id, r.bindingId));
  assert.equal(row.status, 'active');
  assert.equal(row.role, 'owner', 'после подтверждения пишется собственник');
  assert.equal(row.decidedByChairmanId, chairmanId);

  // Повторный скан той же квитанции — теперь обычный вход
  const again = await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  assert.equal(again.status, 'ok');
});

test('председатель чужого дома заявку не видит и не решает', { skip }, async () => {
  await seedChairman();
  const other = await seedChairman('344038, Ростовская обл, г Ростов-на-Дону, ул Другая, д 1');

  const r = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  if (r.status !== 'pending') return;

  assert.equal((await claimsForChairman(db(), other.houseKey)).length, 0);

  const decided = await approveClaim(
    db(), { kind: 'chairman', id: other.chairmanId, houseKey: other.houseKey },
    r.bindingId, 'owner',
  );
  assert.equal(decided.ok, false);
});

test('отказ объясняется, и человек может подать заявку заново', { skip }, async () => {
  const { chairmanId, houseKey } = await seedChairman();
  const r = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  if (r.status !== 'pending') return;

  const rejected = await rejectClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, r.bindingId,
    'В 27-й живёт другая семья',
  );
  assert.equal(rejected.ok, true);

  const [row] = await db().select().from(userProperty)
    .where(eq(userProperty.id, r.bindingId));
  assert.equal(row.status, 'revoked');
  assert.equal(row.rejectReason, 'В 27-й живёт другая семья');

  // Повторное сканирование открывает заявку заново, а не удовлетворяет её
  const again = await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  assert.equal(again.status, 'pending');

  const [after] = await db().select().from(userProperty)
    .where(eq(userProperty.id, r.bindingId));
  assert.equal(after.status, 'pending');
  assert.equal(after.rejectReason, null, 'прежняя причина отказа снимается');
});

test('второго собственника у квартиры не бывает', { skip }, async () => {
  const { chairmanId, houseKey } = await seedChairman();

  const first = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  const second = await claim(REAL_QR, maria, 'Иванова Мария', '27');
  if (first.status !== 'pending' || second.status !== 'pending') return;

  const one = await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, first.bindingId, 'owner',
  );
  assert.equal(one.ok, true);

  const two = await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, second.bindingId, 'owner',
  );
  assert.equal(two.ok, false);
  if (two.ok) return;
  assert.equal(two.reason, 'owner_taken');

  // А жильцом — пожалуйста: на квартире живёт не один человек
  const asMember = await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, second.bindingId, 'member',
  );
  assert.equal(asMember.ok, true);
});

/* ─────────────── запасной путь: диспетчер УК ─────────────── */

/**
 * Дом без председателя: подтвердить некому, и это надо СКАЗАТЬ.
 *
 * Раньше в этом месте заявку разбирал диспетчер УК. Отменено: он заходит
 * в кабинет хорошо если раз в месяц. Признак `dispatcher` означает не
 * «УК подтвердит» и не просто «дом есть в реестре», а «у организации
 * есть СВОЙ КАБИНЕТ — туда можно попросить зайти и назначить председателя».
 * Организация без кабинета (типичный случай ТСЖ/ЖСК, заведённых оператором
 * командой `house:org`) — тот же тупик, что дом вовсе без организации,
 * поэтому тест заводит диспетчеру настоящий кабинет.
 */
test('без председателя подтвердить некому, но это видно жителю', { skip }, async () => {
  const houseKey = parseAddress(HOUSE).houseKey;

  const [org] = await db().insert(managingOrg).values({
    id: newId('org'), inn: '6168108630', name: 'ООО «УК Трианон»', regionCode: '61',
  }).returning({ id: managingOrg.id });
  await insertRegistryHouse(db(), {
    houseKey, orgId: org.id, regionCode: '61', addressRaw: HOUSE,
  });
  await db().insert(dispatcher).values({
    id: newId('dsp'), orgId: org.id, login: 'trianon-dispatcher', passwordHash: 'x', name: 'Диспетчер',
  });

  const deciders = await decidersForHouse(db(), houseKey);
  assert.equal(deciders.chairman, false, 'председателя нет');
  assert.equal(deciders.dispatcher, true, 'у организации есть кабинет — её есть кого попросить');

  const r = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  if (r.status !== 'pending') return;

  // Заявка видна УК только для сведения
  const queue = await claimsForDispatcher(db(), org.id);
  assert.equal(queue.length, 1);

  // И остаётся неподтверждённой: решать некому
  const [row] = await db().select().from(userProperty)
    .where(eq(userProperty.id, r.bindingId));
  assert.equal(row.status, 'pending');
});

test('дом без реестра и без председателя честно говорит, что ждать некого', { skip }, async () => {
  const r = await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  assert.equal(r.status, 'pending');
  if (r.status !== 'pending') return;

  assert.equal(r.hasChairman, false);

  const [row] = await db().select().from(property).where(eq(property.id, r.propertyId));
  const deciders = await decidersForHouse(db(), row.houseKey);
  assert.equal(deciders.chairman, false);
  assert.equal(deciders.dispatcher, false);
});

/* ─────────────── домочадцы ─────────────── */

test('собственник подтверждает домочадца, но только жильцом', { skip }, async () => {
  const { chairmanId, houseKey } = await seedChairman();

  const ownerClaim = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  if (ownerClaim.status !== 'pending') return;
  await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, ownerClaim.bindingId, 'owner',
  );

  const memberClaim = await claim(REAL_QR, maria, 'Крутых Мария', '27');
  if (memberClaim.status !== 'pending') return;

  const ok = await approveBinding(db(), ownerClaim.userId, memberClaim.bindingId);
  assert.equal(ok, true);

  const [row] = await db().select().from(userProperty)
    .where(eq(userProperty.id, memberClaim.bindingId));
  assert.equal(row.status, 'active');
  assert.equal(row.role, 'member', 'собственников штампует только председатель');
});

test('подтвердить домочадца может только собственник', { skip }, async () => {
  const { chairmanId, houseKey } = await seedChairman();

  const ownerClaim = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  const memberClaim = await claim(REAL_QR, maria, 'Крутых Мария', '27');
  if (ownerClaim.status !== 'pending' || memberClaim.status !== 'pending') return;

  await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, ownerClaim.bindingId, 'owner',
  );

  // Сам себя подтвердить нельзя
  assert.equal(await approveBinding(db(), memberClaim.userId, memberClaim.bindingId), false);
});

test('список жильцов показывает собственника и ожидающего доступа', { skip }, async () => {
  const { chairmanId, houseKey } = await seedChairman();

  const ownerClaim = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  const memberClaim = await claim(REAL_QR, maria, 'Крутых Мария', '27');
  if (ownerClaim.status !== 'pending' || memberClaim.status !== 'pending') return;

  await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, ownerClaim.bindingId, 'owner',
  );

  const data = await listHousehold(db(), ownerClaim.userId, ownerClaim.propertyId);
  assert.ok(data);
  assert.equal(data!.canManage, true);
  assert.equal(data!.members.length, 2);
  assert.equal(data!.members.filter((m) => m.status === 'pending').length, 1);
});

test('посторонний вообще не получает состав жильцов', { skip }, async () => {
  const { chairmanId, houseKey } = await seedChairman();
  const ownerClaim = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  if (ownerClaim.status !== 'pending') return;
  await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, ownerClaim.bindingId, 'owner',
  );

  const stranger = await claim(NEIGHBOUR_QR, maria, 'Иванова Мария', '54');
  if (stranger.status !== 'pending') return;

  assert.equal(await listHousehold(db(), stranger.userId, ownerClaim.propertyId), null);
});

test('отзыв доступа гасит сессии домочадца сразу же', { skip }, async () => {
  const { chairmanId, houseKey } = await seedChairman();

  const ownerClaim = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  const memberClaim = await claim(REAL_QR, maria, 'Крутых Мария', '27');
  if (ownerClaim.status !== 'pending' || memberClaim.status !== 'pending') return;

  await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, ownerClaim.bindingId, 'owner',
  );
  await approveBinding(db(), ownerClaim.userId, memberClaim.bindingId);

  const { token } = await createSession(db(), memberClaim.userId, 'max');
  assert.ok(await resolveSession(db(), token), 'сессия живая');

  const revoked = await revokeBinding(db(), ownerClaim.userId, memberClaim.bindingId);
  assert.equal(revoked.ok, true);
  if (!revoked.ok) return;

  await destroyAllSessionsForUser(db(), revoked.revokedUserId);
  assert.equal(await resolveSession(db(), token), null, 'сессия погашена');
});

test('жилец не может отозвать доступ ни у собственника, ни у себя', { skip }, async () => {
  const { chairmanId, houseKey } = await seedChairman();

  const ownerClaim = await claim(REAL_QR, sergey, 'Крутых Сергей', '27');
  const memberClaim = await claim(REAL_QR, maria, 'Крутых Мария', '27');
  if (ownerClaim.status !== 'pending' || memberClaim.status !== 'pending') return;

  await approveClaim(
    db(), { kind: 'chairman', id: chairmanId, houseKey }, ownerClaim.bindingId, 'owner',
  );
  await approveBinding(db(), ownerClaim.userId, memberClaim.bindingId);

  assert.equal((await revokeBinding(db(), memberClaim.userId, ownerClaim.bindingId)).ok, false);
  assert.equal((await revokeBinding(db(), memberClaim.userId, memberClaim.bindingId)).ok, false);
});

/* ─────────────── несколько адресов и MAX ─────────────── */

test('вошедший житель добавляет второй адрес в свой аккаунт, а не заводит новый', { skip }, async () => {
  const first = await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  assert.equal(first.status, 'pending');
  if (first.status !== 'pending') return;

  const second = await bindByReceipt(db(), {
    qrString: NEIGHBOUR_QR,
    existingUserId: first.userId,
  });
  assert.equal(second.status, 'pending');
  if (second.status !== 'pending') return;

  assert.equal(second.userId, first.userId, 'аккаунт тот же');
  assert.equal((await db().select().from(appUser)).length, 1);

  const bindings = await db().select().from(userProperty)
    .where(eq(userProperty.userId, first.userId));
  assert.equal(bindings.length, 2, 'два адреса у одного человека');
});

test('chat_id из MAX сохраняется — без него некуда слать уведомление', { skip }, async () => {
  await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });

  const [row] = await db().select().from(appUser)
    .where(eq(appUser.maxUserId, sergey.maxUserId));
  assert.equal(row.maxChatId, 5001);
});

test('подделанный токен сессии не проходит', { skip }, async () => {
  assert.equal(await resolveSession(db(), 'явно-не-настоящий-токен'), null);
});

test('УК заводится один раз на ИНН', { skip }, async () => {
  await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });
  await bindByReceipt(db(), { qrString: NEIGHBOUR_QR, identity: maria });

  const { uk } = await import('../../db/schema.ts');
  assert.equal((await db().select().from(uk)).length, 1);
});

/* ─────────────── частный дом ─────────────── */

/**
 * ЕДИНСТВЕННОЕ место продукта, где подтверждённый доступ выдаётся без
 * решения живого человека. Условия проверяет canOwnPrivateHouse
 * (см. private-house.test.ts), а здесь — подключение: что именно
 * записывается в базу и что уходит наружу.
 */
const PRIVATE_QR =
  'ST00011|Name=АО "Ростовводоканал"|PersonalAcc=40702810100000000123|BankName=ПАО Сбербанк|' +
  'BIC=046015602|CorrespAcc=30101810600000000602|Sum=112400|Purpose=Оплата за водоснабжение|' +
  'PayeeINN=6167081833|PayerINN=|KPP=616701001|lastName=Крутых|firstName=Сергей|' +
  'middleName=Валерьевич|payerAddress=346720, Ростовская обл, Аксайский р-н, ' +
  'ст-ца Старочеркасская, ул Садовая, д. 17|persAcc=770011223|paymPeriod=042026|category=001';

const PRIVATE_HOUSE_KEY = parseAddress(
  '346720, Ростовская обл, Аксайский р-н, ст-ца Старочеркасская, ул Садовая, д. 17',
).houseKey;

test('частный дом: правило впускает хозяином сразу', { skip }, async () => {
  const r = await bindByReceipt(db(), {
    qrString: PRIVATE_QR, identity: sergey, declaredPrivate: true,
  });

  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;
  assert.equal(r.role, 'owner');
  assert.equal(r.firstTime, true);

  // Получатель платежа у частного дома есть всегда — здесь это водоканал
  const [payee] = await db().select().from(ukTable).where(eq(ukTable.inn, '6167081833'));
  assert.equal(r.ukId, payee.id, 'ukId — получатель из квитанции, а не «УК»');

  const [row] = await db().select().from(userProperty)
    .where(eq(userProperty.userId, r.userId));
  assert.equal(row.status, 'active');
  assert.equal(row.role, 'owner');

  /**
   * След решения. Разбирать жалобу «у меня забрали дом» будут по этой
   * строке: время решения есть, а живого человека за ним нет.
   */
  assert.ok(row.decidedAt, 'момент решения записан');
  assert.equal(row.decidedByChairmanId, null);
  assert.equal(row.decidedByDispatcherId, null);
  assert.equal(row.invitedBy, PRIVATE_HOUSE_GRANT, 'видно, что доступ выдало правило');
});

test('частный дом: без слова человека всё по-прежнему — заявка', { skip }, async () => {
  const r = await bindByReceipt(db(), { qrString: PRIVATE_QR, identity: sergey });

  assert.equal(r.status, 'pending');
  if (r.status !== 'pending') return;

  const [row] = await db().select().from(userProperty)
    .where(eq(userProperty.id, r.bindingId));
  assert.equal(row.status, 'pending');
  assert.notEqual(row.role, 'owner');
});

/**
 * Отказ — это решение живого человека, и отменять его автоматом нельзя.
 * Иначе получивший «нет» просто сканировал бы ещё раз, поставив галочку
 * «частный дом», и входил бы хозяином мимо того, кто ему отказал.
 */
/**
 * Признак многоквартирности приходит сам, из самих квитанций.
 *
 * Реестр лицензий знает только дома лицензированных УК — про ТСЖ
 * и непосредственное управление он молчит. Значит единственное, что
 * доказывает многоквартирность такого дома, это его же жители: пришёл
 * человек с номером квартиры — дом многоквартирный, и объявить его
 * своим частным больше нельзя.
 */
test('квитанция с номером квартиры помечает дом многоквартирным', { skip }, async () => {
  await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey });

  const state = await houseState(db(), parseAddress(HOUSE).houseKey);
  assert.equal(state.multiFlat, true);

  // И правило частного дома на этом доме теперь не сработает
  const r = await bindByReceipt(db(), {
    qrString: REAL_QR.replace(', кв. 27', ''), identity: maria, declaredPrivate: true,
  });
  assert.equal(r.status, 'pending', 'дом с квартирами частным не бывает');
});

test('квитанция без номера квартиры дом многоквартирным не объявляет', { skip }, async () => {
  await bindByReceipt(db(), { qrString: PRIVATE_QR, identity: sergey });

  const state = await houseState(db(), PRIVATE_HOUSE_KEY);
  assert.notEqual(state.multiFlat, true, 'пустая квартира — это «неизвестно», а не «частный дом»');
});

/**
 * Двойной тап — не выдуманный случай, а самый обычный: связь в мессенджере
 * медленная, кнопка не отвечает мгновенно, человек жмёт ещё раз.
 *
 * ЧЕСТНО О ГРАНИЦАХ ЭТОГО ТЕСТА. Настоящую гонку двух запросов он
 * не воспроизводит: в этом окружении параллельные вызовы успевают
 * разойтись, и тест одинаково проходит и на исправленном коде, и на
 * прежнем. Оставлен как страховка от регрессии — что повторный запрос
 * отвечает и не заводит второй привязки, — а не как доказательство
 * починки. Саму гонку закрывает `onConflictDoNothing` без указания
 * индекса в bind.ts: уникальных индексов у привязки два, и арбитр
 * по одному из них пропускал исключение от другого.
 */
test('частный дом: повторный запрос не роняет и не плодит привязок', { skip }, async () => {
  const results = await Promise.allSettled([
    bindByReceipt(db(), { qrString: PRIVATE_QR, identity: sergey, declaredPrivate: true }),
    bindByReceipt(db(), { qrString: PRIVATE_QR, identity: sergey, declaredPrivate: true }),
  ]);

  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 0, `оба запроса обязаны ответить: ${
    rejected.map((r) => (r as PromiseRejectedResult).reason).join('; ')}`);

  const rows = await db().select().from(userProperty);
  assert.equal(rows.length, 1, 'привязка одна');
  assert.equal(rows[0].status, 'active', 'хозяин остался хозяином');
  assert.equal(rows[0].role, 'owner');
});

test('частный дом: правило не воскрешает отклонённую заявку', { skip }, async () => {
  const first = await bindByReceipt(db(), { qrString: PRIVATE_QR, identity: sergey });
  assert.equal(first.status, 'pending');
  if (first.status !== 'pending') return;

  // Состояние «отказано»: как его получают через председателя, проверяет
  // отдельный тест выше, здесь важен только сам факт отказа
  await db().update(userProperty)
    .set({ status: 'revoked', rejectReason: 'Дом принадлежит другой семье' })
    .where(eq(userProperty.id, first.bindingId));

  const again = await bindByReceipt(db(), {
    qrString: PRIVATE_QR, identity: sergey, declaredPrivate: true,
  });
  assert.equal(again.status, 'pending', 'повторный скан снова только просит');

  const [row] = await db().select().from(userProperty)
    .where(eq(userProperty.id, first.bindingId));
  assert.equal(row.status, 'pending');
  assert.notEqual(row.status, 'active');
});

/**
 * Два случая разнесены по разным тестам НАМЕРЕННО.
 *
 * В одном тесте они мешают друг другу: несработавшее правило всё равно
 * заводит человеку ожидающую привязку, а она делает его жителем дома —
 * и следующая проверка упирается в условие «в доме нет других жителей».
 * Проверка ниже падала бы не потому, что код неверен, а потому, что
 * тест сам себе перекрыл дорогу.
 */
test('форма дома не пишется, когда правило не сработало', { skip }, async () => {
  /**
   * Проверяем ФОРМУ, а не пустоту таблицы: строку о доме заводит ещё
   * и признак многоквартирности, и это законно — он приходит от номера
   * квартиры в квитанции, а не от слов человека о форме управления.
   */
  const forms = async () => (await db().select().from(house)).map((r) => r.form);

  // Обычная квартира: галочка есть, но номер квартиры её перебивает
  await bindByReceipt(db(), { qrString: REAL_QR, identity: sergey, declaredPrivate: true });
  assert.equal((await forms()).includes('private'), false, 'дом частным не объявлен');

  // Частный дом, но без слова человека — тоже ничего
  await bindByReceipt(db(), { qrString: PRIVATE_QR, identity: maria });
  assert.equal((await forms()).includes('private'), false);
});

test('сработавшее правило записывает форму дома и с чьих слов', { skip }, async () => {
  const r = await bindByReceipt(db(), {
    qrString: PRIVATE_QR, identity: maria, declaredPrivate: true,
  });
  assert.equal(r.status, 'ok');
  if (r.status !== 'ok') return;

  const [row] = await db().select().from(house)
    .where(eq(house.houseKey, PRIVATE_HOUSE_KEY));
  assert.equal(row.form, 'private');
  assert.equal(row.source, 'resident');
  assert.equal(row.setBy, r.userId, 'записано, с чьих слов');
});

/**
 * Запись оператора автоматика не отменяет. Раньше `setHouseForm` затирал
 * строку целиком: `form='tsj', orgId=<ТСЖ>` превращалось в `form='private',
 * orgId=null, setBy=null` — вместе с решением оператора исчезал и след.
 */
test('слово оператора о доме правило не затирает', { skip }, async () => {
  await setHouseForm(db(), PRIVATE_HOUSE_KEY, {
    form: 'none', source: 'operator', setBy: 'Оператор Ольга',
  });

  const r = await bindByReceipt(db(), {
    qrString: PRIVATE_QR, identity: sergey, declaredPrivate: true,
  });
  assert.equal(r.status, 'ok', 'сама форма «none» правилу не мешает');

  const [row] = await db().select().from(house)
    .where(eq(house.houseKey, PRIVATE_HOUSE_KEY));
  assert.equal(row.form, 'none', 'форма осталась операторской');
  assert.equal(row.source, 'operator');
  assert.equal(row.setBy, 'Оператор Ольга', 'след человека на месте');
});

/**
 * Многоквартирный дом бывает без УК: ТСЖ, ЖСК и непосредственное
 * управление в реестр лицензий не попадают по определению. Пока правило
 * смотрело только в реестр, у такого дома от захвата оставалось одно
 * слово человека.
 */
test('дом с ТСЖ не отдаётся по слову человека', { skip }, async () => {
  await setHouseForm(db(), PRIVATE_HOUSE_KEY, {
    form: 'tsj', source: 'operator', setBy: 'Оператор Ольга',
  });

  const r = await bindByReceipt(db(), {
    qrString: PRIVATE_QR, identity: sergey, declaredPrivate: true,
  });
  assert.equal(r.status, 'pending', 'дом с общим имуществом частным не бывает');

  const active = await db().select().from(userProperty)
    .where(eq(userProperty.status, 'active'));
  assert.equal(active.length, 0);
});

/**
 * Имя и квартира из заявки — находки аудита 26 сентября.
 *
 * Квитанции расчётных центров часто без ФИО. Человек вписывал имя в форму
 * «расскажите о себе», но оно оседало только в заявке: в приветствии,
 * профиле, кабинете УК, у председателя и в поиске оператора он навсегда
 * оставался «Житель». А номер квартиры из квитанции форма спрашивала
 * заново и без него заявку не принимала.
 */
test('имя из заявки заменяет заглушку «Житель», квартира из квитанции второй раз не нужна', { skip: !(await isDbAvailable()) }, async () => {
  const db = testDb();
  const noName = REAL_QR.replace('lastName=Крутых|firstName=Сергей|middleName=Валерьевич|', '');
  const bound = await bindByReceipt(db, { qrString: noName });
  assert.equal(bound.status, 'pending');
  if (bound.status !== 'pending') return;

  const [before] = await db.select().from(appUser).where(eq(appUser.id, bound.userId));
  assert.equal(before.fullName, 'Житель');

  const saved = await saveClaim(db, bound.userId, bound.bindingId, { name: 'Петрова Галина', flat: '' });
  assert.equal(saved.ok, true, 'кв. 27 уже есть в квитанции — спрашивать её снова незачем');

  const [after] = await db.select().from(appUser).where(eq(appUser.id, bound.userId));
  assert.equal(after.fullName, 'Петрова Галина');
});

test('имя из квитанции заявка не перетирает', { skip: !(await isDbAvailable()) }, async () => {
  const db = testDb();
  const bound = await bindByReceipt(db, { qrString: REAL_QR });
  if (bound.status !== 'pending') return assert.fail('ожидали заявку');

  await saveClaim(db, bound.userId, bound.bindingId, { name: 'Кто-то Другой', flat: '27' });
  const [row] = await db.select().from(appUser).where(eq(appUser.id, bound.userId));
  assert.equal(row.fullName, 'Крутых Сергей Валерьевич');
});
