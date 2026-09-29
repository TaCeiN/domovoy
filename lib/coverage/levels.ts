import { sql } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';

/**
 * Покрытие домов — как зона покрытия у сотового оператора.
 *
 * «Подключённый» дом — не тот, где уже есть жители, а тот, про который
 * у нас достаточно данных, чтобы прийти и договориться: известно, кто им
 * управляет, и как с этой организацией связаться.
 *
 *   address  ⚪ только адрес из ГАР
 *   kind     🟡 известен тип дома или способ управления, контакта нет
 *   contact  🟢 организация с ИНН и хотя бы телефоном, почтой или сайтом
 *   agreed   🔵 у дома есть председатель или у организации — кабинет
 *
 * Частный сектор меряется отдельно: договариваться там не с кем
 * по определению, и в проценты покрытия многоквартирных домов он
 * не входит. «Вероятно частный» — только метка карты: правило частного
 * дома выдаёт права, и гадание туда не попадает никогда.
 */

export type CoverageLevel = 'address' | 'kind' | 'contact' | 'agreed';

export interface CoverageInput {
  registryForm: string | null;
  /** Форма, записанная человеком (оператором, правилом частного дома) */
  humanForm: string;
  houseKind: string | null;
  garFlats: number | null;
  flatCount: number | null;
  /** ФНС пометила дом многоквартирным */
  garMkd: boolean | null;
  orgInn: string | null;
  orgHasContact: boolean;
  orgHasCabinet: boolean;
  hasChairman: boolean;
}

export interface Coverage {
  level: CoverageLevel;
  /** Частный по реестру или по решению оператора */
  isPrivate: boolean;
  /** Ни фонд, ни ГАР не знают о квартирах — скорее всего частный дом */
  privateLikely: boolean;
}

export function coverageOf(house: CoverageInput): Coverage {
  const isPrivate = house.registryForm === 'private' || house.humanForm === 'private';
  const knownKind = Boolean(house.houseKind)
    || (house.registryForm !== null && house.registryForm !== 'unknown')
    || house.humanForm !== 'unknown'
    || house.garMkd === true
    || (house.garFlats ?? 0) > 0;

  let level: CoverageLevel = 'address';
  if (house.hasChairman || (house.orgInn && house.orgHasCabinet)) level = 'agreed';
  else if (house.orgInn && house.orgHasContact) level = 'contact';
  else if (knownKind || house.registryForm !== null) level = 'kind';

  const privateLikely = !isPrivate
    && house.garMkd !== true
    && !house.houseKind
    && house.registryForm === null
    && (house.garFlats ?? 0) === 0
    && house.flatCount === null
    && level === 'address';

  return { level, isPrivate, privateLikely };
}

export interface CoverageRow extends CoverageInput {
  houseKey: string;
  address: string;
  lat: number | null;
  lon: number | null;
  residents: number;
}

/**
 * Дома региона со всем, что нужно для уровня, одним запросом.
 *
 * Организация дома — реестровая, а если её нет, то записанная оператором.
 * Жители — подтверждённые привязки к квартирам дома.
 */
export async function coverageRows(db: Database, regionCode: string): Promise<CoverageRow[]> {
  const result = await db.execute(sql`
    with residents as (
      select p.house_key, count(*)::int as n
        from user_property up
        join property p on p.id = up.property_id
       where up.status = 'active'
       group by p.house_key
    ),
    chairs as (
      select distinct house_key from chairman where revoked_at is null
    ),
    cabinets as (
      select distinct org_id from dispatcher
    )
    select h.house_key as "houseKey", h.address_raw as address, h.lat, h.lon,
           h.registry_form as "registryForm", h.form as "humanForm", h.house_kind as "houseKind",
           h.gar_flats as "garFlats", h.flat_count as "flatCount", h.gar_mkd as "garMkd",
           mo.inn as "orgInn",
           (mo.phone is not null or mo.email is not null or mo.site is not null) as "orgHasContact",
           (cab.org_id is not null) as "orgHasCabinet",
           (ch.house_key is not null) as "hasChairman",
           coalesce(r.n, 0) as residents
      from house h
      left join managing_org mo on mo.id = coalesce(h.registry_org_id, h.org_id)
      left join cabinets cab on cab.org_id = mo.id
      left join chairs ch on ch.house_key = h.house_key
      left join residents r on r.house_key = h.house_key
     where h.region_code = ${regionCode} and h.address_raw is not null`);

  return (result.rows as unknown as (CoverageRow & { orgHasContact: boolean | null })[]).map((row) => ({
    ...row,
    orgHasContact: row.orgHasContact === true,
  }));
}
