import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { encodeQr, qrToPixels, dataCapacityBytes } from './lib/qr-encode.mjs';
import { encodeCp1251, encodeByFlag } from './lib/cp1251.mjs';

/**
 * Кодировщик проверяется ДЕКОДЕРОМ, который уже лежит в проекте.
 *
 * Своя реализация QR — это полтысячи строк с таблицами, полем Галуа
 * и выбором маски. Проверять её глазами бессмысленно: ошибка в одной
 * цифре таблицы даст код, который выглядит правильным и не сканируется.
 *
 * Поэтому здесь круг: кодируем байты → рисуем матрицу в пиксели →
 * скармливаем jsQR из public/vendor → сравниваем с исходником.
 * Это ровно тот декодер, которым приложение читает квитанции
 * в браузере, так что круг замыкается на настоящем потребителе.
 */

/**
 * jsQR лежит в UMD-обёртке, а у проекта `type: module` — значит любой
 * `.js` Node грузит как ESM, где нет ни `module`, ни `exports`, и обёртка
 * пытается писать в глобальный объект. Поэтому исполняем её сами,
 * подсунув то, что она ищет: маленький слой вместо копии файла рядом,
 * которая молча разъедется с оригиналом.
 */
function loadJsQr() {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, '../../public/vendor/jsQR.js'), 'utf8');

  const module = { exports: {} };
  new Function('module', 'exports', source)(module, module.exports);
  return module.exports;
}

const jsQR = loadJsQr();

/** Прогнать через кодировщик и декодер, вернуть прочитанные байты. */
function roundTrip(bytes, options) {
  const matrix = encodeQr(bytes, options);
  const { data, width, height } = qrToPixels(matrix, { scale: 4 });

  const decoded = jsQR(data, width, height);
  assert.ok(decoded, `QR не прочитался: версия ${matrix.version}, ${bytes.length} байт`);

  return { matrix, bytes: Uint8Array.from(decoded.binaryData) };
}

test('короткая строка проходит круг', () => {
  const bytes = new TextEncoder().encode('ST00012|Name=Test|PayeeINN=6168108630');
  const { bytes: back } = roundTrip(bytes);
  assert.deepEqual([...back], [...bytes]);
});

/**
 * Кириллица в windows-1251 — главный случай.
 *
 * Именно так печатаются живые квитанции (заголовок ST00011), и именно
 * здесь ломается всё, если кодировать строку как UTF-8: кириллица
 * занимает два байта вместо одного, и приложение читает мусор.
 */
test('кириллица в win-1251 проходит круг байт в байт', () => {
  const text = 'ST00011|Name=ООО "УК Трианон"|payerAddress=г Ростов-на-Дону, пр-кт Ленина, д. 85';
  const bytes = encodeCp1251(text);

  // Один байт на символ — иначе это не win-1251
  assert.equal(bytes.length, text.length);

  const { bytes: back } = roundTrip(bytes);
  assert.deepEqual([...back], [...bytes]);
});

test('кодировка выбирается по признаку из заголовка', () => {
  const text = 'Ленина';
  assert.equal(encodeByFlag(text, '1').length, 6, 'win-1251: байт на символ');
  assert.equal(encodeByFlag(text, '2').length, 12, 'UTF-8: два байта на кириллицу');
  assert.throws(() => encodeByFlag(text, '3'), /умеет только кодировки/);
});

/**
 * Настоящая квитанция целиком, во всех уровнях коррекции.
 *
 * Длина живой строки с адресом — 250–350 байт, это версии 10–15.
 * Проверяем все четыре уровня: таблицы блоков у них разные, и ошибка
 * в одной строке таблицы проявилась бы только на своём уровне.
 */
test('полная квитанция читается при любом уровне коррекции', () => {
  const receipt = [
    'ST00011',
    'Name=ООО "УК Трианон"',
    'PersonalAcc=40702810952090030727',
    'BankName=ПАО Сбербанк',
    'BIC=046015602',
    'CorrespAcc=30101810600000000602',
    'PayeeINN=6168108630',
    'KPP=616801001',
    'Sum=381630',
    'Purpose=Оплата за ЖКУ',
    'lastName=Крутых',
    'firstName=Сергей',
    'middleName=Валерьевич',
    'payerAddress=344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3, кв. 27',
    'persAcc=987654331',
    'paymPeriod=042026',
  ].join('|');

  const bytes = encodeCp1251(receipt);
  assert.ok(bytes.length > 250, `ожидали длинную строку, получили ${bytes.length}`);

  for (const ecc of ['L', 'M', 'Q', 'H']) {
    const { bytes: back } = roundTrip(bytes, { ecc });
    assert.deepEqual([...back], [...bytes], `не сошлось при коррекции ${ecc}`);
  }
});

/**
 * Разные версии кода.
 *
 * Версия выбирается по объёму данных, и у каждой своя раскладка узоров
 * выравнивания. Шагаем по длинам так, чтобы задеть версии с первой
 * по двадцатую с запасом.
 */
test('версии с 1 по 20 читаются', () => {
  const seen = new Set();

  for (let length = 8; length <= 850; length = Math.ceil(length * 1.35)) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = (i * 7 + 33) & 0xff;

    const { matrix, bytes: back } = roundTrip(bytes, { ecc: 'L' });
    seen.add(matrix.version);
    assert.deepEqual([...back], [...bytes], `не сошлось на ${length} байтах`);
  }

  assert.ok(seen.size >= 8, `ожидали много разных версий, вышло ${[...seen].join(', ')}`);
  assert.ok(Math.max(...seen) >= 15, `не добрались до крупных версий: ${[...seen].join(', ')}`);
});

test('слишком длинные данные отвергаются понятной ошибкой', () => {
  const huge = new Uint8Array(3000);
  assert.throws(() => encodeQr(huge, { ecc: 'H' }), /не влезают в QR/);
});

test('строка вместо байтов — ошибка, а не молчаливый UTF-8', () => {
  assert.throws(() => encodeQr('ST00011|Name=Тест'), /нужен Uint8Array/);
});

/** Ёмкость версий должна расти монотонно — грубая проверка таблиц. */
test('ёмкость растёт с версией и падает с уровнем коррекции', () => {
  for (let version = 2; version <= 40; version++) {
    assert.ok(
      dataCapacityBytes(version, 'L') > dataCapacityBytes(version - 1, 'L'),
      `версия ${version} вместила не больше предыдущей`,
    );
  }
  for (let version = 1; version <= 40; version++) {
    assert.ok(
      dataCapacityBytes(version, 'L') > dataCapacityBytes(version, 'M')
      && dataCapacityBytes(version, 'M') > dataCapacityBytes(version, 'Q')
      && dataCapacityBytes(version, 'Q') > dataCapacityBytes(version, 'H'),
      `версия ${version}: уровни коррекции идут не по убыванию ёмкости`,
    );
  }
});
