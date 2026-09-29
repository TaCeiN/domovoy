import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import jsQRModule from 'jsqr';
import { encodeCp1251 } from '../qr/cp1251.mjs';
import { signPayQr, verifyPayQr, receiptQrPng, PAY_QR_TTL_SECONDS } from './pay-qr.ts';

// Пакет CommonJS: под NodeNext функция лежит в default, а TypeScript этого не видит
const jsQR = ((jsQRModule as unknown as { default?: typeof jsQRModule }).default ?? jsQRModule) as unknown as (
  data: Uint8ClampedArray, width: number, height: number,
) => { binaryData: number[] } | null;

const SECRET = 'test-secret';
const RECEIPT =
  'ST00011|Name=ТСЖ "АЛЬТАИР"|PersonalAcc=40702810952090030727|BankName=ПАО Сбербанк|' +
  'BIC=046015602|CorrespAcc=30101810600000000602|Sum=250000|PayeeINN=6163123641|persAcc=550016912';

/** Серый 8-битный PNG без фильтров — ровно то, что пишет receiptQrPng */
function decodePng(png: Buffer) {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'подпись PNG');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = raw[y * (width + 1) + 1 + x];
      rgba.set([v, v, v, 255], (y * width + x) * 4);
    }
  }
  return { rgba, width, height };
}

test('QR квитанции в PNG читается обратно теми же байтами, кириллица — в windows-1251', () => {
  const { rgba, width, height } = decodePng(receiptQrPng(RECEIPT));
  const decoded = jsQR(rgba, width, height);
  assert.ok(decoded, 'банк должен прочитать картинку');
  assert.deepEqual(Uint8Array.from(decoded.binaryData), encodeCp1251(RECEIPT),
    'ST00011 — однобайтовая кодировка, как на бумажной квитанции');
});

test('QR с заголовком ST00012 кодируется в UTF-8', () => {
  const utf = RECEIPT.replace('ST00011', 'ST00012');
  const { rgba, width, height } = decodePng(receiptQrPng(utf));
  const decoded = jsQR(rgba, width, height);
  assert.equal(Buffer.from(decoded!.binaryData).toString('utf8'), utf);
});

test('ссылка на QR подписана под конкретное начисление и живёт ограниченное время', () => {
  const now = 1_800_000_000_000;
  const token = signPayQr('bil_1', SECRET, now);

  assert.equal(verifyPayQr('bil_1', token, SECRET, now + 60_000), true);
  assert.equal(verifyPayQr('bil_2', token, SECRET, now), false, 'чужое начисление');
  assert.equal(verifyPayQr('bil_1', token, 'other-secret', now), false, 'чужой секрет');
  assert.equal(verifyPayQr('bil_1', token, SECRET, now + (PAY_QR_TTL_SECONDS + 1) * 1000), false, 'истекла');
  assert.equal(verifyPayQr('bil_1', 'мусор', SECRET, now), false);
  assert.equal(verifyPayQr('bil_1', `${Number(token.split('.')[0]) + 999}.${token.split('.')[1]}`, SECRET, now), false,
    'срок нельзя продлить, не зная секрета');
});
