/**
 * Загрузка набора данных региона.
 *
 *   npm run dataset:load -- --region 61                  скачать из релиза GitHub и загрузить
 *   npm run dataset:load -- --region 61 --file путь.gz   загрузить готовый файл
 *   npm run prod:dataset -- --region 61                  то же на боевом стенде
 *
 * Откуда качается: `https://github.com/<DATASET_REPO>/releases/download/dataset-NN/dataset-NN.ndjson.gz`.
 * `DATASET_REPO` по умолчанию `TaCeiN/domovoy-datasets` — публичный репозиторий только
 * под наборы: код приложения живёт отдельно, а наборы собраны из открытых госреестров
 * и скачиваются без токена. Для закрытого репозитория наборов нужен
 * `GITHUB_TOKEN` в окружении.
 *
 * Собрать набор самому: `npm run dataset:build -- --region NN` (минуты).
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getDb, closeDb, describeConnection } from './client.ts';
import { readDataset } from '../lib/dataset/format.ts';
import { loadDataset } from '../lib/dataset/load.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const code = (arg('region') ?? '').padStart(2, '0');
if (!/^\d{2}$/.test(code) || code === '00') {
  console.error('Укажите код субъекта: npm run dataset:load -- --region 61');
  process.exit(1);
}

let file = arg('file');

if (!file) {
  const repo = process.env.DATASET_REPO || 'TaCeiN/domovoy-datasets';
  const url = arg('url') ?? `https://github.com/${repo}/releases/download/dataset-${code}/dataset-${code}.ndjson.gz`;
  const dir = join('var', 'datasets');
  mkdirSync(dir, { recursive: true });
  file = join(dir, `dataset-${code}.download.ndjson.gz`);

  console.log(`Скачиваем ${url}`);
  const headers: Record<string, string> = { Accept: 'application/octet-stream' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok || !response.body) {
    console.error(
      `Набор не скачался: ${response.status}.\n` +
      (response.status === 404
        ? `Релиза dataset-${code} нет в ${repo}, или репозиторий закрытый (нужен GITHUB_TOKEN).\n` +
          `Собрать самому: npm run dataset:build -- --region ${code}`
        : 'Повторите позже.'),
    );
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
  console.log(`  ${(statSync(file).size / 1048576).toFixed(1)} МБ`);
}

if (!existsSync(file)) {
  console.error(`Файла нет: ${file}`);
  process.exit(1);
}

const { manifest, rows } = await readDataset(createReadStream(file), code);

const skipped = Object.entries(manifest.stages).filter(([, done]) => !done).map(([stage]) => stage);
console.log(`Набор: ${manifest.regionName}, собран ${manifest.builtAt.slice(0, 10)}; ГАР ${manifest.sources.gar}, ФРТ ${manifest.sources.frt ?? '—'}, OSM ${manifest.sources.osm ?? '—'}`);
console.log(`  строк: ${Object.entries(manifest.counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
if (skipped.includes('licenses')) console.log('  лицензии не собраны: форма управления выведена из названий организаций');
if (skipped.includes('osm')) console.log('  без координат OSM');

console.log('Загрузка →', describeConnection());
const db = getDb();
try {
  const result = await loadDataset(db, manifest, rows);
  console.log(`
Готово.
  организаций      ${result.orgs}
  домов            ${result.houses}
  выпало из реестра ${result.dropped}
  пунктов / улиц   ${result.places} / ${result.streets}
  квартир жителей: организация проставлена ${result.properties.attached}, найдено без региона ${result.properties.byLoose}` +
    (result.properties.collided ? `, разбираться руками ${result.properties.collided}` : ''));
} finally {
  await closeDb();
}
