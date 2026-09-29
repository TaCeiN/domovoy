import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import type { DatasetHouse, DatasetObject, DatasetOrg, DatasetPoi, MergeReport } from './merge.ts';

/**
 * Файл набора региона: одна строка JSON на запись, первой — манифест.
 *
 * ПОЧЕМУ НЕ ДАМП БАЗЫ. Дамп перезаливает таблицы целиком, а на бою
 * к организациям уже привязаны квартиры жителей по `managing_org.id`,
 * к домам — председатели и объявления. Набор же — это данные, которые
 * загрузчик аккуратно вливает поверх: организацию находит по ИНН, дом —
 * по ключу, человеческие решения не трогает. И формат не зависит от
 * версии схемы: миграции идут своим чередом, набор своим.
 *
 * ПОЧЕМУ КОНТРОЛЬНАЯ СУММА. Файл скачивается из релиза GitHub; оборванная
 * закачка gzip иногда распаковывается «успешно» до места обрыва. Загрузить
 * пол-региона и решить, что это весь регион, — худший исход.
 */

/** 2: адресное дерево ГАР (`object`) вместо КЛАДР, дома и организации из фонда */
export const DATASET_FORMAT = 2;
/* Строки poi и паспорт дома добавлены без смены формата: старый загрузчик неизвестные строки пропускает */

export interface DatasetManifest {
  format: 2;
  regionCode: string;
  regionName: string;
  builtAt: string;
  /** Какие этапы сборки прошли: загрузчик честно печатает пропущенные */
  stages: { gar: boolean; params?: boolean; frt: boolean; licenses: boolean; osm: boolean };
  /** Версии источников: «2026.09.15», «2026-09-01» */
  sources: { gar: string; frt: string | null; osm: string | null };
  counts: Record<string, number>;
  report: MergeReport | null;
  sha256: string;
}

export type DatasetRow =
  | { t: 'region'; code: string; name: string; source: string }
  | ({ t: 'object' } & DatasetObject)
  | ({ t: 'org' } & DatasetOrg)
  | ({ t: 'house' } & DatasetHouse)
  | ({ t: 'poi' } & DatasetPoi);

export async function writeDataset(
  path: string,
  manifest: Omit<DatasetManifest, 'sha256' | 'counts'>,
  rows: Iterable<DatasetRow> | AsyncIterable<DatasetRow>,
): Promise<DatasetManifest> {
  // Тело сначала во временный файл: сумма и счётчики нужны в ПЕРВОЙ строке
  const bodyPath = `${path}.body`;
  const body = createWriteStream(bodyPath);
  const hash = createHash('sha256');
  const counts: Record<string, number> = {};

  for await (const row of rows) {
    const line = `${JSON.stringify(row)}\n`;
    hash.update(line);
    counts[row.t] = (counts[row.t] ?? 0) + 1;
    if (!body.write(line)) await once(body, 'drain');
  }
  body.end();
  await once(body, 'finish');

  const full: DatasetManifest = { ...manifest, format: 2, counts, sha256: hash.digest('hex') };

  async function* content() {
    yield `${JSON.stringify(full)}\n`;
    for await (const chunk of createReadStream(bodyPath)) yield chunk;
  }

  await pipeline(Readable.from(content()), createGzip({ level: 9 }), createWriteStream(path));
  await rm(bodyPath, { force: true });
  return full;
}

export async function readDataset(
  stream: NodeJS.ReadableStream,
  expectRegion: string,
): Promise<{ manifest: DatasetManifest; rows: AsyncGenerator<DatasetRow> }> {
  const lines = createInterface({ input: stream.pipe(createGunzip()), crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();

  const first = await iterator.next();
  if (first.done) throw new Error('файл набора пуст');

  const manifest = JSON.parse(first.value) as DatasetManifest;
  if (manifest.format !== DATASET_FORMAT) {
    lines.close();
    throw new Error(`формат набора ${manifest.format} не поддерживается, нужен ${DATASET_FORMAT} — обновите код`);
  }
  if (manifest.regionCode !== expectRegion) {
    lines.close();
    throw new Error(`в файле регион ${manifest.regionCode}, а загружается ${expectRegion}`);
  }

  async function* rows(): AsyncGenerator<DatasetRow> {
    const hash = createHash('sha256');
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value === '') continue;
      hash.update(`${next.value}\n`);
      yield JSON.parse(next.value) as DatasetRow;
    }
    if (hash.digest('hex') !== manifest.sha256) {
      throw new Error('контрольная сумма набора не сошлась: файл испорчен или скачан не до конца');
    }
  }

  return { manifest, rows: rows() };
}
