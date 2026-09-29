import { and, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { house, managingOrg, property } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { parseAddress, looseHouseKey } from '../address/normalize.ts';
import { regionCodeFromAddress } from '../address/region-code.ts';
import { shortenOrgName, type GisOrgInfo, type GisHouse } from '../address/gis.ts';
import type { Database } from '../../db/client.ts';

/**
 * Организация и её дома — точечно, по ИНН, в обход набора региона.
 *
 * Нужна команде `house:org` (db/house-admin.ts): оператор подключает ТСЖ
 * или ЖСК, которых в наборе нет или ещё нет. Раньше эти функции жили
 * в полном импорте реестра `db/registry-import.ts`; импорт заменён набором
 * данных, а точечное подключение осталось.
 *
 * Ключ дома считается тем же `parseAddress`, что и у квитанции и у набора:
 * разойдись нормализация — дом «есть в базе, но житель его не находит».
 */

/** Ключ дома по адресу; `null`, если адрес не разбирается */
export function houseKeyOf(address: string): string | null {
  return parseAddress(address).houseKey || null;
}

/**
 * Реестровый слой одного дома.
 *
 * Заблокированная организация дом за собой не забирает: у неё дома
 * в ГИС ЖКХ остаются, но управление могло уже перейти другой компании.
 * Поэтому она только заполняет пустоту, а действующая перезаписывает.
 */
export async function upsertRegistryHouse(
  db: Database,
  input: { orgId: string; active: boolean; licensed: boolean; house: GisHouse; fallbackRegion: string },
): Promise<{ ok: boolean }> {
  const houseKey = houseKeyOf(input.house.address);
  if (!houseKey) return { ok: false };

  const values = {
    houseKeyLoose: looseHouseKey(input.house.address) || null,
    regionCode: regionCodeFromAddress(parseAddress(input.house.address)) ?? input.fallbackRegion,
    addressRaw: input.house.address,
    gisHouseGuid: input.house.houseGuid,
    flatCount: input.house.flatCount,
    registryOrgId: input.orgId,
    registryForm: input.licensed ? 'uk' : 'unknown',
    importedAt: new Date(),
  };

  await db
    .insert(house)
    .values({ houseKey, ...values })
    .onConflictDoUpdate({
      target: house.houseKey,
      set: values,
      setWhere: input.active ? undefined : isNull(house.registryOrgId),
    });

  return { ok: true };
}

export async function upsertOrgAndHouses(
  db: Database,
  inn: string,
  org: GisOrgInfo,
  houses: GisHouse[],
): Promise<{ orgId: string; added: number; skipped: number }> {
  let regionCode = '00';
  for (const h of houses) {
    const code = regionCodeFromAddress(parseAddress(h.address));
    if (code) { regionCode = code; break; }
  }

  const name = org.name ?? inn;
  const shortName = org.shortName ?? shortenOrgName(name);

  const [row] = await db
    .insert(managingOrg)
    .values({
      id: newId('org'),
      inn,
      kpp: org.kpp ?? null,
      ogrn: org.ogrn ?? null,
      name,
      shortName,
      regionCode,
      gisOrgGuid: org.guid,
      gisStatus: org.status,
      houseCount: houses.length,
      importedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: managingOrg.inn,
      set: { name, shortName, gisOrgGuid: org.guid, gisStatus: org.status, houseCount: houses.length, importedAt: new Date() },
    })
    .returning({ id: managingOrg.id, licenseNumber: managingOrg.licenseNumber });

  const active = org.status === 'REGISTERED';
  let added = 0;
  let skipped = 0;

  for (const h of houses) {
    const result = await upsertRegistryHouse(db, {
      orgId: row.id, active, licensed: Boolean(row.licenseNumber), house: h, fallbackRegion: regionCode,
    });
    if (result.ok) added++; else skipped++;
  }

  return { orgId: row.id, added, skipped };
}

/**
 * Догон квартир жителей после загрузки набора.
 *
 * ЗАЧЕМ. Управляющая организация пишется в `property.managing_org_id`
 * ОДИН РАЗ — в момент привязки. Житель, который привязался, когда его дома
 * в реестре не было, остался бы без УК навсегда: квартира на реестр
 * не смотрит, у неё своя колонка.
 *
 * Квартиры НЕ удаляются и ключи у занятых квартир не меняются никогда —
 * это данные жителя; столкновения печатаются для человека.
 */
export async function catchUpProperties(db: Database): Promise<{ attached: number; byLoose: number; collided: number }> {
  let attached = 0;
  let byLoose = 0;
  let collided = 0;

  const linked = await db
    .select({ id: property.id, orgId: house.registryOrgId, current: property.managingOrgId })
    .from(property)
    .innerJoin(house, eq(house.houseKey, property.houseKey))
    .where(isNotNull(house.registryOrgId));

  for (const row of linked) {
    if (!row.orgId || row.current === row.orgId) continue;
    await db.update(property).set({ managingOrgId: row.orgId }).where(eq(property.id, row.id));
    attached++;
  }

  /**
   * Не нашлись строгим ключом — пробуем без региона. Совпадение
   * принимается, только если оно ЕДИНСТВЕННОЕ, как и при привязке
   * (lib/auth/bind.ts): иначе житель уехал бы в одноимённый дом
   * другого субъекта. Ключ квартиры при этом становится реестровым,
   * чтобы соседи с регионом и без сошлись в один дом.
   */
  const strays = await db
    .select({ id: property.id, addressRaw: property.addressRaw, flat: property.flat, houseKey: property.houseKey })
    .from(property)
    .leftJoin(house, eq(house.houseKey, property.houseKey))
    .where(or(isNull(house.houseKey), isNull(house.addressRaw)));

  for (const stray of strays) {
    const loose = looseHouseKey(stray.addressRaw);
    if (!loose) continue;

    const found = await db
      .select({ houseKey: house.houseKey, orgId: house.registryOrgId })
      .from(house)
      .where(and(eq(house.houseKeyLoose, loose), isNotNull(house.addressRaw)))
      .limit(2);
    if (found.length !== 1 || found[0].houseKey === stray.houseKey) continue;

    const [taken] = await db
      .select({ id: property.id })
      .from(property)
      .where(and(eq(property.houseKey, found[0].houseKey), eq(property.flat, stray.flat)));
    if (taken) {
      collided++;
      console.log(`  та же квартира уже есть под реестровым ключом: ${stray.addressRaw}`);
      continue;
    }

    await db
      .update(property)
      .set({ houseKey: found[0].houseKey, ...(found[0].orgId ? { managingOrgId: found[0].orgId } : {}) })
      .where(eq(property.id, stray.id));
    byLoose++;
  }

  return { attached, byLoose, collided };
}
