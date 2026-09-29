/**
 * Ограничение частоты запросов.
 *
 * ЗАЧЕМ. Его не было нигде, и это превращало каждую слабость входа
 * в рабочий инструмент: номера лицевых счетов перебирались без помех,
 * фамилии собственников тоже, а логины кабинетов выяснялись по времени
 * ответа. Даже после того как все три дыры закрыты, лимит нужен —
 * он превращает «дёшево пробовать миллион раз» в «дорого пробовать сто».
 *
 * ПОЧЕМУ СВОЙ, А НЕ ПАКЕТ. Нужен фиксированный счётчик по ключу и больше
 * ничего. Тянуть зависимость в проект, где их девять штук и все по делу,
 * ради сорока строк — плохой размен.
 *
 * ЧЕГО ОН НЕ УМЕЕТ, и это надо знать честно:
 *   — счётчик живёт В ПАМЯТИ ПРОЦЕССА. Один контейнер — работает;
 *     несколько реплик — каждая считает своё, и общий лимит умножается
 *     на их число. При переезде на несколько реплик счётчик переносится
 *     в Redis или в саму базу;
 *   — ключ по IP опирается на `trustProxy`. За Caddy адрес настоящий,
 *     напрямую — подделывается заголовком.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Уборка. Без неё карта растёт по одному ключу на каждый новый IP
 * и живёт столько же, сколько процесс.
 */
let lastSweep = 0;
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export interface RateLimit {
  /** Сколько попыток разрешаем */
  limit: number;
  /** За какое окно, в миллисекундах */
  windowMs: number;
}

export interface RateVerdict {
  allowed: boolean;
  /** Через сколько секунд можно пробовать снова */
  retryAfter: number;
}

export function consume(key: string, { limit, windowMs }: RateLimit): RateVerdict {
  const now = Date.now();
  sweep(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }

  bucket.count += 1;
  if (bucket.count <= limit) return { allowed: true, retryAfter: 0 };

  return { allowed: false, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
}

/** Сбросить счётчики. Нужно тестам, чтобы соседние проверки не мешали друг другу. */
export function resetRateLimits(): void {
  buckets.clear();
  lastSweep = 0;
}

/**
 * Готовые нормы.
 *
 * Числа выбраны так, чтобы живой человек их не заметил, а перебор
 * упёрся сразу. Вход в кабинет: десять попыток за четверть часа —
 * это втрое больше, чем нужно, чтобы вспомнить пароль.
 */
export const LIMITS = {
  /** Предъявление квитанции: сканирований подряд у человека единицы */
  receipt: { limit: 10, windowMs: 10 * 60_000 },
  /** Тот же лицевой счёт с разных адресов — признак перебора, а не жизни */
  receiptAccount: { limit: 5, windowMs: 60 * 60_000 },
  /** Вход в кабинет диспетчера или председателя */
  login: { limit: 10, windowMs: 15 * 60_000 },
  /** Подсказка улиц: открыта без сессии, набирают её быстро */
  lookup: { limit: 120, windowMs: 60_000 },
  /** Вопросы Домовому: человек печатает медленно, дневной потолок — в lib/bot/handle.ts */
  assistant: { limit: 20, windowMs: 60_000 },
} as const;
