import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, resetTables, closeTestDb, isDbAvailable, insertRegistryHouse } from '../test-db.ts';
import { addressObject, house, managingOrg, poi, property, region } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { parseAddress } from '../address/normalize.ts';
import { setHouseForm } from '../house/form.ts';
import { loadDataset } from './load.ts';
import { seedDemo } from '../demo/seed.ts';
import { DEMO_HOUSE_KEY } from '../demo/constants.ts';
import type { DatasetManifest, DatasetRow } from './format.ts';
import type { DatasetHouse, DatasetOrg } from './merge.ts';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

const MANIFEST = {
  format: 2, regionCode: '61', regionName: 'Ростовская обл', builtAt: '2026-09-16T00:00:00.000Z',
  stages: { gar: true, frt: true, licenses: true, osm: false },
  sources: { gar: '2026.09.15', frt: '2026-09-01', osm: null },
  counts: {}, report: null, sha256: '',
} satisfies DatasetManifest;

const A = 'обл Ростовская, г Волгодонск, ул Степная, д. 151';
const B = 'обл Ростовская, г Аксай, ул Мира, д. 1';

const org = (over: Partial<DatasetOrg> = {}): DatasetOrg => ({
  inn: '6143087723', kpp: '614301001', ogrn: '1166196075737', name: 'ТСН «ТСЖ Антарес»', shortName: 'ТСН «Антарес»',
  phone: '79885771953', email: 'tsj@mail.ru', site: null, frtId: '8866701',
  gisOrgGuid: null, gisStatus: null, licenseNumber: null, licenseStatus: null,
  houseCount: 1, ...over,
});

const houseRow = (address: string, over: Partial<DatasetHouse> = {}): DatasetHouse => ({
  houseKey: parseAddress(address).houseKey, houseKeyLoose: null, fiasGuid: `fias-${address.length}`,
  addressRaw: address, regionCode: '61', streetGuid: 'g-street', houseKind: 'mkd', garMkd: true, cadastralNumber: '61:14:0040140:39', gisHouseGuid: null, flatCount: 100, garFlats: 90,
  registryForm: 'tsj', orgInn: '6143087723', lat: 47.5, lon: 42.1, ...over,
});

async function* rows(list: DatasetRow[]) { for (const row of list) yield row; }

test('организация с тем же ИНН сохраняет id и получает свежие данные', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({ id: orgId, inn: '6143087723', name: 'старое имя', regionCode: '61' });

  await loadDataset(db, MANIFEST, rows([
    { t: 'org', ...org() },
    { t: 'house', ...houseRow(A) },
  ]));

  const [row] = await db.select().from(managingOrg).where(eq(managingOrg.inn, '6143087723'));
  assert.equal(row.id, orgId, 'к id привязаны квартиры и кабинеты — он не меняется');
  assert.equal(row.name, 'ТСН «ТСЖ Антарес»');

  const [h] = await db.select().from(house).where(eq(house.houseKey, parseAddress(A).houseKey));
  assert.equal(h.registryOrgId, orgId);
  assert.equal(h.registryForm, 'tsj');
  assert.equal(h.lat, 47.5);
  assert.equal(h.garMkd, true);
  assert.equal(h.cadastralNumber, '61:14:0040140:39');
});

test('решение оператора переживает загрузку набора', async () => {
  const db = testDb();
  const key = parseAddress(A).houseKey;
  await setHouseForm(db, key, { form: 'direct', source: 'operator', setBy: 'оператор' });

  await loadDataset(db, MANIFEST, rows([{ t: 'org', ...org() }, { t: 'house', ...houseRow(A) }]));

  const [h] = await db.select().from(house).where(eq(house.houseKey, key));
  assert.equal(h.form, 'direct');
  assert.equal(h.source, 'operator');
  assert.equal(h.registryForm, 'tsj');
});

