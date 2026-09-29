import { parseAddress, looseHouseKey, searchName } from '../address/normalize.ts';
import { shortenOrgName } from '../address/gis.ts';
import { garHouseAddress } from './gar-address.ts';
import { registryFormOf, type FrtHouse, type FrtOrg, type HouseKind, type RegistryForm } from './frt.ts';
import { coordKey, type PoiKind } from './osm.ts';
import type { GarHouse, GarObject, GarRegion } from './gar.ts';
import type { HouseParams } from './gar-params.ts';

export type { RegistryForm } from './frt.ts';

/**
 * Сведение источников в строки набора — чистая функция, без сети и базы.
 *
 * ПОРЯДОК ДОВЕРИЯ:
 * - список домов, адресное дерево и GUID ФИАС — из ГАР: там есть все дома;
 * - тип дома, организация и её контакты — из реестра фонда (ФРТ);
 * - лицензия — из реестра лицензий ГИС ЖКХ;
 * - координаты — из OSM, и только они.
 *
 * СШИВКА — ПО GUID ФИАС. Запасной путь — «пункт, улица, номер» без района:
 * фонд пишет адрес без района, а ГАР с районом, и полный ключ у них
 * не совпал бы никогда.
 */

export interface DatasetObject {
  guid: string;
  regionCode: string;
  parentGuid: string | null;
  level: number;
  type: string;
  name: string;
  searchName: string;
}

export interface DatasetOrg {
  inn: string;
  kpp: string | null;
  ogrn: string | null;
  name: string;
  shortName: string;
  phone: string | null;
  email: string | null;
  site: string | null;
  frtId: string | null;
  gisOrgGuid: string | null;
  gisStatus: string | null;
  licenseNumber: string | null;
  licenseStatus: string | null;
  houseCount: number;
}

export interface DatasetHouse {
  houseKey: string;
  houseKeyLoose: string | null;
  fiasGuid: string | null;
  addressRaw: string;
  regionCode: string;
  streetGuid: string | null;
  houseKind: HouseKind | null;
  /** ФНС пометила дом многоквартирным (параметр ГАР 19) */
  garMkd: boolean;
  cadastralNumber: string | null;
  gisHouseGuid: string | null;
  flatCount: number | null;
  garFlats: number;
  /** Пусто — дома нет в реестре фонда, реестр о нём молчит */
  registryForm: RegistryForm | null;
  orgInn: string | null;
  lat: number | null;
  lon: number | null;
  /**
   * Паспорт дома из реестра фонда. Необязательные: наборы, собранные
   * до подбора дома, их не несут, и формат из-за этого не меняется.
   */
  builtYear?: number | null;
  floors?: number | null;
  entrances?: number | null;
  elevators?: number | null;
  wallMaterial?: string | null;
  gas?: boolean | null;
  emergency?: boolean | null;
}

/** Точка окружения: магазин, аптека, школа, детсад, остановка */
export interface DatasetPoi {
  kind: PoiKind;
  name: string | null;
  lat: number;
  lon: number;
}

export interface License { number: string | null; status: string | null; phone: string | null }

export interface MergeInput {
  regionCode: string;
  gar: GarRegion;
  frtHouses: FrtHouse[];
  frtOrgs: FrtOrg[];
  /** По ИНН */
  licenses: Map<string, License>;
  osm: { key: string; lat: number; lon: number }[];
  /** Параметры домов ГАР; без них признак МКД и кадастровый номер пусты */
  params?: HouseParams;
}

export interface MergeReport {
  objects: number;
  garHouses: number;
  frtHouses: number;
  byGuid: number;
  byKey: number;
  addedFromFrt: number;
  keyCollisions: number;
  orgs: number;
  forms: Record<RegistryForm | 'none', number>;
  withCoords: number;
  /** Координаты, отброшенные как чужие: здание тёзки из соседней области */
  coordsDropped: number;
  garMkd: number;
  houses: number;
}

/** Уровни административного деления, из которых строится дерево */
const TREE_LEVELS = new Set([1, 2, 5, 6, 7, 8]);

const typeWithoutDot = (type: string) => type.trim().replace(/\.$/, '');

/** Номер дома ГАР словами: «2, к. 1» */
function garNumber(house: GarHouse): string {
  const add = (value: string | null, type: number | null) =>
    value && type ? `, ${type === 2 ? 'стр.' : type === 3 ? 'соор.' : 'к.'} ${value}` : '';
  return `${house.num}${add(house.add1, house.addType1)}${add(house.add2, house.addType2)}`;
}

interface Row {
  objectId: number | null;
  fiasGuid: string | null;
  address: string;
  streetGuid: string | null;
  garFlats: number;
  coordKey: string | null;
  /** Населённый пункт и муниципальный район дома — для отсева чужих координат */
  placeGuid: string | null;
  districtGuid: string | null;
  frt: FrtHouse | null;
}

