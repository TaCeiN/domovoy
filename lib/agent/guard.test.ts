import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFacts } from './guard.ts';

/**
 * Проверка фактов в ответе модели.
 *
 * Данные жителя — деньги, номера заявок, телефоны, даты, показания —
 * должны взяться из инструментов или из его же сообщения. Числа законов
 * («14 дней», «ст. 157») проверка не трогает: это не данные жителя.
 */

const src = [
  '{"total":"4 850,00 ₽","requests":[{"number":"00012"}],"phone":"+7 (863) 000-00-01","until":"15.10"}',
  'сколько платить',
];

test('числа из инструментов проходят', () => {
  const r = checkFacts('К оплате 4 850,00 ₽, заявка № 12, звоните +7 863 000-00-01 до 15.10.', src);
  assert.deepEqual(r.unknown, []);
  assert.equal(r.ok, true);
});

test('сумма без копеек, как в источнике с копейками, проходит', () => {
  assert.equal(checkFacts('Платить 4 850 ₽.', src).ok, true);
});

test('выдуманная сумма ловится', () => {
  const r = checkFacts('К оплате 5 100 ₽.', src);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unknown, ['5 100 ₽']);
});

test('выдуманный номер заявки ловится', () => {
  assert.equal(checkFacts('Ваша заявка № 45 в работе.', src).ok, false);
  assert.equal(checkFacts('Заявка 45 в работе.', src).ok, false);
});

test('выдуманный телефон ловится', () => {
  assert.equal(checkFacts('Звоните 8 (863) 222-33-44.', src).ok, false);
});

test('выдуманная дата ловится', () => {
  assert.equal(checkFacts('Воду дадут 20 октября.', src).ok, false);
  assert.equal(checkFacts('Воду дадут 20.10.', src).ok, false);
});

test('законы и общие числа не трогаем', () => {
  const r = checkFacts('По закону перерыв не больше 14 дней, ст. 157 ЖК РФ, не более 8 часов в месяц. Звоните 112.', src);
  assert.equal(r.ok, true);
});

test('число из сообщения жителя проходит', () => {
  assert.equal(checkFacts('Показание 123,4 куб. записано в черновик.', ['показание 123,4']).ok, true);
});

test('выдуманное показание ловится', () => {
  assert.equal(checkFacts('Последнее показание 98,7 куб.', src).ok, false);
});

test('короткий выдуманный номер не находится внутри телефона', () => {
  assert.equal(checkFacts('Ваша заявка № 86 выполнена.', src).ok, false);
});

test('число, записанное в источнике так же, проходит (рейтинг 4.6 — не дата)', () => {
  assert.equal(checkFacts('Оценка жильцов — 4.6 из 5.', ['{"rating":4.6}']).ok, true);
});
