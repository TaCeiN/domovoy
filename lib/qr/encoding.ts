/**
 * Ремонт кодировки платёжного QR.
 *
 * ЗАЧЕМ ЭТО ЕСТЬ. Наш собственный сканер отдаёт СЫРЫЕ БАЙТЫ, и мы декодируем
 * их сами по признаку из заголовка — ошибиться там негде. А нативный сканер
 * MAX по контракту отдаёт `Promise<string>`: байты он декодирует сам, каким
 * способом — не документировано («результат кодируется автоматически»).
 * Квитанции печатаются в windows-1251, и декодер без ECI-маркера обычно
 * падает в ISO-8859-1.
 *
 * Спасает то, что latin1 отображает байты 0x00–0xFF в U+0000–U+00FF ОДИН
 * В ОДИН. Значит порча обратима: собрать из строки байты обратно и прочитать
 * их той кодировкой, которую объявляет сам QR. Проверено на настоящей
 * квитанции — восстановленная строка совпадает с исходной символ в символ.
 *
 * Необратим только один случай: если клиент прочитал байты как UTF-8,
 * невалидные последовательности заменились на U+FFFD и данные СТЁРТЫ.
 * Тогда честный ответ один — попросить фотографию квитанции.
 */

/** Признак кодировки — седьмой символ заголовка ST0001X. Таблица 1 ГОСТ. */
const ENCODINGS: Record<string, string> = {
  '1': 'windows-1251',
  '2': 'utf-8',
  '3': 'koi8-r',
};

/**
 * Обратная таблица windows-1252 для диапазона 0x80–0x9F.
 *
 * latin1 и cp1252 совпадают везде, кроме этих 32 позиций. В русском тексте
 * они почти не встречаются (кириллица win-1251 живёт с 0xC0), но «тире» 0x97
 * и кавычки в названии УК — вполне реальны, и без этой таблицы такая строка
 * не восстановилась бы.
 */
const CP1252_HIGH: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

const CYRILLIC = /[Ѐ-ӿ]/;
/** Верхняя половина latin1: признак того, что байты прочитаны не той таблицей. */
const HIGH_LATIN = /[-ÿ]/;

export interface EncodingRepair {
  /** Строка, годная для разбора. При `damaged` — исходная, разбирать её нельзя. */
  text: string;
  /** Ремонт применён. Полезно логировать: так мы узнаём, врёт ли клиент MAX. */
  repaired: boolean;
  /** Данные потеряны безвозвратно — нужен повторный скан другим способом. */
  damaged: boolean;
}

/** Собирает байты обратно из строки, полученной latin1/cp1252-декодированием. */
function toBytes(text: string): Uint8Array | null {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0xff) {
      out[i] = code;
      continue;
    }
    const mapped = CP1252_HIGH[code];
    // Символ вне обеих таблиц — строка не является latin1-мусором
    if (mapped === undefined) return null;
    out[i] = mapped;
  }
  return out;
}

export function repairEncoding(input: string): EncodingRepair {
  const intact: EncodingRepair = { text: input, repaired: false, damaged: false };

  /**
   * U+FFFD ставит декодер на месте байта, который не смог прочитать.
   * Исходного значения в строке уже нет — чинить нечего.
   */
  if (input.includes('�')) return { text: input, repaired: false, damaged: true };

  // Кириллица на месте — клиент справился, трогать нельзя
  if (CYRILLIC.test(input)) return intact;

  // Ремонтируем только платёжный QR: заголовок ASCII и переживает любую порчу
  const header = /^ST(\d{4})(\d)/.exec(input.slice(0, 8));
  if (!header) return intact;

  const label = ENCODINGS[header[2]];
  if (!label) return intact;

  // Нет верхней половины latin1 — значит и портиться было нечему (чистый ASCII)
  if (!HIGH_LATIN.test(input)) return intact;

  const bytes = toBytes(input);
  if (!bytes) return intact;

  let decoded: string;
  try {
    /**
     * fatal ловит случай, когда байты не складываются в объявленную кодировку:
     * для utf-8 это означает, что строка испорчена ещё до нас.
     */
    decoded = new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return { text: input, repaired: false, damaged: true };
  }

  /**
   * Критерий успеха — появилась кириллица.
   *
   * Без него ремонт «удавался» бы всегда: windows-1251 отображает все 256
   * байтов, поэтому TextDecoder не пожалуется даже на бессмыслицу.
   */
  if (!CYRILLIC.test(decoded)) return intact;

  return { text: decoded, repaired: true, damaged: false };
}
