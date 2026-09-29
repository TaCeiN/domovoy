import { sql } from 'drizzle-orm';
import { coverageOf, type CoverageInput, type CoverageLevel } from './levels.ts';
import type { Database } from '../../db/client.ts';

/**
 * Снимок покрытия региона для кабинета оператора: сводка по населённым
 * пунктам и улицам и компактные точки домов.
 *
 * ПОЧЕМУ СВОДКА ПО ПУНКТАМ. Координаты домов в сёлах есть у одного дома
 * из двадцати, а кадастр кривой. Для вопроса «где у нас покрытие и куда
 * идти договариваться» точность до дома и не нужна: хватает «в Новобатайске
 * 1 788 домов, контакт есть у стольких-то, на улице Октябрьской — у стольких».
 * Место пункта на карте — середина его домов с координатами.
 *
 * ПОЧЕМУ СНИМОК В ПАМЯТИ. Домов в регионе миллион; считать уровни на каждый
 * клик — секунды. Снимок строится раз в несколько минут, дома читаются
 * порциями, а в памяти остаются только сводки и типизированные массивы
 * точек — десятки мегабайт, а не гигабайт объектов.
 */

export interface SnapshotRow extends CoverageInput {
  houseKey: string;
  lat: number | null;
  lon: number | null;
  residents: number;
  placeGuid: string | null;
  placeName: string | null;
  placeType: string | null;
  districtName: string | null;
  streetGuid: string | null;
  streetName: string | null;
  streetType: string | null;
}

export interface LevelCounts {
  total: number;
  address: number;
  kind: number;
  contact: number;
  agreed: number;
}

export interface AreaSummary {
  guid: string;
  name: string;
  type: string;
  /** Все дома: многоквартирные, частные и вероятно частные */
  total: number;
  /** Многоквартирные и неизвестные — те, с кем есть о чём договариваться */
  mkd: LevelCounts;
  private: number;
  likely: number;
  residents: number;
}

export interface PlaceSummary extends AreaSummary {
  district: string | null;
  lat: number | null;
  lon: number | null;
}

export interface Bbox { south: number; west: number; north: number; east: number }

/** Точка: широта, долгота, уровень 0..3, группа 0 мкд · 1 частный · 2 вероятно частный, жители, ключ дома */
export type PointRow = [number, number, number, number, number, string];

export const LEVEL_ORDER: CoverageLevel[] = ['address', 'kind', 'contact', 'agreed'];

const blankLevels = (): LevelCounts => ({ total: 0, address: 0, kind: 0, contact: 0, agreed: 0 });

interface Area extends AreaSummary { latSum: number; lonSum: number; located: number; district: string | null }

export class SnapshotBuilder {
  places = new Map<string, Area>();
  streets = new Map<string, Map<string, Area>>();
  totals = { total: 0, mkd: blankLevels(), private: 0, likely: 0, residents: 0, withoutPlace: 0, onMap: 0 };
  lat: number[] = [];
  lon: number[] = [];
  level: number[] = [];
  group: number[] = [];
  residents: number[] = [];
  keys: string[] = [];

