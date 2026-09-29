import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { eq } from 'drizzle-orm';
import { managingOrg, chairman, appUser, house } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import {
  houseState, setHouseForm, setHouseFormUnlessOperator, markMultiFlat,
} from './form.ts';

const HOUSE = 'ростовская обл|ростов-на-дону|ленина пр-кт|85/3';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

test('дом, о котором ничего не известно, отдаёт unknown', async () => {
  const db = testDb();
  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'unknown');
  assert.equal(state.orgId, null);
  assert.equal(state.hasChairman, false);
});

test('дом из реестра лицензий — это uk, и строку заводить не надо', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000001', name: 'ООО УК «Проверка»', regionCode: '61',
    licenseNumber: '61-000111', licenseStatus: 'action',
  });
  await insertRegistryHouse(db, { houseKey: HOUSE, orgId, addressRaw: 'обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. 85/3' });

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'uk', 'форма выводится из реестра');
  assert.equal(state.orgId, orgId);
  assert.equal(state.multiFlat, true, 'реестр лицензий — это только МКД');
});

test('оператор проставил непосредственное управление — оно перекрывает unknown', async () => {
  const db = testDb();
  await setHouseForm(db, HOUSE, { form: 'direct', source: 'operator', setBy: 'оператор' });

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'direct');
  assert.equal(state.orgId, null);
});

test('запись в реестре сильнее записи оператора: дом забрала УК', async () => {
  const db = testDb();
  await setHouseForm(db, HOUSE, { form: 'none', source: 'operator', setBy: 'оператор' });

  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000002', name: 'ООО УК «Позже»', regionCode: '61',
    licenseNumber: '61-000222', licenseStatus: 'action',
  });
  await insertRegistryHouse(db, { houseKey: HOUSE, orgId, addressRaw: 'обл Ростовская' });

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'uk', 'реестр говорит о доме то, что проверяемо');
  assert.equal(state.orgId, orgId);
});

/**
 * house:org (db/house-admin.ts) кладёт в реестровый слой организации БЕЗ
 * лицензии — ТСЖ и ЖСК, подтянутые по ИНН из справочника ГИС ЖКХ, а не
 * из реестра лицензий. Для них организация в реестре не значит 'uk':
 * форму нужно брать из house, как её реально записал оператор.
 */
test('дом ТСЖ, заведённый оператором: организация без лицензии не перебивает форму', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000003', name: 'ТСЖ «Ленина 85/3»', regionCode: '61',
  });
  await insertRegistryHouse(db, { houseKey: HOUSE, orgId, addressRaw: 'обл Ростовская' });
  await setHouseForm(db, HOUSE, { form: 'tsj', orgId, source: 'operator', setBy: 'cli' });

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'tsj', 'форма — та, что реально записал оператор, а не uk по умолчанию');
  assert.equal(state.orgId, orgId);
  assert.equal(state.multiFlat, true, 'организация по реестру — это всё равно МКД');
});

test('организация без лицензии и без записи в house: форма unknown, но orgId и multiFlat на месте', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6100000004', name: 'ЖСК «Стройка»', regionCode: '61',
  });
  await insertRegistryHouse(db, { houseKey: HOUSE, orgId, addressRaw: 'обл Ростовская' });

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'unknown', 'оператор ещё не проставил форму — не uk и не tsj');
  assert.equal(state.orgId, orgId);
  assert.equal(state.multiFlat, true);
});

test('markMultiFlat ставит признак и не сбрасывает форму', async () => {
  const db = testDb();
  await setHouseForm(db, HOUSE, { form: 'private', source: 'resident' });
  await markMultiFlat(db, HOUSE);

  const state = await houseState(db, HOUSE);
  assert.equal(state.multiFlat, true);
  assert.equal(state.form, 'private', 'форму снимает человек, а не автомат');
});

test('действующий председатель виден в состоянии дома', async () => {
  const db = testDb();
  const userId = newId('usr');
  await db.insert(appUser).values({ id: userId, fullName: 'Иванов Иван' });
  await db.insert(chairman).values({
    id: newId('chr'), houseKey: HOUSE, userId, name: 'Иванов Иван', orgId: null,
  });

  const state = await houseState(db, HOUSE);
  assert.equal(state.hasChairman, true);
});

