import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress } from '../address/normalize.ts';
import { mergeDataset, type MergeInput } from './merge.ts';
import { coordKey } from './osm.ts';
import type { GarHouse, GarObject, GarRegion } from './gar.ts';
import type { FrtHouse, FrtOrg } from './frt.ts';

/**
 * Маленький регион ГАР:
 *   обл Ростовская (1) → г Аксай (5) → ул Мира (8) → дома 10, 11
 *                     → р-н Аксайский (2) → х Черюмкин (6) → дом 12 без улицы
 */
function region(): GarRegion {
  const objects = new Map<number, GarObject>([
    [1, { objectId: 1, guid: 'g-region', name: 'Ростовская', type: 'обл.', level: 1 }],
    [2, { objectId: 2, guid: 'g-city', name: 'Аксай', type: 'г.', level: 5 }],
    [3, { objectId: 3, guid: 'g-street', name: 'Мира', type: 'ул.', level: 8 }],
    [4, { objectId: 4, guid: 'g-area', name: 'Аксайский', type: 'р-н', level: 2 }],
    [5, { objectId: 5, guid: 'g-khutor', name: 'Черюмкин', type: 'х.', level: 6 }],
  ]);
  const house = (objectId: number, guid: string, num: string, extra: Partial<GarHouse> = {}): GarHouse => ({
    objectId, guid, num, houseType: 2, add1: null, addType1: null, add2: null, addType2: null, ...extra,
  });
  return {
    objects,
    objectPath: new Map([[1, []], [2, [1]], [3, [1, 2]], [4, [1]], [5, [1, 4]]]),
    houses: [house(10, 'fias-10', '1'), house(11, 'fias-11', '2', { add1: '1', addType1: 1 }), house(12, 'fias-12', '7')],
    housePath: new Map([[10, [1, 2, 3]], [11, [1, 2, 3]], [12, [1, 4, 5]]]),
    flats: new Map([[10, 60]]),
    regionObjectId: 1,
  };
}

const ADDR_10 = 'обл Ростовская, г Аксай, ул Мира, д. 1';

const org = (over: Partial<FrtOrg> = {}): FrtOrg => ({
  frtId: 'o1', inn: '6102017830', ogrn: '1036102003618', name: 'ТСЖ "Прогресс"', shortName: 'ТСЖ "Прогресс"',
  phone: '+79286185189', email: 'tsj@mail.ru', site: null, ...over,
});

const frt = (over: Partial<FrtHouse> = {}): FrtHouse => ({
  frtId: 'h1', fiasGuid: 'fias-10', address: 'обл. Ростовская, г. Аксай, ул. Мира, д. 1',
  place: 'Аксай', street: 'ул. Мира', number: '1', orgFrtId: 'o1', kind: 'mkd', flats: 58, floors: 5, builtYear: 1975,
  entrances: 4, elevators: 0, wallMaterial: 'Панельные', gas: true, emergency: false, ...over,
});

const input = (over: Partial<MergeInput> = {}): MergeInput => ({
  regionCode: '61', gar: region(), frtHouses: [], frtOrgs: [org()], licenses: new Map(), osm: [], ...over,
});

test('адресное дерево: уровни, родители, тип без точки, имя для поиска', () => {
  const { objects } = mergeDataset(input());
  const street = objects.find((o) => o.guid === 'g-street');
  assert.deepEqual(street, {
    guid: 'g-street', regionCode: '61', parentGuid: 'g-city', level: 8, type: 'ул', name: 'Мира', searchName: 'мира',
  });
  assert.equal(objects.find((o) => o.guid === 'g-region')?.parentGuid, null);
});

test('все дома ГАР попадают в набор; дом без улицы висит на населённом пункте', () => {
  const { houses } = mergeDataset(input());
  assert.equal(houses.length, 3);
  const byGuid = new Map(houses.map((h) => [h.fiasGuid, h]));
  assert.equal(byGuid.get('fias-10')?.streetGuid, 'g-street');
  assert.equal(byGuid.get('fias-12')?.streetGuid, 'g-khutor');
  assert.equal(byGuid.get('fias-10')?.registryForm, null, 'без ФРТ реестр о доме молчит');
  assert.equal(byGuid.get('fias-10')?.garFlats, 60);
});