  add(row: SnapshotRow): void {
    const coverage = coverageOf(row);
    const group = coverage.isPrivate ? 1 : coverage.privateLikely ? 2 : 0;

    const count = (area: { total: number; mkd: LevelCounts; private: number; likely: number; residents: number }) => {
      area.total++;
      if (group === 1) area.private++;
      else if (group === 2) area.likely++;
      else { area.mkd.total++; area.mkd[coverage.level]++; }
      if (row.residents > 0) area.residents++;
    };

    count(this.totals);

    if (row.placeGuid) {
      let place = this.places.get(row.placeGuid);
      if (!place) {
        place = {
          guid: row.placeGuid, name: row.placeName ?? '', type: row.placeType ?? '', district: row.districtName,
          total: 0, mkd: blankLevels(), private: 0, likely: 0, residents: 0, latSum: 0, lonSum: 0, located: 0,
        };
        this.places.set(row.placeGuid, place);
      }
      count(place);
      if (row.lat !== null && row.lon !== null) {
        place.latSum += row.lat;
        place.lonSum += row.lon;
        place.located++;
      }

      if (row.streetGuid && row.streetGuid !== row.placeGuid) {
        let streets = this.streets.get(row.placeGuid);
        if (!streets) { streets = new Map(); this.streets.set(row.placeGuid, streets); }
        let street = streets.get(row.streetGuid);
        if (!street) {
          street = {
            guid: row.streetGuid, name: row.streetName ?? '', type: row.streetType ?? '', district: null,
            total: 0, mkd: blankLevels(), private: 0, likely: 0, residents: 0, latSum: 0, lonSum: 0, located: 0,
          };
          streets.set(row.streetGuid, street);
        }
        count(street);
      }
    } else {
      this.totals.withoutPlace++;
    }

    if (row.lat !== null && row.lon !== null) {
      this.totals.onMap++;
      this.lat.push(row.lat);
      this.lon.push(row.lon);
      this.level.push(LEVEL_ORDER.indexOf(coverage.level));
      this.group.push(group);
      this.residents.push(Math.min(row.residents, 65535));
      this.keys.push(row.houseKey);
    }
  }

  finish(): Snapshot {
    const strip = ({ latSum: _a, lonSum: _b, located: _c, district: _d, ...area }: Area): AreaSummary => area;
    const places: PlaceSummary[] = [...this.places.values()].map((place) => ({
      ...strip(place),
      district: place.district,
      lat: place.located ? place.latSum / place.located : null,
      lon: place.located ? place.lonSum / place.located : null,
    }));
    const streets = new Map([...this.streets].map(([guid, map]) => [guid, [...map.values()].map(strip)]));

    const lat = Float64Array.from(this.lat);
    const lon = Float64Array.from(this.lon);
    const level = Uint8Array.from(this.level);
    const group = Uint8Array.from(this.group);
    const residents = Uint16Array.from(this.residents);
    const keys = this.keys;

    return {
      builtAt: new Date().toISOString(),
      totals: this.totals,
      places,
      streets,
      points(box: Bbox, limit: number) {
        const rows: PointRow[] = [];
        let truncated = false;
        for (let i = 0; i < lat.length; i++) {
          if (lat[i] < box.south || lat[i] > box.north || lon[i] < box.west || lon[i] > box.east) continue;
          if (rows.length >= limit) { truncated = true; break; }
          rows.push([lat[i], lon[i], level[i], group[i], residents[i], keys[i]]);
        }
        return { rows, truncated };
      },
    };
  }
}

export interface Snapshot {
  builtAt: string;
  totals: SnapshotBuilder['totals'];
  places: PlaceSummary[];
  streets: Map<string, AreaSummary[]>;
  points(box: Bbox, limit: number): { rows: PointRow[]; truncated: boolean };
}

const PAGE = 50_000;

/**
 * Дома региона порциями по ключу — чтобы в памяти не лежал миллион строк
 * разом. Пункт дома — улица или её родители до уровня 5–6 адресного дерева.
 */
