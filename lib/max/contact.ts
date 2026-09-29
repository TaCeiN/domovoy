import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Проверка номера телефона из window.WebApp.requestContact().
 *
 * Это ВТОРОЙ ФАКТОР: initData доказывает, что человек — владелец аккаунта MAX,
 * requestContact доказывает, что к аккаунту привязан именно этот номер.
 * Вместе с QR квитанции получается три независимых подтверждения перед тем,
 * как отдать доступ к лицевому счёту.
 *
 * Схема подписи ОТЛИЧАЕТСЯ от initData: здесь ключом служит сам токен бота,
 * без промежуточного secret_key.
 *   hash = HMAC_SHA256(ключ: BOT_TOKEN, сообщение: "authDate=..\nphone=..\nuserId=..")
 * Пары в алфавитном порядке, разделитель \n, телефон без «+».
 */

export interface ContactPayload {
  phone: string;
  authDate: string | number;
  hash: string;
}

export type ContactResult =
  | { ok: true; phone: string; authDateSeconds: number }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export const DEFAULT_CONTACT_MAX_AGE_SECONDS = 60 * 60;

/** MAX считает хеш по номеру без «+»: 79991234567, а не +79991234567. */
export function normalisePhone(phone: string): string {
  return phone.replace(/[^\d]/g, '');
}

export function validateContact(
  payload: ContactPayload,
  options: {
    botToken: string;
    userId: number;
    maxAgeSeconds?: number;
    now?: Date;
  },
): ContactResult {
  const {
    botToken,
    userId,
    maxAgeSeconds = DEFAULT_CONTACT_MAX_AGE_SECONDS,
    now = new Date(),
  } = options;

  if (!payload?.phone || !payload?.hash || payload.authDate === undefined) {
    return { ok: false, reason: 'malformed' };
  }

  const phone = normalisePhone(payload.phone);
  const authDate = String(payload.authDate);

  const message = [
    `authDate=${authDate}`,
    `phone=${phone}`,
    `userId=${userId}`,
  ].join('\n');

  const expected = createHmac('sha256', botToken).update(message).digest('hex');

  if (!constantTimeEquals(expected, payload.hash)) {
    return { ok: false, reason: 'bad_signature' };
  }

  const authDateSeconds = toSeconds(authDate);
  if (!Number.isFinite(authDateSeconds)) return { ok: false, reason: 'malformed' };

  if (maxAgeSeconds > 0) {
    const age = (now.getTime() - authDateSeconds * 1000) / 1000;
    if (age > maxAgeSeconds || age < -60) return { ok: false, reason: 'expired' };
  }

  return { ok: true, phone, authDateSeconds };
}

/** authDate приходит строкой; в некоторых клиентах — в миллисекундах. */
function toSeconds(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return NaN;
  return n > 1e11 ? Math.floor(n / 1000) : n;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Только для тестов и демо-режима: в проде подписывает клиент MAX. */
export function signContactForTesting(
  phone: string,
  authDate: string | number,
  userId: number,
  botToken: string,
): string {
  const message = [
    `authDate=${authDate}`,
    `phone=${normalisePhone(phone)}`,
    `userId=${userId}`,
  ].join('\n');
  return createHmac('sha256', botToken).update(message).digest('hex');
}
