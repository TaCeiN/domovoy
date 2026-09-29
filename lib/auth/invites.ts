import { and, desc, eq, isNull } from 'drizzle-orm';
import { invite, property, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import type { Database } from '../../db/client.ts';

/**
 * Приглашение жильца собственником.
 *
 * ЗАЧЕМ. Квитанция на квартиру одна, и лежит она у собственника. Жена,
 * сын, съёмщик — все они предъявляли ту же платёжку и вставали в очередь
 * к председателю наравне с посторонним. Теперь собственник зовёт их сам:
 * он знает, кто у него живёт, лучше любого председателя.
 *
 * ГРАНИЦЫ, КОТОРЫЕ ДЕРЖАТ ЭТО ОТ ПРЕВРАЩЕНИЯ В ДЫРУ:
 *   — зовёт только ПОДТВЕРЖДЁННЫЙ собственник и только на СВОЮ квартиру;
 *   — приглашённый входит жильцом, а не собственником: вторым владельцем
 *     квартиры себя не назначить;
 *   — код одноразовый и живёт 48 часов, иначе пересланная в чат ссылка
 *     остаётся ключом от квартиры навсегда;
 *   — отозвать можно в любой момент, пока им не воспользовались.
 */

/** 48 часов: успеть переслать и дождаться, пока человек дойдёт до телефона. */
export const INVITE_TTL_MS = 48 * 60 * 60 * 1000;

/**
 * Алфавит кода.
 *
 * Без 0/О, 1/І и прочих пар, которые путаются на слух и на вид: код
 * диктуют голосом пожилому человеку, и «ноль или буква о» — это второй
 * звонок и испорченное впечатление. Только заглавная латиница и цифры,
 * которые ни с чем не спутать.
 */
const ALPHABET = 'ACEFHJKLMNPRTUVWXY34679';
const CODE_LENGTH = 6;

function makeCode(): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/** Код приходит от человека: пробелы, дефисы и регистр не должны мешать. */
export function normalizeCode(raw: string): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export type CreateInviteResult =
  | { ok: true; invite: { id: string; code: string; expiresAt: Date } }
  | { ok: false; reason: 'not_owner' };

/** Создать приглашение. Право на это есть только у подтверждённого собственника. */
export async function createInvite(
  db: Database,
  userId: string,
  propertyId: string,
): Promise<CreateInviteResult> {
  const [owner] = await db
    .select({ id: userProperty.id })
    .from(userProperty)
    .where(and(
      eq(userProperty.userId, userId),
      eq(userProperty.propertyId, propertyId),
      eq(userProperty.status, 'active'),
      eq(userProperty.role, 'owner'),
    ))
    .limit(1);

  if (!owner) return { ok: false, reason: 'not_owner' };

  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  /**
   * Совпадение кода почти невероятно, но уникальный индекс всё равно
   * стоит: вторая попытка дешевле, чем непонятная пятисотка у человека.
   */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = makeCode();
    const rows = await db
      .insert(invite)
      .values({
        id: newId('inv'),
        propertyId,
        createdBy: userId,
        code,
        role: 'member',
        expiresAt,
      })
      .onConflictDoNothing({ target: invite.code })
      .returning({ id: invite.id, code: invite.code, expiresAt: invite.expiresAt });

    if (rows[0]) return { ok: true, invite: rows[0] };
  }

  throw new Error('не удалось выдать код приглашения');
}

/** Действующие приглашения квартиры — то, что показываем собственнику. */
export async function listInvites(db: Database, userId: string, propertyId: string) {
  const [owner] = await db
    .select({ id: userProperty.id })
    .from(userProperty)
    .where(and(
      eq(userProperty.userId, userId),
      eq(userProperty.propertyId, propertyId),
      eq(userProperty.status, 'active'),
      eq(userProperty.role, 'owner'),
    ))
    .limit(1);

  if (!owner) return [];

  const rows = await db
    .select()
    .from(invite)
    .where(and(
      eq(invite.propertyId, propertyId),
      isNull(invite.usedAt),
      isNull(invite.revokedAt),
    ))
    .orderBy(desc(invite.createdAt));

  // Истёкшие не показываем: они уже ничего не открывают
  return rows
    .filter((r) => r.expiresAt.getTime() > Date.now())
    .map((r) => ({ id: r.id, code: r.code, expiresAt: r.expiresAt }));
}

