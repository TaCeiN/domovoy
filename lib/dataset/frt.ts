import { inflateRawSync } from 'node:zlib';
import { readCentralDirectory, entryDataOffset, type RangeFetch } from './zip-remote.ts';

/**
 * Открытые данные Фонда развития территорий (бывшая «Реформа ЖКХ»).
 *
 * ЗАЧЕМ. Многоквартирные дома, их управляющие организации с ИНН
 * и контактами — ровно то, что нужно, чтобы с домом можно было
 * договориться. Портал ГИС ЖКХ отдаёт это же только запросами: не глубже
 * 1 900 записей на запрос и с блокировкой после пары десятков подряд —
 * по одной Ростовской области за пять часов собралась половина домов.
 * Фонд выкладывает по каждому региону zip на пару мегабайт раз в месяц,
 * без регистрации и ключей.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: способа управления. Он выводится из организации —
 * см. `registryFormOf`.
 */

export const FRT_BASE = 'https://xn--80adsazqn.xn--p1aee.xn--p1ai'; // аис.фрт.рф

export type RegistryForm = 'uk' | 'tsj' | 'zhsk' | 'direct' | 'private' | 'unknown';

export type HouseKind = 'mkd' | 'blocked' | 'special';

export interface FrtHouse {
  frtId: string;
  fiasGuid: string;
  address: string;
  /** Части адреса отдельными полями — для запасного сопоставления без района */
  place: string;
  street: string;
  number: string;
  orgFrtId: string | null;
  kind: HouseKind | null;
  flats: number | null;
  floors: number | null;
  builtYear: number | null;
  entrances: number | null;
  elevators: number | null;
  /** Материал стен словами фонда: «Панельные», «Кирпич» */
  wallMaterial: string | null;
  /** Газ в доме: есть, нет или фонд молчит */
  gas: boolean | null;
  /** Дом признан аварийным */
  emergency: boolean | null;
}

export interface FrtOrg {
  frtId: string;
  inn: string;
  ogrn: string | null;
  name: string;
  shortName: string | null;
  phone: string | null;
  email: string | null;
  site: string | null;
}

/* ─────────────── страницы ─────────────── */

