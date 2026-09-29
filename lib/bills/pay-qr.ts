import { createHmac, timingSafeEqual } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { encodeQr } from '../qr/encode.mjs';
import { encodeByFlag } from '../qr/cp1251.mjs';

/**
 * QR квитанции для оплаты в банке.
 *
 * Житель нажимает «Сохранить и открыть»: картинка с тем же платёжным QR,
 * что был на бумаге, уходит в галерею, а в банке он выбирает «Оплата
 * по QR → из галереи». Банк сам заполняет перевод по реквизитам.
 * Настоящую ссылку СБП на сумму квитанции выпускает только банк
 * получателя — договоров нет, см. спеку 2026-09-17-pay-bank-redirect.
 *
 * ПОЧЕМУ PNG РИСУЕТ СЕРВЕР. Сохранение в MAX — нативный `downloadFile(url)`:
 * он скачивает файл по обычной ссылке и не принимает ни картинку из
 * браузера, ни наш заголовок авторизации. Поэтому ссылка подписана
 * и живёт недолго: в ней нет сессии, но и угадать её нельзя.
 */

export const PAY_QR_TTL_SECONDS = 15 * 60;

function mac(billId: string, expires: number, secret: string): string {
  return createHmac('sha256', secret).update(`pay-qr|${billId}|${expires}`).digest('hex');
}

/** Подпись ссылки на QR: `<срок в секундах>.<hmac>` */
export function signPayQr(billId: string, secret: string, now = Date.now()): string {
  const expires = Math.floor(now / 1000) + PAY_QR_TTL_SECONDS;
  return `${expires}.${mac(billId, expires, secret)}`;
}

export function verifyPayQr(billId: string, token: string, secret: string, now = Date.now()): boolean {
  const [expiresText, signature] = String(token ?? '').split('.');
  const expires = Number(expiresText);
  if (!Number.isInteger(expires) || !signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (expires * 1000 < now) return false;

  const expected = Buffer.from(mac(billId, expires, secret), 'hex');
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/**
 * Строка квитанции → PNG с QR-кодом.
 *
 * Байты — по признаку кодировки из заголовка, как на бумаге: ST00011 —
 * windows-1251, ST00012 — UTF-8. Иначе банк прочитал бы кириллицу мусором.
 */
export function receiptQrPng(raw: string, { scale = 8, quiet = 4 } = {}): Buffer {
  const flag = /^ST0001(\d)/.exec(raw)?.[1] ?? '2';
  const matrix = encodeQr(encodeByFlag(raw, flag === '1' ? '1' : '2'), { ecc: 'M' });

  const side = (matrix.size + quiet * 2) * scale;
  const rows = Buffer.alloc(side * (side + 1), 255);
  for (let y = 0; y < side; y++) {
    rows[y * (side + 1)] = 0; // фильтр строки: без фильтра
    const my = Math.floor(y / scale) - quiet;
    if (my < 0 || my >= matrix.size) continue;
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - quiet;
      if (mx >= 0 && mx < matrix.size && matrix.modules[my][mx]) rows[y * (side + 1) + 1 + x] = 0;
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // бит на канал
  header[9] = 0; // оттенки серого

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
