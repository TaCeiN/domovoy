import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReceipt, decodeReceiptBytes, formatKopecks } from './receipt.ts';

const NBSP = ' ';

/** Реальная строка с квитанции пилотного дома. */
const REAL_QR =
  'ST00011|Name=ООО "УК Трианон"|PersonalAcc=40702810952090030727|BankName=ПАО Сбербанк|' +
  'BIC=046015602|CorrespAcc=30101810600000000602|Sum=381630|Purpose=Оплата за ЖКУ|' +
  'PayeeINN=6168108630|PayerINN=|KPP=616801001|lastName=Крутых|firstName=Сергей|' +
  'middleName=Валерьевич|payerAddress=344038, Ростовская обл, г Ростов-на-Дону, ' +
  'пр-кт Ленина, д. 85, к. 3, кв. 27|persAcc=987654331|paymPeriod=042026|category=001';

test('реальная квитанция разбирается полностью', () => {
  const r = parseReceipt(REAL_QR);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const { receipt } = r;

  assert.equal(receipt.version, '0001');
  assert.equal(receipt.encoding, 'windows-1251');

  assert.equal(receipt.payee.name, 'ООО "УК Трианон"');
  assert.equal(receipt.payee.inn, '6168108630');
  assert.equal(receipt.payee.kpp, '616801001');
  assert.equal(receipt.payee.bic, '046015602');

  assert.equal(receipt.payer.fullName, 'Крутых Сергей Валерьевич');
  assert.equal(receipt.payer.persAcc, '987654331');
  assert.match(receipt.payer.address!, /Ростов-на-Дону/);

  assert.equal(receipt.sumKopecks, 381630);
  assert.equal(receipt.period, '2026-04');
  assert.equal(receipt.category, '001');
});

test('сумма остаётся копейками и форматируется в рубли только на выводе', () => {
  const r = parseReceipt(REAL_QR);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.receipt.sumKopecks, 381630);
  assert.equal(formatKopecks(r.receipt.sumKopecks!), `3${NBSP}816,30${NBSP}₽`);
});

test('копейки форматируются с ведущим нулём', () => {
  assert.equal(formatKopecks(100000), `1${NBSP}000,00${NBSP}₽`);
  assert.equal(formatKopecks(5), `0,05${NBSP}₽`);
  assert.equal(formatKopecks(1005), `10,05${NBSP}₽`);
  assert.equal(formatKopecks(123456789), `1${NBSP}234${NBSP}567,89${NBSP}₽`);
});

test('расчётный счёт получателя и лицевой счёт плательщика не путаются', () => {
  const r = parseReceipt(REAL_QR);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.receipt.payee.account, '40702810952090030727'); // PersonalAcc
  assert.equal(r.receipt.payer.persAcc, '987654331');            // persAcc
  assert.notEqual(r.receipt.payee.account, r.receipt.payer.persAcc);
});

test('пустой PayerINN не ломает разбор', () => {
  const r = parseReceipt(REAL_QR);
  assert.ok(r.ok);
});

test('UTF-8 вариант ST00012 тоже принимается', () => {
  const r = parseReceipt('ST00012|Name=ТСЖ Маршал|PayeeINN=7701234567|persAcc=123|Sum=100000');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.receipt.encoding, 'utf-8');
  assert.equal(r.receipt.payee.name, 'ТСЖ Маршал');
});

test('регистр имён полей не важен', () => {
  const r = parseReceipt('ST00012|NAME=УК Тест|payeeinn=7701234567|PERSACC=555|SUM=250');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.receipt.payee.name, 'УК Тест');
  assert.equal(r.receipt.payer.persAcc, '555');
  assert.equal(r.receipt.sumKopecks, 250);
});

test('не платёжный QR отвергается', () => {
  assert.equal(parseReceipt('https://example.com').ok, false);
  assert.equal(parseReceipt('').ok, false);
  const r = parseReceipt('QQ00011|Name=x');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'not_a_payment_qr');
});

test('без обязательных полей отвергается', () => {
  const r = parseReceipt('ST00012|Sum=100|persAcc=1');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'missing_required');
});

test('мусорная сумма не становится нулём', () => {
  const r = parseReceipt('ST00012|Name=УК|PayeeINN=1|Sum=3816.30');
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.receipt.sumKopecks, null, 'дробная сумма — не копейки, лучше null чем враньё');
});

