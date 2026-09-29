/**
 * Парсер платёжного QR-кода квитанции ЖКУ по ГОСТ Р 56042-2014.
 *
 * Строка выглядит так:
 *   ST00011|Name=ООО "УК Трианон"|PersonalAcc=40702810952090030727|...
 *
 * Служебный блок: "ST" + версия (0001) + признак кодировки.
 * Формулировка ГОСТ, таблица 1: «1-WIN1251; 2 - UTF8; 3 - KOI8-R».
 * Подтверждается настройками 1С ЖКХ: кодировка «1» печатает ST00011, «2» — ST00012.
 *
 * ПОЧЕМУ ЭТО ВАЖНО. Если взять байты win-1251 и декодировать их как UTF-8,
 * вся кириллица превратится в мусор — ФИО и адрес станут нечитаемыми.
 * Поэтому основной путь сканирования — jsQR, который отдаёт сырые байты
 * (binaryData), а декодируем мы уже сами по флагу из заголовка.
 * Браузерный BarcodeDetector возвращает готовую строку и на win-1251 врёт.
 */

import { repairEncoding } from './encoding.ts';

export const GOST_ENCODINGS: Record<string, string> = {
  '1': 'windows-1251',
  '2': 'utf-8',
  '3': 'koi8-r',
};

export interface ReceiptPayee {
  /** Наименование получателя — управляющая компания */
  name: string;
  inn: string;
  kpp: string | null;
  /** Расчётный счёт получателя. НЕ путать с лицевым счётом плательщика. */
  account: string | null;
  bankName: string | null;
  bic: string | null;
  corrAccount: string | null;
}

export interface ReceiptPayer {
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  /** Собранное ФИО, если пришло хотя бы что-то */
  fullName: string | null;
  address: string | null;
  /** Лицевой счёт плательщика. НЕ путать с расчётным счётом получателя. */
  persAcc: string | null;
}

export interface Receipt {
  version: string;
  encoding: string;
  /**
   * Кодировку пришлось чинить: строку принёс клиент, который декодировал
   * байты не той таблицей. Логируется — по этому флагу видно, какие клиенты
   * MAX портят win-1251 и на каких версиях.
   */
  encodingRepaired: boolean;
  payee: ReceiptPayee;
  payer: ReceiptPayer;
  /** Сумма в КОПЕЙКАХ. 381630 — это 3 816,30 ₽ */
  sumKopecks: number | null;
  /** Период в формате YYYY-MM */
  period: string | null;
  purpose: string | null;
  category: string | null;
  /** Все поля как пришли — на случай нестандартных расширений УК */
  raw: Record<string, string>;
  rawString: string;
}

export type ParseResult =
  | { ok: true; receipt: Receipt }
  | { ok: false; reason: ParseFailure; detail?: string };

export type ParseFailure =
  | 'empty'
  | 'not_a_payment_qr'
  | 'unknown_encoding'
  | 'no_fields'
  | 'missing_required'
  /** Кодировка испорчена клиентом безвозвратно: байты заменены на U+FFFD */
  | 'mangled';

/**
 * Декодирует сырые байты QR по признаку кодировки из заголовка.
 * Заголовок всегда ASCII, поэтому читаем его до выбора декодера.
 */
