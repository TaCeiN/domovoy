import { eq } from 'drizzle-orm';
import { userProperty } from '../../db/schema.ts';
import { destroyAllSessionsForUser } from '../auth/session.ts';
import type { Database } from '../../db/client.ts';

/**
 * Оператор закрывает жителю доступ к квартире.
 *
 * ПОЧЕМУ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ ФЛАГ В `revokeBinding`. Та намеренно
 * ОТКАЗЫВАЕТСЯ отзывать собственника: объект остался бы без владельца,
 * и приглашать домочадцев стало бы некому. Для собственника и жильца
 * там разные правила, и это верно — для жителей.
 *
 * Оператору нужно ровно обратное, и нужно именно там, где нужнее всего:
 * захваченный частный дом, ошибочно выданное хозяйство, человек,
 * которого приложение записало собственником по чужой квитанции. Правило
 * разное — значит и путь отдельный, а не флаг, меняющий чужую функцию
 * на противоположную.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Удаления человека и удаления его обращений. Архив
 * неприкосновенен: у жителя остаётся доказательство, что он пожаловался,
 * даже когда доступ закрыт.
 */

export type AdminRevokeResult =
  | { ok: true; userId: string; wasOwner: boolean }
  | { ok: false; reason: 'not_found' | 'no_reason' | 'already_revoked' };

export const REVOKE_REASON_MAX = 300;

export async function adminRevokeBinding(
  db: Database,
  input: { bindingId: string; reason: string },
): Promise<AdminRevokeResult> {
  /**
   * Причина обязательна.
   *
   * Житель видит её на своём экране, и «доступ закрыт, причина
   * не указана» — это то же молчание, от которого продукт уходит.
   */
  const reason = input.reason.trim();
  if (!reason) return { ok: false, reason: 'no_reason' };

  const [binding] = await db
    .select({
      id: userProperty.id,
      userId: userProperty.userId,
      role: userProperty.role,
      status: userProperty.status,
    })
    .from(userProperty)
    .where(eq(userProperty.id, input.bindingId))
    .limit(1);

  if (!binding) return { ok: false, reason: 'not_found' };
  if (binding.status === 'revoked') return { ok: false, reason: 'already_revoked' };

  await db
    .update(userProperty)
    .set({
      status: 'revoked',
      rejectReason: reason.slice(0, REVOKE_REASON_MAX),
      decidedAt: new Date(),
    })
    .where(eq(userProperty.id, binding.id));

  /**
   * Сессии гаснут немедленно — иначе «закрыть доступ» врало бы:
   * у человека остаётся рабочий вход до истечения срока.
   */
  await destroyAllSessionsForUser(db, binding.userId);

  return { ok: true, userId: binding.userId, wasOwner: binding.role === 'owner' };
}
