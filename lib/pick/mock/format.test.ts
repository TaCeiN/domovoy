import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMockFile } from './format.ts';
import { SAMPLE } from './fixtures.ts';

const clone = () => structuredClone(SAMPLE);

test('правильный файл принимается как есть', () => {
  const r = parseMockFile(clone());
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.file.complexes[0].slug, 'novyy-selmash');
});

test('битые поля перечисляются все сразу, с номером ЖК', () => {
  const f = clone();
  f.complexes[0].slug = 'Новый';
  f.complexes[0].lat = 55.75;
  f.complexes[0].reviews[0].stars = 6;
  const r = parseMockFile(f);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.errors.length, 3);
    assert.ok(r.errors.every((e) => e.startsWith('ЖК 1')));
  }
});

test('повтор slug — отказ', () => {
  const f = clone();
  f.complexes.push(structuredClone(f.complexes[0]));
  const r = parseMockFile(f);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.errors[0], /повтор/);
});

test('ЖК без отзывов и без ЖК вовсе — отказ', () => {
  const f = clone();
  f.complexes[0].reviews = [];
  assert.equal(parseMockFile(f).ok, false);
  assert.equal(parseMockFile({ ...clone(), complexes: [] }).ok, false);
});

test('aliases необязательны, но если есть — список коротких строк', () => {
  const f = clone();
  f.complexes[0].aliases = ['Грин Сайд'];
  assert.equal(parseMockFile(f).ok, true);
  f.complexes[0].aliases = ['', 'x'.repeat(100)];
  assert.equal(parseMockFile(f).ok, false);
});

test('src — только osm, web или mock', () => {
  const f = clone();
  (f.complexes[0].src as Record<string, string>).name = 'cian';
  assert.equal(parseMockFile(f).ok, false);
});

test('примерная оплата ЖКУ необязательна, но если есть — целое число рублей', () => {
  const ok = clone();
  ok.complexes[0].utilities = 5200;
  assert.equal(parseMockFile(ok).ok, true);
  const bad = clone();
  (bad.complexes[0] as { utilities?: unknown }).utilities = '5 тыс';
  assert.equal(parseMockFile(bad).ok, false);
});
