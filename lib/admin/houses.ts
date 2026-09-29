import { and, desc, eq, ilike, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  appUser, chairman, house, houseClaim, managingOrg, property, userProperty,
} from '../../db/schema.ts';
import { houseState, FORM_LABEL, type HouseForm } from '../house/form.ts';
import { listForHouse } from '../requests/service.ts';
import { coverageOf, type Coverage } from '../coverage/levels.ts';
import type { Database } from '../../db/client.ts';
import { reviewsForAdmin } from '../pick/reviews.ts';
import { contactKinds, listContacts } from '../house/contacts.ts';

/**
 * Дома глазами оператора.
 *
 * Отличие от всех остальных взглядов в проекте: оператор ищет дом,
 * о котором ещё ничего не известно. Диспетчер видит дома своей
 * организации, председатель — свой; у оператора точки отсчёта нет,
 * поэтому вход в раздел — поиск по адресу, а не список.
 */

export interface HouseRow {
  houseKey: string;
  address: string;
  form: HouseForm;
  formLabel: string;
  orgName: string | null;
  hasChairman: boolean;
  residents: number;
  openClaims: number;
}

/**
 * Ищем в ДВУХ местах: среди объектов жителей и среди домов реестра.
 *
 * Дом может быть известен только по одному из них: жители пришли,
 * а в реестре его нет (ТСЖ), — или наоборот, реестр знает дом, куда
 * ещё никто не заходил. Оператору нужны оба случая: первый — чтобы
 * подключить, второй — чтобы проверить.
 */
export const SEARCH_LIMIT = 50;

/**
 * Слова запроса — каждое ищется отдельно и все обязательны.
 *
 * Адрес в базе пишется с запятыми и сокращениями: «пр-кт Ленина, д. 85».
 * Поиск одной подстрокой «Ленина 85» его не находил, хотя поле поиска
 * подсказывает вводить именно так.
 */
export function searchWords(q: string): string[] {
  const words = q.split(/[\s,]+/)
    .map((w) => w.replace(/\.$/, '').replace(/[%_\\]/g, ''))
    .filter(Boolean);
  return words.length ? words : [q];
}

/**
 * Ответ поиска: строки и сколько их всего.
 *
 * ОБРЕЗАНИЕ ГОВОРИТСЯ ВСЛУХ. Раньше поиск отдавал полсотни строк и молчал
 * об остальных: оператор видел список и считал, что видит всё. Для дома,
 * записанного в базе двумя способами (проект знает эту беду —
 * `houseKeyCandidates`, `looseHouseKey`), это прямой путь к неверному
 * решению — не нашёл и завёл второй.
 */
export interface SearchResult<T> {
  rows: T[];
  total: number;
  limit: number;
}

/** Строка — в регулярку как есть: номер дома бывает «85/3» */
function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export async function searchHouses(
  db: Database,
  q: string,
  limit = SEARCH_LIMIT,
): Promise<SearchResult<HouseRow>> {
  const words = searchWords(q);
  const matches = (column: typeof property.addressRaw | typeof house.addressRaw): SQL =>
    and(...words.map((word) => ilike(column, `%${word}%`)))!;

  /**
   * Три запроса разом, а не по очереди, и сводки домов — тоже разом.
   * По очереди поиск по миллиону адресов шёл почти четыре секунды
   * с пустой кнопкой (аудит 26 сентября).
   */
  const [fromRegistry, fromProperties, counted] = await Promise.all([
    db.select({ houseKey: house.houseKey, address: house.addressRaw })
      .from(house)
      .where(matches(house.addressRaw))
      .limit(limit),
    db.select({ houseKey: property.houseKey, address: sql<string>`min(${property.addressRaw})` })
      .from(property)
      .where(matches(property.addressRaw))
      .groupBy(property.houseKey)
      .limit(limit),
    /**
     * Всего совпадений — по ОБЪЕДИНЕНИЮ ключей, а не по сумме двух
     * счётчиков: дом, известный и жителям, и реестру, иначе посчитался бы
     * дважды, и строка «показаны 50 из 137» соврала бы в другую сторону.
     */
    db.execute(sql`
      select count(*)::int as n from (
        select house_key from property where ${matches(property.addressRaw)}
        union
        select house_key from house where ${matches(house.addressRaw)}
      ) as found
    `),
  ]);

  /**
   * Подпись дома — из реестра, а не из квартиры.
   *
   * Квартиры шли первыми, и дом подписывался адресом первого жителя:
   * «…д. 85/3, кв. 23» в списке ДОМОВ. Реестр — первым; адрес из
   * квитанции без номера квартиры — запасной.
   */
  const byKey = new Map<string, string>();
  for (const row of fromRegistry) {
    if (row.address && !byKey.has(row.houseKey)) byKey.set(row.houseKey, row.address);
  }
  for (const row of fromProperties) {
    if (row.address && !byKey.has(row.houseKey)) {
      byKey.set(row.houseKey, row.address.replace(/,\s*кв\.?\s*[^,]+$/i, ''));
    }
  }

  const rows: HouseRow[] = await Promise.all([...byKey].slice(0, limit).map(
    async ([houseKey, address]) => ({ houseKey, address, ...(await houseSummaryOf(db, houseKey)) }),
  ));
  const total = Number(((counted.rows ?? counted)[0] as { n: number })?.n ?? rows.length);

  /**
   * Точный номер дома — наверх.
   *
   * По «Ленина 85» первыми шли «д. 85/24» и «д. 285» в других городах:
   * сортировка была по алфавиту. Теперь сначала дома, где номер совпал
   * целиком, потом дома с жителями, потом остальное по алфавиту.
   */
  const numbers = words.filter((w) => /^\d/.test(w));
  const exact = (address: string) => numbers.length > 0
    && numbers.every((n) => new RegExp(`д\\.?\\s*${escapeRe(n)}(,|$)`, 'i').test(address));

  return {
    rows: rows.sort((a, b) => Number(exact(b.address)) - Number(exact(a.address))
      || Number(b.residents > 0) - Number(a.residents > 0)
      || a.address.localeCompare(b.address, 'ru')),
    total,
    limit,
  };
}

