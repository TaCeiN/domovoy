import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { appUser, managingOrg, property, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { canOwnPrivateHouse } from './private-house.ts';
import { setHouseForm } from '../house/form.ts';

const HOUSE = 'ростовская обл|аксайский р-н|садовая ул|17';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

const ASKING = { houseKey: HOUSE, flat: '', declaredPrivate: true };

test('все пять условий выполнены — человек становится хозяином', async () => {
  assert.equal(await canOwnPrivateHouse(testDb(), ASKING), true);
});

test('условие 1: у объекта есть номер квартиры — правило не работает', async () => {
  const res = await canOwnPrivateHouse(testDb(), { ...ASKING, flat: '12' });
  assert.equal(res, false);
});

test('условие 2: дом есть в реестре лицензий — значит МКД', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000007', name: 'ООО УК «Реестр»', regionCode: '61',
  });
  await insertRegistryHouse(db, {
    houseKey: HOUSE, orgId, regionCode: '61', addressRaw: 'обл Ростовская',
  });

  assert.equal(await canOwnPrivateHouse(db, ASKING), false);
});

test('условие 3: у дома уже есть объект с квартирой — значит МКД', async () => {
  const db = testDb();
  await db.insert(property).values({
    id: newId('prp'), addressRaw: 'ул Садовая, д. 17', houseKey: HOUSE, flat: '4',
  });

  assert.equal(await canOwnPrivateHouse(db, ASKING), false);
});

test('условие 4: в доме уже есть жители — второй хозяином не становится', async () => {
  const db = testDb();
  const userId = newId('usr');
  const propertyId = newId('prp');
  await db.insert(appUser).values({ id: userId, fullName: 'Первый' });
  await db.insert(property).values({
    id: propertyId, addressRaw: 'ул Садовая, д. 17', houseKey: HOUSE, flat: '',
  });
  await db.insert(userProperty).values({
    id: newId('ubd'), userId, propertyId, role: 'owner', status: 'active',
  });

  assert.equal(await canOwnPrivateHouse(db, ASKING), false);
});

test('условие 5: человек сказал, что у него квартира — верим ему', async () => {
  const res = await canOwnPrivateHouse(testDb(), { ...ASKING, declaredPrivate: false });
  assert.equal(res, false);
});

/**
 * Реестр лицензий по ст. 192 ЖК РФ знает только дома под управлением
 * лицензированных УК: ТСЖ, ЖСК и непосредственного управления там нет
 * по определению. Значит для такого МКД условие 2 молчит — и молчали бы
 * 3 и 4, пока соседи не отсканировали свои квитанции.
 */
for (const form of ['uk', 'tsj', 'zhsk', 'direct'] as const) {
  test(`условие 2а: дом заведён как «${form}» — общее имущество есть, правило молчит`, async () => {
    const db = testDb();
    await setHouseForm(db, HOUSE, { form, source: 'operator', setBy: 'оператор' });

    assert.equal(await canOwnPrivateHouse(db, ASKING), false);
  });
}

/**
 * «Управления нет» и «никто ещё не сказал» — обычное состояние частного
 * дома, а не признак МКД. Отказывать по ним значило бы закрыть правило
 * совсем: у частного дома формы управления не бывает в принципе.
 */
for (const form of ['none', 'unknown', 'private'] as const) {
  test(`форма «${form}» правилу не мешает`, async () => {
    const db = testDb();
    await setHouseForm(db, HOUSE, { form, source: 'operator', setBy: 'оператор' });

    assert.equal(await canOwnPrivateHouse(db, ASKING), true);
  });
}
