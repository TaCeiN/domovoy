import { and, eq, isNull, ne } from 'drizzle-orm';
import { chairman, house, managingOrg } from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';

/**
 * Форма управления домом.
 *
 * 'uk'      — лицензированная УК из реестра
 * 'tsj'     — товарищество собственников жилья
 * 'zhsk'    — жилищно-строительный кооператив
 * 'direct'  — непосредственное управление собственниками
 * 'none'    — управления нет ни в каком виде
 * 'private' — частный дом: «дома» как сообщества не существует
 * 'unknown' — никто ещё не сказал. НЕ то же самое, что 'none'
 */
export type HouseForm = 'uk' | 'tsj' | 'zhsk' | 'direct' | 'none' | 'private' | 'unknown';

/**
 * Как форма называется по-русски.
 *
 * Живёт рядом с самим перечислением, а не в разметке: названия нужны
 * и экрану оператора, и журналу действий, и подписи «дом» уже сейчас,
 * а разъехавшиеся формулировки в трёх местах — это способ однажды
 * показать человеку «tsj».
 */
export const FORM_LABEL: Record<HouseForm, string> = {
  uk: 'управляющая компания',
  tsj: 'ТСЖ',
  zhsk: 'ЖСК',
  direct: 'непосредственное управление',
  none: 'управления нет',
  private: 'частный дом',
  unknown: 'неизвестно',
};

export const HOUSE_FORMS: HouseForm[] =
  ['uk', 'tsj', 'zhsk', 'direct', 'none', 'private', 'unknown'];

export interface HouseState {
  form: HouseForm;
  orgId: string | null;
  multiFlat: boolean | null;
  hasChairman: boolean;
}

/** Строка `house` вместе с лицензией организации по реестру — всё, что нужно правилу */
export interface HouseLayers {
  form: string;
  orgId: string | null;
  multiFlat: boolean | null;
  registryForm: string | null;
  registryOrgId: string | null;
  /** Лицензия организации из `registry_org_id` */
  registryLicense: string | null;
  garFlats: number | null;
  /** Признак ФНС «Многоквартирный дом»; необязателен у старых строк */
  garMkd?: boolean | null;
}

/** Формы, которые означают управление общим имуществом — бывают только у МКД */
const MULTI_FLAT_REGISTRY = new Set(['uk', 'tsj', 'zhsk', 'direct']);

/**
 * Как реестровый и человеческий слои складываются в одно состояние дома.
 *
 * ОДНА ФУНКЦИЯ на `houseState` и на привязку жителя (lib/auth/bind.ts):
 * раньше привязка брала организацию из `managed_house` своим запросом,
 * и правило «кто обслуживает дом» жило в двух местах.
 *
 * ПОРЯДОК:
 * 1. Организация по реестру С ЛИЦЕНЗИЕЙ — это 'uk' безусловно. Реестр
 *    лицензий проверяем, а запись оператора — память о том, что было верно
 *    когда-то. Так было и при `managed_house`, это закреплено тестами.
 * 2. Форма, которую записал человек (оператор, правило частного дома), —
 *    если он её записал. Организация — его же, а если он её не указал,
 *    то реестровая.
 * 3. Форма и организация по реестру (ТСЖ, ЖСК, частный дом из набора).
 * 4. 'unknown'.
 *
 * МНОГОКВАРТИРНОСТЬ выводится только из данных: форма управления общим
 * имуществом по реестру, организация по реестру, квартиры в ГАР или
 * отметка приложения. `false` — только когда реестр прямо называет дом
 * жилым (частным) и ничто из перечисленного этому не противоречит.
 * На этом признаке стоит защита правила частного дома.
 */
export function effectiveHouse(layers: HouseLayers | undefined): Omit<HouseState, 'hasChairman'> {
  if (!layers) return { form: 'unknown', orgId: null, multiFlat: null };

  const registryForm = layers.registryForm ?? 'unknown';
  const multiFlat = MULTI_FLAT_REGISTRY.has(registryForm)
    || Boolean(layers.registryOrgId)
    || (layers.garFlats ?? 0) > 0
    || layers.garMkd === true
    || layers.multiFlat === true
    ? true
    : registryForm === 'private' ? false : layers.multiFlat;

  if (layers.registryOrgId && layers.registryLicense !== null && (registryForm === 'uk' || registryForm === 'unknown')) {
    return { form: 'uk', orgId: layers.registryOrgId, multiFlat: true };
  }

  if (layers.form !== 'unknown') {
    return { form: layers.form as HouseForm, orgId: layers.orgId ?? layers.registryOrgId, multiFlat };
  }

  return { form: registryForm as HouseForm, orgId: layers.registryOrgId ?? layers.orgId, multiFlat };
}

