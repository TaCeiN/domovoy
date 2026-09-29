import { and, desc, eq, isNull } from 'drizzle-orm';
import { appUser, chairman, house, property, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { houseState } from './form.ts';
import { notify } from '../notify/index.ts';
import type { Database } from '../../db/client.ts';

/**
 * Председатель совета дома — роль жителя, а не отдельная учётка.
 *
 * ПОЧЕМУ ТАК. Прежде это был аккаунт с логином и паролем, а кабинет жил
 * отдельной веб-страницей. Но председатель — такой же житель этого дома:
 * у него та же квартира, те же квитанции и тот же счётчик. Второй аккаунт
 * заставлял помнить, «под кем он сейчас», а в советах домов большинство —
 * люди старшего возраста, для которых это худший вид путаницы. Кабинет
 * переехал внутрь приложения, а вход остался один.
 *
 * КТО НАЗНАЧАЕТ. Управляющая компания, разовым действием при подключении
 * дома. Не поток заявок, а один клик: диспетчер заходит в кабинет редко,
 * и строить на нём ежедневную работу нельзя.
 *
 * ИЗ КОГО ВЫБИРАТЬ. Из всех, кто предъявил квитанцию по этому дому, —
 * включая НЕПОДТВЕРЖДЁННЫХ. Иначе выбирать не из кого: пока председателя
 * нет, подтверждать жителей некому, и подтверждённых в доме ноль.
 * Это и есть точка, с которой дом начинает жить.
 */

export type CreateChairmanResult =
  | { ok: true; id: string; name: string }
  | { ok: false; reason: 'foreign_house' | 'not_a_resident' | 'already_exists' };

/** Житель дома — кандидат в председатели. */
export interface ChairmanCandidate {
  userId: string;
  name: string;
  /** Как он представился в заявке: в MAX у половины аккаунтов нет фамилии */
  claimedName: string | null;
  flat: string;
  status: string;
  viaMax: boolean;
  phoneVerified: boolean;
  /** Когда предъявил квитанцию */
  since: Date;
}

/**
 * Кого УК может назначить председателем этого дома.
 *
 * Сортировка: сначала подтверждённые, потом по номеру квартиры. Первым
 * в списке идёт тот, про кого известно больше всего.
 */
export async function chairmanCandidates(
  db: Database,
  orgId: string,
  houseKey: string,
): Promise<ChairmanCandidate[]> {
  const owned = await db
    .select({ houseKey: house.houseKey })
    .from(house)
    .where(and(eq(house.registryOrgId, orgId), eq(house.houseKey, houseKey)))
    .limit(1);
  if (!owned[0]) return [];

  const rows = await db
    .select({
      userId: userProperty.userId,
      name: appUser.fullName,
      claimedName: userProperty.claimName,
      flat: property.flat,
      status: userProperty.status,
      maxUserId: appUser.maxUserId,
      phoneVerifiedAt: appUser.phoneVerifiedAt,
      since: userProperty.createdAt,
    })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .innerJoin(appUser, eq(userProperty.userId, appUser.id))
    .where(and(eq(property.houseKey, houseKey)));

  const seen = new Set<string>();
  return rows
    .filter((r) => r.status !== 'revoked')
    .filter((r) => (seen.has(r.userId) ? false : (seen.add(r.userId), true)))
    .map((r) => ({
      userId: r.userId,
      name: r.name,
      claimedName: r.claimedName,
      flat: r.flat,
      status: r.status,
      viaMax: r.maxUserId !== null,
      phoneVerified: r.phoneVerifiedAt !== null,
      // Два одинаковых ФИО в одной квартире различимы только датой и входом
      since: r.since,
    }))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return (Number(a.flat) || 0) - (Number(b.flat) || 0);
    });
}

export type ChairmanAppointer =
  | { kind: 'dispatcher'; orgId: string; id: string }
  | { kind: 'operator'; who: string };

