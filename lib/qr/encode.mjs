/**
 * Кодировщик QR — байтовый режим, без зависимостей.
 *
 * ЗАЧЕМ СВОЙ. В проекте уже лежит ДЕКОДЕР (public/vendor/jsQR.js), а вот
 * кодировщика нет, и нужен он ровно одному инструменту — генератору
 * фейковых квитанций. Тянуть ради него пакет с транзитивными
 * зависимостями в проект, где заявки и деньги, — тот же плохой размен,
 * из-за которого здесь свои разбор DBF и алфавит идентификаторов.
 *
 * ПОЧЕМУ ЭТО НЕ СТРАШНО. Правильность кодировщика проверяется тем же
 * jsQR: `qr-encode.test.mjs` кодирует строку, рисует матрицу в пиксели
 * и декодирует обратно. Если таблицы или маскирование врут, круг
 * не сходится, и тест это ловит.
 *
 * ПОЧЕМУ БАЙТОВЫЙ РЕЖИМ, А НЕ ТЕКСТ. Квитанции по ГОСТ Р 56042-2014
 * печатаются в windows-1251 (заголовок ST00011), и кириллица там —
 * ОДИН байт на символ. Кодировщик, принимающий строку, закодировал бы
 * её в UTF-8, и получился бы код, который наше же приложение прочитает
 * мусором. Поэтому вход — массив байтов, а кодировкой занимается
 * вызывающий (см. cp1251.mjs).
 *
 * Реализация по ISO/IEC 18004. Структура — как у эталонной реализации
 * Nayuki: размер блоков не таблицей, а выводится из числа модулей,
 * поэтому таблиц всего две и обе короткие.
 */

/* ─────────────── таблицы стандарта ─────────────── */

/**
 * Сколько байтов коррекции в одном блоке. Индекс — номер версии (1..40),
 * нулевой элемент фиктивный.
 */
const ECC_CODEWORDS_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};

/** На сколько блоков режутся данные. */
const NUM_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};

/** Двухбитный код уровня коррекции в блоке служебной информации. */
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

/* ─────────────── арифметика Галуа GF(256) ─────────────── */

/**
 * Умножение в поле Галуа по образующему многочлену 0x11D — том самом,
 * что задан стандартом QR. Без него не посчитать байты коррекции.
 */
function gfMultiply(a, b) {
  let result = 0;
  for (let i = 7; i >= 0; i--) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((b >>> i) & 1) * a;
  }
  return result & 0xff;
}

/** Образующий многочлен кода Рида — Соломона нужной степени. */
function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;

  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return result;
}

/** Байты коррекции для одного блока данных. */
function reedSolomonRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);

  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i++) {
      result[i] ^= gfMultiply(divisor[i], factor);
    }
  }
  return result;
}

/* ─────────────── ёмкость версий ─────────────── */

/**
 * Сколько модулей версии занято данными.
 *
 * Считаем, а не держим таблицей: из общего числа модулей вычитаем
 * поисковые узоры с разделителями, синхрополосы, узоры выравнивания
 * и служебные поля. Так таблиц становится две вместо четырёх, а ошибиться
 * в переписывании цифр негде.
 */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;

  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** Сколько байтов данных влезает в версию при этом уровне коррекции. */
export function dataCapacityBytes(version, ecc) {
  return Math.floor(rawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[ecc][version] * NUM_BLOCKS[ecc][version];
}

/**
 * Сколько бит занимает счётчик длины в байтовом режиме.
 *
 * До девятой версии восемь, дальше шестнадцать. Мелочь, из-за которой
 * выбор версии обязан считать БИТЫ, а не байты: к данным добавляются
 * четыре бита режима и этот счётчик, и строка ровно по ёмкости
 * в свою версию уже не влезает.
 */
function countBits(version) {
  return version <= 9 ? 8 : 16;
}

/** Влезут ли байты в версию вместе со служебным заголовком. */
export function fitsInVersion(byteLength, version, ecc) {
  return 4 + countBits(version) + byteLength * 8 <= dataCapacityBytes(version, ecc) * 8;
}

/** Позиции центров узоров выравнивания. */
function alignmentPositions(version) {
  if (version === 1) return [];

  const numAlign = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = version === 32
    ? 26
    : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;

  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) {
    result.splice(1, 0, pos);
  }
  return result;
}

/* ─────────────── сборка потока данных ─────────────── */

function buildBitStream(bytes, version, ecc) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  // Режим «байты» и длина: до 9-й версии счётчик восьмибитный, дальше 16
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCapacityBytes(version, ecc) * 8;
  if (bits.length > capacityBits) {
    throw new Error('данные не влезают в выбранную версию');
  }

  // Признак конца, выравнивание до байта и стандартная набивка
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

  const result = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i++) {
    result[i >>> 3] |= bits[i] << (7 - (i & 7));
  }
  return result;
}