export function mergeDataset(input: MergeInput): {
  objects: DatasetObject[]; houses: DatasetHouse[]; orgs: DatasetOrg[]; report: MergeReport;
} {
  const { gar, regionCode } = input;
  const report: MergeReport = {
    objects: 0, garHouses: gar.houses.length, frtHouses: input.frtHouses.length,
    byGuid: 0, byKey: 0, addedFromFrt: 0, keyCollisions: 0, orgs: 0,
    forms: { uk: 0, tsj: 0, zhsk: 0, direct: 0, private: 0, unknown: 0, none: 0 },
    withCoords: 0, coordsDropped: 0, garMkd: 0, houses: 0,
  };

  /* ── адресное дерево ── */

  const inTree = (id: number) => {
    const object = gar.objects.get(id);
    return object && TREE_LEVELS.has(object.level) && (gar.objectPath.has(id) || id === gar.regionObjectId) ? object : null;
  };

  const objects: DatasetObject[] = [];
  for (const object of gar.objects.values()) {
    if (!inTree(object.objectId)) continue;
    const path = gar.objectPath.get(object.objectId) ?? [];
    let parentGuid: string | null = null;
    for (let i = path.length - 1; i >= 0; i--) {
      const parent = inTree(path[i]);
      if (parent) { parentGuid = parent.guid; break; }
    }
    objects.push({
      guid: object.guid, regionCode, parentGuid, level: object.level,
      type: typeWithoutDot(object.type), name: object.name, searchName: searchName(object.name),
    });
  }
  report.objects = objects.length;

  /* ── дома ГАР ── */

  const rows: Row[] = [];
  const byGuid = new Map<string, Row>();
  const byCoordKey = new Map<string, Row[]>();

  for (const house of gar.houses) {
    const chain = (gar.housePath.get(house.objectId) ?? [])
      .map((id) => gar.objects.get(id))
      .filter((o): o is GarObject => Boolean(o));
    if (chain.length === 0) continue;

    const nearest = (levels: number[]) => [...chain].reverse().find((o) => levels.includes(o.level)) ?? null;
    const street = nearest([8, 7]);
    const place = nearest([6, 5]);

    const row: Row = {
      objectId: house.objectId,
      fiasGuid: house.guid.toLowerCase(),
      address: garHouseAddress(chain, house),
      streetGuid: (street ?? place)?.guid ?? null,
      garFlats: gar.flats.get(house.objectId) ?? 0,
      coordKey: place && street ? coordKey(place.name, `${typeWithoutDot(street.type)} ${street.name}`, garNumber(house)) : null,
      placeGuid: place?.guid ?? null,
      districtGuid: nearest([2])?.guid ?? null,
      frt: null,
    };
    rows.push(row);
    byGuid.set(row.fiasGuid!, row);
    if (row.coordKey) {
      const list = byCoordKey.get(row.coordKey);
      if (list) list.push(row); else byCoordKey.set(row.coordKey, [row]);
    }
  }

  /* ── дома фонда ── */

  for (const frt of input.frtHouses) {
    let row = byGuid.get(frt.fiasGuid);
    if (row && !row.frt) {
      report.byGuid++;
    } else {
      const key = coordKey(frt.place, frt.street, frt.number);
      const candidates = key ? (byCoordKey.get(key) ?? []).filter((r) => !r.frt) : [];
      // Запасной путь — только при единственном кандидате: угадывать дом нельзя
      row = candidates.length === 1 ? candidates[0] : undefined;
      if (row) report.byKey++;
    }

    if (!row) {
      row = { objectId: null, fiasGuid: null, address: frt.address, streetGuid: null, garFlats: 0, coordKey: null, placeGuid: null, districtGuid: null, frt: null };
      rows.push(row);
      report.addedFromFrt++;
    }
    row.frt = frt;
  }

  /* ── организации ── */

  const orgByFrtId = new Map<string, FrtOrg>();
  const orgs = new Map<string, DatasetOrg>();
  for (const org of input.frtOrgs) {
    orgByFrtId.set(org.frtId, org);
    if (orgs.has(org.inn)) continue;
    const license = input.licenses.get(org.inn);
    orgs.set(org.inn, {
      inn: org.inn,
      kpp: null,
      ogrn: org.ogrn,
      name: org.name,
      shortName: org.shortName ?? shortenOrgName(org.name),
      phone: org.phone ?? license?.phone ?? null,
      email: org.email,
      site: org.site,
      frtId: org.frtId,
      gisOrgGuid: null,
      gisStatus: null,
      licenseNumber: license?.number ?? null,
      licenseStatus: license?.status ?? null,
      houseCount: 0,
    });
  }
  report.orgs = orgs.size;

  /* ── строки домов ── */

  const osm = new Map(input.osm.map((p) => [p.key, p]));
  const chosen = new Map<string, DatasetHouse & { rank: number; placeGuid: string | null; districtGuid: string | null }>();

  for (const row of rows) {
    const houseKey = parseAddress(row.address).houseKey;
    if (!houseKey) continue;

    const org = row.frt?.orgFrtId ? orgByFrtId.get(row.frt.orgFrtId) ?? null : null;
    const point = row.coordKey ? osm.get(row.coordKey) : undefined;

    const house: DatasetHouse & { rank: number; placeGuid: string | null; districtGuid: string | null } = {
      houseKey,
      houseKeyLoose: looseHouseKey(row.address) || null,
      fiasGuid: row.fiasGuid,
      addressRaw: row.address,
      regionCode,
      streetGuid: row.streetGuid,
      houseKind: row.frt?.kind ?? null,
      garMkd: row.objectId !== null && Boolean(input.params?.mkd.has(row.objectId)),
      cadastralNumber: row.objectId !== null ? input.params?.cadastral.get(row.objectId) ?? null : null,
      gisHouseGuid: null,
      flatCount: row.frt?.flats ?? null,
      garFlats: row.garFlats,
      registryForm: row.frt ? registryFormOf(org, Boolean(org && input.licenses.get(org.inn)?.number), row.frt.kind) : null,
      orgInn: org?.inn ?? null,
      lat: point?.lat ?? null,
      lon: point?.lon ?? null,
      builtYear: row.frt?.builtYear ?? null,
      floors: row.frt?.floors ?? null,
      entrances: row.frt?.entrances ?? null,
      elevators: row.frt?.elevators ?? null,
      wallMaterial: row.frt?.wallMaterial ?? null,
      gas: row.frt?.gas ?? null,
      emergency: row.frt?.emergency ?? null,
      // Кто остаётся при одинаковом ключе: сшитый с фондом, помеченный МКД, затем с квартирами
      placeGuid: row.placeGuid,
      districtGuid: row.districtGuid,
      rank: (row.frt ? 2_000_000 : 0) + (row.objectId !== null && input.params?.mkd.has(row.objectId) ? 1_000_000 : 0) + row.garFlats,
    };

    /**
     * Один ключ — один дом: на ключе стоит уникальность таблицы.
     * Два дома ГАР дают один ключ, когда «85/3» и «85, к. 3» — одно здание
     * или после переименования улицы остался дубль.
     */
    const current = chosen.get(houseKey);
    if (current) {
      report.keyCollisions++;
      if (house.rank <= current.rank) continue;
    }
    chosen.set(houseKey, house);
  }

  dropForeignCoords([...chosen.values()], report);

  const houses: DatasetHouse[] = [];
  for (const { rank: _rank, placeGuid: _place, districtGuid: _district, ...house } of chosen.values()) {
    if (house.orgInn) {
      const org = orgs.get(house.orgInn);
      if (org) org.houseCount++;
    }
    if (house.lat !== null) report.withCoords++;
    if (house.garMkd) report.garMkd++;
    report.forms[house.registryForm ?? 'none']++;
    houses.push(house);
  }
  report.houses = houses.length;

  return { objects, houses, orgs: [...orgs.values()], report };
}