export async function createChairman(
  db: Database,
  input: { houseKey: string; userId: string; by: ChairmanAppointer },
): Promise<CreateChairmanResult> {
  /**
   * Право НАЗНАЧАТЬ, а не право существовать.
   *
   * Раньше запись в реестре домов (тогда `managed_house`) была условием
   * существования председателя, и дом вне реестра лицензий не мог получить
   * его никогда. Теперь это проверка полномочий диспетчера: свой дом по
   * реестру (`house.registry_org_id`) — назначай, чужой — нет. У оператора
   * таких границ нет.
   */
  let orgId: string | null = null;

  if (input.by.kind === 'dispatcher') {
    const [owned] = await db
      .select({ houseKey: house.houseKey })
      .from(house)
      .where(and(
        eq(house.registryOrgId, input.by.orgId),
        eq(house.houseKey, input.houseKey),
      ))
      .limit(1);
    if (!owned) return { ok: false, reason: 'foreign_house' };
    orgId = input.by.orgId;
  } else {
    const state = await houseState(db, input.houseKey);
    orgId = state.orgId;
  }

  /** Председателем может стать только житель ЭТОГО дома. */
  const binding = await db
    .select({
      id: userProperty.id,
      propertyId: userProperty.propertyId,
      status: userProperty.status,
      claimName: userProperty.claimName,
      name: appUser.fullName,
      flat: property.flat,
    })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .innerJoin(appUser, eq(userProperty.userId, appUser.id))
    .where(and(
      eq(userProperty.userId, input.userId),
      eq(property.houseKey, input.houseKey),
    ))
    .limit(1);

  const resident = binding[0];
  if (!resident || resident.status === 'revoked') return { ok: false, reason: 'not_a_resident' };

  const existing = await db
    .select({ id: chairman.id })
    .from(chairman)
    .where(and(eq(chairman.houseKey, input.houseKey), isNull(chairman.revokedAt)))
    .limit(1);
  if (existing[0]) return { ok: false, reason: 'already_exists' };

  const name = resident.claimName?.trim() || resident.name;
  const id = newId('chr');

  await db.insert(chairman).values({
    id,
    orgId,
    houseKey: input.houseKey,
    userId: input.userId,
    name,
    flat: resident.flat || null,
    createdBy: input.by.kind === 'dispatcher' ? input.by.id : null,
    createdBySource: input.by.kind,
  });

  /**
   * Назначение подтверждает и саму привязку к квартире.
   *
   * Иначе получался бы председатель, который не может войти в собственный
   * дом: подтверждать его было бы некому — он и есть подтверждающий.
   * Это и есть точка старта дома.
   */
  if (resident.status !== 'active') {
    /**
     * Статус — да, роль — нет.
     *
     * Здесь стояло «роль собственника, если свободна». Но назначить можно
     * и неподтверждённого — того, кто ввёл строку QR руками, — и тогда
     * назначение дарило ему чужую квартиру: приглашать домочадцев, видеть
     * все её деньги, отклонять настоящего хозяина (аудит 26 сентября).
     * Права председателя он берёт из таблицы `chairman`, а собственность
     * пусть подтверждает, как все.
     */
    await db
      .update(userProperty)
      .set({ status: 'active', decidedAt: new Date() })
      .where(eq(userProperty.id, resident.id));
  }

  /**
   * Сказать человеку, что его назначили.
   *
   * ЗАЧЕМ. Проверено на живом стенде 11 сентября: оператор назначает
   * председателя, сервер отвечает `active` и `isChairman: true`, а экран
   * у человека в ту же секунду показывает «ожидает» и «у дома нет
   * председателя». Клиент перечитывает состояние только при полном
   * запуске, и без этого сообщения человек не узнает о назначении
   * вообще — ни он, ни дом, который его ждёт.
   *
   * Ошибку глотаем: упавший канал не должен отменять назначение.
   * Тот же приём, что у `approveClaim` (lib/auth/claims.ts).
   */
  await notify(db, {
    userId: input.userId,
    kind: 'access_request',
    title: 'Вас назначили председателем совета дома',
    body: 'Раздел «Совет дома» открыт: подтверждение соседей, объявления, '
      + 'опросы и обращения дома. Он в профиле и на главной.',
    deepLinkPayload: 'council',
  }).catch(() => undefined);

  return { ok: true, id, name };
}

/**
 * Снятие с должности. Публикации остаются: история дома не переписывается.
 *
 * Гасить сессии больше не нужно: права председателя проверяются по этой
 * таблице на каждом запросе, а не зашиваются в сессию при входе. Доступ
 * закрывается в ту же секунду сам по себе.
 *
 * Тип границы прав — тот же `ChairmanAppointer`, что и у назначения.
 * У председателя, назначенного оператором в доме без организации,
 * `chairman.orgId` пуст, и условие «orgId = ukId диспетчера» не совпадёт
 * никогда — раньше это делало такое назначение необратимым: снять
 * ошибочно назначенного человека можно было только правкой в базе руками.
 * Диспетчер по-прежнему снимает только председателя дома СВОЕЙ
 * организации; у оператора такой границы нет.
 */
export async function revokeChairman(
  db: Database,
  by: ChairmanAppointer,
  chairmanId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: chairman.id, orgId: chairman.orgId })
    .from(chairman)
    .where(and(eq(chairman.id, chairmanId), isNull(chairman.revokedAt)))
    .limit(1);

  const found = rows[0];
  if (!found) return false;
  if (by.kind === 'dispatcher' && found.orgId !== by.orgId) return false;

  await db.update(chairman).set({ revokedAt: new Date() }).where(eq(chairman.id, chairmanId));
  return true;
}

/** Председатели домов этой УК: и действующие, и снятые. */
export async function listChairmen(db: Database, ukId: string) {
  const rows = await db
    .select({
      id: chairman.id,
      houseKey: chairman.houseKey,
      name: chairman.name,
      flat: chairman.flat,
      createdAt: chairman.createdAt,
      revokedAt: chairman.revokedAt,
      viaMax: appUser.maxUserId,
      phone: appUser.phone,
    })
    .from(chairman)
    .innerJoin(appUser, eq(chairman.userId, appUser.id))
    .where(eq(chairman.orgId, ukId))
    .orderBy(desc(chairman.createdAt));

  return rows.map((c) => ({
    id: c.id,
    houseKey: c.houseKey,
    name: c.name,
    flat: c.flat,
    phone: c.phone,
    viaMax: c.viaMax !== null,
    createdAt: c.createdAt,
    revokedAt: c.revokedAt,
    active: c.revokedAt === null,
  }));
}

/** Действующий председатель дома — его имя видят жители под объявлениями. */
export async function chairmanOfHouse(db: Database, houseKey: string) {
  const rows = await db
    .select()
    .from(chairman)
    .where(and(eq(chairman.houseKey, houseKey), isNull(chairman.revokedAt)))
    .limit(1);
  return rows[0] ?? null;
}
