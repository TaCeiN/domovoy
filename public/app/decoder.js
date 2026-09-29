/**
 * Декодирование QR из картинки в СЫРЫЕ БАЙТЫ.
 *
 * ПОЧЕМУ БАЙТЫ, А НЕ СТРОКА. Квитанции печатаются в windows-1251, и признак
 * кодировки лежит в самом QR — седьмым символом заголовка. Любой декодер,
 * отдающий готовую строку, эту таблицу выбирает за нас и обычно ошибается.
 * Поэтому наружу отсюда выходят байты, а собирает из них строку тот, кто
 * прочитал заголовок.
 *
 * ПОЧЕМУ ZXING, А НЕ JSQR. jsQR берёт ровный кадр и глобальный порог яркости.
 * Живая квитанция — мятая бумага, косой ракурс, тень от руки и термопечать
 * с низким контрастом. ZXing умеет локальную бинаризацию, повороты, зеркало
 * и инверсию; jsQR — ничего из этого. jsQR остаётся резервом на случай,
 * если .wasm не загрузился: слабый декодер лучше неработающей кнопки.
 */

const ZXING_OPTIONS = {
  formats: ['QRCode'],
  // Точность важнее скорости: человек и так держит телефон над бумагой
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  maxNumberOfSymbols: 1,
};

let zxingPromise = null;

/** Грузит модуль один раз. Возвращает null, если .wasm недоступен. */
async function loadZxing() {
  zxingPromise ??= (async () => {
    const module = await import('../vendor/zxing/reader/index.js');
    module.prepareZXingModule({
      overrides: {
        /**
         * Без этого модуль пойдёт за .wasm на jsDelivr — мини-приложению
         * ходить на сторонние домены нельзя.
         */
        locateFile: (path) => (path.endsWith('.wasm')
          ? new URL('../vendor/zxing/reader/zxing_reader.wasm', import.meta.url).href
          : path),
      },
    });
    return module;
  })().catch(() => null);

  return zxingPromise;
}

let jsQrPromise = null;
function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  jsQrPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    // Резолвим от модуля, а не от страницы: приложение может лежать
    // в подпапке GitHub Pages, и абсолютный путь тогда уедет в корень домена
    script.src = new URL('../vendor/jsQR.js', import.meta.url).href;
    script.onload = () => resolve(window.jsQR);
    script.onerror = () => reject(new Error('Не удалось загрузить декодер QR'));
    document.head.appendChild(script);
  });
  return jsQrPromise;
}

/** Резерв: jsQR отдаёт байты в binaryData — это обычный массив чисел. */
async function decodeWithJsQr(imageData) {
  const jsQR = await loadJsQr().catch(() => null);
  if (!jsQR) return null;

  const found = jsQR(imageData.data, imageData.width, imageData.height, {
    inversionAttempts: 'attemptBoth',
  });
  if (!found?.binaryData?.length) return null;
  return Uint8Array.from(found.binaryData);
}

/** Достаёт байты из результата ZXing, если код прочитан целиком. */
function bytesOf(results) {
  const hit = results.find((r) => r.isValid && r.bytes?.length);
  return hit ? new Uint8Array(hit.bytes) : null;
}

/** Один кадр или фрагмент кадра. Возвращает байты QR либо null. */
export async function decodeImageData(imageData) {
  const zxing = await loadZxing();
  if (zxing) {
    const results = await zxing.readBarcodes(imageData, ZXING_OPTIONS).catch(() => []);
    return bytesOf(results);
  }
  return decodeWithJsQr(imageData);
}

/**
 * Целый файл фотографии.
 *
 * ZXing читает файл сам, без нашего canvas, и делает это на ПОЛНОМ
 * разрешении: до этой правки снимок ужимался до 1600 px по большей стороне,
 * и QR с квитанции формата A4 после сжатия опускался ниже порога
 * распознавания — «код на фото не найден» на совершенно нормальном снимке.
 */
export async function decodeBlob(blob) {
  const zxing = await loadZxing();
  if (zxing) {
    const results = await zxing.readBarcodes(blob, ZXING_OPTIONS).catch(() => []);
    return bytesOf(results);
  }

  // Резервный путь: рисуем на canvas, как раньше, но без агрессивного сжатия
  const bitmap = await createImageBitmap(blob);
  const maxSide = 3000;
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return decodeWithJsQr(image);
}
