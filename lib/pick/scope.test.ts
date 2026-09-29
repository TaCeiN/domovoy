import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPickerHouse } from './scope.ts';

const base = { houseKind: null, garMkd: null, flatCount: null, garFlats: 0, registryForm: null, form: 'unknown' };

test('в подбор попадают многоквартирные дома по любому из признаков', () => {
  assert.equal(isPickerHouse({ ...base, houseKind: 'mkd' }), true);
  assert.equal(isPickerHouse({ ...base, garMkd: true }), true);
  assert.equal(isPickerHouse({ ...base, flatCount: 12 }), true);
  assert.equal(isPickerHouse({ ...base, garFlats: 3 }), true);
});

test('частный дом и дом на две квартиры в подбор не попадают', () => {
  assert.equal(isPickerHouse(base), false);
  assert.equal(isPickerHouse({ ...base, garFlats: 2 }), false);
  assert.equal(isPickerHouse({ ...base, houseKind: 'mkd', registryForm: 'private' }), false);
  assert.equal(isPickerHouse({ ...base, houseKind: 'mkd', form: 'private' }), false, 'решение оператора сильнее');
});
