import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string, salt: Buffer, keylen: number,
) => Promise<Buffer>;

/**
 * Пароли диспетчеров.
 *
 * scrypt, а не sha256: обычный хеш подбирается перебором на видеокарте
 * со скоростью миллиардов вариантов в секунду. Диспетчерский аккаунт даёт
 * доступ ко всем заявкам дома с адресами жильцов — этого достаточно,
 * чтобы не экономить на хешировании даже в MVP.
 *
 * Формат хранения: scrypt$<соль в hex>$<ключ в hex>
 */

const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== KEY_LENGTH) return false;

  const actual = await scrypt(password, salt, KEY_LENGTH);
  return timingSafeEqual(actual, expected);
}

/**
 * Хеш-пустышка для несуществующего логина.
 *
 * ЗАЧЕМ. Вход в кабинет отвечал одинаковым текстом на неверный логин
 * и неверный пароль — но не одинаковым ВРЕМЕНЕМ: при отсутствии строки
 * в базе scrypt не считался вовсе. Измерено: 3,4 мс против 38 мс,
 * разница в одиннадцать раз, различима через сеть. Перебирая логины
 * вида `uk-<название>`, можно составить список подключённых компаний
 * и председателей — ровно то, что ответ обещал скрыть.
 *
 * Поэтому при отсутствии учётки пароль всё равно проверяется — против
 * заведомо чужого хеша. Результат всегда ложь, а время такое же.
 */
const DUMMY_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(KEY_LENGTH)}`;

export async function verifyPasswordOrBurnTime(
  password: string,
  stored: string | undefined | null,
): Promise<boolean> {
  if (!stored) {
    await verifyPassword(password, DUMMY_HASH);
    return false;
  }
  return verifyPassword(password, stored);
}

/**
 * Пароль для человека: диспетчер получает его от нас и переписывает
 * с экрана или диктует по телефону.
 *
 * Без похожих символов: ноль от «о», единица от «l». Жил в chairman.ts,
 * пока у председателя был свой пароль; теперь председатель входит
 * как обычный житель, а пароли остались только у кабинетов УК —
 * поэтому функция переехала туда, где ей место.
 */
const HUMAN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

export function generatePassword(length = 10): string {
  const bytes = randomBytes(length);
  return [...bytes].map((b) => HUMAN_ALPHABET[b % HUMAN_ALPHABET.length]).join('');
}