test('некорректный период не проходит', () => {
  const bad = parseReceipt('ST00012|Name=УК|PayeeINN=1|paymPeriod=132026');
  assert.ok(bad.ok);
  if (!bad.ok) return;
  assert.equal(bad.receipt.period, null, 'месяца 13 не бывает');
});

test('байты windows-1251 декодируются по флагу заголовка, а не как UTF-8', () => {
  // Собираем настоящую win-1251 строку: кириллица в однобайтовой кодировке
  const ascii = 'ST00011|Name=';
  const cyrillicWin1251 = [0xd3, 0xca]; // «УК» в win-1251
  const tail = '|PayeeINN=7701234567';

  const bytes = new Uint8Array([
    ...[...ascii].map((c) => c.charCodeAt(0)),
    ...cyrillicWin1251,
    ...[...tail].map((c) => c.charCodeAt(0)),
  ]);

  const decoded = decodeReceiptBytes(bytes);
  assert.ok(decoded, 'должно декодироваться');
  assert.match(decoded!, /Name=УК/, 'кириллица должна читаться, а не превращаться в мусор');

  // А если бы декодировали как UTF-8 — получили бы замену на U+FFFD
  const wrong = new TextDecoder('utf-8').decode(bytes);
  assert.ok(wrong.includes('�'), 'подтверждаем: наивный UTF-8 ломает кириллицу');

  const parsed = parseReceipt(decoded!);
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.receipt.payee.name, 'УК');
});

test('не-QR байты отвергаются на уровне декодера', () => {
  assert.equal(decodeReceiptBytes(new Uint8Array([1, 2, 3])), null);
  const notSt = new Uint8Array([...'HTTP://xx'].map((c) => c.charCodeAt(0)));
  assert.equal(decodeReceiptBytes(notSt), null);
});

test('кавычки внутри названия УК сохраняются, обёртка снимается', () => {
  const keep = parseReceipt('ST00012|Name=ООО "УК Трианон"|PayeeINN=1');
  assert.ok(keep.ok);
  if (!keep.ok) return;
  assert.equal(keep.receipt.payee.name, 'ООО "УК Трианон"');

  const wrapped = parseReceipt('ST00012|Name="ООО УК Трианон"|PayeeINN=1');
  assert.ok(wrapped.ok);
  if (!wrapped.ok) return;
  assert.equal(wrapped.receipt.payee.name, 'ООО УК Трианон');

  const guillemets = parseReceipt('ST00012|Name=«ТСЖ Пример»|PayeeINN=1');
  assert.ok(guillemets.ok);
  if (!guillemets.ok) return;
  assert.equal(guillemets.receipt.payee.name, 'ТСЖ Пример');
});

/* ─────────── кодировка нативного сканера MAX ─────────── */

/**
 * Нативный сканер MAX отдаёт готовую строку, а не байты. Если он прочитал
 * win-1251 как latin1, разбор обязан её починить, а не принять мусор:
 * до этой правки квитанция «разбиралась успешно», адрес не давал ключа дома,
 * и человек получал сообщение про нехватку лицевого счёта — неправду.
 */
test('квитанция из нативного сканера чинится и разбирается', () => {
  const bytes: number[] = [];
  for (const ch of REAL_QR) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) bytes.push(c);
    else if (c >= 0x410 && c <= 0x44f) bytes.push(c - 0x410 + 0xc0);
    else throw new Error('символ вне тестовой таблицы');
  }
  const mangled = new TextDecoder('latin1').decode(Uint8Array.from(bytes));

  const r = parseReceipt(mangled);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.receipt.encodingRepaired, true);
  assert.equal(r.receipt.payee.name, 'ООО "УК Трианон"');
  assert.match(r.receipt.payer.address ?? '', /Ростов-на-Дону/);
});

test('безвозвратно испорченная строка отклоняется, а не разбирается', () => {
  const r = parseReceipt('ST00011|Name=\uFFFD\uFFFD\uFFFD|PayeeINN=6168108630|persAcc=1');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'mangled');
});

test('целая квитанция помечается как неремонтированная', () => {
  const r = parseReceipt(REAL_QR);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.receipt.encodingRepaired, false);
});
