import { parseAddress } from '../address/normalize.ts';
import { scan } from './osm-pbf.mjs';

/**
 * Координаты домов из OpenStreetMap.
 *
 * ЗАЧЕМ. В ГАР нет координат: реестр знает, где дом в адресном дереве,
 * но не где он на земле. Карта покрытия без точек не карта. Геокодер
 * на миллион домов — те же часы с лимитами, от которых мы ушли; OSM
 * лежит файлом.
 *
 * КАК СОПОСТАВЛЯЕМ. Ключ «пункт, улица, номер» тем же `parseAddress`, что
 * и привязка жителя: он сам снимает тип пункта («г», «х», «ст-ца»),
 * понимает «улица Мира» и «Мира улица», «4к2» и «4, к. 2». Регион и район
 * в ключ не входят — OSM их не пишет. Совпадение принимается, только если
 * ключ единственный: в области несколько хуторов «Красный», и угадывать,
 * в каком из них «ул Мира, 1», нельзя.
 */

/**
 * Выжимки Geofabrik по федеральным округам.
 *
 * Меньше округа Geofabrik по России не режет (кроме Калининграда и Крыма).
 * Таблица меняется только при изменении деления страны на округа.
 */
const DISTRICTS: Record<string, string[]> = {
  'central-fed-district': ['31', '32', '33', '36', '37', '40', '44', '46', '48', '50', '57', '62', '67', '68', '69', '71', '76', '77'],
  'northwestern-fed-district': ['10', '11', '29', '35', '47', '51', '53', '60', '78', '83'],
  kaliningrad: ['39'],
  'south-fed-district': ['01', '08', '23', '30', '34', '61'],
  'crimean-fed-district': ['91', '92'],
  'north-caucasus-fed-district': ['05', '06', '07', '09', '15', '20', '26'],
  'volga-fed-district': ['02', '12', '13', '16', '18', '21', '43', '52', '56', '58', '59', '63', '64', '73'],
  'ural-fed-district': ['45', '66', '72', '74', '86', '89'],
  'siberian-fed-district': ['04', '17', '19', '22', '24', '38', '42', '54', '55', '70'],
  'far-eastern-fed-district': ['03', '14', '25', '27', '28', '41', '49', '65', '75', '79', '87'],
};

export const OSM_EXTRACTS: Record<string, string> = Object.fromEntries(
  Object.entries(DISTRICTS).flatMap(([district, codes]) =>
    codes.map((code) => [code, `https://download.geofabrik.de/russia/${district}-latest.osm.pbf`])),
);

/** Ключ сопоставления координат; `null`, если адрес не разбирается */
export function coordKey(place: string, street: string, house: string): string | null {
  if (!place.trim() || !street.trim() || !house.trim()) return null;
  return parseAddress(`${place}, ${street}, д. ${house}`).houseKey || null;
}

const lowerName = (s: string) => s.trim().toLowerCase().replace(/ё/g, 'е');

/**
 * Ключ здания OSM.
 *
 * Пункт — тег `addr:city`, а без него ближайший узел `place`: в сёлах тега
 * почти никогда нет. Пункт обязан быть известен ГАР региона — это отсекает
 * соседние области той же выжимки.
 */
export function osmBuildingKey(
  tags: Record<string, string>,
  nearestPlace: string | null,
  placeNames: Set<string>,
): string | null {
  const street = tags['addr:street'];
  const house = tags['addr:housenumber'];
  if (!street || !house) return null;

  const place = tags['addr:city'] ?? nearestPlace;
  if (!place || !placeNames.has(lowerName(place))) return null;

  // «137 с1», «4 к2» — сжатые формы OSM; разбор понимает «стр» и «корп»
  const expanded = house.replace(/(\d)\s*с\s*(\d)/iu, '$1 стр $2').replace(/(\d)\s*к\s*(\d)/iu, '$1 корп $2');
  return coordKey(place, street, expanded);
}

/** Сетка населённых пунктов: ближайший ищется по соседним клеткам, а не перебором всех */
export class PlaceGrid {
  cells = new Map<string, { name: string; lat: number; lon: number }[]>();
  static STEP = 0.1;
  /** Дальше ~30 км пункт уже не «ближайший», а чужой */
  static RADIUS = 3;

  constructor(places: { name: string; lat: number; lon: number }[]) {
    for (const place of places) {
      const key = this.key(place.lat, place.lon);
      const cell = this.cells.get(key);
      if (cell) cell.push(place); else this.cells.set(key, [place]);
    }
  }

  key(lat: number, lon: number): string {
    return `${Math.floor(lat / PlaceGrid.STEP)}:${Math.floor(lon / PlaceGrid.STEP)}`;
  }