/** Отозвать приглашение может тот, кто его выдал. */
export async function revokeInvite(
  db: Database,
  userId: string,
  inviteId: string,
): Promise<boolean> {
  const [found] = await db
    .select({ id: invite.id, createdBy: invite.createdBy, usedAt: invite.usedAt })
    .from(invite)
    .where(eq(invite.id, inviteId))
    .limit(1);

  if (!found || found.createdBy !== userId || found.usedAt) return false;

  await db.update(invite).set({ revokedAt: new Date() }).where(eq(invite.id, inviteId));
  return true;
}

export type RedeemProblem =
  | 'not_found'
  | 'expired'
  | 'used'
  | 'revoked'
  | 'already_bound';

export type RedeemResult =
  | { ok: true; propertyId: string; addressRaw: string }
  | { ok: false; reason: RedeemProblem };

/** Коды и тексты держим рядом с причинами: маршрут отвечает одинаково везде. */
export const REDEEM_CODES: Record<RedeemProblem, number> = {
  not_found: 404,
  expired: 410,
  used: 409,
  revoked: 410,
  already_bound: 409,
};

export const REDEEM_MESSAGES: Record<RedeemProblem, string> = {
  not_found: 'Такого кода нет. Проверьте, всё ли верно, или попросите новый',
  expired: 'Срок приглашения истёк — попросите собственника прислать новое',
  used: 'Этим приглашением уже воспользовались. Нужен новый код',
  revoked: 'Приглашение отозвано — попросите собственника прислать новое',
  already_bound: 'Эта квартира у вас уже есть',
};

/**
 * Принять приглашение.
 *
 * Доступ открывается СРАЗУ и полностью: за человека поручился собственник,
 * и ждать председателя ему незачем. Роль — «жилец»: собственник у квартиры
 * остаётся один, это правило базы, а не интерфейса.
 */
export async function redeemInvite(
  db: Database,
  userId: string,
  rawCode: string,
): Promise<RedeemResult> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, reason: 'not_found' };

  const [found] = await db
    .select()
    .from(invite)
    .where(eq(invite.code, code))
    .limit(1);

  if (!found) return { ok: false, reason: 'not_found' };
  if (found.revokedAt) return { ok: false, reason: 'revoked' };
  if (found.usedAt) return { ok: false, reason: 'used' };
  if (found.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'expired' };

  const [addressRow] = await db
    .select({ addressRaw: property.addressRaw })
    .from(property)
    .where(eq(property.id, found.propertyId))
    .limit(1);

  const [existing] = await db
    .select({ id: userProperty.id, status: userProperty.status })
    .from(userProperty)
    .where(and(
      eq(userProperty.userId, userId),
      eq(userProperty.propertyId, found.propertyId),
    ))
    .limit(1);

  /**
   * Уже подтверждён здесь — код не тратим: он ещё пригодится тому,
   * кому его на самом деле передавали.
   */
  if (existing?.status === 'active') return { ok: false, reason: 'already_bound' };

  if (existing) {
    // Ожидающая или отклонённая заявка превращается в подтверждённый доступ
    await db
      .update(userProperty)
      .set({
        status: 'active',
        role: 'member',
        decidedAt: new Date(),
        rejectReason: null,
      })
      .where(eq(userProperty.id, existing.id));
  } else {
    await db.insert(userProperty).values({
      id: newId('ubd'),
      userId,
      propertyId: found.propertyId,
      role: 'member',
      status: 'active',
      inviteCode: found.code,
      decidedAt: new Date(),
      /** Адрес человек не приносил — он пришёл по приглашению собственника */
      addressFromUser: false,
    });
  }

  await db
    .update(invite)
    .set({ usedAt: new Date(), usedBy: userId })
    .where(eq(invite.id, found.id));

  return { ok: true, propertyId: found.propertyId, addressRaw: addressRow?.addressRaw ?? '' };
}
