import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coordKey, osmBuildingKey, PlaceGrid, OSM_EXTRACTS, poiKind } from './osm.ts';

const PLACES = new Set(['аксай', 'багаевская']);

test('ключ координат не зависит от типа пункта, написания улицы и корпуса', () => {
  const gar = coordKey('Аксай', 'ул Мира', '4, к. 2');
  assert.ok(gar);
  assert.equal(osmBuildingKey({ 'addr:city': 'Аксай', 'addr:street': 'улица Мира', 'addr:housenumber': '4к2' }, null, PLACES), gar);
  assert.equal(osmBuildingKey({ 'addr:street': 'Мира улица', 'addr:housenumber': '4 к2' }, 'Аксай', PLACES), gar, 'пункт по ближайшему узлу');
});

test('ё и точки в типе улицы не мешают', () => {
  assert.equal(
    osmBuildingKey({ 'addr:street': 'переулок Зелёный', 'addr:housenumber': '1' }, 'Багаевская', PLACES),
    coordKey('Багаевская', 'пер. Зеленый', '1'),
  );
});

test('здание без улицы, номера или известного пункта не сопоставляется', () => {
  assert.equal(osmBuildingKey({ 'addr:housenumber': '1' }, 'Аксай', PLACES), null);
  assert.equal(osmBuildingKey({ 'addr:street': 'улица Мира' }, 'Аксай', PLACES), null);
  assert.equal(osmBuildingKey({ 'addr:street': 'улица Мира', 'addr:housenumber': '1' }, 'Элиста', PLACES), null);
  assert.equal(osmBuildingKey({ 'addr:street': 'улица Мира', 'addr:housenumber': '1' }, null, PLACES), null);
});

test('ближайший пункт находится по сетке, а не перебором', () => {
  const grid = new PlaceGrid([
    { name: 'Аксай', lat: 47.27, lon: 39.86 },
    { name: 'Багаевская', lat: 47.32, lon: 40.39 },
  ]);
  assert.equal(grid.nearest(47.28, 39.88), 'Аксай');
  assert.equal(grid.nearest(47.31, 40.35), 'Багаевская');
  assert.equal(grid.nearest(55.75, 37.62), null, 'дальше радиуса поиска пункта нет');
});

test('выжимка есть у Ростовской области и у Москвы', () => {
  assert.match(OSM_EXTRACTS['61'], /south-fed-district/);
  assert.match(OSM_EXTRACTS['77'], /central-fed-district/);
  assert.match(OSM_EXTRACTS['39'], /kaliningrad/);
});

test('точки окружения: магазин, аптека, школа, детсад, остановка', () => {
  assert.equal(poiKind({ shop: 'supermarket' }), 'shop');
  assert.equal(poiKind({ shop: 'convenience' }), 'shop');
  assert.equal(poiKind({ amenity: 'pharmacy' }), 'pharmacy');
  assert.equal(poiKind({ amenity: 'school' }), 'school');
  assert.equal(poiKind({ amenity: 'kindergarten' }), 'kindergarten');
  assert.equal(poiKind({ highway: 'bus_stop' }), 'stop');
  assert.equal(poiKind({ public_transport: 'platform' }), 'stop');
  assert.equal(poiKind({ shop: 'clothes' }), null, 'не любой магазин — только продукты');
  assert.equal(poiKind({ building: 'yes' }), null);
});