  nearest(lat: number, lon: number): string | null {
    const y = Math.floor(lat / PlaceGrid.STEP);
    const x = Math.floor(lon / PlaceGrid.STEP);
    const kx = Math.cos((lat * Math.PI) / 180);
    let best: string | null = null;
    let bestDist = Infinity;

    for (let dy = -PlaceGrid.RADIUS; dy <= PlaceGrid.RADIUS; dy++) {
      for (let dx = -PlaceGrid.RADIUS; dx <= PlaceGrid.RADIUS; dx++) {
        for (const place of this.cells.get(`${y + dy}:${x + dx}`) ?? []) {
          const dist = (place.lat - lat) ** 2 + ((place.lon - lon) * kx) ** 2;
          if (dist < bestDist) { bestDist = dist; best = place.name; }
        }
      }
    }
    return best;
  }
}

export type PoiKind = 'shop' | 'pharmacy' | 'school' | 'kindergarten' | 'stop';

export interface OsmPoi { kind: PoiKind; name: string | null; lat: number; lon: number }

/**
 * Что рядом с домом — для карточки подбора дома.
 *
 * Магазин — только продуктовый: одежда и запчасти переезжающему
 * не ответят на вопрос «где купить хлеб».
 */
export function poiKind(tags: Record<string, string>): PoiKind | null {
  if (tags.shop === 'supermarket' || tags.shop === 'convenience') return 'shop';
  if (tags.amenity === 'pharmacy') return 'pharmacy';
  if (tags.amenity === 'school') return 'school';
  if (tags.amenity === 'kindergarten') return 'kindergarten';
  if (tags.highway === 'bus_stop' || tags.public_transport === 'platform') return 'stop';
  return null;
}

const PLACE_KINDS = new Set(['city', 'town', 'village', 'hamlet', 'isolated_dwelling', 'locality']);

/**
 * Здания с адресом из выжимки — только с единственным ключом, и точки
 * окружения для подбора дома.
 *
 * Позиция — первый узел контура: для точки на карте области центр
 * здания не нужен, а хранить все узлы округа нельзя — их десятки миллионов.
 * Проходов три, от конца файла к началу: отношения → ломаные → узлы.
 */
export async function scanOsm(
  pbfPath: string,
  placeNames: Set<string>,
): Promise<{ buildings: { key: string; lat: number; lon: number }[]; pois: OsmPoi[] }> {
  type Building = { tags: Record<string, string>; node: number };
  const buildings: Building[] = [];
  const firstWay = new Map<number, Building>();
  /** Точки-контуры (школа, супермаркет): позиция — первый узел, как у зданий */
  const poiWays: { kind: PoiKind; name: string | null; node: number }[] = [];
  const pois: OsmPoi[] = [];

  const addressed = (tags: Record<string, string> | null) =>
    Boolean(tags?.building && tags['addr:housenumber'] && tags['addr:street']);

  await scan(pbfPath, {
    onRelation(_id, tags, ways) {
      if (!addressed(tags) || ways.length === 0) return;
      const building = { tags, node: -1 };
      buildings.push(building);
      firstWay.set(ways[0], building);
    },
  });

  const wanted = new Set<number>();
  await scan(pbfPath, {
    onWay(id, tags, refs) {
      if (refs.length === 0) return;
      const owner = firstWay.get(id);
      if (owner) { owner.node = refs[0]; wanted.add(refs[0]); }
      const kind = tags ? poiKind(tags) : null;
      if (kind) { poiWays.push({ kind, name: tags.name ?? null, node: refs[0] }); wanted.add(refs[0]); }
      if (!addressed(tags)) return;
      buildings.push({ tags, node: refs[0] });
      wanted.add(refs[0]);
    },
  });

  const coords = new Map<number, [number, number]>();
  const places: { name: string; lat: number; lon: number }[] = [];
  await scan(pbfPath, {
    onNode(id, lat, lon, tags) {
      if (wanted.has(id)) coords.set(id, [lat, lon]);
      if (tags?.name && PLACE_KINDS.has(tags.place) && placeNames.has(lowerName(tags.name))) {
        places.push({ name: tags.name, lat, lon });
      }
      const kind = tags ? poiKind(tags) : null;
      if (kind) pois.push({ kind, name: tags!.name ?? null, lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) });
    },
  });

  for (const way of poiWays) {
    const at = coords.get(way.node);
    if (at) pois.push({ kind: way.kind, name: way.name, lat: Number(at[0].toFixed(6)), lon: Number(at[1].toFixed(6)) });
  }

  const grid = new PlaceGrid(places);
  const byKey = new Map<string, { key: string; lat: number; lon: number } | null>();

  for (const building of buildings) {
    const at = coords.get(building.node);
    if (!at) continue;
    const key = osmBuildingKey(building.tags, building.tags['addr:city'] ? null : grid.nearest(at[0], at[1]), placeNames);
    if (!key) continue;
    // Второе здание с тем же ключом делает ключ непригодным — отмечаем пустотой
    byKey.set(key, byKey.has(key) ? null : { key, lat: Number(at[0].toFixed(6)), lon: Number(at[1].toFixed(6)) });
  }

  return {
    buildings: [...byKey.values()].filter((v): v is { key: string; lat: number; lon: number } => v !== null),
    pois,
  };
}
