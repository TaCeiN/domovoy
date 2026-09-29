import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReceipt, toKopecks, formatPeriod, persAccFor, PAYEES } from './lib/receipt.mjs';
import { parseReceipt } from '../../lib/qr/receipt.ts';
import { parseAddress } from '../../lib/address/normalize.ts';

/**
 * Круг замыкается на настоящем потребителе.
 *
 * Генератор бесполезен, если выдаёт строки, которые приложение читает
 * иначе, чем задумано: тогда проверять им нечего, а расхождение вылезет
 * на живом стенде и будет выглядеть как поломка приложения.
 *
 * Поэтому здесь всё, что собирает генератор, тут же разбирается
 * НАСТОЯЩИМ разборщиком из lib/qr/receipt.ts и настоящей нормализацией
 * адреса. Не копией, а импортом — копия однажды разъедется.
 */

const REGISTRY_ADDRESS = '344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. 85/3';

test('собранная квитанция разбирается приложением', () => {
  const payee = PAYEES.find((p) => p.id === 'ivc');

  const string = buildReceipt({
    encoding: '1',
    payeeName: payee.name,
    payeeInn: payee.inn,
    kpp: payee.kpp,
    purpose: payee.purpose,
    persAcc: '857000000015641',
    address: `${REGISTRY_ADDRESS}, кв. 27`,
    lastName: 'Крутых',
    firstName: 'Сергей',
    middleName: 'Валерьевич',
    sumKopecks: toKopecks('3816.30'),
    period: '082026',
  });

  const parsed = parseReceipt(string);
  assert.equal(parsed.ok, true, 'разбор обязан принять нашу строку');
  if (!parsed.ok) return;

  assert.equal(parsed.receipt.encoding, 'windows-1251');
  assert.equal(parsed.receipt.payee.name, payee.name);
  assert.equal(parsed.receipt.payee.inn, payee.inn);
  assert.equal(parsed.receipt.payer.persAcc, '857000000015641');
  assert.equal(parsed.receipt.payer.fullName, 'Крутых Сергей Валерьевич');

  // Деньги — только в копейках, ни одного float по дороге
  assert.equal(parsed.receipt.sumKopecks, 381630);
  assert.equal(parsed.receipt.period, '2026-08');
});

/**
 * Квитанция расчётного центра — без адреса и без ФИО.
 *
 * Самый частый живой случай и самый долгий в починке: приложение обязано
 * не заводить пустой объект, а спросить адрес у жителя. Генератор должен
 * уметь его воспроизводить, иначе этот путь так и останется непроверенным.
 */
test('квитанция без адреса и ФИО собирается и разбирается', () => {
  const string = buildReceipt({
    payeeName: 'ГУП РО "ИВЦ ЖКХ"',
    payeeInn: '6167110467',
    persAcc: '857000000015641',
    address: '',
    lastName: '',
    firstName: '',
    sumKopecks: 250000,
    period: '082026',
  });

  assert.ok(!string.includes('payerAddress='), 'пустых полей в строке быть не должно');
  assert.ok(!string.includes('lastName='));

  const parsed = parseReceipt(string);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.equal(parsed.receipt.payer.address, null);
  assert.equal(parsed.receipt.payer.fullName, null);
  assert.equal(parsed.receipt.payer.persAcc, '857000000015641');
});

test('адрес из генератора даёт тот же ключ дома, что и реестровый', () => {
  const fromGenerator = parseAddress(`${REGISTRY_ADDRESS}, кв. 27`);
  const fromRegistry = parseAddress(REGISTRY_ADDRESS);

  assert.equal(
    fromGenerator.houseKey, fromRegistry.houseKey,
    'квартира не должна влиять на ключ дома — иначе соседи разойдутся',
  );
  assert.equal(fromGenerator.flat, '27');
});

test('обе кодировки дают заголовок, который разбор понимает', () => {
  for (const [flag, expected] of [['1', 'windows-1251'], ['2', 'utf-8']]) {
    const string = buildReceipt({
      encoding: flag,
      payeeName: 'ООО "УК Трианон"',
      payeeInn: '6168108630',
      persAcc: '1',
    });
    const parsed = parseReceipt(string);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.receipt.encoding, expected);
  }
});

test('сумма в рублях превращается в копейки без потерь', () => {
  assert.equal(toKopecks('3816.30'), 381630);
  assert.equal(toKopecks('3816,30'), 381630, 'запятая как разделитель тоже бывает');
  assert.equal(toKopecks('0'), 0);
  assert.equal(toKopecks('не число'), null);
  assert.equal(toKopecks('-5'), null);
});

test('период по умолчанию — текущий месяц в формате квитанции', () => {
  assert.equal(formatPeriod(new Date(2026, 7, 15)), '082026');
  assert.equal(formatPeriod(new Date(2026, 11, 1)), '122026');
});

/**
 * Номер счёта обязан быть устойчивым: та же квартира — тот же номер.
 *
 * Иначе каждая генерация заводила бы в приложении НОВЫЙ лицевой счёт,
 * и проверить «повторный скан той же квитанции обновляет, а не плодит»
 * стало бы нечем.
 */
test('лицевой счёт повторяем для одного адреса и разный для разных', () => {
  const first = persAccFor(REGISTRY_ADDRESS, '27');
  assert.equal(first, persAccFor(REGISTRY_ADDRESS, '27'));
  assert.notEqual(first, persAccFor(REGISTRY_ADDRESS, '28'));
  assert.notEqual(first, persAccFor('г Азов, ул Мира, д. 1', '27'));
  assert.match(first, /^\d{15}$/, 'пятнадцать цифр — как у расчётных центров');
});
