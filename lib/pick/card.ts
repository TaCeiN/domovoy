import { and, eq, isNull } from 'drizzle-orm';
import { chairman, house, managingOrg, poi } from '../../db/schema.ts';
import { effectiveHouse, houseLayerColumns } from '../house/form.ts';
import { isPickerHouse } from './scope.ts';
import { complaintSummary, paymentSummary, type ComplaintSummary } from './stats.ts';
import { canReview, houseReviews, type PublicReview, type RatingSummary } from './reviews.ts';
import { nearby, type Near } from './houses.ts';
import { listingLinks, type Listing } from './links.ts';
import { isFavorite } from './favorites.ts';
import type { Database } from '../../db/client.ts';

/**
 * Карточка дома в подборе — всё, что мы честно знаем о доме, одним ответом.
 *
 * Внутреннюю жизнь дома (ленту, объявления, опросы, тексты обращений)
 * сюда не кладём: карточку видит посторонний человек из MAX.
 */

export interface PickCard {
  houseKey: string;
  address: string;
  lat: number | null;
  lon: number | null;
  passport: {
    builtYear: number | null; floors: number | null; flats: number | null;
    entrances: number | null; elevators: number | null; wallMaterial: string | null;
    gas: boolean | null; emergency: boolean | null;
  };
  management: { form: string; orgName: string | null; license: string | null; phone: string | null; hasChairman: boolean };
  complaints: ComplaintSummary;
  payment: number | null;
  reviews: PublicReview[];
  summary: RatingSummary;
  near: Near | null;
  listings: Listing[];
  favorite: boolean;
  canReview: boolean;
}

export async function pickCard(db: Database, houseKey: string, viewerId: string | null, now = new Date()): Promise<PickCard | null> {
  const [row] = await db
    .select({
      ...houseLayerColumns,
      houseKey: house.houseKey,
      address: house.addressRaw,
      regionCode: house.regionCode,
      lat: house.lat,
      lon: house.lon,
      houseKind: house.houseKind,
      flatCount: house.flatCount,
      builtYear: house.builtYear,
      floors: house.floors,
      entrances: house.entrances,
      elevators: house.elevators,
      wallMaterial: house.wallMaterial,
      gas: house.gas,
      emergency: house.emergency,
    })
    .from(house)
    .leftJoin(managingOrg, eq(managingOrg.id, house.registryOrgId))
    .where(eq(house.houseKey, houseKey))
    .limit(1);
  if (!row || !isPickerHouse(row)) return null;

  const effective = effectiveHouse(row);
  const [org] = effective.orgId
    ? await db.select({ name: managingOrg.name, shortName: managingOrg.shortName, license: managingOrg.licenseNumber, phone: managingOrg.phone })
        .from(managingOrg).where(eq(managingOrg.id, effective.orgId)).limit(1)
    : [];
  const [chair] = await db.select({ id: chairman.id }).from(chairman)
    .where(and(eq(chairman.houseKey, houseKey), isNull(chairman.revokedAt))).limit(1);

  /**
   * «Рядом» — только если точки региона вообще загружены. Набор, собранный
   * без OSM-точек, дал бы «дальше 1,5 км» у магазина, аптеки и школы разом:
   * это неправда — мы не знаем, что их нет, мы просто их не загружали.
   */
  const [anyPoi] = row.regionCode
    ? await db.select({ id: poi.id }).from(poi).where(eq(poi.regionCode, row.regionCode)).limit(1)
    : [];
  const at = anyPoi && row.lat !== null && row.lon !== null ? { lat: row.lat, lon: row.lon } : null;
  const [complaints, payment, { reviews, summary }, near, favorite, reviewer] = await Promise.all([
    complaintSummary(db, houseKey, now),
    paymentSummary(db, houseKey, now),
    houseReviews(db, houseKey, viewerId),
    at ? nearby(db, at) : Promise.resolve(null),
    isFavorite(db, viewerId, houseKey),
    viewerId ? canReview(db, viewerId, houseKey) : Promise.resolve(false),
  ]);

  return {
    houseKey,
    address: row.address ?? '',
    lat: row.lat,
    lon: row.lon,
    passport: {
      builtYear: row.builtYear, floors: row.floors, flats: row.flatCount ?? (row.garFlats || null),
      entrances: row.entrances, elevators: row.elevators, wallMaterial: row.wallMaterial,
      gas: row.gas, emergency: row.emergency,
    },
    management: {
      form: effective.form,
      orgName: org ? org.shortName ?? org.name : null,
      license: org?.license ?? null,
      phone: org?.phone ?? null,
      hasChairman: Boolean(chair),
    },
    complaints,
    payment,
    reviews,
    summary,
    near,
    listings: listingLinks(row.address ?? ''),
    favorite,
    canReview: reviewer,
  };
}
