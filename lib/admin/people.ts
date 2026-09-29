import { desc, eq, ilike, or, sql } from 'drizzle-orm';
import {
  appUser, dispatcher, house, managingOrg, property, userProperty,
} from '../../db/schema.ts';
import { SEARCH_LIMIT, type SearchResult } from './houses.ts';
import type { Database } from '../../db/client.ts';

/**
 * Жители и организации глазами оператора.
 *
 * Здесь только поиск и карточка: закрытие доступа живёт отдельно
 * в `revoke.ts`, потому что у него своё правило — оператору можно
 * то, чего нельзя жителям.
 */

export interface UserRow {
  id: string;
  name: string;
  viaMax: boolean;
  phone: string | null;
  properties: number;
}

export async function searchUsers(
  db: Database,
  q: string,
  limit = SEARCH_LIMIT,
): Promise<SearchResult<UserRow>> {
  const pattern = `%${q}%`;
  const match = or(ilike(appUser.fullName, pattern), ilike(appUser.phone, pattern));

  const rows = await db
    .select({
      id: appUser.id,
      name: appUser.fullName,
      maxUserId: appUser.maxUserId,
      phone: appUser.phone,
    })
    .from(appUser)
    .where(match)
    .limit(limit);

  const out: UserRow[] = [];
  for (const row of rows) {
    const [counted] = await db
      .select({ n: sql<number>`count(*)` })
      .from(userProperty)
      .where(eq(userProperty.userId, row.id));

    out.push({
      id: row.id,
      name: row.name ?? 'без имени',
      viaMax: row.maxUserId !== null,
      phone: row.phone,
      properties: Number(counted?.n ?? 0),
    });
  }

  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(appUser)
    .where(match);

  return { rows: out, total: Number(total?.n ?? out.length), limit };
}

/**
 * Карточка человека: его квартиры и что с ними.
 *
 * Обращений здесь нет намеренно: они принадлежат КВАРТИРЕ, а не
 * человеку, и смотреть их оператор ходит в карточку дома. Иначе
 * пришлось бы решать, показывать ли ему чужие жалобы по тем же
 * квартирам — вопрос, которого лучше не заводить.
 */
export async function userCard(db: Database, userId: string) {
  const [person] = await db
    .select({
      id: appUser.id,
      name: appUser.fullName,
      maxUserId: appUser.maxUserId,
      phone: appUser.phone,
      phoneVerifiedAt: appUser.phoneVerifiedAt,
      createdAt: appUser.createdAt,
    })
    .from(appUser)
    .where(eq(appUser.id, userId))
    .limit(1);

  if (!person) return null;

  const bindings = await db
    .select({
      bindingId: userProperty.id,
      propertyId: userProperty.propertyId,
      address: property.addressRaw,
      houseKey: property.houseKey,
      flat: property.flat,
      role: userProperty.role,
      status: userProperty.status,
      rejectReason: userProperty.rejectReason,
      claimName: userProperty.claimName,
      createdAt: userProperty.createdAt,
    })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .where(eq(userProperty.userId, userId))
    .orderBy(desc(userProperty.createdAt));

  return {
    id: person.id,
    name: person.name ?? 'без имени',
    viaMax: person.maxUserId !== null,
    phone: person.phone,
    phoneVerified: person.phoneVerifiedAt !== null,
    createdAt: person.createdAt,
    bindings,
  };
}

export interface OrgRow {
  id: string;
  name: string;
  inn: string;
  licenseNumber: string | null;
  houses: number;
  dispatcherLogin: string | null;
}

export async function searchOrgs(
  db: Database,
  q: string,
  limit = SEARCH_LIMIT,
): Promise<SearchResult<OrgRow>> {
  const pattern = `%${q}%`;
  const match = or(
    ilike(managingOrg.name, pattern),
    ilike(managingOrg.shortName, pattern),
    ilike(managingOrg.inn, pattern),
  );

  const rows = await db
    .select({
      id: managingOrg.id,
      name: managingOrg.name,
      shortName: managingOrg.shortName,
      inn: managingOrg.inn,
      licenseNumber: managingOrg.licenseNumber,
    })
    .from(managingOrg)
    .where(match)
    .limit(limit);

  const out: OrgRow[] = [];
  for (const row of rows) {
    const [houses] = await db
      .select({ n: sql<number>`count(*)` })
      .from(house)
      .where(eq(house.registryOrgId, row.id));

    const [cabinet] = await db
      .select({ login: dispatcher.login })
      .from(dispatcher)
      .where(eq(dispatcher.orgId, row.id))
      .limit(1);

    out.push({
      id: row.id,
      name: row.shortName ?? row.name,
      inn: row.inn,
      licenseNumber: row.licenseNumber,
      houses: Number(houses?.n ?? 0),
      dispatcherLogin: cabinet?.login ?? null,
    });
  }

  const [total] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(managingOrg)
    .where(match);

  return { rows: out, total: Number(total?.n ?? out.length), limit };
}