/** Дальше этого от середины своего пункта дом стоять не может: это не тот пункт */
const MAX_KM_FROM_PLACE = 25;
/** Самые протяжённые районы области — около сотни километров из конца в конец */
const MAX_KM_FROM_DISTRICT = 90;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

interface Located { lat: number | null; lon: number | null; placeGuid: string | null; districtGuid: string | null }

/**
 * Отсев координат, попавших в чужой населённый пункт.
 *
 * Ключ «пункт, улица, номер» не знает региона: выжимка OSM — целый
 * федеральный округ, и «х Красный, ул Мира, 1» есть и у нас, и в соседней
 * области. Если у нашего хутора здание нашлось только там, дом получал
 * точку за сотню километров. Середина группы — медиана её точек: одна
 * чужая точка её не сдвигает, а сама оказывается далеко от неё.
 *
 * Два прохода. Сначала район: у хутора все здания могут оказаться
 * чужими, и тогда медиана пункта сама чужая, — а район из десятков
 * пунктов в основном свой. Потом пункт, уже на очищенных точках.
 * Город областного значения района не имеет и сверяется только с собой:
 * точек у него тысячи, и чужие в меньшинстве.
 */
function dropForeignCoords(houses: Located[], report: MergeReport): void {
  dropFar(houses, (h) => h.districtGuid, MAX_KM_FROM_DISTRICT, report);
  dropFar(houses, (h) => h.placeGuid, MAX_KM_FROM_PLACE, report);
}

function dropFar(houses: Located[], groupOf: (h: Located) => string | null, maxKm: number, report: MergeReport): void {
  const groups = new Map<string, Located[]>();
  for (const house of houses) {
    const group = groupOf(house);
    if (house.lat === null || !group) continue;
    const list = groups.get(group);
    if (list) list.push(house); else groups.set(group, [house]);
  }

  for (const list of groups.values()) {
    const lat = median(list.map((h) => h.lat!));
    const lon = median(list.map((h) => h.lon!));
    const kx = Math.cos((lat * Math.PI) / 180) * 111;
    for (const house of list) {
      const km = Math.hypot((house.lat! - lat) * 111, (house.lon! - lon) * kx);
      if (km > maxKm) {
        house.lat = null;
        house.lon = null;
        report.coordsDropped++;
      }
    }
  }
}
