import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { eq, and, gt, lt, isNull } from 'drizzle-orm';
import { session, appUser, userProperty, dispatcher, chairman, admin } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import type { Database } from '../../db/client.ts';
import { PLACEHOLDER_NAME } from './names.ts';

/**
 * Сессии живут в базе, а не в JWT.
 *
 * Причина конкретная: собственник может отозвать доступ у домочадца.
 * Со stateless-токеном отозванный продолжал бы работать до истечения срока —
 * то есть кнопка «отозвать доступ» врала бы пользователю. Один лишний
 * запрос к базе на запрос — приемлемая цена за честный отзыв.
 *
 * В базе лежит только ХЕШ токена: утечка дампа не даёт войти под чужой
 * сессией, как и с паролями.
 */

export const SESSION_COOKIE = 'zd_session';
export const SESSION_TTL_DAYS = 30;

export interface SessionUser {
  id: string;
  fullName: string;
  maxUserId: number | null;
  phoneVerified: boolean;
  /** Фото из MAX — аватар в профиле; нет — рисуем Домового по ФИО */
  maxPhotoUrl?: string | null;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Database,
  userId: string,
  platform: 'max' | 'web',
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  await db.insert(session).values({
    id: newId('ses'),
    userId,
    tokenHash: hashToken(token),
    platform,
    expiresAt,
  });

  return { token, expiresAt };
}

export async function resolveSession(
  db: Database,
  token: string | undefined,
): Promise<SessionUser | null> {
  if (!token) return null;

  const rows = await db
    .select({
      userId: appUser.id,
      fullName: appUser.fullName,
      maxUserId: appUser.maxUserId,
      maxPhotoUrl: appUser.maxPhotoUrl,
      phoneVerifiedAt: appUser.phoneVerifiedAt,
    })
    .from(session)
    .innerJoin(appUser, eq(session.userId, appUser.id))
    .where(and(eq(session.tokenHash, hashToken(token)), gt(session.expiresAt, new Date())))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.userId,
    fullName: row.fullName,
    maxUserId: row.maxUserId,
    phoneVerified: row.phoneVerifiedAt !== null,
    maxPhotoUrl: row.maxPhotoUrl,
  };
}

export interface SessionDispatcher {
  id: string;
  ukId: string;
  name: string;
}

export async function createDispatcherSession(
  db: Database,
  dispatcherId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  // Кабинет — рабочее место: смена короче, чем сессия жителя
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

  await db.insert(session).values({
    id: newId('ses'),
    dispatcherId,
    tokenHash: hashToken(token),
    platform: 'web',
    expiresAt,
  });

  return { token, expiresAt };
}

export async function resolveDispatcherSession(
  db: Database,
  token: string | undefined,
): Promise<SessionDispatcher | null> {
  if (!token) return null;

  const rows = await db
    .select({ id: dispatcher.id, ukId: dispatcher.orgId, name: dispatcher.name })
    .from(session)
    .innerJoin(dispatcher, eq(session.dispatcherId, dispatcher.id))
    .where(and(eq(session.tokenHash, hashToken(token)), gt(session.expiresAt, new Date())))
    .limit(1);

  return rows[0] ?? null;
}

export interface SessionAdmin {
  id: string;
  login: string;
  name: string;
}

export async function createAdminSession(
  db: Database,
  adminId: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  // Тот же срок, что у кабинета УК: это рабочее место, а не телефон
  const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

  await db.insert(session).values({
    id: newId('ses'),
    adminId,
    tokenHash: hashToken(token),
    platform: 'web',
    expiresAt,
  });

  return { token, expiresAt };
}

/**
 * Выключенный оператор доступа не имеет — и прежняя его сессия тоже.
 *
 * Проверка `disabled_at` стоит ЗДЕСЬ, а не только при входе: иначе
 * выключение учётки действовало бы со следующего входа, то есть
 * не действовало бы вовсе — у того, кто уже вошёл, остаются двенадцать
 * часов полного доступа ко всем домам.
 */