/**
 * Разрезать данные на блоки, посчитать коррекцию и переплести.
 *
 * Переплетение обязательно: оно размазывает повреждение по блокам,
 * иначе одно пятно на бумаге убивало бы целый блок сразу.
 */
function addEccAndInterleave(data, version, ecc) {
  const numBlocks = NUM_BLOCKS[ecc][version];
  const eccLen = ECC_CODEWORDS_PER_BLOCK[ecc][version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);

  const shortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortLength = Math.floor(rawCodewords / numBlocks) - eccLen;

  const divisor = reedSolomonDivisor(eccLen);
  const blocks = [];

  for (let i = 0, offset = 0; i < numBlocks; i++) {
    const length = shortLength + (i < shortBlocks ? 0 : 1);
    const chunk = data.subarray(offset, offset + length);
    offset += length;
    blocks.push({ data: chunk, ecc: reedSolomonRemainder(chunk, divisor) });
  }

  const result = new Uint8Array(rawCodewords);
  let at = 0;

  const longest = shortLength + 1;
  for (let i = 0; i < longest; i++) {
    for (let b = 0; b < blocks.length; b++) {
      // У коротких блоков последнего байта нет — его просто пропускаем
      if (i < blocks[b].data.length) result[at++] = blocks[b].data[i];
    }
  }
  for (let i = 0; i < eccLen; i++) {
    for (const block of blocks) result[at++] = block.ecc[i];
  }
  return result;
}

/* ─────────────── рисование матрицы ─────────────── */

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  return { size, modules, reserved };
}

function setFunction(m, x, y, dark) {
  if (x < 0 || y < 0 || x >= m.size || y >= m.size) return;
  m.modules[y][x] = dark;
  m.reserved[y][x] = true;
}

function drawFinder(m, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(m, cx + dx, cy + dy, dist !== 2 && dist !== 4);
    }
  }
}

function drawAlignment(m, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFunction(m, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFunctionPatterns(m, version) {
  // Синхрополосы: чередование по шестой строке и шестому столбцу
  for (let i = 0; i < m.size; i++) {
    setFunction(m, 6, i, i % 2 === 0);
    setFunction(m, i, 6, i % 2 === 0);
  }

  drawFinder(m, 3, 3);
  drawFinder(m, m.size - 4, 3);
  drawFinder(m, 3, m.size - 4);

  const positions = alignmentPositions(version);
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < positions.length; j++) {
      // Углы заняты поисковыми узорами
      const corner = (i === 0 && j === 0)
        || (i === 0 && j === positions.length - 1)
        || (i === positions.length - 1 && j === 0);
      if (!corner) drawAlignment(m, positions[i], positions[j]);
    }
  }

  // Места под служебную информацию резервируем заранее
  for (let i = 0; i < 9; i++) {
    setFunction(m, i, 8, false);
    setFunction(m, 8, i, false);
  }
  for (let i = 0; i < 8; i++) {
    setFunction(m, m.size - 1 - i, 8, false);
    setFunction(m, 8, m.size - 1 - i, false);
  }
  // Всегда тёмный модуль — требование стандарта
  setFunction(m, 8, m.size - 8, true);

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;

    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = m.size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(m, a, b, bit);
      setFunction(m, b, a, bit);
    }
  }
}

function drawFormatBits(m, ecc, mask) {
  const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;

  const at = (i) => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) setFunction(m, 8, i, at(i));
  setFunction(m, 8, 7, at(6));
  setFunction(m, 8, 8, at(7));
  setFunction(m, 7, 8, at(8));
  for (let i = 9; i < 15; i++) setFunction(m, 14 - i, 8, at(i));

  for (let i = 0; i < 8; i++) setFunction(m, m.size - 1 - i, 8, at(i));
  for (let i = 8; i < 15; i++) setFunction(m, 8, m.size - 15 + i, at(i));
  setFunction(m, 8, m.size - 8, true);
}

/** Данные идут змейкой снизу справа, по два столбца, минуя синхрополосу. */
function drawCodewords(m, codewords) {
  let i = 0;

  for (let right = m.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;

    for (let vert = 0; vert < m.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? m.size - 1 - vert : vert;

        if (!m.reserved[y][x] && i < codewords.length * 8) {
          m.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
        // Остаточные модули остаются светлыми — так требует стандарт
      }
    }
  }
}

function applyMask(m, mask) {
  for (let y = 0; y < m.size; y++) {
    for (let x = 0; x < m.size; x++) {
      if (m.reserved[y][x]) continue;

      let invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) m.modules[y][x] = !m.modules[y][x];
    }
  }
}

/**
 * Штраф за «некрасивость».
 *
 * Стандарт требует выбрать маску с наименьшим штрафом: длинные полосы
 * одного цвета и квадраты 2×2 сбивают сканер, а узор, похожий на
 * поисковый, он принимает за угол кода.
 */
