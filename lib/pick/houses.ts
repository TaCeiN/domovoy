import { and, between, isNotNull, sql } from 'drizzle-orm';
import { house, poi } from '../../db/schema.ts';
import { around, cellDeg, distanceM, tooWide, type Bbox, type Point } from './geo.ts';
import { PICKER_HOUSE } from './scope.ts';
import { ratingsFor } from './reviews.ts';
import type { PoiKind } from '../dataset/osm.ts';
import type { Database } from '../../db/client.ts';

/**
 * Дома на карте подбора.
 *
 * Кружки считает база, а не телефон: многоквартирных домов в области
 * десятки тысяч, и отдавать их все, чтобы мессенджер сам их сгруппировал,
 * значит мегабайты по мобильной сети. Плагин кластеров тоже не нужен.
 */

export const HOUSES_ZOOM = 15;
export const MAX_HOUSES = 2000;

export interface MapHouse {
  houseKey: string; lat: number; lon: number; address: string;
  builtYear: number | null; floors: number | null;
  rating: number | null; reviews: number;
}
export interface Cluster { lat: number; lon: number; count: number }
export type MapAnswer =
  | { kind: 'zoom_in' }
  | { kind: 'clusters'; clusters: Cluster[] }
  | { kind: 'houses'; houses: MapHouse[] };

export async function mapHouses(db: Database, box: Bbox, zoom: number): Promise<MapAnswer> {
  if (tooWide(box)) return { kind: 'zoom_in' };

  const inBox = and(
    isNotNull(house.lat),
    between(house.lat, box.south, box.north),
    between(house.lon, box.west, box.east),
    PICKER_HOUSE,
  );

  if (zoom < HOUSES_ZOOM) {
    const cell = cellDeg(zoom);
    const rows = await db
      .select({
        lat: sql<number>`avg(${house.lat})::float`,
        lon: sql<number>`avg(${house.lon})::float`,
        count: sql<number>`count(*)::int`,
      })
      .from(house)
      .where(inBox)
      .groupBy(sql`floor(${house.lat} / ${cell}::float8)`, sql`floor(${house.lon} / ${cell}::float8)`);
    return { kind: 'clusters', clusters: rows.map((r) => ({ lat: Number(r.lat), lon: Number(r.lon), count: r.count })) };
  }

  const rows = await db
    .select({
      houseKey: house.houseKey, lat: house.lat, lon: house.lon, address: house.addressRaw,
      builtYear: house.builtYear, floors: house.floors,
    })
    .from(house)
    .where(inBox)
    .limit(MAX_HOUSES);
  const ratings = await ratingsFor(db, rows.map((r) => r.houseKey));

  return {
    kind: 'houses',
    houses: rows.map((r) => ({
      houseKey: r.houseKey,
      lat: r.lat!,
      lon: r.lon!,
      address: r.address ?? '',
      builtYear: r.builtYear,
      floors: r.floors,
      rating: ratings.get(r.houseKey)?.rating ?? null,
      reviews: ratings.get(r.houseKey)?.count ?? 0,
    })),
  };
}

export const NEAR_RADIUS_M = 1500;
export type Near = Record<PoiKind, number | null>;

/** Метры до ближайшей точки каждого вида; `null` — дальше 1,5 км или OSM о ней не знает */
export async function nearby(db: Database, at: Point): Promise<Near> {
  const box = around(at, NEAR_RADIUS_M);
  const rows = await db
    .select({ kind: poi.kind, lat: poi.lat, lon: poi.lon })
    .from(poi)
    .where(and(between(poi.lat, box.south, box.north), between(poi.lon, box.west, box.east)));

  const near: Near = { shop: null, pharmacy: null, school: null, kindergarten: null, stop: null };
  for (const row of rows) {
    const kind = row.kind as PoiKind;
    if (!(kind in near)) continue;
    const meters = Math.round(distanceM(at, row));
    if (meters > NEAR_RADIUS_M) continue;
    if (near[kind] === null || meters < near[kind]!) near[kind] = meters;
  }
  return near;
}