export async function resolveAdminSession(
  db: Database,
  token: string | undefined,
): Promise<SessionAdmin | null> {
  if (!token) return null;

  const rows = await db
    .select({ id: admin.id, login: admin.login, name: admin.name })
    .from(session)
    .innerJoin(admin, eq(session.adminId, admin.id))
    .where(and(
      eq(session.tokenHash, hashToken(token)),
      gt(session.expiresAt, new Date()),
      isNull(admin.disabledAt),
    ))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Председатель совета дома — РОЛЬ, а не отдельный вход.
 *
 * ЧТО ИЗМЕНИЛОСЬ. Раньше у председателя была своя учётка с логином
 * и паролем, своя сессия и отдельная веб-страница. На деле председатель —
 * такой же житель этого дома: та же квартира, та же квитанция, тот же
 * счётчик. Второй аккаунт заставлял человека помнить, «под кем он
 * сейчас», а в советах домов большинство — люди старшего возраста,
 * для которых это худший вид путаницы.
 *
 * Теперь права выводятся из сессии ЖИТЕЛЯ: есть ли у его `app_user`
 * действующая строка в `chairman`. Никакого второго входа.
 */
export interface ChairmanRole {
  id: string;
  /** Управляющая организация — если она у дома есть (см. db/schema.ts, chairman.org_id). */
  ukId: string | null;
  houseKey: string;
  name: string;
}

/**
 * Председательство пользователя.
 *
 * Возвращает массив: формально ничто не мешает человеку возглавлять
 * совет в двух домах — например, живя в одном и владея квартирой
 * в соседнем. На практике это редкость, но исключать её незачем.
 */
export async function chairmanRolesOf(
  db: Database,
  userId: string,
): Promise<ChairmanRole[]> {
  return db
    .select({
      id: chairman.id,
      ukId: chairman.orgId,
      houseKey: chairman.houseKey,
      name: chairman.name,
    })
    .from(chairman)
    .where(and(eq(chairman.userId, userId), isNull(chairman.revokedAt)));
}

/** Председательство в конкретном доме — или null. */
export async function chairmanOf(
  db: Database,
  userId: string,
  houseKey: string,
): Promise<ChairmanRole | null> {
  const rows = await db
    .select({
      id: chairman.id,
      ukId: chairman.orgId,
      houseKey: chairman.houseKey,
      name: chairman.name,
    })
    .from(chairman)
    .where(and(
      eq(chairman.userId, userId),
      eq(chairman.houseKey, houseKey),
      isNull(chairman.revokedAt),
    ))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Снятия сессий председателя больше не требуется.
 *
 * Его права проверяются по таблице `chairman` на КАЖДОМ запросе, а не
 * зашиваются в сессию при входе. Снятие с должности закрывает доступ
 * в ту же секунду само по себе — гасить нечего.
 */

/** Выход: убиваем одну сессию. */
export async function destroySession(db: Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(session).where(eq(session.tokenHash, hashToken(token)));
}

/**
 * Отзыв доступа домочадца обязан убить все его сессии немедленно —
 * иначе кнопка «отозвать» не делает того, что обещает.
 */
export async function destroyAllSessionsForUser(db: Database, userId: string): Promise<void> {
  await db.delete(session).where(eq(session.userId, userId));
}

/**
 * Уборка протухших сессий.
 *
 * Раньше эта функция не вызывалась ниоткуда, а таблица росла вечно:
 * мини-приложение создаёт новую сессию при КАЖДОМ запуске
 * (`POST /api/auth/max`) и при каждом молчаливом перелогине после 401,
 * а срок жизни строки — тридцать суток. Теперь её зовёт `startSessionCleanup`.
 *
 * Два исправления по дороге. Условие было записано как
 * `gt(new Date() as never, session.expiresAt)` — приведение к `never`
 * означало, что типизацию преодолели силой; штатная форма — `lt`.
 * И фильтр `isNull(session.dispatcherId)` оставлял протухшие сессии
 * диспетчеров навсегда, хотя они как раз самые короткие (12 часов).
 */
export async function purgeExpiredSessions(db: Database): Promise<number> {
  const removed = await db
    .delete(session)
    .where(lt(session.expiresAt, new Date()))
    .returning({ id: session.id });
  return removed.length;
}

/**
 * Периодическая уборка. Таймер не держит процесс живым (`unref`):
 * иначе скрипты и тесты, поднимающие приложение, не завершались бы.
 */
export function startSessionCleanup(
  db: Database,
  intervalMs = 6 * 60 * 60 * 1000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    purgeExpiredSessions(db).catch(() => { /* уборка не повод падать */ });
  }, intervalMs);
  timer.unref();
  return timer;
}

/** Сравнение секретов с постоянным временем. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Найти или завести человека по подписи MAX.
 *
 * Нужно там, где входным билетом служит не квитанция, а что-то ещё —
 * сегодня это приглашение жильца. Такой человек приходит совсем новым:
 * ни привязок, ни сессии у него нет, а личность за него подтверждает
 * платформа. Отдельная функция, потому что `resolveUser` в `bind.ts`
 * завязан на квитанцию, которой здесь нет.
 */
export async function findOrCreateMaxUser(
  db: Database,
  identity: {
    maxUserId: number;
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
    photoUrl?: string | null;
    chatId?: number | null;
  },
) {
  const [existing] = await db
    .select()
    .from(appUser)
    .where(eq(appUser.maxUserId, identity.maxUserId))
    .limit(1);

  if (existing) {
    // chat_id мог появиться только сейчас — без него уведомление слать некуда.
    // Фото — тоже: сменил аватар в MAX — в профиле должен быть новый
    const changes: { maxChatId?: number; maxPhotoUrl?: string } = {};
    if (identity.chatId && existing.maxChatId !== identity.chatId) changes.maxChatId = identity.chatId;
    if (identity.photoUrl && existing.maxPhotoUrl !== identity.photoUrl) changes.maxPhotoUrl = identity.photoUrl;
    if (Object.keys(changes).length) {
      await db.update(appUser).set(changes).where(eq(appUser.id, existing.id));
      return { ...existing, ...changes };
    }
    return existing;
  }

  const fullName = [identity.lastName, identity.firstName].filter(Boolean).join(' ')
    || identity.firstName
    || PLACEHOLDER_NAME;

  const [created] = await db
    .insert(appUser)
    .values({
      id: newId('usr'),
      fullName,
      maxUserId: identity.maxUserId,
      maxUsername: identity.username ?? null,
      maxPhotoUrl: identity.photoUrl ?? null,
      maxChatId: identity.chatId ?? null,
    })
    .returning();

  return created;
}
