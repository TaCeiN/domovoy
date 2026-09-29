/**
 * Сборка набора данных региона.
 *
 *   npm run dataset:build -- --region 61
 *   npm run dataset:build -- --region 61 --no-osm      без координат (без 300 МБ выжимки)
 *
 * Минуты, а не часы. Источники:
 *   ГАР ФНС        — адресное дерево и все дома, файлы региона кусками из общего архива;
 *   фонд (ФРТ)     — многоквартирные дома, организации с ИНН и контактами, два zip;
 *   ГИС ЖКХ        — номера лицензий, несколько запросов;
 *   OpenStreetMap  — координаты для карты покрытия, выжимка федерального округа.
 *
 * Базы не нужно: итог — файл `var/datasets/dataset-NN.ndjson.gz`. Загрузить —
 * `npm run dataset:load`, выложить — `npm run dataset:publish`. Скачанное лежит
 * в `var/datasets/`, и повторная сборка его не качает.
 *
 * Новый регион — запуск с другим кодом: GUID субъекта, выгрузки фонда
 * и выжимка OSM находятся по коду сами.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchLicenses } from '../lib/address/gis.ts';
import { readCentralDirectory, httpRange, openEntryStream } from '../lib/dataset/zip-remote.ts';
import { readGarRegion, type GarFileKind } from '../lib/dataset/gar.ts';
import { readHouseParams, toJson, fromJson, type HouseParams } from '../lib/dataset/gar-params.ts';
import { fetchFrtRegion } from '../lib/dataset/frt.ts';
import { OSM_EXTRACTS, scanOsm, type OsmPoi } from '../lib/dataset/osm.ts';
import { mergeDataset, type License } from '../lib/dataset/merge.ts';
import { writeDataset, type DatasetRow } from '../lib/dataset/format.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (...parts: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...parts);

const code = (arg('region') ?? '').padStart(2, '0');
if (!/^\d{2}$/.test(code) || code === '00') {
  console.error('Укажите код субъекта: npm run dataset:build -- --region 61');
  process.exit(1);
}

const root = arg('work') ?? join('var', 'datasets');
const work = join(root, code);
mkdirSync(work, { recursive: true });

/* ─────────────── 1. ГАР ─────────────── */

const info = await (await fetch('https://fias.nalog.ru/WebServices/Public/GetLastDownloadFileInfo', {
  headers: { accept: 'application/json' },
})).json() as { GarXMLFullURL?: string };
if (!info.GarXMLFullURL) throw new Error('ФНС не отдала ссылку на ГАР');
const garUrl = info.GarXMLFullURL;
const garDate = /(\d{4}\.\d{2}\.\d{2})/.exec(garUrl)?.[1] ?? 'unknown';
log(`ГАР от ${garDate}`);

const garDir = join(work, `gar-${garDate}`);
mkdirSync(garDir, { recursive: true });

const GAR_FILES: Record<GarFileKind, RegExp> = {
  ADDR_OBJ: new RegExp(`^${code}/AS_ADDR_OBJ_\\d`),
  HOUSES: new RegExp(`^${code}/AS_HOUSES_\\d`),
  APARTMENTS: new RegExp(`^${code}/AS_APARTMENTS_\\d`),
  ADM_HIERARCHY: new RegExp(`^${code}/AS_ADM_HIERARCHY_\\d`),
};

const remote = httpRange(garUrl);
const entries = await readCentralDirectory(remote.fetchRange, await remote.size());
for (const [kind, pattern] of Object.entries(GAR_FILES) as [GarFileKind, RegExp][]) {
  const entry = entries.find((e) => pattern.test(e.name));
  if (!entry) throw new Error(`в архиве ГАР нет ${kind} для региона ${code}`);
  const target = join(garDir, `${kind}.xml`);
  if (existsSync(target) && statSync(target).size === entry.size) continue;
  log(`  ${kind}: ${(entry.compressedSize / 1048576).toFixed(0)} МБ сжатого…`);
  await pipeline(await openEntryStream(garUrl, entry), createWriteStream(`${target}.part`));
  renameSync(`${target}.part`, target);
}

