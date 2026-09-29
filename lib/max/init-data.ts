import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Проверка стартовых параметров мини-приложения MAX.
 *
 * Алгоритм — по документации dev.max.ru/docs/webapps/validation:
 *   secret_key = HMAC_SHA256(ключ: "WebAppData", сообщение: BOT_TOKEN)
 *   hash       = hex(HMAC_SHA256(ключ: secret_key, сообщение: launch_params))
 *
 * Порядок аргументов обратный привычному: ключом служит строковая константа,
 * а сообщением — токен бота. Перепутать местами легко, и тогда подпись
 * не сойдётся ни разу.
 *
 * Схема MAX похожа на телеграмовскую, но НЕ совпадает с ней. Реализовано
 * строго по документации MAX.
 */

const SECRET_SALT = 'WebAppData';

/** Данные протухают через час — рекомендация документации MAX. */
export const DEFAULT_MAX_AGE_SECONDS = 60 * 60;

export interface MaxUser {
  id: number;
  first_name: string;
  last_name: string | null;
  username: string | null;
  language_code: string | null;
  photo_url: string | null;
}

export interface MaxChat {
  id: number;
  type: 'DIALOG' | 'CHAT' | 'CHANNEL';
}

export interface MaxInitData {
  user: MaxUser;
  chat: MaxChat | null;
  queryId: string | null;
  authDate: Date;
  /** Payload из диплинка https://max.ru/<bot>?startapp=<payload> */
  startParam: string | null;
  ip: string | null;
}

export type InitDataResult =
  | { ok: true; data: MaxInitData }
  | { ok: false; reason: InitDataFailure };

export type InitDataFailure =
  | 'empty'
  | 'malformed'
  | 'hash_missing'
  | 'hash_duplicated'
  | 'bad_signature'
  | 'expired'
  | 'user_missing';

/**
 * MAX кладёт параметры во фрагмент URL — а фрагмент браузер на сервер
 * не отправляет. Клиент обязан прочитать window.WebApp.initData и передать
 * строку явно. Здесь принимаем оба вида: и голое значение WebAppData,
 * и полный URL/фрагмент, из которого его надо достать.
 */
export function extractWebAppData(input: string): string | null {
  if (!input) return null;

  const hashIndex = input.indexOf('#');
  const fragment = hashIndex >= 0 ? input.slice(hashIndex + 1) : input;

  // Полный фрагмент вида WebAppData=...&WebAppPlatform=web
  if (fragment.includes('WebAppData=')) {
    /**
     * Разбираем вручную, а не через URLSearchParams.
     *
     * Он читает строку по правилам HTML-форм и меняет «+» на пробел.
     * Внутри же лежит уже закодированная строка подписанных параметров,
     * где «+» может быть значащим символом, — и такая подмена портит её
     * ДО всякой проверки подписи.
     */
    for (const pair of fragment.split('&')) {
      const [key, value] = splitPair(pair);
      if (key !== 'WebAppData' || !value) continue;
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
    return null;
  }

  // Уже готовое значение WebAppData
  return fragment.length > 0 ? fragment : null;
}

/** Разбивает по первому «=», а не по каждому: значения url-энкодятся и могут содержать «=». */
function splitPair(pair: string): [string, string] {
  const i = pair.indexOf('=');
  return i < 0 ? [pair, ''] : [pair.slice(0, i), pair.slice(i + 1)];
}

function safeJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export interface ValidateOptions {
  botToken: string;
  /** 0 отключает проверку срока — только для тестов. */
  maxAgeSeconds?: number;
  now?: Date;
}

export function validateInitData(rawInput: string, options: ValidateOptions): InitDataResult {
  const { botToken, maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS, now = new Date() } = options;

  const webAppData = extractWebAppData(rawInput);
  if (!webAppData) return { ok: false, reason: 'empty' };

  const pairs = webAppData.split('&').filter(Boolean).map(splitPair);
  if (pairs.length === 0) return { ok: false, reason: 'malformed' };

  const hashes = pairs.filter(([key]) => key === 'hash');
  if (hashes.length === 0) return { ok: false, reason: 'hash_missing' };
  if (hashes.length > 1) return { ok: false, reason: 'hash_duplicated' };
  const receivedHash = decodeURIComponent(hashes[0][1]);

  const secretKey = createHmac('sha256', SECRET_SALT).update(botToken).digest();

  /**
   * Пробел кодируют двумя способами, и подпись обязана пережить оба.
   *
   * ЧТО СЛУЧИЛОСЬ В БОЮ. У одного участника теста вход падал
   * с `bad_signature`, у остальных работал. Разница оказалась в названии
   * чата — «Хакатон 111», с пробелом. Одни клиенты кодируют пробел как
   * «%20», другие как «+» по правилам форм. `decodeURIComponent` второй
   * вариант не понимает: «+» так и остаётся плюсом, строка расходится
   * с подписанной, и хэш не сходится.
   *
   * Угадывать нечего — проверяем обе трактовки. Безопасность не страдает:
   * подделать хэш без токена бота всё равно нельзя, а перебор двух
   * вариантов лишь признаёт честную подпись честной.
   */
  const withoutHash = pairs.filter(([key]) => key !== 'hash');

  const decodeValue = (value: string, plusIsSpace: boolean): string => {
    const prepared = plusIsSpace ? value.split('+').join('%20') : value;
    try {
      return decodeURIComponent(prepared);
    } catch {
      return prepared;
    }
  };

  const attempt = (plusIsSpace: boolean) => {
    const decoded = withoutHash
      .map(([key, value]) => [key, decodeValue(value, plusIsSpace)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const launchParams = decoded.map(([key, value]) => `${key}=${value}`).join('\n');
    const expectedHash = createHmac('sha256', secretKey).update(launchParams).digest('hex');
    return constantTimeEquals(expectedHash, receivedHash) ? decoded : null;
  };

  const signed = attempt(false) ?? attempt(true);
  if (!signed) return { ok: false, reason: 'bad_signature' };

  const values = new Map(signed);

  const user = safeJson<MaxUser>(values.get('user'));
  if (!user || typeof user.id !== 'number') {
    return { ok: false, reason: 'user_missing' };
  }

  const authDateSeconds = Number(values.get('auth_date'));
  if (!Number.isFinite(authDateSeconds)) return { ok: false, reason: 'malformed' };
  const authDate = new Date(authDateSeconds * 1000);

  if (maxAgeSeconds > 0) {
    const ageSeconds = (now.getTime() - authDate.getTime()) / 1000;
    if (ageSeconds > maxAgeSeconds || ageSeconds < -60) {
      return { ok: false, reason: 'expired' };
    }
  }

  return {
    ok: true,
    data: {
      user,
      chat: safeJson<MaxChat>(values.get('chat')),
      queryId: values.get('query_id') ?? null,
      authDate,
      startParam: values.get('start_param') ?? null,
      ip: values.get('ip') ?? null,
    },
  };
}

/** Сравнение с постоянным временем: обычное === утекает информацию по таймингу. */
function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Собирает подписанную строку так же, как это делает MAX.
 * Нужна только для тестов и демо-режима — в проде подписывает платформа.
 */
export function signInitDataForTesting(
  params: Record<string, string>,
  botToken: string,
): string {
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const launchParams = entries.map(([key, value]) => `${key}=${value}`).join('\n');

  const secretKey = createHmac('sha256', SECRET_SALT).update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(launchParams).digest('hex');

  const encoded = entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`);
  encoded.push(`hash=${hash}`);
  return encoded.join('&');
}
