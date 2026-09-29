import { and, asc, eq, inArray } from 'drizzle-orm';
import { appUser, property, userProperty, house, dispatcher } from '../../db/schema.ts';
import { notify } from '../notify/index.ts';
import { houseState, type HouseForm, type HouseState } from '../house/form.ts';
import type { Database } from '../../db/client.ts';
import { PLACEHOLDER_NAME } from './names.ts';

/**
 * Заявки на доступ к квартире.
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Раньше «кого пустить» решалось внутри разбора
 * квитанции: свободный счёт — впустить собственником, занятый — спросить
 * владельца. Это связывало два разных вопроса, и слабый ответ на первый
 * («у него есть строка QR») давал власть отвечать на второй. Теперь
 * предъявление квитанции только заводит заявку, а решение живёт здесь
 * и принимается человеком.
 *
 * КТО РЕШАЕТ. Председатель совета дома — он знает соседей в лицо, и его
 * самого назначает УК под протокол собрания. Если председателя нет,
 * заявку разбирает диспетчер УК: у него есть биллинг, где лицевой счёт
 * связан с ФИО и квартирой. Если нет ни того, ни другого, ждать некого —
 * и приложение обязано сказать об этом прямо, а не показывать вечное
 * «заявка на рассмотрении».
 */

/** Что человек рассказывает о себе, пока ждёт подтверждения. */
export interface ClaimInput {
  /**
   * ФИО. Спрашиваем явно, а не берём из аккаунта MAX.
   *
   * У половины аккаунтов там нет фамилии, а иногда вместо имени ник.
   * Председателю нужно понять, кто перед ним, поэтому имя приходит
   * от самого человека и лежит рядом с заявкой, не подменяя имя аккаунта.
   */
  name: string;
  /**
   * Квартира. Пусто, если у объекта её нет вовсе, — частный дом или
   * квитанция без указанной квартиры (см. saveClaim: требуем это поле,
   * только если у property она может быть непустой).
   */
  flat: string;
  /** Телефон для связи — необязателен, но резко упрощает сверку */
  phone?: string;
  /** Свободная строка: «я из 27-й, сын Ивановых», «снимаю с марта» */
  note?: string;
}

export type SaveClaimResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'bad_input' | 'already_decided' };

export const CLAIM_NAME_MIN = 3;
export const CLAIM_MAX_LENGTH = 300;

/**
 * Житель заполняет данные о себе.
 *
 * Менять их можно, пока заявка не решена: человек ошибается в номере
 * квартиры чаще, чем кажется, и заставлять его заводить заявку заново
 * значит плодить дубли в очереди председателя.
 */
export async function saveClaim(
  db: Database,
  userId: string,
  bindingId: string,
  input: ClaimInput,
): Promise<SaveClaimResult> {
  const name = input.name.trim();
  const flat = input.flat.trim();

  if (name.length < CLAIM_NAME_MIN) return { ok: false, reason: 'bad_input' };
  if (name.length > CLAIM_MAX_LENGTH || flat.length > 32) return { ok: false, reason: 'bad_input' };

  const rows = await db
    .select({
      id: userProperty.id,
      status: userProperty.status,
      // Квартиру спрашиваем не всегда: у объекта её может не быть вовсе —
      // см. комментарий у ClaimInput.flat.
      propertyFlat: property.flat,
    })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .where(and(eq(userProperty.id, bindingId), eq(userProperty.userId, userId)))
    .limit(1);

  const found = rows[0];
  if (!found) return { ok: false, reason: 'not_found' };
  if (found.status !== 'pending') return { ok: false, reason: 'already_decided' };

  /**
   * Квартиру требуем, только если у объекта она вообще может быть.
   *
   * Пустая `property.flat` — это уже известный приложению факт: либо дом
   * частный и квартиры не бывает в принципе, либо адрес пришёл без нее
   * из квитанции. Спрашивать то же самое второй раз незачем — экран входа
   * (lib/auth/private-house.ts, public/app/screens/login.js) уже решил,
   * что квартиры тут нет.
   */
  /**
   * И квартиру, которая УЖЕ есть в квитанции, второй раз не требуем.
   *
   * Раньше форма спрашивала «кв. 27» у того, кто только что принёс
   * квитанцию с «кв. 27», и без неё заявку не принимала (аудит
   * 26 сентября). Требуем, только когда квартира объекту не известна.
   */
  if (!flat && found.propertyFlat === null) return { ok: false, reason: 'bad_input' };

  await db
    .update(userProperty)
    .set({
      claimName: name,
      // Квартира из квитанции — та же, что назвал бы человек: берём её
      claimFlat: flat || found.propertyFlat || null,
      claimPhone: input.phone?.trim().slice(0, 32) || null,
      claimNote: input.note?.trim().slice(0, CLAIM_MAX_LENGTH) || null,
    })
    .where(eq(userProperty.id, bindingId));

  /**
   * Имя из заявки становится именем человека, если другого не было.
   *
   * Квитанции расчётных центров часто без ФИО, и человек оставался
   * «Житель» везде: в приветствии, у председателя, в кабинете УК,
   * в поиске оператора. Имя из квитанции или из MAX не перетираем.
   */
  await db
    .update(appUser)
    .set({ fullName: name })
    .where(and(eq(appUser.id, userId), eq(appUser.fullName, PLACEHOLDER_NAME)));

  return { ok: true };
}

