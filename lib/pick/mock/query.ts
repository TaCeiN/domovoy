import { and, between, eq, or, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { mockComplex, mockComplexPhoto } from '../../../db/schema.ts';
import { listingLinks, type Listing } from '../links.ts';
import type { Bbox } from '../geo.ts';
import type { MockReview } from './format.ts';
import type { Database } from '../../../db/client.ts';
import { DISTRICTS, districtBbox, matchDistricts, type DistrictGeometry } from './districts.ts';

/**
 * Режим заглушки подбора дома (docs/mock-complexes.md).
 *
 * Включается ДАННЫМИ: пока в `mock_complex` есть строки, карта, поиск
 * и карточка отдают ЖК. Флага нет намеренно — выключить значит
 * `mock:clear`, и ответы маршрутов становятся прежними.
 */

export const MOCK_KEY = /^mock:[a-z0-9-]{1,60}$/;
const keyOf = (slug: string) => `mock:${slug}`;

type Row = typeof mockComplex.$inferSelect;

function rating(reviews: MockReview[]): number {
  const avg = reviews.reduce((s, r) => s + r.stars, 0) / reviews.length;
  return Math.round(avg * 10) / 10;
}

export async function mockActive(db: Database): Promise<boolean> {
  const [row] = await db.select({ slug: mockComplex.slug }).from(mockComplex).limit(1);
  return Boolean(row);
}

export interface MapComplex {
  key: string; name: string; address: string; microdistrict: string | null; district: string | null;
  lat: number; lon: number; developer: string | null; priceFrom: number | null; grocery: boolean;
  rating: number; reviews: number; quote: string | null;
}

function toMap(r: Row): MapComplex {
  return {
    key: keyOf(r.slug), name: r.name, address: r.address, microdistrict: r.microdistrict, district: r.district,
    lat: r.lat, lon: r.lon, developer: r.developer, priceFrom: r.priceFrom, grocery: r.grocery,
    rating: rating(r.reviews), reviews: r.reviews.length, quote: r.reviews[0]?.plus ?? null,
  };
}

/** ЖК всего десятки — кружков-групп нет, отдаём все точки рамки на любом масштабе */
export async function mockMap(db: Database, box: Bbox): Promise<{ kind: 'complexes'; complexes: MapComplex[] }> {
  const rows = await db.select().from(mockComplex).where(and(
    between(mockComplex.lat, box.south, box.north),
    between(mockComplex.lon, box.west, box.east),
  ));
  return { kind: 'complexes', complexes: rows.map(toMap) };
}

export interface MockSearchHouse { houseKey: string; address: string; lat: number; lon: number; label: 'ЖК' }
export interface MockSearchDistrict { district: string; count: number; bbox: Bbox }

/** Сколько ЖК в каждом районе и какие у них микрорайоны — для поиска и карты */
async function districtStats(db: Database) {
  const rows = await db
    .select({
      district: mockComplex.district,
      count: sql<number>`count(*)::int`,
      micro: sql<string[]>`array_remove(array_agg(distinct ${mockComplex.microdistrict}), null)`,
      lat: sql<number>`avg(${mockComplex.lat})::float`,
      lon: sql<number>`avg(${mockComplex.lon})::float`,
    })
    .from(mockComplex)
    .groupBy(mockComplex.district);
  const byName = new Map(rows.map((r) => [r.district, r]));
  const micro: Record<string, string[]> = {};
  for (const r of rows) if (r.district) micro[r.district] = r.micro ?? [];
  return {
    count: (name: string) => byName.get(name)?.count ?? 0,
    /** Середина ЖК района — туда смотрит карта, если район целиком не влезает в экран */
    focus: (name: string) => {
      const r = byName.get(name);
      return r ? { lat: Number(r.lat), lon: Number(r.lon) } : null;
    },
    micro,
  };
}

/**
 * Поиск по ЖК и по районам. ЖК — с НАЧАЛА СЛОВА: «ета» не должна находить
 * «Бета». Строка человека идёт в регулярное выражение, поэтому её
 * спецсимволы экранируются. Районы — по названию, народному имени
 * («ЖД», «ЗЖМ», «Сельмаш») и микрорайонам, с одной опечаткой
 * (lib/pick/mock/districts.ts); находится и район, где ЖК пока нет.
 */
export async function mockSearch(db: Database, q: string): Promise<{ houses: MockSearchHouse[]; streets: never[]; districts: MockSearchDistrict[] }> {
  const text = q.trim();
  if (text.length < 2) return { houses: [], streets: [], districts: [] };
  const word = `(^|[\\s«"(.,/-])${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  const starts = (column: AnyPgColumn) => sql`${column} ~* ${word}`;

  const rows = await db.select().from(mockComplex)
    // aliases — jsonb-массив; в тексте '["Грин Сайд"]' кавычка перед словом — тоже граница слова
    .where(or(starts(mockComplex.name), starts(mockComplex.address), starts(mockComplex.microdistrict),
      sql`${mockComplex.aliases}::text ~* ${word}`))
    .limit(8);

  const stats = await districtStats(db);
  const districts = matchDistricts(text, stats.micro);

  return {
    houses: rows.map((r) => ({ houseKey: keyOf(r.slug), address: `${r.name} · ${r.address}`, lat: r.lat, lon: r.lon, label: 'ЖК' })),
    streets: [],
    districts: districts.map((d) => ({ district: d.name, count: stats.count(d.name), bbox: districtBbox(d) })),
  };
}

export interface MapDistrict {
  name: string; count: number; bbox: Bbox;
  label: { lat: number; lon: number };
  /** Середина ЖК района; null, если ЖК в нём нет */
  focus: { lat: number; lon: number } | null;
  geometry: DistrictGeometry;
}

/**
 * Районы для отдалённой карты: граница, точка подписи и число ЖК.
 * Пока заглушка ЖК не загружена — пусто: районы нужны только ей.
 */
export async function mockDistricts(db: Database): Promise<{ districts: MapDistrict[] }> {
  if (!(await mockActive(db))) return { districts: [] };
  const stats = await districtStats(db);
  return {
    districts: DISTRICTS.map((d) => ({
      name: d.name, count: stats.count(d.name), bbox: districtBbox(d), label: d.label, focus: stats.focus(d.name),
      geometry: d.geometry,
    })),
  };
}

export interface MockCard {
  kind: 'mock';
  key: string; name: string; address: string; microdistrict: string | null; district: string | null;
  lat: number; lon: number; developer: string | null; priceFrom: number | null; grocery: boolean;
  blurb: string | null; tags: string[]; reviews: MockReview[]; rating: number; reviewCount: number;
  /** Примерная оплата ЖКУ, ₽ в месяц; нет в файле — null */
  utilities: number | null;
  listings: Listing[];
  similar: { key: string; name: string; rating: number; microdistrict: string | null; developer: string | null }[];
  /** Рендер застройщика с подписью; нет — карточка рисует заглушку */
  photo: { url: string; credit: string } | null;
}

export async function mockCard(db: Database, key: string): Promise<MockCard | null> {
  if (!MOCK_KEY.test(key)) return null;
  const slug = key.slice('mock:'.length);
  const [row] = await db.select().from(mockComplex).where(eq(mockComplex.slug, slug)).limit(1);
  if (!row) return null;

  const others = (await db.select().from(mockComplex)).filter((r) => r.slug !== slug);
  const [pic] = await db.select({ credit: mockComplexPhoto.credit }).from(mockComplexPhoto)
    .where(eq(mockComplexPhoto.slug, slug)).limit(1);
  others.sort((a, b) =>
    Number(b.district === row.district) - Number(a.district === row.district)
    || rating(b.reviews) - rating(a.reviews));

  return {
    kind: 'mock',
    key, name: row.name, address: row.address, microdistrict: row.microdistrict, district: row.district,
    lat: row.lat, lon: row.lon, developer: row.developer, priceFrom: row.priceFrom, grocery: row.grocery,
    blurb: row.blurb, tags: row.tags, reviews: row.reviews, rating: rating(row.reviews), reviewCount: row.reviews.length,
    utilities: row.utilities,
    // Как в макете — одна площадка; ссылка на её поиск, цен у себя не показываем
    listings: listingLinks(`г Ростов-на-Дону, ${row.address}`).filter((l) => l.site === 'avito'),
    similar: others.slice(0, 3).map((r) => ({
      key: keyOf(r.slug), name: r.name, rating: rating(r.reviews), microdistrict: r.microdistrict, developer: r.developer,
    })),
    photo: pic ? { url: `/api/pick/mock-photo/${slug}`, credit: pic.credit } : null,
  };
}

/** Фото ЖК по slug; чужое имя в пути (`..`, `/`) до базы не доходит */
export async function mockPhoto(db: Database, slug: string): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!/^[a-z0-9-]{1,60}$/.test(slug)) return null;
  const [row] = await db.select({ bytes: mockComplexPhoto.bytes, mime: mockComplexPhoto.mime })
    .from(mockComplexPhoto).where(eq(mockComplexPhoto.slug, slug)).limit(1);
  return row ?? null;
}