test('дом ФРТ сшивается по GUID ФИАС: форма из организации, тип, квартиры, адрес ГАР', () => {
  const { houses, orgs, report } = mergeDataset(input({ frtHouses: [frt()] }));
  const h = houses.find((x) => x.fiasGuid === 'fias-10');
  assert.equal(h?.registryForm, 'tsj');
  assert.equal(h?.orgInn, '6102017830');
  assert.equal(h?.houseKind, 'mkd');
  assert.equal(h?.flatCount, 58);
  assert.equal(h?.addressRaw, ADDR_10, 'написание ГАР — оно же у квитанций и старого реестра');
  assert.equal(h?.houseKey, parseAddress(ADDR_10).houseKey);
  assert.equal(report.byGuid, 1);
  assert.deepEqual(orgs[0], {
    inn: '6102017830', kpp: null, ogrn: '1036102003618', name: 'ТСЖ "Прогресс"', shortName: 'ТСЖ "Прогресс"',
    phone: '+79286185189', email: 'tsj@mail.ru', site: null, frtId: 'o1',
    gisOrgGuid: null, gisStatus: null, licenseNumber: null, licenseStatus: null, houseCount: 1,
  });
});

test('чужой GUID у фонда — дом находится по пункту, улице и номеру', () => {
  const { houses, report } = mergeDataset(input({ frtHouses: [frt({ fiasGuid: 'stale', number: '2, к. 1' })] }));
  assert.equal(houses.find((h) => h.fiasGuid === 'fias-11')?.registryForm, 'tsj');
  assert.equal(report.byKey, 1);
  assert.equal(houses.length, 3);
});

test('дом ФРТ, которого нет в ГАР, добавляется со своим адресом и без GUID', () => {
  const { houses, report } = mergeDataset(input({
    frtHouses: [frt({ fiasGuid: 'nowhere', place: 'Аксай', street: 'ул. Новая', number: '9', address: 'обл. Ростовская, г. Аксай, ул. Новая, д. 9' })],
  }));
  assert.equal(houses.length, 4);
  const added = houses.find((h) => h.fiasGuid === null);
  assert.equal(added?.addressRaw, 'обл. Ростовская, г. Аксай, ул. Новая, д. 9');
  assert.equal(added?.streetGuid, null);
  assert.equal(report.addedFromFrt, 1);
});

test('лицензия делает организацию УК, блокированная застройка без организации — частный дом', () => {
  const { houses, orgs } = mergeDataset(input({
    frtOrgs: [org({ name: 'ООО "Дом"', shortName: 'ООО "Дом"' })],
    frtHouses: [frt(), frt({ frtId: 'h2', fiasGuid: 'fias-12', orgFrtId: null, kind: 'blocked' })],
    licenses: new Map([['6102017830', { number: '061-000123', status: 'ACTIVE', phone: null }]]),
  }));
  const byGuid = new Map(houses.map((h) => [h.fiasGuid, h]));
  assert.equal(byGuid.get('fias-10')?.registryForm, 'uk');
  assert.equal(byGuid.get('fias-12')?.registryForm, 'private');
  assert.equal(orgs[0].licenseNumber, '061-000123');
});

test('организации без домов в регионе тоже попадают в набор — с ними можно договориться', () => {
  const { orgs } = mergeDataset(input({ frtOrgs: [org(), org({ frtId: 'o2', inn: '6141045453' })] }));
  assert.equal(orgs.length, 2);
  assert.equal(orgs[1].houseCount, 0);
});

test('два дома ГАР с одним ключом: остаётся сшитый с фондом', () => {
  const gar = region();
  gar.houses.push({ objectId: 13, guid: 'fias-dup', num: '1', houseType: 2, add1: null, addType1: null, add2: null, addType2: null });
  gar.housePath.set(13, [1, 2, 3]);
  gar.flats.set(13, 200);

  const { houses, report } = mergeDataset(input({ gar, frtHouses: [frt()] }));
  assert.equal(houses.filter((h) => h.addressRaw === ADDR_10).length, 1);
  assert.equal(houses.find((h) => h.addressRaw === ADDR_10)?.fiasGuid, 'fias-10');
  assert.equal(report.keyCollisions, 1);
});

test('признак МКД и кадастровый номер из параметров ГАР', () => {
  const { houses, report } = mergeDataset(input({
    params: { cadastral: new Map([[10, '61:14:0040140:39']]), mkd: new Set([10]) },
  }));
  const h = houses.find((x) => x.fiasGuid === 'fias-10');
  assert.equal(h?.garMkd, true);
  assert.equal(h?.cadastralNumber, '61:14:0040140:39');
  assert.equal(houses.find((x) => x.fiasGuid === 'fias-11')?.garMkd, false);
  assert.equal(report.garMkd, 1);
});

