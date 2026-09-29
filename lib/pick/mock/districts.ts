import { readFileSync } from 'node:fs';
import type { Bbox } from '../geo.ts';

/**
 * Районы Ростова-на-Дону для подбора дома (заглушка ЖК, docs/mock-complexes.md).
 *
 * Границы — настоящие: административные районы города из OpenStreetMap
 * (ODbL, подпись «© OpenStreetMap» уже стоит на карте), упрощены до
 * ~850 точек на весь город, чтобы файл уходил на телефон за один запрос.
 * Собраны 28.09.2026 через Nominatim; все 29 ЖК заглушки лежат внутри
 * своего района — проверено при сборке.
 *
 * На отдалённой карте ЖК собираются по этим районам, а не по пикселям
 * (просьба владельца 28.09): кружок «Советский · 4 ЖК» понятнее, чем
 * «4» в случайном месте между двумя районами.
 */

type Ring = [number, number][];
export interface DistrictGeometry { type: 'Polygon' | 'MultiPolygon'; coordinates: Ring[] | Ring[][] }
export interface District {
  name: string;
  /** Точка подписи внутри района: центр масс, а если он снаружи — ближайшая точка внутри */
  label: { lat: number; lon: number };
  geometry: DistrictGeometry;
}

interface RawDistrict { name: string; osm: number; label: [number, number]; geometry: DistrictGeometry }

const raw = JSON.parse(readFileSync(new URL('./rostov-districts.json', import.meta.url), 'utf-8')) as RawDistrict[];

export const DISTRICTS: District[] = raw.map((d) => ({
  name: d.name,
  label: { lat: d.label[0], lon: d.label[1] },
  geometry: d.geometry,
}));

/**
 * Как район называют люди. Поиск раньше знал только официальное
 * название из данных ЖК, и «ЖД», «ЗЖМ», «Сельмаш» не находили ничего.
 * «Центр» — намеренно у двух районов: исторический центр делят Кировский
 * и Ленинский.
 */
const ALIASES: Record<string, string[]> = {
  'Ворошиловский район': ['северный', 'сжм', 'северный жилой массив', 'северный посёлок', 'автосборочный'],
  'Железнодорожный район': ['жд', 'железка', 'железнодорожка'],
  'Кировский район': ['центр', 'кировка', 'богатяновка'],
  'Ленинский район': ['центр', 'ленинка', 'первомайский посёлок'],
  'Октябрьский район': ['каменка', 'рабочий городок'],
  'Первомайский район': ['сельмаш', 'первомайка', 'орджоникидзе'],
  'Пролетарский район': ['нахичевань', 'александровка', 'берберовка'],
  'Советский район': ['западный', 'зжм', 'западный жилой массив', 'левенцовка', 'левенцовский'],
};

/** Слова, которые ничего не говорят о том, КАКОЙ район: их не сравниваем */
const NOISE = new Set(['район', 'районы', 'рн', 'мкр', 'микрорайон', 'жилой', 'массив']);

function words(text: string): string[] {
  return text.toLowerCase().replace(/ё/g, 'е')
    .replace(/р-н/g, ' ')
    .split(/[^a-zа-я0-9]+/)
    .filter((w) => w.length > 1 && !NOISE.has(w));
}

/** Расстояние Дамерау — Левенштейна: одна перестановка соседних букв — одна ошибка */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * 0 — слово запроса начинает слово кандидата, 1 — то же с одной опечаткой,
 * null — не похоже. Опечатку прощаем от четырёх букв: на коротком слове
 * одна буква меняет всё («ока» ≠ «окт»).
 */
function wordScore(q: string, candidate: string): 0 | 1 | null {
  if (candidate.startsWith(q)) return 0;
  if (q.length < 4) return null;
  for (const len of [q.length - 1, q.length, q.length + 1]) {
    if (len > 0 && len <= candidate.length && distance(q, candidate.slice(0, len)) <= 1) return 1;
  }
  return null;
}

/** Каждое слово запроса нашлось в фразе; сумма опечаток или null */
function phraseScore(query: string[], phrase: string[]): number | null {
  let typos = 0;
  for (const q of query) {
    const best = phrase.map((w) => wordScore(q, w)).filter((s) => s !== null).sort()[0];
    if (best === undefined) return null;
    typos += best;
  }
  return typos;
}

/**
 * Районы по запросу человека.
 *
 * Совпадение по официальному названию важнее народного: «первомайский»
 * — это Первомайский район, а не «Первомайский посёлок» Ленинского.
 * `extra` — микрорайоны из данных ЖК: «Берберовка» ведёт в свой район,
 * даже если её нет в списке выше.
 */
export function matchDistricts(q: string, extra: Record<string, string[]> = {}): District[] {
  const query = words(q);
  if (query.length === 0) {
    // «районы», «район» — показать все: так человек узнаёт, какие они есть
    return /район/i.test(q) ? DISTRICTS : [];
  }

  const byName: { d: District; score: number }[] = [];
  const byAlias: { d: District; score: number }[] = [];
  for (const d of DISTRICTS) {
    const own = phraseScore(query, words(d.name));
    if (own !== null) { byName.push({ d, score: own }); continue; }
    const aliases = [...(ALIASES[d.name] ?? []), ...(extra[d.name] ?? [])];
    const scores = aliases.map((a) => phraseScore(query, words(a))).filter((s) => s !== null);
    if (scores.length) byAlias.push({ d, score: Math.min(...scores) });
  }
  const hits = byName.length ? byName : byAlias;
  return hits.sort((a, b) => a.score - b.score).map((h) => h.d);
}

/** Рамка района — по его границе, а не по его ЖК: карта охватывает район целиком */
export function districtBbox(d: District): Bbox {
  const rings = d.geometry.type === 'Polygon'
    ? (d.geometry.coordinates as Ring[])
    : (d.geometry.coordinates as Ring[][]).flat();
  let south = 90, north = -90, west = 180, east = -180;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      south = Math.min(south, lat); north = Math.max(north, lat);
      west = Math.min(west, lon); east = Math.max(east, lon);
    }
  }
  return { south, north, west, east };
}
