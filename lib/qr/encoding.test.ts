import test from 'node:test';
import assert from 'node:assert/strict';
import { repairEncoding } from './encoding.ts';

const REAL_QR =
  'ST00011|Name=ООО "УК Трианон"|PersonalAcc=40702810952090030727|BankName=ПАО Сбербанк|' +
  'BIC=046015602|CorrespAcc=30101810600000000602|Sum=381630|Purpose=Оплата за ЖКУ|' +
  'PayeeINN=6168108630|PayerINN=|KPP=616801001|lastName=Крутых|firstName=Сергей|' +
  'middleName=Валерьевич|payerAddress=344038, Ростовская обл, г Ростов-на-Дону, ' +
  'пр-кт Ленина, д. 85, к. 3, кв. 27|persAcc=987654331|paymPeriod=042026|category=001';

/**
 * Кодировщик в windows-1251 для тестов.
 *
 * Готового в Node нет, а тащить iconv ради шести строк незачем: русский
 * диапазон отображается арифметикой, и этого хватает на любую квитанцию.
 */
function toCp1251(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c === 0x401) out.push(0xa8);
    else if (c === 0x451) out.push(0xb8);
    else if (c >= 0x410 && c <= 0x44f) out.push(c - 0x410 + 0xc0);
    else throw new Error(`нет отображения для U+${c.toString(16)}`);
  }
  return Uint8Array.from(out);
}

/** Так строку увидит клиент, который прочитал win-1251 как latin1. */
const asLatin1 = (text: string) => new TextDecoder('latin1').decode(toCp1251(text));

/** Так — клиент, который прочитал их как UTF-8: битые байты заменены на U+FFFD. */
const asUtf8 = (text: string) => new TextDecoder('utf-8').decode(toCp1251(text));

test('latin1-мусор восстанавливается побайтово точно', () => {
  const r = repairEncoding(asLatin1(REAL_QR));
  assert.equal(r.damaged, false);
  assert.equal(r.repaired, true);
  assert.equal(r.text, REAL_QR);
});

test('целую строку не трогаем', () => {
  const r = repairEncoding(REAL_QR);
  assert.equal(r.repaired, false);
  assert.equal(r.damaged, false);
  assert.equal(r.text, REAL_QR);
});

test('UTF-8 поверх win-1251 — потеря без возврата', () => {
  const r = repairEncoding(asUtf8(REAL_QR));
  assert.equal(r.damaged, true, 'U+FFFD означает, что байты уже стёрты');
  assert.equal(r.repaired, false);
});

test('ST00012: latin1 поверх UTF-8 тоже чинится', () => {
  const utf8Receipt = 'ST00012|Name=ТСЖ Маршал|PayeeINN=7701234567|persAcc=123';
  const bytes = new TextEncoder().encode(utf8Receipt);
  const mangled = new TextDecoder('latin1').decode(bytes);

  const r = repairEncoding(mangled);
  assert.equal(r.repaired, true);
  assert.equal(r.text, utf8Receipt);
});

test('не платёжный QR не трогаем вовсе', () => {
  const r = repairEncoding('https://example.com/Ã©Ã¨');
  assert.equal(r.repaired, false);
  assert.equal(r.damaged, false);
});

test('чистый ASCII без кириллицы не считается мусором', () => {
  const ascii = 'ST00011|Name=UK TRIANON|PayeeINN=6168108630|persAcc=1';
  const r = repairEncoding(ascii);
  assert.equal(r.repaired, false);
  assert.equal(r.text, ascii);
});

/**
 * Кавычки в названии УК — самый частый нелатинский символ в квитанции,
 * и cp1252 отображает их не туда же, куда latin1. Без обратной таблицы
 * 0x80–0x9F такая строка не восстановилась бы.
 */
test('кавычки-ёлочки из cp1252 не мешают ремонту', () => {
  const withQuotes = 'ST00011|Name=УК «Трианон»|PayeeINN=6168108630|persAcc=1';
  const bytes: number[] = [];
  for (const ch of withQuotes) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) bytes.push(c);
    else if (c === 0xab) bytes.push(0xab);
    else if (c === 0xbb) bytes.push(0xbb);
    else if (c >= 0x410 && c <= 0x44f) bytes.push(c - 0x410 + 0xc0);
    else throw new Error('символ вне тестовой таблицы');
  }
  const mangled = new TextDecoder('windows-1252').decode(Uint8Array.from(bytes));

  const r = repairEncoding(mangled);
  assert.equal(r.repaired, true);
  assert.equal(r.text, withQuotes);
});