/** Колонки для `effectiveHouse` — одинаковые во всех запросах */
export const houseLayerColumns = {
  form: house.form,
  orgId: house.orgId,
  multiFlat: house.multiFlat,
  registryForm: house.registryForm,
  registryOrgId: house.registryOrgId,
  registryLicense: managingOrg.licenseNumber,
  garFlats: house.garFlats,
  garMkd: house.garMkd,
};

/**
 * Всё, что известно о доме, одним запросом.
 *
 * `/api/me` зовёт эту функцию на каждый объект при каждой загрузке экрана,
 * поэтому дом с лицензией организации и председатель читаются параллельно.
 */
export async function houseState(db: Database, houseKey: string): Promise<HouseState> {
  const [[layers], [chair]] = await Promise.all([
    db
      .select(houseLayerColumns)
      .from(house)
      .leftJoin(managingOrg, eq(managingOrg.id, house.registryOrgId))
      .where(eq(house.houseKey, houseKey))
      .limit(1),
    db
      .select({ id: chairman.id })
      .from(chairman)
      .where(and(eq(chairman.houseKey, houseKey), isNull(chairman.revokedAt)))
      .limit(1),
  ]);

  return { ...effectiveHouse(layers), hasChairman: Boolean(chair) };
}

export interface SetHouseFormInput {
  form: HouseForm;
  orgId?: string | null;
  source: 'registry' | 'resident' | 'operator';
  setBy?: string | null;
}

export async function setHouseForm(
  db: Database,
  houseKey: string,
  input: SetHouseFormInput,
): Promise<void> {
  await db
    .insert(house)
    .values({
      houseKey,
      form: input.form,
      orgId: input.orgId ?? null,
      source: input.source,
      setBy: input.setBy ?? null,
      setAt: new Date(),
    })
    .onConflictDoUpdate({
      target: house.houseKey,
      set: {
        form: input.form,
        orgId: input.orgId ?? null,
        source: input.source,
        setBy: input.setBy ?? null,
        setAt: new Date(),
      },
    });
}

/**
 * То же самое, но НЕ поверх записи живого человека.
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ. `setHouseForm` перезаписывает строку целиком,
 * и это правильно, когда пишет человек: он видит дом и знает про него
 * больше нас. Но правило частного дома (lib/auth/private-house.ts) —
 * автоматика, а она вслепую превращала заведённое оператором
 * `form='tsj', orgId=<ТСЖ>` в `form='private', orgId=null, setBy=null`.
 * То есть молча отменяла решение оператора и заодно стирала след,
 * по которому можно было бы понять, что дом захвачен.
 *
 * Возвращает false, если запись оператора уже есть и её не тронули.
 */
export async function setHouseFormUnlessOperator(
  db: Database,
  houseKey: string,
  input: SetHouseFormInput,
): Promise<boolean> {
  const values = {
    form: input.form,
    orgId: input.orgId ?? null,
    source: input.source,
    setBy: input.setBy ?? null,
    setAt: new Date(),
  };

  const rows = await db
    .insert(house)
    .values({ houseKey, ...values })
    .onConflictDoUpdate({
      target: house.houseKey,
      set: values,
      // Условие смотрит на СТАРУЮ строку: `house.source` в ON CONFLICT
      // DO UPDATE — это то, что уже лежит в таблице, а не то, что вставляем
      setWhere: ne(house.source, 'operator'),
    })
    .returning({ houseKey: house.houseKey });

  return rows.length > 0;
}

/**
 * Дом оказался многоквартирным.
 *
 * Форму НЕ трогаем: её ставит человек, и снимать её автоматом значит
 * менять права молча. Признак нужен защите правила частного дома
 * и глазам оператора.
 */
export async function markMultiFlat(db: Database, houseKey: string): Promise<void> {
  await db
    .insert(house)
    .values({ houseKey, multiFlat: true, source: 'registry' })
    .onConflictDoUpdate({ target: house.houseKey, set: { multiFlat: true } });
}