export function decodeReceiptBytes(bytes: Uint8Array): string | null {
  if (bytes.length < 8) return null;

  const header = String.fromCharCode(...bytes.slice(0, 8));
  if (!header.startsWith('ST')) return null;

  const encodingFlag = header[6];
  const label = GOST_ENCODINGS[encodingFlag];
  if (!label) return null;

  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // koi8-r доступен не во всех рантаймах — деградируем в utf-8
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function parseReceipt(input: string): ParseResult {
  if (!input || !input.trim()) return { ok: false, reason: 'empty' };

  const cleaned = input.trim().replace(/^﻿/, '');

  /**
   * Ремонт до разбора, а не после.
   *
   * Иначе `Name` и `payerAddress` разъезжаются по полям уже мусором, и разбор
   * рапортует успех: обязательные поля формально на месте, потому что ИНН
   * и лицевой счёт — ASCII и порчу переживают.
   */
  const repair = repairEncoding(cleaned);
  if (repair.damaged) return { ok: false, reason: 'mangled' };

  const text = repair.text;
  const parts = text.split('|');
  const header = parts[0]?.trim() ?? '';

  const headerMatch = /^ST(\d{4})(\d)$/.exec(header);
  if (!headerMatch) {
    return { ok: false, reason: 'not_a_payment_qr', detail: header.slice(0, 16) };
  }

  const [, version, encodingFlag] = headerMatch;
  const encoding = GOST_ENCODINGS[encodingFlag];
  if (!encoding) return { ok: false, reason: 'unknown_encoding', detail: encodingFlag };

  const raw: Record<string, string> = {};
  for (const chunk of parts.slice(1)) {
    const eq = chunk.indexOf('=');
    if (eq <= 0) continue;
    const key = chunk.slice(0, eq).trim();
    const value = chunk.slice(eq + 1).trim();
    if (key) raw[key] = value;
  }
  if (Object.keys(raw).length === 0) return { ok: false, reason: 'no_fields' };

  // Регистр имён полей у разных УК гуляет, ищем без учёта регистра
  const lookup = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  const get = (key: string): string | null => {
    const value = lookup.get(key.toLowerCase());
    return value && value.length > 0 ? value : null;
  };

  const name = get('Name');
  const inn = get('PayeeINN');
  if (!name || !inn) {
    return {
      ok: false,
      reason: 'missing_required',
      detail: !name ? 'Name' : 'PayeeINN',
    };
  }

  const lastName = get('lastName');
  const firstName = get('firstName');
  const middleName = get('middleName');
  const fullName = [lastName, firstName, middleName].filter(Boolean).join(' ') || null;

  return {
    ok: true,
    receipt: {
      version,
      encoding,
      encodingRepaired: repair.repaired,
      payee: {
        name: unquote(name),
        inn,
        kpp: get('KPP'),
        account: get('PersonalAcc'),
        bankName: get('BankName'),
        bic: get('BIC'),
        corrAccount: get('CorrespAcc'),
      },
      payer: {
        lastName,
        firstName,
        middleName,
        fullName,
        address: get('payerAddress'),
        persAcc: get('persAcc') ?? get('PersAcc'),
      },
      sumKopecks: parseSum(get('Sum')),
      period: parsePeriod(get('paymPeriod')),
      purpose: get('Purpose'),
      category: get('category'),
      raw,
      rawString: text,
    },
  };
}

/**
 * Sum приходит в КОПЕЙКАХ. Классическая ошибка — показать 381 630 ₽
 * вместо 3 816,30 ₽, поэтому нигде не делим, храним целыми копейками.
 */
function parseSum(value: string | null): number | null {
  if (!value) return null;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** paymPeriod идёт как MMYYYY, приводим к YYYY-MM для сортировки и сравнений. */
function parsePeriod(value: string | null): string | null {
  if (!value) return null;
  const m = /^(\d{2})[.\-/]?(\d{4})$/.exec(value);
  if (m) {
    const month = Number(m[1]);
    if (month < 1 || month > 12) return null;
    return `${m[2]}-${m[1]}`;
  }
  // Встречается и обратный порядок YYYY-MM
  const iso = /^(\d{4})[.\-/]?(\d{2})$/.exec(value);
  if (iso) {
    const month = Number(iso[2]);
    if (month < 1 || month > 12) return null;
    return `${iso[1]}-${iso[2]}`;
  }

  /**
   * Двузначный год: «0823» — август 2023.
   *
   * Так пишут расчётные центры, и по ГОСТ это допустимо: поле необязательное
   * и формат в нём не закреплён. Пока мы этого не понимали, период квитанции
   * молча становился пустым, и в приложении она висела без месяца.
   *
   * Порядок определяем по значению: месяц не бывает больше 12, поэтому
   * «0823» читается однозначно как MMYY, а «2308» — как YYMM. Если обе
   * половины ≤ 12 («0102»), выбираем MMYY: так пишет подавляющее
   * большинство квитанций.
   */
  const short = /^(\d{2})[.\-/]?(\d{2})$/.exec(value);
  if (short) {
    const [, first, second] = short;
    if (Number(first) >= 1 && Number(first) <= 12) return `20${second}-${first}`;
    if (Number(second) >= 1 && Number(second) <= 12) return `20${first}-${second}`;
  }

  return null;
}

/**
 * Снимает кавычки, только если ими обёрнуто ВСЁ значение.
 * Односторонняя обрезка ломала бы `ООО "УК Трианон"` — в русских
 * названиях кавычки часть имени, а не обёртка.
 */
function unquote(value: string): string {
  const pairs: [string, string][] = [['"', '"'], ["'", "'"], ['«', '»']];
  for (const [open, close] of pairs) {
    if (value.length > 1 && value.startsWith(open) && value.endsWith(close)) {
      const inner = value.slice(open.length, value.length - close.length).trim();
      // Не трогаем, если внутри есть ещё кавычки того же вида
      if (inner && !inner.includes(open) && !inner.includes(close)) return inner;
    }
  }
  return value;
}

/** Неразрывный пробел: сумма не должна переноситься по разряду. */
const NBSP = ' ';

/**
 * Рубли для показа. Единственное место, где копейки превращаются в рубли.
 * Разряды группируем сами, а не через toLocaleString: результат не должен
 * зависеть от того, с какой сборкой ICU собран рантайм.
 */
export function formatKopecks(kopecks: number): string {
  const sign = kopecks < 0 ? '-' : '';
  const abs = Math.abs(kopecks);
  const rubles = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, '0');
  const grouped = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${sign}${grouped},${rest}${NBSP}₽`;
}
