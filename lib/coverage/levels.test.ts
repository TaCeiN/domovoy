import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageOf, type CoverageInput } from './levels.ts';

const bare: CoverageInput = {
  registryForm: null, humanForm: 'unknown', houseKind: null, garFlats: 0, flatCount: null, garMkd: null,
  orgInn: null, orgHasContact: false, orgHasCabinet: false, hasChairman: false,
};

test('только адрес: реестр о доме молчит, квартир нет — адрес и «вероятно частный»', () => {
  assert.deepEqual(coverageOf(bare), { level: 'address', isPrivate: false, privateLikely: true });
});

test('тип известен, контакта нет — жёлтый', () => {
  assert.equal(coverageOf({ ...bare, houseKind: 'mkd', registryForm: 'unknown' }).level, 'kind');
  assert.equal(coverageOf({ ...bare, garFlats: 40 }).level, 'kind', 'квартиры в ГАР — это знание о типе');
  assert.equal(coverageOf({ ...bare, humanForm: 'direct' }).level, 'kind', 'форму поставил оператор');
});

test('организация с ИНН и контактом — зелёный; без контакта — ещё жёлтый', () => {
  const org = { ...bare, houseKind: 'mkd' as const, registryForm: 'tsj' as const, orgInn: '6102017830' };
  assert.equal(coverageOf({ ...org, orgHasContact: true }).level, 'contact');
  assert.equal(coverageOf(org).level, 'kind');
});

test('председатель или кабинет организации — договорились', () => {
  assert.equal(coverageOf({ ...bare, hasChairman: true }).level, 'agreed', 'председатель сам по себе — договорённость');
  assert.equal(coverageOf({ ...bare, orgInn: '1', orgHasContact: true, orgHasCabinet: true }).level, 'agreed');
});

test('частный дом по реестру или по слову оператора — частный, не «вероятно»', () => {
  assert.deepEqual(coverageOf({ ...bare, registryForm: 'private', houseKind: 'blocked' }), { level: 'kind', isPrivate: true, privateLikely: false });
  assert.equal(coverageOf({ ...bare, humanForm: 'private' }).isPrivate, true);
});

test('дом с квартирами, из реестра фонда или с признаком ФНС вероятно частным не считается', () => {
  assert.deepEqual(coverageOf({ ...bare, garMkd: true }), { level: 'kind', isPrivate: false, privateLikely: false });
  assert.equal(coverageOf({ ...bare, garFlats: 3 }).privateLikely, false);
  assert.equal(coverageOf({ ...bare, houseKind: 'mkd' }).privateLikely, false);
});
