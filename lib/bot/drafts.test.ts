import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { createDraft, readDraft, markDraftUsed, DRAFT_TTL_MS } from './drafts.ts';
import { appUser, botDraft, property } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';

/**
 * Черновик жалобы от бота.
 *
 * Главное — чужой черновик не открывается ни чтением, ни отметкой
 * «отправлен», а отправленный второй раз форму не заполняет.
 */

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';
const db = () => testDb();
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await closeTestDb(); });

async function seed() {
  const anna = newId('usr');
  const oleg = newId('usr');
  await db().insert(appUser).values([{ id: anna, fullName: 'Анна' }, { id: oleg, fullName: 'Олег' }]);
  const propertyId = newId('prp');
  await db().insert(property).values({
    id: propertyId, houseKey: 'bot-draft-test', addressRaw: 'ул Тестовая, д 1, кв 1', flat: '1',
  });
  return { anna, oleg, propertyId };
}

const WATER = { category: 'Сантехника', text: 'В квартире нет воды уже 15 дней.' };

test('свой черновик читается, чужой — нет', { skip }, async () => {
  const { anna, oleg, propertyId } = await seed();
  const id = await createDraft(db(), { userId: anna, propertyId, ...WATER });
  assert.match(id, /^bdr_/);

  assert.deepEqual(await readDraft(db(), anna, id), { propertyId, ...WATER });
  assert.equal(await readDraft(db(), oleg, id), null);
  assert.equal(await readDraft(db(), anna, 'bdr_NOPE'), null);
});

test('черновик старше суток не выдаётся', { skip }, async () => {
  const { anna, propertyId } = await seed();
  const id = await createDraft(db(), { userId: anna, propertyId, ...WATER });
  await db().update(botDraft)
    .set({ createdAt: new Date(Date.now() - DRAFT_TTL_MS - 1000) })
    .where(eq(botDraft.id, id));
  assert.equal(await readDraft(db(), anna, id), null);
});

test('отправленный черновик второй раз форму не заполняет; чужой не отметить', { skip }, async () => {
  const { anna, oleg, propertyId } = await seed();
  const id = await createDraft(db(), { userId: anna, propertyId, ...WATER });

  await markDraftUsed(db(), oleg, id);
  assert.notEqual(await readDraft(db(), anna, id), null, 'сосед не может «отправить» чужой черновик');

  await markDraftUsed(db(), anna, id);
  assert.equal(await readDraft(db(), anna, id), null);
});
