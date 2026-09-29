import { and, inArray, isNotNull, max, min } from 'drizzle-orm';
import { house } from '../../db/schema.ts';
import { findStreets, housesOnStreet, loadedRegions } from '../address/registry.ts';
import { isPickerHouse } from './scope.ts';
import type { Bbox } from './geo.ts';
import type { Database } from '../../db/client.ts';

/**
 * Поиск «как в Яндекс Картах»: одно поле, улица и номер.
 *
 * Улицы ищет тот же `findStreets`, что и экран адреса при входе:
 * два разных поиска по одному дереву ГАР однажды разойдутся, и дом,
 * который находится при регистрации, не найдётся в подборе.
 */

export function splitQuery(q: string): { street: string; number: string | null } {
  const text = q.trim().replace(/\s+/g, ' ');
  const m = /^(.*?)[\s,]+(?:д\.?\s*|дом\s+)?(\d+[а-яё]?(?:\s*(?:к|корп)\.?\s*\d+)?)$/iu.exec(text);
  if (!m || !m[1].replace(/[,\s]/g, '')) return { street: text, number: null };
  return { street: m[1].replace(/[,\s]+$/, ''), number: m[2] };
}

/** «85 к3», «85к3», «85 корп. 3» — одно и то же */
const normNumber = (s: string) => s.toUpperCase().replace(/Ё/g, 'Е').replace(/КОРП/g, 'К').replace(/[\s.]/g, '');

export interface SearchHouse { houseKey: string; address: string; lat: number | null; lon: number | null }
export interface SearchStreet { guid: string; label: string; bbox: Bbox | null }

export async function searchPick(db: Database, q: string): Promise<{ houses: SearchHouse[]; streets: SearchStreet[] }> {
  const { street, number } = splitQuery(q);
  if (street.length < 2) return { houses: [], streets: [] };

  const regions = await loadedRegions(db);
  const streets = (await Promise.all(regions.map((r) => findStreets(db, r.code, street, 5)))).flat().slice(0, 5);
  if (streets.length === 0) return { houses: [], streets: [] };

  let houses: SearchHouse[] = [];
  if (number) {
    const wanted = normNumber(number);
    const hits: { houseKey: string; address: string; exact: boolean }[] = [];
    for (const s of streets) {
      for (const h of await housesOnStreet(db, s.code)) {
        const n = normNumber(h.number);
        if (n.startsWith(wanted)) hits.push({ houseKey: h.houseKey, address: h.address, exact: n === wanted });
      }
    }
    hits.sort((a, b) => Number(b.exact) - Number(a.exact));

    const keys = hits.map((h) => h.houseKey);
    const rows = keys.length
      ? await db.select({
          houseKey: house.houseKey, lat: house.lat, lon: house.lon,
          houseKind: house.houseKind, garMkd: house.garMkd, flatCount: house.flatCount,
          garFlats: house.garFlats, registryForm: house.registryForm, form: house.form,
        }).from(house).where(inArray(house.houseKey, keys))
      : [];
    const byKey = new Map(rows.map((r) => [r.houseKey, r]));
    houses = hits
      .filter((h) => { const r = byKey.get(h.houseKey); return Boolean(r && isPickerHouse(r)); })
      .slice(0, 8)
      .map((h) => ({ houseKey: h.houseKey, address: h.address, lat: byKey.get(h.houseKey)!.lat, lon: byKey.get(h.houseKey)!.lon }));
  }

  const boxes = await db
    .select({
      guid: house.streetGuid,
      south: min(house.lat), north: max(house.lat), west: min(house.lon), east: max(house.lon),
    })
    .from(house)
    .where(and(inArray(house.streetGuid, streets.map((s) => s.code)), isNotNull(house.lat)))
    .groupBy(house.streetGuid);

  return {
    houses,
    streets: streets.map((s) => {
      const b = boxes.find((x) => x.guid === s.code);
      return {
        guid: s.code,
        label: s.label,
        bbox: b && b.south !== null ? { south: b.south, north: b.north!, west: b.west!, east: b.east! } : null,
      };
    }),
  };
}
