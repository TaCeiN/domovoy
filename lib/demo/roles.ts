import { and, desc, eq, ne } from 'drizzle-orm';
import { appUser, demoRelease, demoRole, session } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { createSession, destroyAllSessionsForUser } from '../auth/session.ts';
import type { Database } from '../../db/client.ts';
import { avatarKind, type AvatarKind } from '../auth/avatar.ts';
import { DEMO_ROLES } from './constants.ts';

export interface RoleView {
  key: string;
  title: string;
  subtitle: string;
  holderName: string | null;
  heldSince: Date | null;
  mine: boolean;
  avatar: AvatarKind | null;
}

/** Роли демо-дома со статусом — для экрана «Демо-дом» */
export async function listRoles(db: Database, maxUserId: number): Promise<RoleView[]> {
  const rows = await db.select().from(demoRole).orderBy(demoRole.position);
  return rows.map((r) => ({
    key: r.key, title: r.title, subtitle: r.subtitle,
    // Аватар персонажа — по его ФИО, как в профиле (lib/auth/avatar.ts)
    avatar: avatarKind(DEMO_ROLES.find((p) => p.key === r.key)?.name),
    holderName: r.holderMaxUserId ? r.holderName : null,
    heldSince: r.holderMaxUserId ? r.heldSince : null,
    mine: r.holderMaxUserId === maxUserId,
  }));
}

export type TakeResult =
  | { ok: true; token: string; expiresAt: Date }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'taken'; holderName: string | null; heldSince: Date | null }
  | { ok: false; reason: 'has_own'; ownName: string };

/**
 * Взять роль демо-дома.
 *
 * Роль — персонаж: его `max_user_id` становится аккаунтом эксперта, и
 * дальше работают обычный вход (/api/auth/max) и бот. Занятую роль берём
 * только с `takeover` — прежний держатель отвязывается, его сессии гаснут,
 * а в `demo_release` остаётся след для плашки «Вашу роль передали».
 *
 * У эксперта уже есть свой житель (уникальный `app_user_max_uq`) — без
 * `unlinkMine` отказываем; с ним — его житель остаётся, но без MAX.
 * Своя прежняя демо-роль освобождается молча: роль у эксперта одна.
 */
export async function takeRole(
  db: Database,
  input: {
    key: string; maxUserId: number; maxChatId: number | null; name: string;
    takeover?: boolean; unlinkMine?: boolean; now?: Date;
  },
): Promise<TakeResult> {
  const now = input.now ?? new Date();
  const [role] = await db.select().from(demoRole).where(eq(demoRole.key, input.key)).limit(1);
  if (!role) return { ok: false, reason: 'not_found' };

  if (role.holderMaxUserId && role.holderMaxUserId !== input.maxUserId && !input.takeover) {
    return { ok: false, reason: 'taken', holderName: role.holderName, heldSince: role.heldSince };
  }

  const [already] = await db.select().from(appUser)
    .where(and(eq(appUser.maxUserId, input.maxUserId), ne(appUser.id, role.userId))).limit(1);
  if (already) {
    const [ownRole] = await db.select().from(demoRole).where(eq(demoRole.userId, already.id)).limit(1);
    if (ownRole) {
      await db.update(demoRole).set({ holderMaxUserId: null, holderName: null, heldSince: null })
        .where(eq(demoRole.key, ownRole.key));
    } else if (!input.unlinkMine) {
      return { ok: false, reason: 'has_own', ownName: already.fullName };
    }
    await db.update(appUser).set({ maxUserId: null, maxChatId: null }).where(eq(appUser.id, already.id));
    await destroyAllSessionsForUser(db, already.id);
  }

  if (role.holderMaxUserId && role.holderMaxUserId !== input.maxUserId) {
    await db.insert(demoRelease).values({
      id: newId('drl'), maxUserId: role.holderMaxUserId, roleKey: role.key, releasedAt: now,
    });
    await destroyMaxSessions(db, role.userId);
  }

  await db.update(appUser).set({ maxUserId: input.maxUserId, maxChatId: input.maxChatId })
    .where(eq(appUser.id, role.userId));
  await db.update(demoRole)
    .set({ holderMaxUserId: input.maxUserId, holderName: input.name, heldSince: now })
    .where(eq(demoRole.key, role.key));

  const session = await createSession(db, role.userId, 'max');
  return { ok: true, token: session.token, expiresAt: session.expiresAt };
}

/**
 * Потерял ли этот аккаунт MAX роль — и какую.
 * Только если сейчас он ничего не держит: иначе потеря уже не новость.
 */
export async function releasedFor(
  db: Database,
  maxUserId: number,
): Promise<{ roleKey: string; roleTitle: string; releasedAt: Date } | null> {
  const [holding] = await db.select({ key: demoRole.key }).from(demoRole)
    .where(eq(demoRole.holderMaxUserId, maxUserId)).limit(1);
  if (holding) return null;
  const [last] = await db.select().from(demoRelease)
    .where(eq(demoRelease.maxUserId, maxUserId)).orderBy(desc(demoRelease.releasedAt)).limit(1);
  if (!last) return null;
  const [role] = await db.select({ title: demoRole.title }).from(demoRole).where(eq(demoRole.key, last.roleKey)).limit(1);
  return { roleKey: last.roleKey, roleTitle: role?.title ?? last.roleKey, releasedAt: last.releasedAt };
}

/**
 * Вход в роль из обычного браузера: сессия персонажа, держатель не меняется.
 * Аккаунта MAX тут нет — держать роль нечем, и выбивать никого нельзя.
 */
export async function enterRole(
  db: Database,
  key: string,
): Promise<{ ok: true; token: string; expiresAt: Date } | { ok: false; reason: 'not_found' }> {
  const [role] = await db.select().from(demoRole).where(eq(demoRole.key, key)).limit(1);
  if (!role) return { ok: false, reason: 'not_found' };
  const created = await createSession(db, role.userId, 'web');
  return { ok: true, token: created.token, expiresAt: created.expiresAt };
}

/** Освободить роль из кабинета оператора: держатель отвязан, в журнале потерь */
export async function releaseRole(db: Database, key: string, now = new Date()): Promise<boolean> {
  const [role] = await db.select().from(demoRole).where(eq(demoRole.key, key)).limit(1);
  if (!role) return false;
  if (role.holderMaxUserId) {
    await db.insert(demoRelease).values({
      id: newId('drl'), maxUserId: role.holderMaxUserId, roleKey: role.key, releasedAt: now,
    });
  }
  await db.update(appUser).set({ maxUserId: null, maxChatId: null }).where(eq(appUser.id, role.userId));
  await db.update(demoRole).set({ holderMaxUserId: null, holderName: null, heldSince: null })
    .where(eq(demoRole.key, key));
  await destroyMaxSessions(db, role.userId);
  return true;
}

/** Гасим только MAX-сессии персонажа: браузерные эксперты остаются внутри */
async function destroyMaxSessions(db: Database, userId: string): Promise<void> {
  await db.delete(session).where(and(eq(session.userId, userId), eq(session.platform, 'max')));
}
