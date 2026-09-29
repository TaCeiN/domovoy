import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSort, sortRequests } from './sort.ts';

const rows = [
  { id: 'b', createdAt: new Date('2026-09-20') },
  { id: 'a', createdAt: new Date('2026-09-25') },
  { id: 'c', createdAt: new Date('2026-09-10') },
];

test('новые сверху и старые сверху — по дате создания', () => {
  assert.deepEqual(sortRequests(rows, 'newest').map((r) => r.id), ['a', 'b', 'c']);
  assert.deepEqual(sortRequests(rows, 'oldest').map((r) => r.id), ['c', 'b', 'a']);
});

test('по сроку — порядок очереди не трогаем, мусор в параметре — по сроку', () => {
  assert.deepEqual(sortRequests(rows, 'deadline').map((r) => r.id), ['b', 'a', 'c']);
  assert.equal(readSort('drop table'), 'deadline');
  assert.equal(readSort('newest'), 'newest');
});
