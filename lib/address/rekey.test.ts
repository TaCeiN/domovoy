import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRekey } from './rekey.ts';
import { parseAddress } from './normalize.ts';

/**
 * Пересчёт ключей домов после смены правил разбора адреса.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ. Пересчёт УДАЛЯЕТ строки: когда правила
 * становятся мягче, два дома реестра дают один ключ, а уникальный индекс
 * второго не пустит. Решать, кто останется, «по ходу» обхода нельзя —
 * исход зависел бы от порядка строк из базы. Поэтому план считается
 * целиком и заранее, чистой функцией, и его видно в тестах.
 */

const address = (tail: string) => `344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, ${tail}`;
const keyOf = (tail: string) => parseAddress(address(tail)).houseKey;

const row = (id: string, tail: string, houseKey: string, blocked = false) => ({
  id,
  addressRaw: address(tail),
  houseKey,
  blocked,
});

test('ключ совпадает с нынешними правилами — делать нечего', () => {
  const plan = planRekey([row('a', 'д. 85, к. 3', keyOf('д. 85, к. 3'))]);

  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.deletes, []);
});

test('ключ устарел — дом получает новый', () => {
  const plan = planRekey([row('a', 'д. 85/3', 'ключ-по-старым-правилам')]);

  assert.deepEqual(plan.updates, [{ id: 'a', houseKey: keyOf('д. 85/3') }]);
  assert.deepEqual(plan.deletes, []);
});

test('два написания одного дома схлопываются в одну запись', () => {
  const plan = planRekey([
    row('дробью', 'д. 85/3', 'ключ-по-старым-правилам'),
    row('корпусом', 'д. 85, к. 3', keyOf('д. 85, к. 3')),
  ]);

  assert.equal(plan.deletes.length, 1, 'одна из двух записей уходит');
  assert.equal(plan.updates.length + plan.deletes.length, 2, 'обе строки в плане');

  const survivor = ['дробью', 'корпусом'].find((id) => !plan.deletes.includes(id));
  assert.ok(survivor, 'один дом остаётся');
});

test('дом остаётся за действующей организацией, заблокированная уступает', () => {
  const plan = planRekey([
    row('заблокированная', 'д. 85/3', 'ключ-по-старым-правилам', true),
    row('действующая', 'д. 85, к. 3', keyOf('д. 85, к. 3')),
  ]);

  assert.deepEqual(plan.deletes, ['заблокированная']);
});

test('порядок строк на исход не влияет', () => {
  const rows = [
    row('заблокированная', 'д. 85, к. 3', 'ключ-по-старым-правилам', true),
    row('действующая', 'д. 85/3', 'другой-старый-ключ'),
  ];

  assert.deepEqual(planRekey(rows).deletes, ['заблокированная']);
  assert.deepEqual(planRekey([...rows].reverse()).deletes, ['заблокированная']);
});

test('разные дома не сливаются', () => {
  const plan = planRekey([
    row('первый', 'д. 85, к. 3', keyOf('д. 85, к. 3')),
    row('второй', 'д. 85, к. 4', keyOf('д. 85, к. 4')),
  ]);

  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(plan.updates, []);
});

test('неразбираемый адрес не трогаем и не удаляем', () => {
  const plan = planRekey([
    { id: 'мусор', addressRaw: '   ', houseKey: 'старый', blocked: false },
  ]);

  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(plan.unparsed, ['мусор']);
});