function penalty(m) {
  let result = 0;
  const size = m.size;

  const runPenalty = (run) => (run >= 5 ? run - 2 : 0);

  for (let y = 0; y < size; y++) {
    let run = 1;
    for (let x = 1; x < size; x++) {
      if (m.modules[y][x] === m.modules[y][x - 1]) run++;
      else { result += runPenalty(run); run = 1; }
    }
    result += runPenalty(run);
  }
  for (let x = 0; x < size; x++) {
    let run = 1;
    for (let y = 1; y < size; y++) {
      if (m.modules[y][x] === m.modules[y - 1][x]) run++;
      else { result += runPenalty(run); run = 1; }
    }
    result += runPenalty(run);
  }

  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const c = m.modules[y][x];
      if (c === m.modules[y][x + 1] && c === m.modules[y + 1][x] && c === m.modules[y + 1][x + 1]) {
        result += 3;
      }
    }
  }

  // Узор 1:1:3:1:1 со светлой зоной — его сканер принимает за поисковый
  const pattern = [true, false, true, true, true, false, true];
  const looksLikeFinder = (get, i, size2) => {
    for (let k = 0; k < 7; k++) if (get(i + k) !== pattern[k]) return false;
    const before = [i - 4, i - 3, i - 2, i - 1].every((p) => p < 0 || !get(p));
    const after = [i + 7, i + 8, i + 9, i + 10].every((p) => p >= size2 || !get(p));
    return before || after;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x + 7 <= size; x++) {
      if (looksLikeFinder((p) => m.modules[y][p], x, size)) result += 40;
    }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y + 7 <= size; y++) {
      if (looksLikeFinder((p) => m.modules[p][x], y, size)) result += 40;
    }
  }

  let dark = 0;
  for (const row of m.modules) for (const cell of row) if (cell) dark++;
  const total = size * size;
  result += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;

  return result;
}

/* ─────────────── точка входа ─────────────── */

/**
 * Закодировать массив байтов в матрицу QR.
 *
 * Возвращает `{ size, modules }`, где `modules[y][x] === true` — тёмный
 * модуль. Отрисовкой занимается вызывающий: инструменту нужен и SVG
 * для экрана, и пиксели для проверки декодером.
 */
export function encodeQr(bytes, { ecc = 'M', minVersion = 1, maxVersion = 40 } = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('нужен Uint8Array: кодировка — забота вызывающего');
  }
  if (!ECC_CODEWORDS_PER_BLOCK[ecc]) throw new Error(`неизвестный уровень коррекции: ${ecc}`);

  let version = minVersion;
  while (version <= maxVersion && !fitsInVersion(bytes.length, version, ecc)) version++;

  if (version > maxVersion) {
    const limit = dataCapacityBytes(maxVersion, ecc) - 3;
    throw new Error(
      `${bytes.length} байт не влезают в QR при коррекции ${ecc}: максимум ${limit}`,
    );
  }

  const data = buildBitStream(bytes, version, ecc);
  const codewords = addEccAndInterleave(data, version, ecc);

  const m = createMatrix(version);
  drawFunctionPatterns(m, version);
  drawCodewords(m, codewords);

  // Маску выбираем по штрафу — так велит стандарт
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, mask);
    drawFormatBits(m, ecc, mask);
    const score = penalty(m);
    if (best === null || score < best.score) {
      best = { mask, score, modules: m.modules.map((row) => [...row]) };
    }
    applyMask(m, mask);
  }

  return { size: m.size, version, ecc, mask: best.mask, modules: best.modules };
}

/** Матрица в SVG — для экрана и для печати. */
export function qrToSvg({ size, modules }, { scale = 8, quiet = 4 } = {}) {
  const side = (size + quiet * 2) * scale;
  const parts = [];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!modules[y][x]) continue;
      parts.push(`M${(x + quiet) * scale},${(y + quiet) * scale}h${scale}v${scale}h-${scale}z`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side}" height="${side}" shape-rendering="crispEdges">`
    + `<rect width="${side}" height="${side}" fill="#fff"/>`
    + `<path d="${parts.join('')}" fill="#000"/>`
    + '</svg>';
}

/** Матрица в RGBA-пиксели — нужно декодеру в тестах. */
export function qrToPixels({ size, modules }, { scale = 4, quiet = 4 } = {}) {
  const side = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);

  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const mx = Math.floor(x / scale) - quiet;
      const my = Math.floor(y / scale) - quiet;
      const dark = mx >= 0 && my >= 0 && mx < size && my < size && modules[my][mx];
      if (!dark) continue;

      const at = (y * side + x) * 4;
      data[at] = 0;
      data[at + 1] = 0;
      data[at + 2] = 0;
    }
  }
  return { data, width: side, height: side };
}
