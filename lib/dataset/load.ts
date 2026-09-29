import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { addressObject, house, managingOrg, poi, region } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { catchUpProperties } from './org.ts';
import { DEMO_HOUSE_KEY } from '../demo/constants.ts';
import type { Database } from '../../db/client.ts';
import type { DatasetManifest, DatasetRow } from './format.ts';

/**
 * Загрузка набора данных региона в базу.
 *
 * ЧТО МОЖНО ТРОГАТЬ, А ЧТО НЕТ:
 * - адресное дерево региона заменяется целиком — это чистый справочник;
 * - организация находится по ИНН и сохраняет свой `id`: к нему привязаны
 *   кабинеты УК и квартиры жителей;
 * - у дома пишется ТОЛЬКО реестровый слой. `form`, `org_id`, `source`,
 *   `multi_flat` — решения людей и автоматики приложения, их набор
 *   не отменяет (см. комментарий к таблице `house` в db/schema.ts);
 * - ключ уже известного дома не меняется: строка ищется сначала по GUID
 *   ФИАС, и если ключ из набора другой, реестровый слой пишется в старую
 *   строку. На ключе держатся квартиры, председатели и объявления;
 * - точки окружения региона (`poi`) заменяются целиком, но только если
 *   набор их несёт: старый набор без точек прежние не стирает;
 * - дом, которого в новом наборе нет, НЕ удаляется. Он теряет реестровую
 *   форму и организацию, но сохраняет адрес и продолжает находиться.
 *
 * Всё в одной транзакции: загрузка, оборванная на середине, не оставляет
 * регион наполовину старым и наполовину новым.
 */

const BATCH = 1000;