export type WithdrawResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'already_decided' };

/**
 * Отозвать свою заявку — с полным удалением строки.
 *
 * ПОЧЕМУ УДАЛЕНИЕ, А НЕ СТАТУС. Отзыв делает сам человек, и в заявке
 * лежат его ФИО, номер квартиры и свободная строка «кто он» — данные,
 * которые он сообщил ради подтверждения и передумал сообщать. Пометка
 * `revoked` оставила бы их в очереди председателя мёртвым грузом
 * и в базе навсегда. Здесь нечего хранить: решения по заявке не было.
 *
 * Отзывать можно только СВОЮ и только НЕРЕШЁННУЮ заявку. Решённую
 * трогать нельзя: `active` — это действующий доступ, он снимается
 * отзывом доступа, а `revoked` — отказ председателя, и стереть чужое
 * решение человек не вправе.
 *
 * Обращения в УК, поданные по этому объекту на уровне 0, остаются:
 * маршрута удаления заявки в УК не существует, и это ядро продукта.
 */
export async function withdrawClaim(
  db: Database,
  userId: string,
  bindingId: string,
): Promise<WithdrawResult> {
  const rows = await db
    .select({ id: userProperty.id, status: userProperty.status })
    .from(userProperty)
    .where(and(eq(userProperty.id, bindingId), eq(userProperty.userId, userId)))
    .limit(1);

  const found = rows[0];
  if (!found) return { ok: false, reason: 'not_found' };
  if (found.status !== 'pending') return { ok: false, reason: 'already_decided' };

  await db.delete(userProperty).where(eq(userProperty.id, bindingId));
  return { ok: true };
}

/** Строка очереди — то, чего хватает, чтобы узнать человека. */
export interface PendingClaim {
  bindingId: string;
  propertyId: string;
  /** Нужен кабинету УК: сгруппировать ожидающих по домам без председателя */
  houseKey: string;
  address: string;
  /** Квартира из адреса объекта */
  flat: string;
  /** Квартира, которую называет сам человек: расхождение — повод переспросить */
  claimedFlat: string | null;
  claimedName: string | null;
  claimedPhone: string | null;
  note: string | null;
  /** Имя аккаунта: в MAX оно приходит от платформы и подделке не поддаётся */
  accountName: string;
  /** Заходил через мессенджер — значит личность подтверждена платформой */
  viaMax: boolean;
  phoneVerified: boolean;
  requestedAt: Date;
  /** Успел ли человек рассказать о себе */
  complete: boolean;
}

async function claimsForHouses(db: Database, houseKeys: string[]): Promise<PendingClaim[]> {
  if (houseKeys.length === 0) return [];

  const rows = await db
    .select({
      bindingId: userProperty.id,
      propertyId: property.id,
      houseKey: property.houseKey,
      address: property.addressRaw,
      flat: property.flat,
      claimName: userProperty.claimName,
      claimFlat: userProperty.claimFlat,
      claimPhone: userProperty.claimPhone,
      claimNote: userProperty.claimNote,
      accountName: appUser.fullName,
      maxUserId: appUser.maxUserId,
      phoneVerifiedAt: appUser.phoneVerifiedAt,
      createdAt: userProperty.createdAt,
    })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .innerJoin(appUser, eq(userProperty.userId, appUser.id))
    .where(and(eq(userProperty.status, 'pending'), inArray(property.houseKey, houseKeys)))
    .orderBy(asc(userProperty.createdAt));

  return rows.map((r) => ({
    bindingId: r.bindingId,
    propertyId: r.propertyId,
    houseKey: r.houseKey,
    address: r.address,
    flat: r.flat,
    claimedFlat: r.claimFlat,
    claimedName: r.claimName,
    claimedPhone: r.claimPhone,
    note: r.claimNote,
    accountName: r.accountName,
    viaMax: r.maxUserId !== null,
    phoneVerified: r.phoneVerifiedAt !== null,
    requestedAt: r.createdAt,
    // Квартиру считаем заполненной и тогда, когда у объекта её нет вовсе —
    // частный дом или квитанция без квартиры. Спрашивать заново нечего.
    complete: Boolean(r.claimName && (r.claimFlat || r.flat === '')),
  }));
}