async function houseSummaryOf(db: Database, houseKey: string) {
  const state = await houseState(db, houseKey);

  const [orgRow] = state.orgId
    ? await db
        .select({ name: managingOrg.name, shortName: managingOrg.shortName })
        .from(managingOrg)
        .where(eq(managingOrg.id, state.orgId))
        .limit(1)
    : [];

  const [counted] = await db
    .select({ n: sql<number>`count(*)` })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .where(eq(property.houseKey, houseKey));

  const [claims] = await db
    .select({ n: sql<number>`count(*)` })
    .from(houseClaim)
    .where(and(eq(houseClaim.houseKey, houseKey), eq(houseClaim.status, 'open')));

  return {
    form: state.form,
    formLabel: FORM_LABEL[state.form],
    orgName: orgRow ? (orgRow.shortName ?? orgRow.name) : null,
    hasChairman: state.hasChairman,
    residents: Number(counted?.n ?? 0),
    openClaims: Number(claims?.n ?? 0),
  };
}

/**
 * Карточка дома: всё, что оператору нужно, чтобы принять решение.
 *
 * Обращения здесь ТОЛЬКО НА ЧТЕНИЕ, и маршрутов их правки в кабинете
 * не существует: у жителя должно остаться доказательство, которое никто
 * не сотрёт, включая оператора.
 */
export async function houseCard(db: Database, houseKey: string) {
  const [addressRow] = await db
    .select({ address: property.addressRaw })
    .from(property)
    .where(eq(property.houseKey, houseKey))
    .limit(1);

  const [registryRow] = await db
    .select({ address: house.addressRaw })
    .from(house)
    .where(eq(house.houseKey, houseKey))
    .limit(1);

  const residents = await db
    .select({
      bindingId: userProperty.id,
      userId: userProperty.userId,
      name: appUser.fullName,
      claimName: userProperty.claimName,
      flat: property.flat,
      role: userProperty.role,
      status: userProperty.status,
      viaMax: appUser.maxUserId,
      phone: appUser.phone,
    })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .innerJoin(appUser, eq(userProperty.userId, appUser.id))
    .where(eq(property.houseKey, houseKey))
    .orderBy(property.flat);

  const [chair] = await db
    .select({
      id: chairman.id,
      name: chairman.name,
      flat: chairman.flat,
      createdAt: chairman.createdAt,
    })
    .from(chairman)
    .where(and(eq(chairman.houseKey, houseKey), isNull(chairman.revokedAt)))
    .limit(1);

  const claims = await db
    .select({
      id: houseClaim.id,
      userName: appUser.fullName,
      note: houseClaim.note,
      createdAt: houseClaim.createdAt,
    })
    .from(houseClaim)
    .innerJoin(appUser, eq(houseClaim.userId, appUser.id))
    .where(and(eq(houseClaim.houseKey, houseKey), eq(houseClaim.status, 'open')))
    .orderBy(desc(houseClaim.createdAt));

  const [own] = await db
    .select({ setBy: house.setBy, setAt: house.setAt, source: house.source })
    .from(house)
    .where(eq(house.houseKey, houseKey))
    .limit(1);

  const { registry, coverage } = await registryOf(db, houseKey, Boolean(chair));

  // `residents` в сводке — это ЧИСЛО, а в карточке СПИСОК. Разводим явно,
  // иначе одно тихо перекрывает другое, и тип у поля зависит от порядка ключей
  const { residents: _count, ...summary } = await houseSummaryOf(db, houseKey);

  const reviews = await reviewsForAdmin(db, houseKey);

  return {
    houseKey,
    reviews,
    // Адрес реестра — без квартиры; из квитанции жителя — только если дома в реестре нет
    address: registryRow?.address ?? addressRow?.address?.replace(/,\s*кв\.?\s*\S+$/i, '') ?? houseKey,
    ...summary,
    setBy: own?.setBy ?? null,
    setAt: own?.setAt ?? null,
    source: own?.source ?? null,
    chairman: chair ?? null,
    registry,
    coverage,
    residents: residents.map((r) => ({
      ...r,
      name: r.claimName?.trim() || r.name || 'без имени',
      viaMax: r.viaMax !== null,
    })),
    claims,
    requests: await listForHouse(db, houseKey),
    /** Телефоны дома — оператор правит их прямо в карточке */
    contacts: await listContacts(db, houseKey),
    contactKinds: contactKinds(),
  };
}