export interface LoadResult {
  orgs: number;
  houses: number;
  /** Домов региона, выпавших из реестра */
  dropped: number;
  places: number;
  streets: number;
  properties: { attached: number; byLoose: number; collided: number };
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export async function loadDataset(
  db: Database,
  manifest: DatasetManifest,
  rows: AsyncIterable<DatasetRow>,
): Promise<LoadResult> {
  const code = manifest.regionCode;
  const now = new Date();

  const counts = await db.transaction(async (tx) => {
    const orgIdByInn = new Map<string, string>();
    let orgs = 0;
    let houses = 0;
    let places = 0;
    let streets = 0;
    let treeCleared = false;

    let objectBatch: typeof addressObject.$inferInsert[] = [];
    let houseBatch: (DatasetRow & { t: 'house' })[] = [];
    let poiBatch: typeof poi.$inferInsert[] = [];
    let poisCleared = false;

    async function flushObjects() {
      if (!objectBatch.length) return;
      await tx.insert(addressObject).values(objectBatch).onConflictDoNothing();
      objectBatch = [];
    }

    async function flushHouses() {
      if (!houseBatch.length) return;
      await writeHouses(tx, houseBatch, orgIdByInn, now);
      houses += houseBatch.length;
      houseBatch = [];
    }

    async function flushPois() {
      if (!poiBatch.length) return;
      await tx.insert(poi).values(poiBatch);
      poiBatch = [];
    }

    for await (const row of rows) {
      switch (row.t) {
        case 'region':
          // «Загружается» — до справочника: оборвётся, и регион не притворится готовым
          await tx.insert(region)
            .values({ code: row.code, name: row.name, status: 'loading', source: row.source })
            .onConflictDoUpdate({ target: region.code, set: { name: row.name, status: 'loading', source: row.source } });
          break;

        case 'object': {
          if (!treeCleared) {
            treeCleared = true;
            await tx.delete(addressObject).where(eq(addressObject.regionCode, code));
          }
          const { t: _t, ...object } = row;
          objectBatch.push(object);
          if (object.level === 5 || object.level === 6) places++;
          if (object.level === 7 || object.level === 8) streets++;
          if (objectBatch.length >= BATCH) await flushObjects();
          break;
        }

        case 'org': {
          await flushObjects();
          const { t: _t, ...org } = row;
          const [saved] = await tx.insert(managingOrg)
            .values({ id: newId('org'), ...org, regionCode: code, importedAt: now })
            .onConflictDoUpdate({
              target: managingOrg.inn,
              set: {
                ogrn: sql`coalesce(${org.ogrn}, ${managingOrg.ogrn})`,
                // У фонда нет КПП и GUID портала — прежние значения не стираем
                kpp: sql`coalesce(${org.kpp}, ${managingOrg.kpp})`,
                gisOrgGuid: sql`coalesce(${org.gisOrgGuid}, ${managingOrg.gisOrgGuid})`,
                gisStatus: sql`coalesce(${org.gisStatus}, ${managingOrg.gisStatus})`,
                name: org.name,
                shortName: org.shortName,
                phone: sql`coalesce(${org.phone}, ${managingOrg.phone})`,
                email: sql`coalesce(${org.email}, ${managingOrg.email})`,
                site: sql`coalesce(${org.site}, ${managingOrg.site})`,
                frtId: org.frtId,
                licenseNumber: sql`coalesce(${org.licenseNumber}, ${managingOrg.licenseNumber})`,
                licenseStatus: sql`coalesce(${org.licenseStatus}, ${managingOrg.licenseStatus})`,
                houseCount: org.houseCount,
                importedAt: now,
              },
            })
            .returning({ id: managingOrg.id });
          orgIdByInn.set(org.inn, saved.id);
          orgs++;
          break;
        }

        case 'house':
          await flushObjects();
          houseBatch.push(row);
          if (houseBatch.length >= BATCH) await flushHouses();
          break;

        case 'poi': {
          await flushObjects();
          await flushHouses();
          if (!poisCleared) {
            poisCleared = true;
            await tx.delete(poi).where(eq(poi.regionCode, code));
          }
          const { t: _t, ...point } = row;
          poiBatch.push({ id: newId('poi', 10), regionCode: code, ...point });
          if (poiBatch.length >= BATCH) await flushPois();
          break;
        }
      }
    }

    await flushObjects();
    await flushHouses();
    await flushPois();

    let dropped = 0;
    if (houses > 0) {
      const [gone] = await tx.execute(sql`
        with gone as (
          update ${house} set registry_form = null, registry_org_id = null
           where ${and(
             eq(house.regionCode, code),
             // Демо-дом выдуман и в наборе его нет никогда: «выпавшим» он
             // лишился бы своей УК, и обращения ушли бы «совету дома».
             ne(house.houseKey, DEMO_HOUSE_KEY),
             or(isNull(house.importedAt), lt(house.importedAt, now)),
             or(sql`${house.registryForm} is not null`, sql`${house.registryOrgId} is not null`),
           )}
          returning 1
        )
        select count(*)::int as n from gone`).then((r) => r.rows as { n: number }[]);
      dropped = gone?.n ?? 0;

      /**
       * Число домов у организаций, которых в наборе нет, — пересчитать.
       * Иначе в нём навсегда остаётся цифра прежнего импорта, и кабинет
       * УК показывает «8 домов по данным лицензии» при нуле домов в реестре.
       */
      await tx.execute(sql`
        update ${managingOrg} m
           set house_count = (select count(*) from ${house} h where h.registry_org_id = m.id)
         where m.region_code = ${code}
           and (m.imported_at is null or m.imported_at < ${now})`);
    }

    if (treeCleared) {
      await tx.update(region)
        .set({ status: 'loaded', placeCount: places, streetCount: streets, loadedAt: now })
        .where(eq(region.code, code));
    }

    return { orgs, houses, dropped, places, streets };
  });

  // Догон квартир — после фиксации: он читает уже новый реестр
  const properties = await catchUpProperties(db);
  return { ...counts, properties };
}

async function writeHouses(
  tx: Tx,
  batch: (DatasetRow & { t: 'house' })[],
  orgIdByInn: Map<string, string>,
  now: Date,
): Promise<void> {
  /**
   * Дом, уже известный базе по GUID ФИАС, сохраняет свой ключ.
   *
   * Правила разбора адреса со временем меняются, написание улицы в ГАР —
   * тоже. Новый ключ завёл бы второй дом, а соседи, объявления
   * и председатель остались бы на старом.
   */
  const guids = batch.map((row) => row.fiasGuid).filter((g): g is string => Boolean(g));
  const knownKey = new Map<string, string>();
  if (guids.length) {
    const known = await tx.select({ houseKey: house.houseKey, fiasGuid: house.fiasGuid })
      .from(house)
      .where(inArray(house.fiasGuid, guids));
    for (const row of known) if (row.fiasGuid) knownKey.set(row.fiasGuid, row.houseKey);
  }

  const seen = new Set<string>();
  const values = [];
  for (const row of batch) {
    const houseKey = (row.fiasGuid && knownKey.get(row.fiasGuid)) || row.houseKey;
    if (seen.has(houseKey)) continue;
    seen.add(houseKey);
    values.push({
      houseKey,
      fiasGuid: row.fiasGuid,
      addressRaw: row.addressRaw,
      houseKeyLoose: row.houseKeyLoose,
      regionCode: row.regionCode,
      streetGuid: row.streetGuid,
      houseKind: row.houseKind,
      // Наборы до признака МКД его не несут — пусто, а не «нет»
      garMkd: row.garMkd ?? null,
      cadastralNumber: row.cadastralNumber ?? null,
      gisHouseGuid: row.gisHouseGuid,
      flatCount: row.flatCount,
      garFlats: row.garFlats,
      registryForm: row.registryForm,
      registryOrgId: row.orgInn ? orgIdByInn.get(row.orgInn) ?? null : null,
      lat: row.lat,
      lon: row.lon,
      builtYear: row.builtYear ?? null,
      floors: row.floors ?? null,
      entrances: row.entrances ?? null,
      elevators: row.elevators ?? null,
      wallMaterial: row.wallMaterial ?? null,
      gas: row.gas ?? null,
      emergency: row.emergency ?? null,
      importedAt: now,
    });
  }

  await tx.insert(house)
    .values(values)
    .onConflictDoUpdate({
      target: house.houseKey,
      set: {
        fiasGuid: sql`excluded.fias_guid`,
        addressRaw: sql`excluded.address_raw`,
        houseKeyLoose: sql`excluded.house_key_loose`,
        regionCode: sql`excluded.region_code`,
        streetGuid: sql`excluded.street_guid`,
        houseKind: sql`excluded.house_kind`,
        garMkd: sql`excluded.gar_mkd`,
        cadastralNumber: sql`excluded.cadastral_number`,
        gisHouseGuid: sql`coalesce(excluded.gis_house_guid, ${house.gisHouseGuid})`,
        flatCount: sql`excluded.flat_count`,
        garFlats: sql`excluded.gar_flats`,
        registryForm: sql`excluded.registry_form`,
        registryOrgId: sql`excluded.registry_org_id`,
        lat: sql`excluded.lat`,
        lon: sql`excluded.lon`,
        builtYear: sql`excluded.built_year`,
        floors: sql`excluded.floors`,
        entrances: sql`excluded.entrances`,
        elevators: sql`excluded.elevators`,
        wallMaterial: sql`excluded.wall_material`,
        gas: sql`excluded.gas`,
        emergency: sql`excluded.emergency`,
        importedAt: sql`excluded.imported_at`,
      },
    });
}
