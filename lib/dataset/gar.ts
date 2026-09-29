import { readGarTags } from './gar-xml.ts';

/**
 * Регион ГАР в памяти: адресные объекты, дома, их место в иерархии
 * и число квартир.
 *
 * ПОЧЕМУ ГАР. Это единственный источник, где есть ВСЕ дома: частный сектор,
 * ТСЖ, дома без всякого управления. Реестр ГИС ЖКХ знает многоквартирные
 * и часть жилых, OSM — то, что нарисовали волонтёры. У каждого дома ГАР
 * есть GUID ФИАС, и по нему дом сшивается с ГИС ЖКХ без сравнения текста.
 */

export type GarFileKind = 'ADDR_OBJ' | 'HOUSES' | 'APARTMENTS' | 'ADM_HIERARCHY';

export interface GarObject {
  objectId: number;
  guid: string;
  name: string;
  /** Как в ГАР: «г.», «ул», «тер. СНТ» — точка снимается при сборке адреса */
  type: string;
  level: number;
}

export interface GarHouse {
  objectId: number;
  guid: string;
  num: string;
  houseType: number;
  add1: string | null;
  addType1: number | null;
  add2: string | null;
  addType2: number | null;
}

export interface GarRegion {
  objects: Map<number, GarObject>;
  houses: GarHouse[];
  /** Предки дома от региона вниз, без самого дома */
  housePath: Map<number, number[]>;
  /** Предки адресного объекта, без самого объекта */
  objectPath: Map<number, number[]>;
  /** Число действующих квартир по objectId дома */
  flats: Map<number, number>;
  regionObjectId: number;
}

/**
 * Какие типы домов ГАР считаем жилыми строениями.
 *
 * 1 владение, 2 дом, 3 домовладение, 5 здание, 10 корпус, 14 объект
 * незавершённого строительства. Гаражи (4), строения (7), сооружения (8),
 * котельные и погреба — не жильё: житель с квитанцией на них не придёт,
 * а в списке домов они только путали бы поиск адреса.
 */
export const RESIDENTIAL_HOUSE_TYPES = new Set([1, 2, 3, 5, 10, 14]);

/** Тип помещения «квартира» в справочнике APARTMENT_TYPES */
const FLAT_TYPE = '2';

const isActual = (row: Record<string, string>) => row.ISACTUAL === '1' && row.ISACTIVE === '1';

const numberOrNull = (value: string | undefined) => (value ? Number(value) : null);

export async function readGarRegion(
  open: (kind: GarFileKind) => AsyncIterable<Buffer | string>,
): Promise<GarRegion> {
  const objects = new Map<number, GarObject>();
  let regionObjectId = 0;

  for await (const row of readGarTags(open('ADDR_OBJ'), 'OBJECT')) {
    if (!isActual(row)) continue;
    const object: GarObject = {
      objectId: Number(row.OBJECTID),
      guid: row.OBJECTGUID,
      name: row.NAME,
      type: row.TYPENAME,
      level: Number(row.LEVEL),
    };
    objects.set(object.objectId, object);
    if (object.level === 1) regionObjectId = object.objectId;
  }

  const houses: GarHouse[] = [];
  const houseIds = new Set<number>();

  for await (const row of readGarTags(open('HOUSES'), 'HOUSE')) {
    if (!isActual(row)) continue;
    const houseType = Number(row.HOUSETYPE);
    if (!RESIDENTIAL_HOUSE_TYPES.has(houseType)) continue;

    const objectId = Number(row.OBJECTID);
    houseIds.add(objectId);
    houses.push({
      objectId,
      guid: row.OBJECTGUID,
      num: row.HOUSENUM ?? '',
      houseType,
      add1: row.ADDNUM1 ?? null,
      addType1: numberOrNull(row.ADDTYPE1),
      add2: row.ADDNUM2 ?? null,
      addType2: numberOrNull(row.ADDTYPE2),
    });
  }

  const flatIds = new Set<number>();
  for await (const row of readGarTags(open('APARTMENTS'), 'APARTMENT')) {
    if (isActual(row) && row.APARTTYPE === FLAT_TYPE) flatIds.add(Number(row.OBJECTID));
  }

  const housePath = new Map<number, number[]>();
  const objectPath = new Map<number, number[]>();
  const flats = new Map<number, number>();

  /**
   * Иерархия — административная, а не муниципальная.
   *
   * Реестр ГИС ЖКХ и квитанции пишут «р-н Аксайский, г Аксай»: это
   * административное деление. Муниципальное дало бы «м.р-н Аксайский,
   * г.п. Аксайское» — таких адресов не печатает никто.
   */
  for await (const row of readGarTags(open('ADM_HIERARCHY'), 'ITEM')) {
    if (row.ISACTIVE !== '1') continue;
    const objectId = Number(row.OBJECTID);

    if (flatIds.has(objectId)) {
      const parent = Number(row.PARENTOBJID);
      flats.set(parent, (flats.get(parent) ?? 0) + 1);
      continue;
    }

    const isHouse = houseIds.has(objectId);
    if (!isHouse && !objects.has(objectId)) continue;

    const path = (row.PATH ?? '').split('.').map(Number);
    path.pop();
    (isHouse ? housePath : objectPath).set(objectId, path);
  }

  return { objects, houses, housePath, objectPath, flats, regionObjectId };
}