export async function buildSnapshot(db: Database, regionCode: string): Promise<Snapshot> {
  const builder = new SnapshotBuilder();
  let after = '';

  for (;;) {
    const result = await db.execute(sql`
      with page as (
        select house_key, lat, lon, registry_form, form, house_kind, gar_flats, flat_count, gar_mkd,
               registry_org_id, org_id, street_guid
          from house
         where region_code = ${regionCode} and address_raw is not null and house_key > ${after}
         order by house_key
         limit ${PAGE}
      ),
      residents as (
        select p.house_key, count(*)::int as n
          from user_property up join property p on p.id = up.property_id
         where up.status = 'active' and p.house_key in (select house_key from page)
         group by p.house_key
      ),
      -- Кабинетов и председателей единицы: собрать их списком дешевле,
      -- чем спрашивать о каждом из миллиона домов отдельно
      cabinet as (select distinct org_id from dispatcher),
      chaired as (
        select distinct house_key from chairman
         where revoked_at is null and house_key in (select house_key from page)
      )
      select h.house_key as "houseKey", h.lat, h.lon,
             h.registry_form as "registryForm", h.form as "humanForm", h.house_kind as "houseKind",
             h.gar_flats as "garFlats", h.flat_count as "flatCount", h.gar_mkd as "garMkd",
             mo.inn as "orgInn",
             coalesce(mo.phone is not null or mo.email is not null or mo.site is not null, false) as "orgHasContact",
             cab.org_id is not null as "orgHasCabinet",
             ch.house_key is not null as "hasChairman",
             coalesce(r.n, 0) as residents,
             s.guid as "streetGuid", s.name as "streetName", s.type as "streetType",
             case when s.level in (5, 6) then s.guid when p1.level in (5, 6) then p1.guid when p2.level in (5, 6) then p2.guid end as "placeGuid",
             case when s.level in (5, 6) then s.name when p1.level in (5, 6) then p1.name when p2.level in (5, 6) then p2.name end as "placeName",
             case when s.level in (5, 6) then s.type when p1.level in (5, 6) then p1.type when p2.level in (5, 6) then p2.type end as "placeType",
             coalesce(case when p1.level = 2 then p1.name end, case when p2.level = 2 then p2.name end, case when p3.level = 2 then p3.name end) as "districtName"
        from page h
        left join managing_org mo on mo.id = coalesce(h.registry_org_id, h.org_id)
        left join cabinet cab on cab.org_id = mo.id
        left join chaired ch on ch.house_key = h.house_key
        left join residents r on r.house_key = h.house_key
        left join address_object s on s.guid = h.street_guid
        left join address_object p1 on p1.guid = s.parent_guid
        left join address_object p2 on p2.guid = p1.parent_guid
        left join address_object p3 on p3.guid = p2.parent_guid
       order by h.house_key`);

    const rows = result.rows as unknown as SnapshotRow[];
    for (const row of rows) builder.add(row);
    if (rows.length < PAGE) break;
    after = rows[rows.length - 1].houseKey;
  }

  return builder.finish();
}

interface CacheEntry {
  /** Когда начали строить текущий готовый снимок */
  at: number;
  ready: Snapshot | null;
  /** Строящийся снимок: все запросы ждут один и тот же */
  pending: Promise<Snapshot> | null;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60_000;

/**
 * Снимок из кэша. Устаревший отдаётся сразу, а новый строится в фоне:
 * сводка десятиминутной давности оператору полезнее полуминуты ожидания.
 * Ждать приходится только самый первый раз после запуска сервера.
 */
export function coverageSnapshot(
  db: Database,
  regionCode: string,
  build: (db: Database, regionCode: string) => Promise<Snapshot> = buildSnapshot,
): Promise<Snapshot> {
  let entry = cache.get(regionCode);
  if (!entry) {
    entry = { at: 0, ready: null, pending: null };
    cache.set(regionCode, entry);
  }
  const fresh = entry.ready && Date.now() - entry.at < TTL_MS;
  if (fresh) return Promise.resolve(entry.ready!);

  if (!entry.pending) {
    const current = entry;
    const startedAt = Date.now();
    current.pending = build(db, regionCode)
      .then((snapshot) => {
        current.ready = snapshot;
        current.at = startedAt;
        return snapshot;
      })
      .finally(() => { current.pending = null; });
    // Фоновая пересборка упала — остаётся прежний снимок, следующий запрос попробует снова
    if (current.ready) current.pending.catch(() => {});
  }
  return entry.ready ? Promise.resolve(entry.ready) : entry.pending!;
}

/** Для тестов: следующий запрос построит снимок заново */
export function resetCoverageCache(): void {
  cache.clear();
}
