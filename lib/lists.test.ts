import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIST_PAGE, LIST_MAX, readLimit, matchesQuery } from './lists.ts';

/**
 * Разбор параметров списка — один на все списочные маршруты.
 *
 * Если каждый маршрут читает `limit` сам, они разъезжаются: где-то мусор
 * в параметре роняет запрос, где-то отдаёт всё, где-то ноль строк.
 */

test('пустой и мусорный limit дают страницу по умолчанию', () => {
  assert.equal(readLimit(undefined), LIST_PAGE);
  assert.equal(readLimit(''), LIST_PAGE);
  assert.equal(readLimit('сорок'), LIST_PAGE);
  assert.equal(readLimit(null), LIST_PAGE);
});

test('limit не бывает нулевым и отрицательным', () => {
  assert.equal(readLimit('0'), 1);
  assert.equal(readLimit('-5'), 1);
});

/**
 * Потолок нужен ровно затем, чтобы «Показать ещё» не превратилось
 * в выгрузку всей истории одним ответом: параметр приходит из адресной
 * строки, а на той стороне мессенджер и мобильный интернет.
 */
test('limit упирается в потолок', () => {
  assert.equal(readLimit('1000000'), LIST_MAX);
  assert.equal(readLimit(String(LIST_MAX + 1)), LIST_MAX);
});

test('дробное значение округляется вниз', () => {
  assert.equal(readLimit('50.9'), 50);
});

test('поиск не различает регистр и находит часть слова', () => {
  assert.equal(matchesQuery(['Не работает ЛИФТ'], 'лифт'), true);
  assert.equal(matchesQuery(['Течёт кран'], 'кра'), true);
  assert.equal(matchesQuery(['Течёт кран'], 'лифт'), false);
});

test('поиск идёт по всем переданным полям сразу', () => {
  const row = ['00207', 'Пр-кт Ленина, д. 85', 'Лифт шумит'];
  assert.equal(matchesQuery(row, 'ленина'), true);
  assert.equal(matchesQuery(row, '207'), true);
  assert.equal(matchesQuery(row, 'шумит'), true);
});

/** Пустой запрос — это отсутствие поиска, а не «ничего не найдено». */
test('пустой запрос пропускает всё', () => {
  assert.equal(matchesQuery(['что угодно'], ''), true);
  assert.equal(matchesQuery(['что угодно'], '   '), true);
});

test('пустые поля не роняют поиск', () => {
  assert.equal(matchesQuery([null, undefined, 'Лифт'], 'лифт'), true);
  assert.equal(matchesQuery([null, undefined], 'лифт'), false);
});
