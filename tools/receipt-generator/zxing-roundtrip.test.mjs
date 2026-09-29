import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeQr, qrToPixels } from './lib/qr-encode.mjs';
import { encodeCp1251 } from './lib/cp1251.mjs';
import { repairEncoding } from '../../lib/qr/encoding.ts';

/**
 * Круг замыкается на ТОМ ЖЕ декодере, которым приложение читает квитанции.
 *
 * Соседний qr-encode.test.mjs проверяет кодировщик через jsQR — он остался
 * резервом. Здесь проверяется основной путь: ZXing, вендоренный в public/,
 * и главное — что он отдаёт СЫРЫЕ БАЙТЫ, а не готовую строку.
 *
 * Второй тест в этом файле важнее первого. Он показывает на живом декодере,
 * что происходит с кириллицей win-1251, когда байты превращают в строку
 * без учёта заголовка, — и что наш ремонт эту порчу отменяет. Именно так
 * ведёт себя нативный сканер мессенджера: по документации он отдаёт
 * `Promise<string>` и «кодирует результат автоматически».
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * В Node модуль не может забрать .wasm по file:// — fetch такую схему
 * не поддерживает. В браузере он лежит рядом и грузится обычным запросом,
 * поэтому подмена только для тестов.
 */
const zxing = await import('../../public/vendor/zxing/reader/index.js');
zxing.prepareZXingModule({
  overrides: {
    wasmBinary: readFileSync(join(here, '../../public/vendor/zxing/reader/zxing_reader.wasm')),
  },
});

const OPTIONS = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  maxNumberOfSymbols: 1,
};

const RECEIPT =
  'ST00011|Name=ООО "УК Трианон"|PayeeINN=6168108630|'
  + 'payerAddress=344038, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3, кв. 27|'
  + 'persAcc=987654331|Sum=381630';

/** Нарисовать QR и прочитать его вендоренным ZXing. */
async function roundTrip(bytes) {
  const matrix = encodeQr(bytes, {});
  const { data, width, height } = qrToPixels(matrix, { scale: 4 });

  const results = await zxing.readBarcodes({ data, width, height }, OPTIONS);
  const hit = results.find((r) => r.isValid && r.bytes?.length);
  assert.ok(hit, `QR не прочитался: версия ${matrix.version}, ${bytes.length} байт`);
  return hit;
}

test('ZXing отдаёт байты win-1251 без искажений', async () => {
  const bytes = encodeCp1251(RECEIPT);
  // Один байт на символ — иначе это не win-1251
  assert.equal(bytes.length, RECEIPT.length);

  const hit = await roundTrip(bytes);
  assert.deepEqual([...hit.bytes], [...bytes], 'байты обязаны дойти нетронутыми');

  const decoded = new TextDecoder('windows-1251').decode(Uint8Array.from(hit.bytes));
  assert.equal(decoded, RECEIPT);
});

/**
 * ЗАЧЕМ ЭТОТ ТЕСТ. Вопрос «портит ли нативный сканер MAX кодировку» стоял
 * первым в списке задач с 25 августа. Ответить на него напрямую нельзя —
 * чужой клиент в тесты не позовёшь. Но ядро у мобильных сканеров то же
 * самое, ZXing, и здесь видно, ЧТО именно оно отдаёт строкой: латиницу
 * вместо кириллицы, байт в байт. Такую порчу ремонт отменяет полностью.
 */
test('строка от ZXing — это latin1-мусор, и ремонт его отменяет', async () => {
  const hit = await roundTrip(encodeCp1251(RECEIPT));

  assert.ok(!/[Ѐ-ӿ]/.test(hit.text), 'кириллицы в строке от декодера нет — она и есть проблема');
  assert.ok(!hit.text.includes('�'), 'но байты не потеряны: замен U+FFFD нет');

  const repaired = repairEncoding(hit.text);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.text, RECEIPT);
});