test('дом, выпавший из набора, остаётся, но теряет реестровую форму и организацию', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({ id: orgId, inn: '6100000001', name: 'УК', regionCode: '61', licenseNumber: '1' });
  await insertRegistryHouse(db, { houseKey: parseAddress(B).houseKey, orgId, addressRaw: B });

  await loadDataset(db, MANIFEST, rows([{ t: 'org', ...org() }, { t: 'house', ...houseRow(A) }]));

  const [gone] = await db.select().from(house).where(eq(house.houseKey, parseAddress(B).houseKey));
  assert.ok(gone, 'на дом могут ссылаться квартиры и председатели — строку не удаляем');
  assert.equal(gone.registryOrgId, null);
  assert.equal(gone.registryForm, null);
  assert.equal(gone.addressRaw, B, 'адрес остаётся: дом по-прежнему находится');
});

test('демо-дом не «выпадает» из набора: его УК переживает загрузку', async () => {
  const db = testDb();
  await seedDemo(db);
  const [before] = await db.select().from(house).where(eq(house.houseKey, DEMO_HOUSE_KEY));
  assert.ok(before.registryOrgId);

  const result = await loadDataset(db, MANIFEST, rows([{ t: 'org', ...org() }, { t: 'house', ...houseRow(A) }]));

  const [after] = await db.select().from(house).where(eq(house.houseKey, DEMO_HOUSE_KEY));
  assert.equal(after.registryOrgId, before.registryOrgId, 'обращения демо-дома идут в демо-УК, а не «совету дома»');
  assert.equal(after.registryForm, 'uk');
  assert.equal(result.dropped, 0);
});

test('организация, которой нет в наборе, не хранит прежнее число домов', async () => {
  const db = testDb();
  const orgId = newId('org');
  // Старый импорт ГИС ЖКХ насчитал «Трианону» 8 домов, в реестре фонда его нет
  await db.insert(managingOrg).values({ id: orgId, inn: '6168108630', name: 'УК Трианон', regionCode: '61', houseCount: 8 });

  await loadDataset(db, MANIFEST, rows([{ t: 'org', ...org() }, { t: 'house', ...houseRow(A) }]));

  const [stale] = await db.select().from(managingOrg).where(eq(managingOrg.id, orgId));
  assert.equal(stale.houseCount, 0, 'кабинет УК показывал «8 по данным лицензии» при нуле домов');
  const [fresh] = await db.select().from(managingOrg).where(eq(managingOrg.inn, '6143087723'));
  assert.equal(fresh.houseCount, 1);
});

test('квартира жителя без организации получает её после загрузки', async () => {
  const db = testDb();
  const propertyId = newId('prp');
  await db.insert(property).values({ id: propertyId, addressRaw: `${A}, кв. 5`, houseKey: parseAddress(A).houseKey, flat: '5' });

  const result = await loadDataset(db, MANIFEST, rows([{ t: 'org', ...org() }, { t: 'house', ...houseRow(A) }]));

  const [p] = await db.select().from(property).where(eq(property.id, propertyId));
  const [o] = await db.select().from(managingOrg).where(eq(managingOrg.inn, '6143087723'));
  assert.equal(p.managingOrgId, o.id);
  assert.equal(result.properties.attached, 1);
});

test('дом, известный по GUID ФИАС, сохраняет ключ, даже если набор принёс другой', async () => {
  const db = testDb();
  await loadDataset(db, MANIFEST, rows([{ t: 'house', ...houseRow(A, { fiasGuid: 'same', orgInn: null }) }]));
  await loadDataset(db, MANIFEST, rows([{ t: 'house', ...houseRow(B, { fiasGuid: 'same', orgInn: null }) }]));

  const withGuid = await db.select().from(house).where(eq(house.fiasGuid, 'same'));
  assert.equal(withGuid.length, 1);
  assert.equal(withGuid[0].houseKey, parseAddress(A).houseKey, 'на ключе живут квартиры и председатели');
  assert.equal(withGuid[0].addressRaw, B, 'написание обновилось');
});

