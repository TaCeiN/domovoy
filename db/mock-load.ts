/**
 * Заглушка ЖК для подбора дома (docs/mock-complexes.md).
 *
 *   npm run mock:load                          скачать из релиза и залить
 *   npm run mock:load -- --file путь.json      залить готовый файл
 *   npm run mock:clear                         очистить — подбор вернётся к настоящим домам
 *   npm run prod:mock [-- --clear]             то же на боевом стенде
 *
 * Откуда качается: https://github.com/<DATASET_REPO>/releases/download/mock-complexes-61/mock-complexes-61.json
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getDb, closeDb, describeConnection } from './client.ts';
import { parseMockFile, type MockFile } from '../lib/pick/mock/format.ts';
import { loadMock, clearMock, type MockPhotos } from '../lib/pick/mock/load.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function readSource(): Promise<string> {
  const file = arg('file');
  if (file) return readFileSync(file, 'utf8');

  const repo = process.env.DATASET_REPO || 'TaCeiN/domovoy-datasets';
  const url = `https://github.com/${repo}/releases/download/mock-complexes-61/mock-complexes-61.json`;
  console.log(`Скачиваем ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    console.error(`Файл не скачался: ${response.status}. Укажите свой: --file var/mock/mock-complexes-61.json`);
    process.exit(1);
  }
  return response.text();
}

/**
 * Фото ЖК — рядом с JSON: у --file в папке photos/, у релиза — файлами
 * того же релиза. Не скачалось — ЖК остаётся без фото, заливка не падает.
 */
async function readPhotos(file: MockFile): Promise<MockPhotos> {
  const photos: MockPhotos = new Map();
  const local = arg('file');
  const repo = process.env.DATASET_REPO || 'TaCeiN/domovoy-datasets';
  for (const c of file.complexes) {
    if (!c.photo) continue;
    const name = c.photo.file;
    const mime = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg';
    try {
      let bytes: Buffer;
      if (local) {
        bytes = readFileSync(join(dirname(local), 'photos', name));
      } else {
        const response = await fetch(`https://github.com/${repo}/releases/download/mock-complexes-61/${name}`, { redirect: 'follow' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        bytes = Buffer.from(await response.arrayBuffer());
      }
      photos.set(c.slug, { bytes, mime });
    } catch (error) {
      console.warn(`Фото ${c.slug} не загрузилось: ${(error as Error).message}`);
    }
  }
  return photos;
}

const db = getDb();
try {
  if (process.argv.includes('--clear')) {
    await clearMock(db);
    console.log(`Заглушка ЖК очищена (${describeConnection()}). Подбор показывает настоящие дома.`);
  } else {
    const parsed = parseMockFile(JSON.parse((await readSource()).replace(/^﻿/, '')));
    if (!parsed.ok) {
      console.error('Файл не принят, ничего не записано:\n  ' + parsed.errors.join('\n  '));
      process.exitCode = 1;
    } else {
      const count = await loadMock(db, parsed.file, await readPhotos(parsed.file));
      console.log(`Заглушка ЖК → ${describeConnection()}: ${count} ЖК. В приложении они помечены «Примерные данные».`);
    }
  }
} finally {
  await closeDb();
}