log('Разбор ГАР…');
const gar = await readGarRegion((kind) => createReadStream(join(garDir, `${kind}.xml`), { highWaterMark: 1 << 20 }));
const regionObject = gar.objects.get(gar.regionObjectId);
if (!regionObject) throw new Error('в ГАР нет объекта субъекта');
const regionType = regionObject.type.replace(/\.$/, '');
log(`  объектов ${gar.objects.size}, домов ${gar.houses.length}, с квартирами ${gar.flats.size}`);

/**
 * Параметры домов: кадастровый номер и признак ФНС «Многоквартирный дом».
 *
 * Файл региона — 3,4 ГБ распакованным, и на диск он НЕ пишется: читается
 * потоком из архива, а кэшируется выжимка на пару десятков мегабайт.
 * Распаковка его целиком однажды переполнила системный диск.
 */
const paramsFile = join(garDir, 'house-params.json');
let params: HouseParams;
if (existsSync(paramsFile)) {
  params = fromJson(readFileSync(paramsFile, 'utf8'));
} else {
  const entry = entries.find((e) => new RegExp(`^${code}/AS_HOUSES_PARAMS_\\d`).test(e.name));
  if (!entry) throw new Error(`в архиве ГАР нет параметров домов региона ${code}`);
  log(`Параметры домов ГАР: ${(entry.compressedSize / 1048576).toFixed(0)} МБ сжатого, читаем потоком…`);
  params = await readHouseParams(await openEntryStream(garUrl, entry) as AsyncIterable<Buffer>);
  writeFileSync(paramsFile, toJson(params));
}
log(`  кадастровых номеров ${params.cadastral.size}, многоквартирных по ФНС ${params.mkd.size}`);

/* ─────────────── 2. Фонд развития территорий ─────────────── */

log('Фонд: реестры домов и организаций…');
const frt = await fetchFrtRegion(`${regionType} ${regionObject.name}`);
log(`  ${frt.regionName} от ${frt.version}: домов ${frt.houses.length}, организаций ${frt.orgs.length}`);

/* ─────────────── 3. Лицензии ─────────────── */

/**
 * Лицензия отличает управляющую компанию от товарищества надёжнее названия.
 * Портал ГИС ЖКХ закрывается на частые запросы, поэтому между страницами
 * пауза, а отказ сборку не валит: без лицензий форма выводится из названия
 * организации, и манифест честно говорит, что этап не прошёл.
 */
const licenses = new Map<string, License>();
let licensesDone = false;
const licensesFile = join(work, `licenses-${new Date().toISOString().slice(0, 10)}.json`);
if (existsSync(licensesFile)) {
  for (const [inn, license] of JSON.parse(readFileSync(licensesFile, 'utf8')) as [string, License][]) licenses.set(inn, license);
  licensesDone = true;
} else {
  log('Лицензии ГИС ЖКХ…');
  try {
    for (let page = 1; ; page++) {
      const { total, items } = await fetchLicenses(regionObject.guid, page, 100);
      for (const license of items) {
        if (!license.licensee?.inn) continue;
        licenses.set(license.licensee.inn, {
          number: license.licenseNumber ?? null, status: license.status ?? null, phone: license.licensee.phone ?? null,
        });
      }
      if (items.length === 0 || page * 100 >= total) break;
      await sleep(2000);
    }
    writeFileSync(licensesFile, JSON.stringify([...licenses]));
    licensesDone = true;
  } catch (error) {
    log(`  лицензии пропущены: ${(error as Error).message.slice(0, 120)}`);
  }
}
log(`  лицензиатов ${licenses.size}`);

/* ─────────────── 4. OpenStreetMap ─────────────── */

let osm: { key: string; lat: number; lon: number }[] = [];
let pois: OsmPoi[] = [];
let osmVersion: string | null = null;
const extractUrl = OSM_EXTRACTS[code];

