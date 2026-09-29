import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';
import { appUser, demoRole, session } from '../../db/schema.ts';
import { seedDemo } from './seed.ts';
import { listRoles, takeRole, releasedFor, enterRole } from './roles.ts';
import { newId } from '../ids.ts';

process.env.UPLOADS_DIR = join(tmpdir(), 'domovoy-test-uploads-demo');

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); await seedDemo(testDb()); });

const ivan = { maxUserId: 7001, maxChatId: 8001, name: 'Иван П.' };
const maria = { maxUserId: 7002, maxChatId: 8002, name: 'Мария К.' };

test('свободную роль берут сразу — персонаж получает аккаунт MAX', async () => {
  const db = testDb();
  const res = await takeRole(db, { key: 'chairman', ...ivan });
  assert.equal(res.ok, true);
  const [role] = await db.select().from(demoRole).where(eq(demoRole.key, 'chairman'));
  const [user] = await db.select().from(appUser).where(eq(appUser.id, role.userId));
  assert.equal(user.maxUserId, ivan.maxUserId);
  assert.equal(role.holderName, 'Иван П.');
  const list = await listRoles(db, ivan.maxUserId);
  assert.equal(list.find((r) => r.key === 'chairman')?.mine, true);
});

test('занятую без согласия не отдаём, с согласием — прежний держатель отвязан', async () => {
  const db = testDb();
  await takeRole(db, { key: 'chairman', ...ivan });

  const refused = await takeRole(db, { key: 'chairman', ...maria });
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.reason, 'taken');
    assert.equal(refused.holderName, 'Иван П.');
  }

  const taken = await takeRole(db, { key: 'chairman', ...maria, takeover: true });
  assert.equal(taken.ok, true);
  const lost = await releasedFor(db, ivan.maxUserId);
  assert.equal(lost?.roleKey, 'chairman');
  assert.equal(await releasedFor(db, maria.maxUserId), null);
});

test('вторая роль тому же эксперту освобождает первую', async () => {
  const db = testDb();
  await takeRole(db, { key: 'owner12', ...ivan });
  await takeRole(db, { key: 'owner45', ...ivan });
  const list = await listRoles(db, ivan.maxUserId);
  assert.equal(list.find((r) => r.key === 'owner12')?.holderName, null);
  assert.equal(list.find((r) => r.key === 'owner45')?.mine, true);
});

test('свой настоящий житель — только с согласием отвязать', async () => {
  const db = testDb();
  const own = newId('usr');
  await db.insert(appUser).values({ id: own, fullName: 'Свой Житель', maxUserId: ivan.maxUserId });

  const refused = await takeRole(db, { key: 'owner78', ...ivan });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, 'has_own');

  const ok = await takeRole(db, { key: 'owner78', ...ivan, unlinkMine: true });
  assert.equal(ok.ok, true);
  const [mine] = await db.select().from(appUser).where(eq(appUser.id, own));
  assert.equal(mine.maxUserId, null, 'свой житель остался, но без MAX');
});

test('несуществующая роль — не найдена', async () => {
  const res = await takeRole(testDb(), { key: 'nope', ...ivan });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'not_found');
});

test('из браузера роль открывается без держателя и никого не выбивает', async () => {
  const db = testDb();
  await takeRole(db, { key: 'chairman', ...ivan });

  const web = await enterRole(db, 'chairman');
  assert.equal(web.ok, true);
  const list = await listRoles(db, ivan.maxUserId);
  assert.equal(list.find((r) => r.key === 'chairman')?.mine, true, 'держатель в MAX прежний');

  await takeRole(db, { key: 'chairman', ...maria, takeover: true });
  const [role] = await db.select().from(demoRole).where(eq(demoRole.key, 'chairman'));
  const left = await db.select().from(session).where(eq(session.userId, role.userId));
  assert.ok(left.some((s) => s.platform === 'web'), 'браузерная сессия пережила перехват');
});
