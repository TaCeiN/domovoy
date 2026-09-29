import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';
import { appUser, property, request, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import { createSession, resolveSession } from '../auth/session.ts';
import { adminRevokeBinding } from './revoke.ts';

const HOUSE = 'ростовская обл|аксайский р-н|садовая ул|17';

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

async function seedBinding(role: 'owner' | 'member', flat = '12') {
  const db = testDb();
  const userId = newId('usr');
  const propertyId = newId('prp');
  const bindingId = newId('ubd');

  await db.insert(appUser).values({ id: userId, fullName: 'Петров Пётр' });
  await db.insert(property).values({
    id: propertyId, addressRaw: 'ул Садовая, д. 17', houseKey: HOUSE, flat,
  });
  await db.insert(userProperty).values({
    id: bindingId, userId, propertyId, role, status: 'active',
  });

  const { token } = await createSession(db, userId, 'max');
  return { userId, propertyId, bindingId, token };
}

test('оператор закрывает доступ, сессии гаснут сразу', async () => {
  const db = testDb();
  const { bindingId, token } = await seedBinding('member');

  const res = await adminRevokeBinding(db, { bindingId, reason: 'Съехал' });
  assert.equal(res.ok, true);

  const [row] = await db.select().from(userProperty).where(eq(userProperty.id, bindingId));
  assert.equal(row.status, 'revoked');
  assert.equal(row.rejectReason, 'Съехал', 'человек видит причину у себя на экране');
  assert.ok(row.decidedAt, 'решение датировано');

  assert.equal(await resolveSession(db, token), null,
    'иначе «закрыть доступ» врёт: вход остаётся рабочим');
});

/**
 * Обычный отзыв собственника не пускает — и правильно, для жителей.
 * Оператору это нужно ровно там, где нужнее всего: захваченный частный
 * дом или ошибочно выданное хозяйство.
 */
test('собственника оператор отозвать может, и вызывающий об этом узнаёт', async () => {
  const db = testDb();
  const { bindingId } = await seedBinding('owner');

  const res = await adminRevokeBinding(db, { bindingId, reason: 'Захват частного дома' });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.wasOwner, true, 'дом остался без владельца — это надо показать человеку');
});

test('без причины отзыва нет', async () => {
  const db = testDb();
  const { bindingId } = await seedBinding('member');

  const res = await adminRevokeBinding(db, { bindingId, reason: '   ' });
  assert.equal(res.ok, false);
  if (res.ok) return;
  assert.equal(res.reason, 'no_reason');

  const [row] = await db.select().from(userProperty).where(eq(userProperty.id, bindingId));
  assert.equal(row.status, 'active', 'привязка не тронута');
});

test('повторный отзыв отвечает отказом, а не молча проходит', async () => {
  const db = testDb();
  const { bindingId } = await seedBinding('member');

  await adminRevokeBinding(db, { bindingId, reason: 'Съехал' });
  const again = await adminRevokeBinding(db, { bindingId, reason: 'Ещё раз' });

  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.reason, 'already_revoked');
});

/**
 * Архив неприкосновенен. Отзыв доступа — про то, что человек больше
 * не войдёт, а не про то, что его жалоб не было.
 */
test('обращения отозванного остаются', async () => {
  const db = testDb();
  const { bindingId, propertyId, userId } = await seedBinding('member');

  await db.insert(request).values({
    id: newId('req'), number: 1, numberScope: `house:${HOUSE}`,
    propertyId, orgId: null, authorId: userId,
    kind: 'complaint', category: 'Другое',
    title: 'Течёт крыша', description: 'Третий подъезд', status: 'new',
  });

  await adminRevokeBinding(db, { bindingId, reason: 'Проверка' });

  const rows = await db.select().from(request).where(eq(request.propertyId, propertyId));
  assert.equal(rows.length, 1, 'удалять обращения нельзя никому, включая оператора');
});
