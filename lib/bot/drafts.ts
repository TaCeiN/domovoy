import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../../db/client.ts';
import { botDraft } from '../../db/schema.ts';
import { newId } from '../ids.ts';

/**
 * Черновик жалобы, который готовит бот MAX.
 *
 * Бот заявок не создаёт — он кладёт сюда переписанный текст, а кнопка
 * `open_app` с `d_<id>` открывает форму жалобы уже заполненной.
 * Отправляет житель, обычным `POST /api/requests`.
 *
 * Сутки, а не час: пожилой человек нажмёт кнопку вечером, а черновик
 * бот составил утром. Дольше незачем — через сутки текст «нет воды
 * 15 дней» уже неправда.
 */
export const DRAFT_TTL_MS = 24 * 3600 * 1000;

export interface DraftInput {
  userId: string;
  propertyId: string;
  category: string;
  text: string;
}

export interface DraftView {
  propertyId: string;
  category: string;
  text: string;
}

export async function createDraft(db: Database, input: DraftInput): Promise<string> {
  const id = newId('bdr');
  await db.insert(botDraft).values({ id, ...input });
  return id;
}

/** Черновик владельца. Чужой, протухший или отправленный — null: форма откроется пустой. */
export async function readDraft(db: Database, userId: string, id: string): Promise<DraftView | null> {
  const [row] = await db.select({
    propertyId: botDraft.propertyId, category: botDraft.category, text: botDraft.text,
  }).from(botDraft).where(and(
    eq(botDraft.id, id),
    eq(botDraft.userId, userId),
    isNull(botDraft.usedAt),
    gt(botDraft.createdAt, new Date(Date.now() - DRAFT_TTL_MS)),
  ));
  return row ?? null;
}

/** Заявку по черновику отправили. Чужой id молча ничего не меняет. */
export async function markDraftUsed(db: Database, userId: string, id: string): Promise<void> {
  await db.update(botDraft)
    .set({ usedAt: new Date() })
    .where(and(eq(botDraft.id, id), eq(botDraft.userId, userId)));
}