test('контакты организации из фонда не стирают GUID портала, записанный раньше', async () => {
  const db = testDb();
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6143087723', name: 'старое', regionCode: '61', gisOrgGuid: 'portal-guid', gisStatus: 'REGISTERED', kpp: '614301001',
  });

  await loadDataset(db, MANIFEST, rows([{ t: 'org', ...org() }]));

  const [row] = await db.select().from(managingOrg).where(eq(managingOrg.id, orgId));
  assert.equal(row.gisOrgGuid, 'portal-guid');
  assert.equal(row.gisStatus, 'REGISTERED');
  assert.equal(row.kpp, '614301001');
  assert.equal(row.email, 'tsj@mail.ru');
  assert.equal(row.frtId, '8866701');
});

test('адресное дерево региона заменяется, регион помечается загруженным', async () => {
  const db = testDb();
  await db.insert(addressObject).values({ guid: 'old', regionCode: '61', parentGuid: null, level: 8, type: 'ул', name: 'Старая', searchName: 'старая' });

  await loadDataset(db, MANIFEST, rows([
    { t: 'region', code: '61', name: 'Ростовская обл', source: 'ГАР' },
    { t: 'object', guid: 'g-region', regionCode: '61', parentGuid: null, level: 1, type: 'обл', name: 'Ростовская', searchName: 'ростовская' },
    { t: 'object', guid: 'g-city', regionCode: '61', parentGuid: 'g-region', level: 5, type: 'г', name: 'Ростов-на-Дону', searchName: 'ростов-на-дону' },
    { t: 'object', guid: 'g-street', regionCode: '61', parentGuid: 'g-city', level: 8, type: 'ул', name: 'Большая Садовая', searchName: 'большая садовая' },
  ]));

  const objects = await db.select().from(addressObject);
  assert.deepEqual(objects.map((o) => o.guid).sort(), ['g-city', 'g-region', 'g-street']);
  const [r] = await db.select().from(region);
  assert.equal(r.status, 'loaded');
  assert.equal(r.placeCount, 1);
  assert.equal(r.streetCount, 1);
});

test('паспорт дома пишется, а точки окружения региона заменяются целиком', async () => {
  const db = testDb();
  await db.insert(poi).values({ id: newId('poi'), regionCode: '61', kind: 'shop', name: 'старый', lat: 1, lon: 1 });

  await loadDataset(db, MANIFEST, rows([
    { t: 'org', ...org() },
    { t: 'house', ...houseRow(A, { builtYear: 1984, floors: 9, entrances: 4, elevators: 4, wallMaterial: 'Панельные', gas: false, emergency: false }) },
    { t: 'poi', kind: 'pharmacy', name: 'Аптека', lat: 47.51, lon: 42.11 },
    { t: 'poi', kind: 'stop', name: null, lat: 47.52, lon: 42.12 },
  ]));

  const [h] = await db.select().from(house).where(eq(house.houseKey, parseAddress(A).houseKey));
  assert.equal(h.builtYear, 1984);
  assert.equal(h.floors, 9);
  assert.equal(h.elevators, 4);
  assert.equal(h.wallMaterial, 'Панельные');
  assert.equal(h.gas, false);

  const points = await db.select().from(poi).where(eq(poi.regionCode, '61'));
  assert.deepEqual(points.map((p) => p.kind).sort(), ['pharmacy', 'stop'], 'старые точки региона стёрты');
});

test('старый набор без паспорта и точек грузится, точки не трогаются', async () => {
  const db = testDb();
  await db.insert(poi).values({ id: newId('poi'), regionCode: '61', kind: 'shop', name: 'есть', lat: 1, lon: 1 });

  await loadDataset(db, MANIFEST, rows([{ t: 'org', ...org() }, { t: 'house', ...houseRow(A) }]));

  const [h] = await db.select().from(house).where(eq(house.houseKey, parseAddress(A).houseKey));
  assert.equal(h.builtYear, null);
  assert.equal((await db.select().from(poi)).length, 1, 'набор без точек не стирает прежние');
});
