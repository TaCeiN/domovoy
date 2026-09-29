import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBbox, tooWide, distanceM, around, cellDeg } from './geo.ts';

test('рамка карты: «запад,юг,восток,север», мусор отвергается', () => {
  assert.deepEqual(parseBbox('39.6,47.2,39.8,47.3'), { west: 39.6, south: 47.2, east: 39.8, north: 47.3 });
  assert.equal(parseBbox('39.8,47.2,39.6,47.3'), null, 'запад восточнее востока');
  assert.equal(parseBbox('1,2,3'), null);
  assert.equal(parseBbox('a,b,c,d'), null);
  assert.equal(parseBbox(undefined), null);
  assert.equal(parseBbox('0,-91,1,1'), null, 'широта за полюсом');
});

test('слишком широкая рамка — больше двух градусов', () => {
  assert.equal(tooWide({ west: 39, south: 47, east: 40.5, north: 48 }), false);
  assert.equal(tooWide({ west: 38, south: 47, east: 40.5, north: 48 }), true);
});

test('расстояние по сфере: градус широты около 111 км', () => {
  const d = distanceM({ lat: 47, lon: 39.7 }, { lat: 48, lon: 39.7 });
  assert.ok(Math.abs(d - 111_195) < 200, String(d));
  assert.equal(distanceM({ lat: 47, lon: 39 }, { lat: 47, lon: 39 }), 0);
});

test('квадрат вокруг точки содержит точку на заданном расстоянии', () => {
  const box = around({ lat: 47.23, lon: 39.72 }, 1500);
  assert.ok(box.north - 47.23 > 0.0134 && box.north - 47.23 < 0.0136);
  assert.ok(box.east - 39.72 > box.north - 47.23, 'на юге России градус долготы короче градуса широты');
});

test('шаг сетки кружков уменьшается вдвое с каждым приближением', () => {
  assert.equal(cellDeg(10) / cellDeg(11), 2);
  assert.ok(cellDeg(14) < 0.01);
});