const ENTITIES: Record<string, string> = { '&quot;': '"', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&#039;': "'" };
const decode = (s: string) => s.replace(/&(quot|amp|lt|gt|#039);/g, (m) => ENTITIES[m]).trim();

export function parseFrtRegions(html: string): { gid: string; name: string }[] {
  return [...html.matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)]
    .map((m) => ({ gid: m[1], name: decode(m[2]) }));
}

/** Заголовок набора и ссылка экспорта идут на странице по очереди */
export function parseFrtExports(html: string): { id: string; title: string }[] {
  const titles = [...html.matchAll(/f-28 fw-500 mt-48">([^<]+)</g)].map((m) => ({ at: m.index ?? 0, title: decode(m[1]) }));
  const out: { id: string; title: string }[] = [];
  for (const [i, t] of titles.entries()) {
    const end = titles[i + 1]?.at ?? html.length;
    const link = /opendata\/export\/(\d+)/.exec(html.slice(t.at, end));
    if (link) out.push({ id: link[1], title: t.title });
  }
  return out;
}

const TYPE_WORDS: Record<string, string> = {
  обл: 'область', область: 'область',
  респ: 'республика', республика: 'республика',
  г: 'город', город: 'город',
  край: 'край',
  ао: 'автономный округ', 'авт. округ': 'автономный округ',
  аобл: 'автономная область',
};

function regionTokens(name: string): string {
  const words = name.toLowerCase().replace(/ё/g, 'е').replace(/[.()]/g, ' ').split(/[\s-]+/).filter(Boolean);
  return [...new Set(words.map((w) => TYPE_WORDS[w] ?? w).join(' ').split(' '))].sort().join(' ');
}

/**
 * ГАР пишет «обл. Ростовская», фонд — «Ростовская область». Сравниваем
 * набор слов с развёрнутыми сокращениями типа, порядок не важен.
 */
export function matchFrtRegion(
  regions: { gid: string; name: string }[],
  garRegionName: string,
): { gid: string; name: string } | null {
  const wanted = regionTokens(garRegionName);
  return regions.find((r) => regionTokens(r.name) === wanted) ?? null;
}

/* ─────────────── файлы ─────────────── */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ';') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

export async function unzipFirst(buf: Buffer): Promise<string> {
  const fetchRange: RangeFetch = async (start, end) => buf.subarray(start, end + 1);
  const [entry] = await readCentralDirectory(fetchRange, buf.length);
  if (!entry) throw new Error('архив фонда пуст');
  const start = await entryDataOffset(fetchRange, entry);
  const data = buf.subarray(start, start + entry.compressedSize);
  const bytes = entry.method === 0 ? data : inflateRawSync(data);
  return bytes.toString('utf8').replace(/^﻿/, '');
}

function table(csv: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(csv.replace(/^﻿/, ''));
  if (!header) return [];
  return rows
    .filter((r) => r.length >= Math.min(header.length, 5))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const orNull = (v: string | undefined) => (v && v !== '-' && v !== 'Не заполнено' ? v : null);

function intOrNull(v: string | undefined): number | null {
  const n = Number.parseInt((v ?? '').replace(/\s/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

/** «Центральное», «Автономное» — газ есть; «Отсутствует» — нет; пусто — фонд молчит */
function gasOf(v: string | undefined): boolean | null {
  const value = orNull(v);
  if (!value) return null;
  return !/^отсутств/i.test(value);
}

function yesNo(v: string | undefined): boolean | null {
  const value = orNull(v)?.toLowerCase();
  return value === 'да' ? true : value === 'нет' ? false : null;
}

/**
 * «81-Б» и «81 а» у фонда — «81Б» и «81а» в ГАР.
 *
 * Правим здесь, а не в общем разборе адреса: его ключи уже лежат в базе
 * у привязанных квартир, и смягчение правил развело бы их с соседями.
 */
function literal(number: string): string {
  return number.trim().replace(/(\d)\s*-?\s*([а-яёА-ЯЁ])(?![а-яё])/u, '$1$2');
}

const KIND: Record<string, HouseKind> = {
  'Многоквартирный дом': 'mkd',
  'Жилой дом блокированной застройки': 'blocked',
  'Специализированный жилищный фонд': 'special',
};

export function frtHouses(csv: string): FrtHouse[] {
  return table(csv)
    .filter((r) => r.houseguid)
    .map((r) => ({
      frtId: r.id,
      fiasGuid: r.houseguid.toLowerCase(),
      address: r.address,
      place: r.formalname_city ?? '',
      street: [r.shortname_street, r.formalname_street].filter(Boolean).join(' '),
      number: [
        literal(`${r.house_number ?? ''}${r.letter ?? ''}`),
        r.block ? `к. ${r.block}` : '',
        r.building ? `стр. ${r.building}` : '',
      ].filter(Boolean).join(', '),
      orgFrtId: orNull(r.management_organization_id),
      kind: KIND[r.house_type] ?? null,
      flats: intOrNull(r.living_quarters_count),
      floors: intOrNull(r.floor_count_max),
      builtYear: intOrNull(r.built_year),
      entrances: intOrNull(r.entrance_count),
      elevators: intOrNull(r.elevators_count),
      wallMaterial: orNull(r.wall_material),
      gas: gasOf(r.gas_type),
      emergency: yesNo(r.is_alarm),
    }));
}

export function frtOrgs(csv: string): FrtOrg[] {
  return table(csv)
    .filter((r) => /^\d{10}(\d{2})?$/.test(r.inn))
    .map((r) => ({
      frtId: r.id,
      inn: r.inn,
      ogrn: orNull(r.orn),
      name: r.name_full,
      shortName: orNull(r.name_short),
      phone: orNull(r.phone),
      email: orNull(r.email),
      site: orNull(r.site),
    }));
}

/**
 * Способ управления — из организации дома.
 *
 * Фонд способа не публикует, но он почти всегда читается из того, КТО
 * управляет: лицензия выдаётся только управляющим компаниям; товарищество
 * и кооператив называют себя в наименовании — так требует ГК РФ.
 * Непосредственного управления так не узнать: организации у такого дома нет,
 * и честный ответ — «неизвестно».
 *
 * Дом блокированной застройки с 2022 года многоквартирным не является
 * (ЖК РФ, ст. 16 в ред. 476-ФЗ) — это частный дом.
 */
export function registryFormOf(org: FrtOrg | null, licensed: boolean, kind: HouseKind | null): RegistryForm {
  if (!org) return kind === 'blocked' ? 'private' : 'unknown';
  if (licensed) return 'uk';

  const name = `${org.name} ${org.shortName ?? ''}`.toUpperCase().replace(/Ё/g, 'Е');
  if (/ТСЖ|ТСН|ТОВАРИЩЕСТВ/.test(name)) return 'tsj';
  if (/ЖСК|(^|[^А-Я])ЖК([^А-Я]|$)|КООПЕРАТИВ/.test(name)) return 'zhsk';
  if (/(^|[^А-ЯA-Z])([ОO]{3}|[ОO]?[АA][ОO]|ЗАО|ПАО|МУП|ГУП|МП|МБУ|ФГБУ|ГУК|УК|УО)([^А-ЯA-Z]|$)|ОБЩЕСТВО С ОГРАНИЧЕННОЙ|АКЦИОНЕРНОЕ ОБЩЕСТВО|УНИТАРНОЕ|УПРАВЛЯЮЩАЯ|УЧРЕЖДЕНИЕ/.test(name)) return 'uk';
  return 'unknown';
}

/* ─────────────── сеть ─────────────── */

async function get(path: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(FRT_BASE + path, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
    if (response.ok) return response;
    if (attempt >= 4 || response.status < 500) throw new Error(`фонд ответил ${response.status} на ${path}`);
    await new Promise((r) => setTimeout(r, attempt * 3000));
  }
}

/** Реестр домов и организаций региона — два zip, секунды. */
export async function fetchFrtRegion(garRegionName: string): Promise<{
  houses: FrtHouse[]; orgs: FrtOrg[]; version: string; regionName: string;
}> {
  const regions = parseFrtRegions(await (await get('/opendata')).text());
  const region = matchFrtRegion(regions, garRegionName);
  if (!region) throw new Error(`фонд не знает региона «${garRegionName}»`);

  const exports: { id: string; title: string }[] = [];
  for (let page = 1; page <= 10; page++) {
    const found = parseFrtExports(await (await get(`/opendata?gid=${region.gid}&page=${page}&pageSize=12`)).text());
    if (found.length === 0) break;
    exports.push(...found);
  }

  const housesSet = exports.find((e) => e.title.startsWith('Реестр домов по'));
  const orgsSet = exports.find((e) => e.title.startsWith('Реестр управляющих организаций по'));
  if (!housesSet || !orgsSet) throw new Error(`у фонда нет реестров домов и организаций для «${region.name}»`);

  const download = async (id: string) => {
    const response = await get(`/opendata/export/${id}`);
    const file = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? id;
    return { text: await unzipFirst(Buffer.from(await response.arrayBuffer())), file };
  };

  const housesFile = await download(housesSet.id);
  const orgsFile = await download(orgsSet.id);

  return {
    houses: frtHouses(housesFile.text),
    orgs: frtOrgs(orgsFile.text),
    // export-reestrmkd-61-20260901.zip → 2026-09-01
    version: /(\d{4})(\d{2})(\d{2})/.exec(housesFile.file)?.slice(1).join('-') ?? housesFile.file,
    regionName: region.name,
  };
}
