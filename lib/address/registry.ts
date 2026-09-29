import { and, eq, inArray, isNotNull, like, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { region, addressObject, house } from '../../db/schema.ts';
import { searchName, parseAddress } from './normalize.ts';
import { addressWithFlat } from './pick-house.ts';
import type { Database } from '../../db/client.ts';

/**
 * Справочник адресов: поиск улицы и сборка адреса.
 *
 * Нужен там, где в квитанции адреса нет. По ГОСТ Р 56042-2014 поле
 * payerAddress необязательное, и расчётные центры его не печатают: в QR
 * остаются только реквизиты получателя и лицевой счёт. Восстановить по
 * такому счёту адрес нельзя ни по одной открытой базе — связка «лицевой
 * счёт → квартира» живёт только в биллинге получателя платежа. Поэтому
 * адрес выбирает сам житель, но выбирает из справочника, а не пишет
 * строкой: иначе соседи по одному дому напишут его пятью способами
 * и разойдутся по пяти разным «домам».
 */

/** Код субъекта РФ из ИНН юрлица: первые две цифры. */
export function regionCodeFromInn(inn: string | null | undefined): string | null {
  if (!inn || !/^\d{10}$|^\d{12}$/.test(inn)) return null;
  const code = inn.slice(0, 2);
  // 00 не бывает; 99 и 98 — межрегиональные инспекции, регион по ним не определить
  if (code === '00' || code === '99' || code === '98') return null;
  return code;
}

export interface RegionState {
  code: string;
  name: string | null;
  loaded: boolean;
  streetCount: number;
}

export async function regionState(db: Database, code: string | null): Promise<RegionState | null> {
  if (!code) return null;

  const rows = await db.select().from(region).where(eq(region.code, code)).limit(1);
  const found = rows[0];

  return {
    code,
    name: found?.name ?? null,
    loaded: found?.status === 'loaded',
    streetCount: found?.streetCount ?? 0,
  };
}

/** Регионы, справочник которых уже загружен, — их показываем в подсказке. */
export async function loadedRegions(db: Database) {
  const rows = await db.select().from(region).where(eq(region.status, 'loaded'));
  return rows.map((r) => ({ code: r.code, name: r.name, streetCount: r.streetCount }));
}

/**
 * Экранирование подстановочных знаков LIKE.
 *
 * Запрос улиц открыт без сессии, а `%` и `_` в нём не экранировались:
 * `?q=%` превращался в `LIKE '%%'`, то есть «все сорок тысяч улиц региона».
 * Инъекции тут нет — параметр биндится, — но перебор индекса без пользы
 * есть, и повторять его можно сколько угодно раз.
 *
 * Обратный слэш в Postgres — экранирующий символ LIKE по умолчанию,
 * отдельный ESCAPE не нужен.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export interface StreetHit {
  /** GUID ФИАС улицы; поле называется code, как при КЛАДР, — фронт не менялся */
  code: string;
  name: string;
  socr: string;
  placeName: string | null;
  placeSocr: string | null;
  postalCode: null;
  label: string;
}

/**
 * Поиск улицы внутри региона.
 *
 * Совпадение с начала названия, а не «где угодно внутри»: по запросу «лен»
 * человек ждёт Ленина и Ленинградскую, а не Молоденина.
 *
 * Улица — уровень 8 адресного дерева ГАР, а также планировочная структура
 * (7: СНТ, микрорайон, квартал): у садовых товариществ улиц часто нет.
 */
export async function findStreets(
  db: Database,
  regionCode: string,
  query: string,
  limit = 20,
): Promise<StreetHit[]> {
  const words = queryWords(query);
  if (words.join(' ').length < 2) return [];

  const place = alias(addressObject, 'place');

  /**
   * Запрос — улица и, может быть, пункт: «Садовая Аксай», «Аксай, Садовая».
   *
   * Раньше весь запрос искался началом названия улицы, и уточнить пункт
   * было нельзя: улиц «Садовая» в области десятки, в подсказку влезает
   * двадцать, и житель Аксая своей улицы не находил вовсе. Перебираем
   * границу между словами улицы и пункта в обе стороны.
   */
  const variants: SQL[] = [];
  const streetIs = (text: string) => like(addressObject.searchName, `${escapeLike(text)}%`);
  const placeIs = (text: string) => like(place.searchName, `${escapeLike(text)}%`);
  for (let k = 1; k <= words.length; k++) {
    const head = words.slice(0, k).join(' ');
    const tail = words.slice(k).join(' ');
    variants.push(tail ? and(streetIs(head), placeIs(tail))! : streetIs(head));
    if (tail) variants.push(and(placeIs(head), streetIs(tail))!);
  }

  const rows = await db
    .select({
      code: addressObject.guid,
      name: addressObject.name,
      socr: addressObject.type,
      placeName: place.name,
      placeSocr: place.type,
      placeLevel: place.level,
    })
    .from(addressObject)
    .leftJoin(place, eq(place.guid, addressObject.parentGuid))
    .where(and(
      eq(addressObject.regionCode, regionCode),
      inArray(addressObject.level, [7, 8]),
      or(...variants),
    ))
    /**
     * Города выше хуторов.
     *
     * По запросу «ленина» в Ростовской области находится под сотню улиц,
     * и почти в каждом хуторе есть своя. Без ранжирования человек из
     * Ростова-на-Дону листает полсотни посёлков до своего города. В ГАР
     * нет населения, но уровень и тип пункта различают город с хутором.
     */
    .orderBy(
      sql`case
            when ${place.level} = 5 then 0
            when ${place.type} in ('пгт', 'рп') then 1
            when ${place.type} in ('ст-ца', 'сл') then 2
            when ${place.level} = 6 then 3
            else 4
          end`,
      place.name,
      sql`length(${addressObject.name})`,
      addressObject.name,
    )
    .limit(limit);

  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    socr: r.socr,
    placeName: r.placeName,
    placeSocr: r.placeSocr,
    postalCode: null,
    label: [`${r.socr} ${r.name}`, r.placeName ? `${r.placeSocr} ${r.placeName}` : null].filter(Boolean).join(', '),
  }));
}

