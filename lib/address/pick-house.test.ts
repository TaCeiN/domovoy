import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickHouse } from './pick-house.ts';

/**
 * Реальный случай: пр-кт Ленина, 85/3 в Ростове-на-Дону.
 *
 * В реестре он записан дробью и принадлежит ООО «УК Трианон». Демо-набор
 * кладёт туда же дом «85, к. 3» с выдуманной организацией. Ключи разные —
 * дробь корпусом мы намеренно не считаем, — поэтому перебор вариантов
 * находит ОБА, и выбор между ними произволен.
 */
const TRIANON = { houseKey: 'c78d49f0', orgId: 'org_trianon', gisStatus: 'REGISTERED' };
const DEMO = { houseKey: '11fa768e', orgId: 'org_demo', gisStatus: null };

test('точное написание жителя выигрывает у варианта', () => {
  // Житель ввёл «85/3» — это ключ Трианона
  const picked = pickHouse([DEMO, TRIANON], 'c78d49f0');
  assert.equal(picked?.orgId, 'org_trianon');
});

test('порядок строк из базы ничего не решает', () => {
  assert.equal(pickHouse([TRIANON, DEMO], '11fa768e')?.orgId, 'org_demo');
  assert.equal(pickHouse([DEMO, TRIANON], '11fa768e')?.orgId, 'org_demo');
});

test('без точного совпадения выигрывает действующая организация', () => {
  const blocked = { houseKey: 'aaa', orgId: 'org_blocked', gisStatus: 'BLOCKED' };
  const active = { houseKey: 'bbb', orgId: 'org_active', gisStatus: 'REGISTERED' };

  assert.equal(pickHouse([blocked, active], 'zzz')?.orgId, 'org_active');
  assert.equal(pickHouse([active, blocked], 'zzz')?.orgId, 'org_active');
});

test('единственный кандидат берётся как есть, даже заблокированный', () => {
  const blocked = { houseKey: 'aaa', orgId: 'org_blocked', gisStatus: 'BLOCKED' };
  assert.equal(pickHouse([blocked], 'zzz')?.orgId, 'org_blocked');
});

test('кандидатов нет — дома нет', () => {
  assert.equal(pickHouse([], 'zzz'), null);
});

test('дом с организацией выигрывает у дома без неё, когда статусов нет', () => {
  const bare = { houseKey: 'aaa', orgId: null, gisStatus: null };
  const managed = { houseKey: 'bbb', orgId: 'org_tsj', gisStatus: null };
  assert.equal(pickHouse([bare, managed], 'zzz')?.orgId, 'org_tsj');
});

test('частный дом без организации находится как дом', () => {
  const bare = { houseKey: 'aaa', orgId: null, gisStatus: null };
  assert.equal(pickHouse([bare], 'zzz')?.houseKey, 'aaa');
});
