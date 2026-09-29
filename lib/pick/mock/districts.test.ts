import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISTRICTS, matchDistricts, districtBbox } from './districts.ts';

const names = (q: string, extra?: Record<string, string[]>) => matchDistricts(q, extra).map((d) => d.name);

test('районов Ростова восемь, у каждого граница и точка подписи внутри рамки', () => {
  assert.equal(DISTRICTS.length, 8);
  for (const d of DISTRICTS) {
    const b = districtBbox(d);
    assert.ok(b.south < b.north && b.west < b.east, d.name);
    assert.ok(d.label.lat > b.south && d.label.lat < b.north, d.name);
    assert.ok(d.label.lon > b.west && d.label.lon < b.east, d.name);
  }
});

test('район находится по началу названия, без учёта регистра и слова «район»', () => {
  assert.deepEqual(names('совет'), ['Советский район']);
  assert.deepEqual(names('ПЕРВОМАЙСКИЙ р-н'), ['Первомайский район']);
  assert.deepEqual(names('Ворошиловский район'), ['Ворошиловский район']);
});

test('район находится по народному названию', () => {
  assert.deepEqual(names('жд'), ['Железнодорожный район']);
  assert.deepEqual(names('ЗЖМ'), ['Советский район']);
  assert.deepEqual(names('сельмаш'), ['Первомайский район']);
  assert.deepEqual(names('нахичевань'), ['Пролетарский район']);
  assert.deepEqual(names('северный'), ['Ворошиловский район']);
});

test('«центр» — оба центральных района', () => {
  assert.deepEqual(names('центр').sort(), ['Кировский район', 'Ленинский район']);
});

test('опечатка в одну букву прощается, если слово не короче четырёх букв', () => {
  assert.deepEqual(names('ворашиловский'), ['Ворошиловский район']);
  assert.deepEqual(names('пролитарский'), ['Пролетарский район']);
  assert.deepEqual(names('сов'), ['Советский район']);
  assert.deepEqual(names('ока'), []);
});

test('ё и е не различаются', () => {
  assert.deepEqual(names('северный посёлок'), ['Ворошиловский район']);
  assert.deepEqual(names('северный поселок'), ['Ворошиловский район']);
});

test('«районы» показывает все восемь', () => {
  assert.equal(names('районы').length, 8);
  assert.equal(names('район').length, 8);
});

test('микрорайоны из данных ЖК тоже ведут в свой район', () => {
  assert.deepEqual(names('берберовка', { 'Пролетарский район': ['мкр. Берберовка'] }), ['Пролетарский район']);
});

test('слово из середины не находит: «ета» — не «Советский»', () => {
  assert.deepEqual(names('етский'), []);
  assert.deepEqual(names('x'), []);
});
