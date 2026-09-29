import { copyFile, mkdir, stat } from 'node:fs/promises';

/**
 * Вендоринг декодера в public/.
 *
 * Фронт собирается не бандлером, а браузером: `public/app/*.js` грузятся
 * как есть, поэтому импортировать из node_modules нельзя — в бою этой папки
 * рядом нет. Так же уже сделано с jsQR.
 *
 * Второй файл — сам .wasm. По умолчанию zxing-wasm тянет его с jsDelivr,
 * а мини-приложению ходить на сторонние домены нельзя: это и будущий CSP,
 * и работоспособность в сети, где jsDelivr может быть недоступен.
 */
/**
 * Структура повторяет пакет, а не придумывается заново: `reader/index.js`
 * импортирует `../share.js` относительным путём, и переименование файлов
 * этот импорт ломает — проверка фронта падает на «Could not resolve».
 */
const FILES = [
  ['node_modules/zxing-wasm/dist/es/share.js', 'public/vendor/zxing/share.js'],
  ['node_modules/zxing-wasm/dist/es/reader/index.js', 'public/vendor/zxing/reader/index.js'],
  ['node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', 'public/vendor/zxing/reader/zxing_reader.wasm'],
];

await mkdir('public/vendor/zxing/reader', { recursive: true });

for (const [from, to] of FILES) {
  await copyFile(from, to);
  const { size } = await stat(to);
  console.log(`${from} → ${to} (${(size / 1024).toFixed(0)} КБ)`);
}
