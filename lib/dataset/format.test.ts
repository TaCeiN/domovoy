import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { writeDataset, readDataset, type DatasetRow, type DatasetManifest } from './format.ts';

const dir = mkdtempSync(join(tmpdir(), 'domovoy-dataset-'));

const MANIFEST: Omit<DatasetManifest, 'sha256' | 'counts'> = {
  format: 2,
  regionCode: '61',
  regionName: 'Ростовская обл',
  builtAt: '2026-09-16T00:00:00.000Z',
  stages: { gar: true, frt: true, licenses: true, osm: true },
  sources: { gar: '2026.09.15', frt: '2026-09-01', osm: null },
  report: null,
};

const ROWS: DatasetRow[] = [
  { t: 'region', code: '61', name: 'Ростовская обл', source: 'КЛАДР' },
  { t: 'object', guid: 'g-city', regionCode: '61', parentGuid: 'g-region', level: 5, type: 'г', name: 'Ростов-на-Дону', searchName: 'ростов-на-дону' },
  {
    t: 'house', houseKey: 'k1', houseKeyLoose: null, fiasGuid: 'f1', addressRaw: 'обл Ростовская, г Аксай, ул Мира, д. 1',
    regionCode: '61', streetGuid: null, houseKind: null, garMkd: false, cadastralNumber: null, gisHouseGuid: null, flatCount: null, garFlats: 0, registryForm: null, orgInn: null, lat: null, lon: null,
  },
];

async function readAll(path: string, region = '61') {
  const { manifest, rows } = await readDataset(createReadStream(path), region);
  const out: DatasetRow[] = [];
  for await (const row of rows) out.push(row);
  return { manifest, out };
}

test('записанный набор читается теми же строками, счётчики в манифесте', async () => {
  const path = join(dir, 'ok.ndjson.gz');
  const written = await writeDataset(path, MANIFEST, ROWS);
  assert.deepEqual(written.counts, { region: 1, object: 1, house: 1 });
  assert.match(written.sha256, /^[0-9a-f]{64}$/);

  const { manifest, out } = await readAll(path);
  assert.deepEqual(out, ROWS);
  assert.equal(manifest.sha256, written.sha256);
});

test('набор чужого региона не читается', async () => {
  const path = join(dir, 'region.ndjson.gz');
  await writeDataset(path, MANIFEST, ROWS);
  await assert.rejects(readAll(path, '23'), /регион/);
});

test('неизвестная версия формата не читается', async () => {
  const path = join(dir, 'format.ndjson.gz');
  await writeDataset(path, MANIFEST, ROWS);
  const lines = gunzipSync(readFileSync(path)).toString('utf8').split('\n');
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), format: 1 });
  writeFileSync(path, gzipSync(lines.join('\n')));
  await assert.rejects(readAll(path), /формат/);
});

test('испорченная строка ловится контрольной суммой', async () => {
  const path = join(dir, 'broken.ndjson.gz');
  await writeDataset(path, MANIFEST, ROWS);
  const text = gunzipSync(readFileSync(path)).toString('utf8').replace('Ростов-на-Дону', 'Ростов-на-Доне');
  writeFileSync(path, gzipSync(text));
  await assert.rejects(readAll(path), /контрольная сумма/);
});