test('координата за сотню километров от своего пункта отбрасывается как чужая', () => {
  const gar = region();
  gar.houses.push(
    { objectId: 14, guid: 'fias-14', num: '5', houseType: 2, add1: null, addType1: null, add2: null, addType2: null },
    { objectId: 15, guid: 'fias-15', num: '6', houseType: 2, add1: null, addType1: null, add2: null, addType2: null },
  );
  gar.housePath.set(14, [1, 2, 3]);
  gar.housePath.set(15, [1, 2, 3]);
  const at = (num: string, lat: number, lon: number) => ({ key: coordKey('Аксай', 'ул Мира', num)!, lat, lon });

  const { houses, report } = mergeDataset(input({
    gar,
    osm: [at('1', 47.27, 39.86), at('5', 47.28, 39.87), at('6', 48.7, 44.5)],
  }));
  const byGuid = new Map(houses.map((h) => [h.fiasGuid, h]));
  assert.equal(byGuid.get('fias-10')?.lat, 47.27);
  assert.equal(byGuid.get('fias-15')?.lat, null, 'Волгоград — не Аксай');
  assert.equal(report.coordsDropped, 1);
  assert.equal(report.withCoords, 2);
});

test('хутор, у которого все здания нашлись в чужой области, сверяется с серединой района', () => {
  const gar = region();
  // р-н Аксайский (4): х Черюмкин (5) и х Красный (21), в обоих ул Садовая
  gar.objects.set(20, { objectId: 20, guid: 'g-sad-1', name: 'Садовая', type: 'ул.', level: 8 });
  gar.objects.set(21, { objectId: 21, guid: 'g-red', name: 'Красный', type: 'х.', level: 6 });
  gar.objects.set(22, { objectId: 22, guid: 'g-sad-2', name: 'Садовая', type: 'ул.', level: 8 });
  const add = (objectId: number, num: string, path: number[]) => {
    gar.houses.push({ objectId, guid: `fias-${objectId}`, num, houseType: 2, add1: null, addType1: null, add2: null, addType2: null });
    gar.housePath.set(objectId, path);
  };
  add(30, '1', [1, 4, 5, 20]);
  add(31, '2', [1, 4, 5, 20]);
  add(32, '1', [1, 4, 21, 22]);

  const { houses, report } = mergeDataset(input({
    gar,
    osm: [
      { key: coordKey('Черюмкин', 'ул Садовая', '1')!, lat: 47.30, lon: 39.90 },
      { key: coordKey('Черюмкин', 'ул Садовая', '2')!, lat: 47.31, lon: 39.91 },
      // Единственное здание «х Красный, ул Садовая, 1» — в Краснодарском крае
      { key: coordKey('Красный', 'ул Садовая', '1')!, lat: 45.20, lon: 37.66 },
    ],
  }));
  const byGuid = new Map(houses.map((h) => [h.fiasGuid, h]));
  assert.equal(byGuid.get('fias-30')?.lat, 47.30);
  assert.equal(byGuid.get('fias-32')?.lat, null, 'медиана пункта из одной чужой точки сама чужая — ловит район');
  assert.equal(report.coordsDropped, 1);
});

test('координаты — по ключу «пункт, улица, номер»', () => {
  const key = coordKey('Аксай', 'ул Мира', '1');
  assert.ok(key);
  const { houses, report } = mergeDataset(input({ osm: [{ key: key!, lat: 47.27, lon: 39.86 }] }));
  const h = houses.find((x) => x.fiasGuid === 'fias-10');
  assert.deepEqual([h?.lat, h?.lon], [47.27, 39.86]);
  assert.equal(report.withCoords, 1);
});

test('паспорт дома из фонда переходит в набор; без фонда — пусто', () => {
  const { houses } = mergeDataset(input({ frtHouses: [frt({ emergency: true })] }));
  const h = houses.find((x) => x.fiasGuid === 'fias-10');
  assert.equal(h?.builtYear, 1975);
  assert.equal(h?.floors, 5);
  assert.equal(h?.entrances, 4);
  assert.equal(h?.elevators, 0);
  assert.equal(h?.wallMaterial, 'Панельные');
  assert.equal(h?.gas, true);
  assert.equal(h?.emergency, true);

  const bare = houses.find((x) => x.fiasGuid === 'fias-12');
  assert.equal(bare?.builtYear, null);
  assert.equal(bare?.emergency, null);
});