/** Очередь председателя — только его дом. */
export function claimsForChairman(db: Database, houseKey: string): Promise<PendingClaim[]> {
  return claimsForHouses(db, [houseKey]);
}

/** Очередь диспетчера — все дома его организации из реестра лицензий. */
export async function claimsForDispatcher(db: Database, orgId: string): Promise<PendingClaim[]> {
  const houses = await db
    .select({ houseKey: house.houseKey })
    .from(house)
    .where(eq(house.registryOrgId, orgId));

  return claimsForHouses(db, houses.map((h) => h.houseKey));
}

export type DecideProblem = 'not_found' | 'owner_taken' | 'incomplete';

export type DecideResult =
  | { ok: true; userId: string; role: 'owner' | 'member' }
  | { ok: false; reason: DecideProblem };

/** Коды и тексты держим рядом с причинами — оба кабинета отвечают одинаково. */
export const CLAIM_CODES: Record<DecideProblem, number> = {
  not_found: 404,
  owner_taken: 409,
  incomplete: 409,
};

export const CLAIM_MESSAGES: Record<DecideProblem, string> = {
  not_found: 'Заявка не найдена или уже решена',
  owner_taken: 'У этой квартиры уже есть собственник. Подтвердите жильцом '
    + 'или сначала отзовите доступ у прежнего',
  incomplete: 'Человек ещё не рассказал о себе. Подтверждать заявку, '
    + 'в которой нет ни имени, ни квартиры, нельзя',
};

/**
 * Кто принимает решение — ТОЛЬКО председатель совета дома.
 *
 * Диспетчер УК отсюда убран сознательно. Он заходит в кабинет хорошо
 * если раз в месяц, и жители застряли бы в очереди навсегда. УК в этой
 * цепочке наблюдатель: видит, что в доме копятся заявки, — и назначает
 * председателя, который их и разберёт.
 *
 * Тип оставлен размеченным объединением, а не голым `chairmanId`:
 * если однажды появится ещё один подтверждающий (например, старший
 * по подъезду), он добавится сюда, а не размажется по вызовам.
 */
export type Decider = { kind: 'chairman'; id: string; houseKey: string };

async function bindingInScope(db: Database, bindingId: string, decider: Decider) {
  const rows = await db
    .select({
      id: userProperty.id,
      userId: userProperty.userId,
      status: userProperty.status,
      propertyId: userProperty.propertyId,
      houseKey: property.houseKey,
      managingOrgId: property.managingOrgId,
      claimName: userProperty.claimName,
      claimFlat: userProperty.claimFlat,
      // Нужно решить, обязательна ли квартира в заявке, — см. approveClaim
      propertyFlat: property.flat,
    })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .where(eq(userProperty.id, bindingId))
    .limit(1);

  const found = rows[0];
  if (!found || found.status !== 'pending') return null;

  return found.houseKey === decider.houseKey ? found : null;
}

/**
 * Подтвердить доступ.
 *
 * Роль выбирает подтверждающий: «собственник» или «жилец». Догадаться
 * по квитанции нельзя — она всегда выписана на собственника, и по ней
 * собственник и домочадец выглядят одинаково.
 */
export async function approveClaim(
  db: Database,
  decider: Decider,
  bindingId: string,
  role: 'owner' | 'member',
): Promise<DecideResult> {
  const found = await bindingInScope(db, bindingId, decider);
  if (!found) return { ok: false, reason: 'not_found' };

  /**
   * Подтверждать вслепую нельзя.
   *
   * Пока человек не рассказал о себе, в очереди стоит строка «неизвестно
   * кто просит доступ к квартире 42» — подтверждение такой заявки
   * не отличается от подтверждения чужого захвата.
   *
   * Квартиру требуем, только если у объекта она вообще может быть:
   * пустая `property.flat` — частный дом или квитанция без квартиры,
   * и claimFlat там законно пуст.
   */
  if (!found.claimName || (!found.claimFlat && found.propertyFlat !== '')) {
    return { ok: false, reason: 'incomplete' };
  }

  /**
   * Второй действующий собственник у объекта появиться не может: это
   * запрещено частичным уникальным индексом. Ошибку ловим и объясняем,
   * а не отдаём наружу «внутренняя ошибка».
   */
  if (role === 'owner') {
    const taken = await db
      .select({ id: userProperty.id })
      .from(userProperty)
      .where(and(
        eq(userProperty.propertyId, found.propertyId),
        eq(userProperty.role, 'owner'),
        eq(userProperty.status, 'active'),
      ))
      .limit(1);
    if (taken[0]) return { ok: false, reason: 'owner_taken' };
  }

  await db
    .update(userProperty)
    .set({
      status: 'active',
      role,
      decidedAt: new Date(),
      rejectReason: null,
      decidedByChairmanId: decider.id,
    })
    .where(eq(userProperty.id, bindingId));

  await notify(db, {
    userId: found.userId,
    kind: 'access_request',
    title: 'Доступ к квартире подтверждён',
    body: role === 'owner'
      ? 'Вас подтвердили как собственника. Все разделы приложения открыты.'
      : 'Вас подтвердили как жильца. Все разделы приложения открыты.',
    deepLinkPayload: 'home',
  }).catch(() => undefined);

  return { ok: true, userId: found.userId, role };
}