/** Типы улиц и пунктов, которые люди пишут в запросе, но которых нет в названии */
const TYPE_WORDS = new Set([
  'ул', 'улица', 'пр-кт', 'пр', 'просп', 'проспект', 'пер', 'переулок', 'пл', 'площадь',
  'б-р', 'бульвар', 'ш', 'шоссе', 'проезд', 'пр-д', 'наб', 'набережная', 'туп', 'тупик', 'мкр', 'микрорайон',
  'г', 'город', 'х', 'хутор', 'с', 'село', 'ст-ца', 'станица', 'п', 'пос', 'поселок', 'пгт', 'сл', 'слобода',
]);

/** Слова запроса без знаков препинания и слов-типов: «г. Аксай, ул. Садовая» → «аксай», «садовая» */
function queryWords(query: string): string[] {
  const words = searchName(query.replace(/[.,;]/g, ' ')).split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !TYPE_WORDS.has(w));
  // «Набережная» бывает и названием улицы: если кроме типов ничего нет, ищем как есть
  return meaningful.length ? meaningful : words;
}

export interface HouseHit {
  houseKey: string;
  /** Номер для показа: «85 к3», «15А» */
  number: string;
  address: string;
}

/**
 * Дома улицы — чтобы житель выбрал свой, а не вводил номер.
 *
 * Выбранный из списка дом даёт ровно тот ключ, что у соседей: номер
 * «85/3», набранный руками как «85 к3», больше не разводит дом надвое.
 */
export async function housesOnStreet(db: Database, streetGuid: string, limit = 2000): Promise<HouseHit[]> {
  const rows = await db
    .select({ houseKey: house.houseKey, address: house.addressRaw })
    .from(house)
    .where(and(eq(house.streetGuid, streetGuid), isNotNull(house.addressRaw)))
    .limit(limit);

  return rows
    .map((row) => {
      const parsed = parseAddress(row.address!);
      const number = [
        parsed.house?.toUpperCase(),
        parsed.block ? `к${parsed.block}` : null,
        parsed.building ? `стр${parsed.building}` : null,
      ].filter(Boolean).join(' ');
      return { houseKey: row.houseKey, number, address: row.address! };
    })
    .filter((row) => row.number)
    // Естественный порядок: 2, 10, 10А, а не 10, 10А, 2
    .sort((a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true }));
}

export type ComposeResult =
  | { ok: true; addressRaw: string }
  | { ok: false; reason: 'street_not_found' | 'bad_house' | 'house_not_found' };

/**
 * Что прислал житель: дом из списка или улицу с номером, набранным руками
 * («моего дома нет в списке» — новостройка, которой ещё нет в ГАР).
 *
 * Квартира необязательна: частный дом её не имеет вовсе.
 */
export type AddressInput =
  | { houseKey: string; flat?: string }
  | { streetCode: string; house: string; block?: string; building?: string; flat?: string };

/**
 * Собрать адрес так, чтобы ключ дома совпал с соседями.
 *
 * Дом из списка — его реестровое написание. Номер руками — адрес собирается
 * из адресного дерева тем же порядком, что у домов ГАР
 * (lib/dataset/gar-address.ts): субъект, район, пункт, улица, дом.
 */
export async function composeAddress(
  db: Database,
  input: AddressInput,
): Promise<ComposeResult> {
  const flat = (input.flat ?? '').trim();

  if ('houseKey' in input) {
    const [found] = await db
      .select({ address: house.addressRaw })
      .from(house)
      .where(and(eq(house.houseKey, input.houseKey), isNotNull(house.addressRaw)))
      .limit(1);
    if (!found?.address) return { ok: false, reason: 'house_not_found' };
    return { ok: true, addressRaw: addressWithFlat(found.address, flat || null) };
  }

  const houseNumber = input.house.trim();

  /**
   * Цифра в номере обязательна. Проверялась только непустота, и «д. abc»
   * проходило: разбор такой номер не понимал и молча выбрасывал, а ключ
   * считался из города с улицей — вся улица становилась одним домом.
   */
  if (!houseNumber || !/\d/.test(houseNumber)) return { ok: false, reason: 'bad_house' };

  // Цепочка от улицы до субъекта: дерево неглубокое, шесть уровней самое большее
  const chain: { type: string; name: string; level: number }[] = [];
  let guid: string | null = input.streetCode;
  for (let depth = 0; guid && depth < 10; depth++) {
    const [node] = await db
      .select({ type: addressObject.type, name: addressObject.name, level: addressObject.level, parent: addressObject.parentGuid })
      .from(addressObject)
      .where(eq(addressObject.guid, guid))
      .limit(1);
    if (!node) break;
    chain.unshift(node);
    guid = node.parent;
  }
  if (chain.length === 0 || ![7, 8].includes(chain[chain.length - 1].level)) {
    return { ok: false, reason: 'street_not_found' };
  }

  const parts = [
    ...chain.map((node) => `${node.type} ${node.name}`),
    `д. ${houseNumber}`,
    input.block?.trim() ? `к. ${input.block.trim()}` : null,
    input.building?.trim() ? `стр. ${input.building.trim()}` : null,
    flat ? `кв. ${flat}` : null,
  ].filter(Boolean);

  return { ok: true, addressRaw: parts.join(', ') };
}