/**
 * Автоматика не отменяет решение живого человека. Раньше правило частного
 * дома звало обычный setHouseForm и превращало операторское
 * `form='tsj', orgId=<ТСЖ>` в `form='private', orgId=null, setBy=null` —
 * вместе с формой пропадал и след того, кто её ставил.
 */
test('setHouseFormUnlessOperator не трогает запись оператора', async () => {
  const db = testDb();
  await setHouseForm(db, HOUSE, { form: 'tsj', source: 'operator', setBy: 'оператор' });

  const written = await setHouseFormUnlessOperator(db, HOUSE, {
    form: 'private', source: 'resident', setBy: 'usr_1',
  });
  assert.equal(written, false, 'функция честно говорит, что не записала');

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'tsj', 'форма осталась операторской');
});

test('setHouseFormUnlessOperator пишет, когда человека за домом нет', async () => {
  const db = testDb();

  assert.equal(
    await setHouseFormUnlessOperator(db, HOUSE, {
      form: 'private', source: 'resident', setBy: 'usr_1',
    }),
    true,
    'пустой дом заводится',
  );

  // Второй скан того же дома обновляет свою же запись — она не операторская
  assert.equal(
    await setHouseFormUnlessOperator(db, HOUSE, {
      form: 'private', source: 'resident', setBy: 'usr_2',
    }),
    true,
  );

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'private');
});

test('ФНС пометила дом многоквартирным — многоквартирный, даже без квартир в ГАР', async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: HOUSE, addressRaw: 'обл Ростовская' });
  await db.update(house).set({ garMkd: true }).where(eq(house.houseKey, HOUSE));

  const state = await houseState(db, HOUSE);
  assert.equal(state.multiFlat, true);
});

test('ТСЖ по реестру без оператора: форма и организация из набора, дом многоквартирный', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({ id: orgId, inn: '6100000005', name: 'ТСН «Антарес»', regionCode: '61' });
  await insertRegistryHouse(db, { houseKey: HOUSE, orgId, addressRaw: 'обл Ростовская', registryForm: 'tsj' });

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'tsj');
  assert.equal(state.orgId, orgId);
  assert.equal(state.multiFlat, true);
});

test('частный дом по реестру: форма private, дом не многоквартирный', async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: HOUSE, addressRaw: 'обл Ростовская', registryForm: 'private' });

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'private');
  assert.equal(state.orgId, null);
  assert.equal(state.multiFlat, false);
});

test('квартиры в ГАР делают дом многоквартирным, даже если способ управления неизвестен', async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: HOUSE, addressRaw: 'обл Ростовская', registryForm: 'unknown', garFlats: 12 });

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'unknown');
  assert.equal(state.multiFlat, true);
});

test('оператор сильнее реестра без лицензии: его форма перекрывает ТСЖ набора', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({ id: orgId, inn: '6100000006', name: 'ТСЖ «Было»', regionCode: '61' });
  await insertRegistryHouse(db, { houseKey: HOUSE, orgId, addressRaw: 'обл Ростовская', registryForm: 'tsj' });
  await setHouseForm(db, HOUSE, { form: 'direct', source: 'operator', setBy: 'оператор' });

  const state = await houseState(db, HOUSE);
  assert.equal(state.form, 'direct');
});

test('запись оператора не стирает реестровый слой, а загрузка набора — человеческий', async () => {
  const db = testDb();
  await insertRegistryHouse(db, { houseKey: HOUSE, addressRaw: 'обл Ростовская, г Аксай, ул Мира, д. 1', registryForm: 'private' });
  await setHouseForm(db, HOUSE, { form: 'none', source: 'operator', setBy: 'оператор' });

  const [row] = await db.select().from(house).where(eq(house.houseKey, HOUSE));
  assert.equal(row.addressRaw, 'обл Ростовская, г Аксай, ул Мира, д. 1');
  assert.equal(row.registryForm, 'private');
  assert.equal(row.form, 'none');
});