/** Отклонить заявку. Причина обязательна: человек должен понимать, что делать. */
export async function rejectClaim(
  db: Database,
  decider: Decider,
  bindingId: string,
  reason: string,
): Promise<DecideResult> {
  const found = await bindingInScope(db, bindingId, decider);
  if (!found) return { ok: false, reason: 'not_found' };

  await db
    .update(userProperty)
    .set({
      status: 'revoked',
      decidedAt: new Date(),
      rejectReason: reason.trim().slice(0, CLAIM_MAX_LENGTH) || null,
      decidedByChairmanId: decider.id,
    })
    .where(eq(userProperty.id, bindingId));

  await notify(db, {
    userId: found.userId,
    kind: 'access_request',
    title: 'Заявка на доступ отклонена',
    body: reason.trim() || 'Обратитесь в управляющую компанию.',
    deepLinkPayload: 'home',
  }).catch(() => undefined);

  return { ok: true, userId: found.userId, role: 'member' };
}

/**
 * Ждёт ли дом кого-нибудь, кто разберёт заявки.
 *
 * Нужно для честного ответа жителю: «доступ подтверждает председатель»,
 * «у дома нет председателя — попросите УК его назначить».
 */
export async function decidersForHouse(
  db: Database,
  houseKey: string,
  /**
   * Состояние дома, если уже посчитано вызывающим кодом.
   *
   * `/api/me` считает `houseState` один раз на объект и раздаёт его сюда
   * и в `houseSummary` — без этого один запрос экрана делал до трёх
   * одинаковых `houseState` (по три запроса к базе каждый) на одну квартиру.
   */
  precomputedState?: HouseState,
): Promise<{ chairman: boolean; dispatcher: boolean; form: HouseForm; canAskOperator: boolean }> {
  const state = precomputedState ?? await houseState(db, houseKey);
  // Известна ли организация — из реестра лицензий (форма 'uk') или заведённая
  // оператором вручную (ТСЖ/ЖСК без лицензии, house:org).
  const hasOrg = state.orgId !== null;

  /**
   * Есть ли у организации СВОЙ КАБИНЕТ диспетчера.
   *
   * ЗАЧЕМ ОТДЕЛЬНО ОТ `hasOrg`. Команда `house:org` подключает организацию
   * — обычно ТСЖ или ЖСК — БЕЗ кабинета: у неё просто нет диспетчера,
   * который бы в него заходил, `dispatcher` (db/schema.ts) для неё пуста.
   * Пока это не проверялось, известная организация вела себя как назначенный
   * председатель: кнопка «Подключить дом» у жителя пропадала, а текст
   * отправлял его просить УК назначить председателя — хотя войти в кабинет
   * и сделать это некому. Дом замирал навсегда, если оператор не выполнял
   * вторым шагом ещё одну ручную правку.
   */
  const hasDispatcherCabinet = hasOrg && Boolean(
    (await db
      .select({ id: dispatcher.id })
      .from(dispatcher)
      .where(eq(dispatcher.orgId, state.orgId as string))
      .limit(1))[0],
  );

  return {
    chairman: state.hasChairman,
    /**
     * Означает «у организации есть кабинет, и туда можно попросить зайти
     * и назначить председателя» — а не просто «организация известна».
     * Подтверждает жителей всегда только председатель.
     */
    dispatcher: hasDispatcherCabinet,
    form: state.form,
    /**
     * Просить оператора есть смысл, пока у дома нет ПРЕДСЕДАТЕЛЯ.
     *
     * Организация сама по себе выход не даёт, если у неё нет кабинета:
     * диспетчерской, куда мог бы зайти живой человек и назначить
     * председателя, попросту не существует. Дом с кабинетом УК —
     * не тупик, а дом без кабинета — тупик, даже если организация
     * уже известна. У частного дома подключать нечего.
     */
    canAskOperator: !state.hasChairman && !hasDispatcherCabinet && state.form !== 'private',
  };
}
