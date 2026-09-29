import { test } from 'node:test';
import assert from 'node:assert/strict';
import { periodLabel } from './service.ts';

test('подпись периода всегда с годом', () => {
  assert.equal(periodLabel('2026-04'), 'апрель 2026');
  assert.equal(periodLabel('2023-08'), 'август 2023');
});