if (has('no-osm')) {
  log('OSM: пропущен по ключу --no-osm');
} else if (!extractUrl) {
  log(`OSM: для региона ${code} выжимка не задана — координат не будет`);
} else {
  const osmDir = join(root, 'osm');
  mkdirSync(osmDir, { recursive: true });
  const fileName = extractUrl.split('/').pop()!.replace('-latest', '');
  const pbf = join(osmDir, fileName);
  // Выжимка, уже лежащая у генератора квитанций, второй раз не качается
  const toolCopy = join('tools', 'receipt-generator', 'data', fileName);

  let path = existsSync(pbf) ? pbf : existsSync(toolCopy) ? toolCopy : null;
  if (!path) {
    log(`OSM: качаем ${extractUrl}…`);
    const response = await fetch(extractUrl, { redirect: 'follow' });
    if (!response.ok || !response.body) throw new Error(`Geofabrik ответил ${response.status}`);
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(`${pbf}.part`));
    renameSync(`${pbf}.part`, pbf);
    path = pbf;
  }
  osmVersion = statSync(path).mtime.toISOString().slice(0, 10);

  log(`OSM: здания с адресом (${(statSync(path).size / 1048576).toFixed(0)} МБ)…`);
  const placeNames = new Set<string>();
  for (const object of gar.objects.values()) {
    if (object.level === 5 || object.level === 6) placeNames.add(object.name.toLowerCase().replace(/ё/g, 'е'));
  }
  const scanned = await scanOsm(path, placeNames);
  osm = scanned.buildings;
  pois = scanned.pois;
  log(`  зданий с однозначным адресом ${osm.length}, точек окружения в округе ${pois.length}`);
}

/* ─────────────── 5. Сведение и запись ─────────────── */

log('Сведение…');
const merged = mergeDataset({ regionCode: code, gar, frtHouses: frt.houses, frtOrgs: frt.orgs, licenses, osm, params });
const regionName = `${regionObject.name} ${regionType}`;

/**
 * Точки окружения — только в рамке домов региона, с запасом в 2 км:
 * выжимка OSM — целый федеральный округ, чужие области набору не нужны.
 * Цикл, а не Math.min(...array): на сотнях тысяч домов разворот массива
 * переполняет стек.
 */
function regionPois(): OsmPoi[] {
  let south = Infinity, north = -Infinity, west = Infinity, east = -Infinity;
  for (const h of merged.houses) {
    if (h.lat === null || h.lon === null) continue;
    if (h.lat < south) south = h.lat;
    if (h.lat > north) north = h.lat;
    if (h.lon < west) west = h.lon;
    if (h.lon > east) east = h.lon;
  }
  if (south === Infinity) return [];
  const pad = 0.02;
  return pois.filter((p) => p.lat >= south - pad && p.lat <= north + pad && p.lon >= west - pad && p.lon <= east + pad);
}
const poiRows = regionPois();

function* rows(): Generator<DatasetRow> {
  yield { t: 'region', code, name: regionName, source: `ГАР ${garDate}, ФРТ ${frt.version}` };
  for (const object of merged.objects) yield { t: 'object', ...object };
  for (const org of merged.orgs) yield { t: 'org', ...org };
  for (const house of merged.houses) yield { t: 'house', ...house };
  for (const poi of poiRows) yield { t: 'poi', ...poi };
}

const out = join(root, `dataset-${code}.ndjson.gz`);
const manifest = await writeDataset(out, {
  format: 2,
  regionCode: code,
  regionName,
  builtAt: new Date().toISOString(),
  stages: { gar: true, params: true, frt: true, licenses: licensesDone, osm: osm.length > 0 },
  sources: { gar: garDate, frt: frt.version, osm: osmVersion },
  report: merged.report,
}, rows());

const r = merged.report;
console.log(`
Готово: ${out} (${(statSync(out).size / 1048576).toFixed(1)} МБ)

  адресных объектов         ${r.objects}
  домов ГАР                 ${r.garHouses}
  домов фонда               ${r.frtHouses}
    сшито по GUID ФИАС      ${r.byGuid}
    сшито по адресу         ${r.byKey}
    добавлено из фонда      ${r.addedFromFrt}
  слито дублей ключа        ${r.keyCollisions}
  организаций               ${r.orgs}
  домов в наборе            ${r.houses}
    УК ${r.forms.uk} · ТСЖ ${r.forms.tsj} · ЖСК ${r.forms.zhsk} · частные ${r.forms.private} · неизвестно ${r.forms.unknown} · нет в фонде ${r.forms.none}
  многоквартирных по ФНС    ${r.garMkd}
  с координатами            ${r.withCoords}
  чужих координат отброшено ${r.coordsDropped}
  точек окружения           ${poiRows.length}
  строк: ${Object.entries(manifest.counts).map(([k, v]) => `${k} ${v}`).join(', ')}

Выложить: npm run dataset:publish -- --region ${code}`);
