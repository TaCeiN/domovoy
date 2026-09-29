import { readGarTags } from './gar-xml.ts';

/**
 * Параметры домов ГАР: кадастровый номер и признак «Многоквартирный дом».
 *
 * ЗАЧЕМ ПРИЗНАК. ФНС сама помечает многоквартирные дома — 22 267 по
 * Ростовской области, больше, чем знает реестр фонда (15 924). Это знание
 * о типе дома из госреестра, а не гадание по числу квартир, и на нём можно
 * держать и уровни покрытия, и защиту правила частного дома.
 *
 * ЗАЧЕМ НОМЕР. По кадастровому номеру находится объект на кадастровой
 * карте; сейчас он только хранится.
 *
 * ПОЧЕМУ ПОТОКОМ. Файл параметров региона — 3,4 ГБ в распакованном виде
 * и однажды уже переполнил системный диск. Он читается прямо из архива,
 * а на диск ложится только выжимка на пару десятков мегабайт.
 */

/** Справочник PARAM_TYPES */
const CADASTRAL = '8';
const APARTMENT_BUILDING = '19';

export interface HouseParams {
  /** objectId дома → кадастровый номер */
  cadastral: Map<number, string>;
  /** objectId многоквартирных домов */
  mkd: Set<number>;
}

export async function readHouseParams(
  stream: AsyncIterable<Buffer | string>,
  today = new Date().toISOString().slice(0, 10),
): Promise<HouseParams> {
  const cadastral = new Map<number, string>();
  const mkd = new Set<number>();

  for await (const param of readGarTags(stream, 'PARAM')) {
    // Значение действует, пока не наступила дата окончания
    if (param.ENDDATE && param.ENDDATE <= today) continue;
    const objectId = Number(param.OBJECTID);
    if (param.TYPEID === CADASTRAL && param.VALUE) cadastral.set(objectId, param.VALUE);
    if (param.TYPEID === APARTMENT_BUILDING && param.VALUE === '1') mkd.add(objectId);
  }

  return { cadastral, mkd };
}

export function toJson(params: HouseParams): string {
  return JSON.stringify({ cadastral: [...params.cadastral], mkd: [...params.mkd] });
}

export function fromJson(text: string): HouseParams {
  const raw = JSON.parse(text) as { cadastral: [number, string][]; mkd: number[] };
  return { cadastral: new Map(raw.cadastral), mkd: new Set(raw.mkd) };
}