export interface HouseRegistry {
  form: string | null;
  kind: string | null;
  garMkd: boolean | null;
  garFlats: number | null;
  cadastralNumber: string | null;
  fiasGuid: string | null;
  lat: number | null;
  lon: number | null;
  org: {
    inn: string; name: string; phone: string | null; email: string | null; site: string | null;
    licenseNumber: string | null; hasCabinet: boolean;
  } | null;
}

/**
 * Что о доме знает реестр и какой у него уровень покрытия.
 *
 * Оператор открывает карточку, чтобы решить, как договориться с домом.
 * Для этого нужны не только жители, но и то, что собрал набор данных:
 * кто управляет, как с ним связаться, многоквартирный ли дом вообще.
 * Уровень считается той же функцией, что и карта покрытия.
 */
async function registryOf(
  db: Database,
  houseKey: string,
  hasChairman: boolean,
): Promise<{ registry: HouseRegistry | null; coverage: Coverage }> {
  const result = await db.execute(sql`
    select h.registry_form, h.form, h.house_kind, h.gar_mkd, h.gar_flats, h.flat_count,
           h.cadastral_number, h.fias_guid, h.lat, h.lon, h.address_raw,
           mo.inn, coalesce(mo.short_name, mo.name) as org_name, mo.phone, mo.email, mo.site, mo.license_number,
           exists (select 1 from dispatcher d where d.org_id = mo.id) as has_cabinet
      from house h
      left join managing_org mo on mo.id = coalesce(h.registry_org_id, h.org_id)
     where h.house_key = ${houseKey}
     limit 1`);
  const row = result.rows[0] as Record<string, unknown> | undefined;

  const org = row?.inn ? {
    inn: String(row.inn),
    name: String(row.org_name),
    phone: (row.phone as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    site: (row.site as string | null) ?? null,
    licenseNumber: (row.license_number as string | null) ?? null,
    hasCabinet: row.has_cabinet === true,
  } : null;

  const coverage = coverageOf({
    registryForm: (row?.registry_form as string | null) ?? null,
    humanForm: (row?.form as string | undefined) ?? 'unknown',
    houseKind: (row?.house_kind as string | null) ?? null,
    garFlats: (row?.gar_flats as number | null) ?? null,
    flatCount: (row?.flat_count as number | null) ?? null,
    garMkd: (row?.gar_mkd as boolean | null) ?? null,
    orgInn: org?.inn ?? null,
    orgHasContact: Boolean(org && (org.phone || org.email || org.site)),
    orgHasCabinet: org?.hasCabinet ?? false,
    hasChairman,
  });

  // Дом без адреса реестра — квартира жителя, которой в наборе нет
  if (!row || !row.address_raw) return { registry: null, coverage };

  return {
    coverage,
    registry: {
      form: (row.registry_form as string | null) ?? null,
      kind: (row.house_kind as string | null) ?? null,
      garMkd: (row.gar_mkd as boolean | null) ?? null,
      garFlats: (row.gar_flats as number | null) ?? null,
      cadastralNumber: (row.cadastral_number as string | null) ?? null,
      fiasGuid: (row.fias_guid as string | null) ?? null,
      lat: (row.lat as number | null) ?? null,
      lon: (row.lon as number | null) ?? null,
      org,
    },
  };
}
