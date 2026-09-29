import { and, asc, eq, sql } from 'drizzle-orm';
import { appUser, houseClaim, property, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { notify } from '../notify/index.ts';
import type { Database } from '../../db/client.ts';

export interface HouseClaimRow {
  id: string;
  houseKey: string;
  /** Адрес для оператора: из реестра, а если дома там нет — из квитанции жителя */
  address: string;
  userId: string;
  userName: string;
  note: string | null;
  createdAt: Date;
}

export type OpenClaimResult =
  | { ok: true; id: string; created: boolean }
  | { ok: false; reason: 'not_a_resident' };

export const CLAIM_NOTE_MAX = 300;

/**
 * Житель просит подключить свой дом.
 *
 * Просить может только тот, кто к дому привязан, — включая
 * НЕПОДТВЕРЖДЁННОГО: подтверждать его как раз и некому, ради этого
 * заявка и существует.
 */
export async function openHouseClaim(
  db: Database,
  input: { houseKey: string; userId: string; note?: string },
): Promise<OpenClaimResult> {
  const [binding] = await db
    .select({ id: userProperty.id })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .where(and(
      eq(userProperty.userId, input.userId),
      eq(property.houseKey, input.houseKey),
    ))
    .limit(1);
  if (!binding) return { ok: false, reason: 'not_a_resident' };

  const [existing] = await db
    .select({ id: houseClaim.id })
    .from(houseClaim)
    .where(and(
      eq(houseClaim.houseKey, input.houseKey),
      eq(houseClaim.userId, input.userId),
      eq(houseClaim.status, 'open'),
    ))
    .limit(1);
  if (existing) return { ok: true, id: existing.id, created: false };

  const id = newId('hcl');
  /**
   * Гонка двойного тапа: два одновременных запроса проходят SELECT выше,
   * не находя открытой заявки, и оба вставляют. Частичный уникальный
   * индекс house_claim_open_uq пропустит только одного, второму вместо
   * исключения базы (23505) отдаём уже вставленную строку — жителю нужен
   * тот же ответ «заявка подана», а не ошибка сервера на ровном месте.
   * Тот же приём — lib/auth/bind.ts, upsertAccount.
   */
  const rows = await db
    .insert(houseClaim)
    .values({
      id,
      houseKey: input.houseKey,
      userId: input.userId,
      note: input.note?.trim().slice(0, CLAIM_NOTE_MAX) || null,
      status: 'open',
    })
    .onConflictDoNothing({
      target: [houseClaim.houseKey, houseClaim.userId],
      where: sql`${houseClaim.status} = 'open'`,
    })
    .returning({ id: houseClaim.id });

  if (rows[0]) return { ok: true, id: rows[0].id, created: true };

  const [raced] = await db
    .select({ id: houseClaim.id })
    .from(houseClaim)
    .where(and(
      eq(houseClaim.houseKey, input.houseKey),
      eq(houseClaim.userId, input.userId),
      eq(houseClaim.status, 'open'),
    ))
    .limit(1);
  return { ok: true, id: raced.id, created: false };
}

/** Очередь оператора: самые старые первыми. */
export async function openHouseClaims(db: Database): Promise<HouseClaimRow[]> {
  const rows = await db
    .select({
      id: houseClaim.id,
      houseKey: houseClaim.houseKey,
      address: sql<string | null>`coalesce(
        (select h.address_raw from house h where h.house_key = ${houseClaim.houseKey}),
        (select min(p.address_raw) from property p where p.house_key = ${houseClaim.houseKey}))`,
      userId: houseClaim.userId,
      userName: appUser.fullName,
      note: houseClaim.note,
      createdAt: houseClaim.createdAt,
    })
    .from(houseClaim)
    .innerJoin(appUser, eq(houseClaim.userId, appUser.id))
    .where(eq(houseClaim.status, 'open'))
    .orderBy(asc(houseClaim.createdAt));

  return rows.map((r) => ({ ...r, address: r.address ?? r.houseKey, userName: r.userName ?? 'без имени' }));
}

/**
 * Открытые заявки человека — по каким домам он уже попросил подключение.
 *
 * ЗАЧЕМ. Пока этого не было, заявка уходила в одну сторону: `/api/me`
 * о ней не знал, экран после отправки не менялся ни на букву, и человек
 * видел ту же кнопку с тем же текстом «расскажите о доме — мы подключим
 * его вручную. Это делается один раз». Проверено на живом стенде
 * 11 сентября: единственным следом был тост, исчезающий за секунды.
 */
export async function openClaimsOf(
  db: Database,
  userId: string,
): Promise<Map<string, Date>> {
  const rows = await db
    .select({ houseKey: houseClaim.houseKey, createdAt: houseClaim.createdAt })
    .from(houseClaim)
    .where(and(eq(houseClaim.userId, userId), eq(houseClaim.status, 'open')));

  return new Map(rows.map((r) => [r.houseKey, r.createdAt]));
}

export async function decideHouseClaim(
  db: Database,
  id: string,
  status: 'done' | 'rejected',
  by: string,
  /** Причина отказа — человек должен понимать, что делать дальше */
  reason?: string,
): Promise<boolean> {
  const rows = await db
    .update(houseClaim)
    .set({ status, decidedAt: new Date(), decidedBy: by })
    .where(and(eq(houseClaim.id, id), eq(houseClaim.status, 'open')))
    .returning({ id: houseClaim.id, userId: houseClaim.userId });

  const decided = rows[0];
  if (!decided) return false;

  /**
   * Сказать человеку, чем кончилось.
   *
   * Ни «сделано», ни «отказано» не доводились до него ничем. Отказ был
   * невидим полностью: следующее нажатие заводило новую открытую заявку,
   * и человек подавал её бесконечно, ни разу не узнав о решении.
   *
   * Ошибку глотаем: упавший канал не отменяет решения оператора.
   */
  await notify(db, {
    userId: decided.userId,
    kind: 'access_request',
    title: status === 'done' ? 'Ваш дом подключён' : 'Заявку на подключение дома отклонили',
    body: status === 'done'
      ? 'Мы завели ваш дом в сервисе. Откройте приложение — разделы дома уже работают.'
      : (reason?.trim() || 'Причина не указана. Напишите в управляющую организацию своего дома.'),
    deepLinkPayload: 'home',
  }).catch(() => undefined);

  return true;
}
