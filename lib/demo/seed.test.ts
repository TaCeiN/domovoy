import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, resetTables, closeTestDb, isDbAvailable } from '../test-db.ts';
import {
  appUser, bill, chairman, demoRole, dispatcher, house, meter, poll, post, property, request, userProperty,
} from '../../db/schema.ts';
import { seedDemo, clearDemo, ensureDemo } from './seed.ts';
import { isDemoEnabled } from './setting.ts';
import { verifyPassword } from '../auth/password.ts';
import { DEMO_HOUSE_KEY, DEMO_ROLES } from './constants.ts';
import { newId } from '../ids.ts';

process.env.UPLOADS_DIR = join(tmpdir(), 'domovoy-test-uploads-demo');

before(async () => {
  if (!(await isDbAvailable())) throw new Error('Нужна база: docker compose up -d db');
});
after(async () => { await closeTestDb(); });
beforeEach(async () => { await resetTables(); });

test('сид заводит дом, роли, историю и кабинет УК', async () => {
  const db = testDb();
  const creds = await seedDemo(db);
  assert.equal(creds.ukLogin, 'demo-uk');
  assert.ok(creds.ukPassword.length >= 8);

  const [h] = await db.select().from(house).where(eq(house.houseKey, DEMO_HOUSE_KEY));
  assert.ok(h.lat && h.lon && h.builtYear, 'паспорт и точка на карте');

  const roles = await db.select().from(demoRole);
  assert.deepEqual(roles.map((r) => r.key).sort(), DEMO_ROLES.map((r) => r.key).sort());

  const [chair] = await db.select().from(chairman).where(eq(chairman.houseKey, DEMO_HOUSE_KEY));
  assert.equal(chair.userId, roles.find((r) => r.key === 'chairman')!.userId);

  const statuses = (await db.select({ s: request.status }).from(request)).map((r) => r.s);
  for (const s of ['new', 'in_work', 'need_info', 'done', 'rejected']) {
    assert.ok(statuses.includes(s), `есть заявка «${s}»`);
  }
  assert.ok((await db.select().from(bill)).length >= 6 * 3, 'полгода начислений');
  assert.ok((await db.select().from(meter)).length >= 3);
  assert.equal((await db.select().from(poll)).length, 2);
  assert.ok((await db.select().from(post)).length >= 6);
});

test('повторный сид — тот же дом, без дублей', async () => {
  const db = testDb();
  await seedDemo(db);
  await seedDemo(db);
  assert.equal((await db.select().from(demoRole)).length, DEMO_ROLES.length);
  assert.equal((await db.select().from(house).where(eq(house.houseKey, DEMO_HOUSE_KEY))).length, 1);
});

test('очистка стирает демо-дом и не трогает ничего вне его', async () => {
  const db = testDb();
  const realUser = newId('usr');
  await db.insert(appUser).values({ id: realUser, fullName: 'Настоящий Житель' });
  const realProp = newId('prp');
  await db.insert(property).values({ id: realProp, addressRaw: 'пр-кт Ленина, д. 85/3, кв. 5', houseKey: 'реальный|дом', flat: '5' });
  await db.insert(userProperty).values({ id: newId('ubd'), userId: realUser, propertyId: realProp, role: 'owner', status: 'active' });

  await seedDemo(db);
  await clearDemo(db);

  assert.equal((await db.select().from(demoRole)).length, 0);
  assert.equal((await db.select().from(house).where(eq(house.houseKey, DEMO_HOUSE_KEY))).length, 0);
  assert.equal((await db.select().from(property).where(eq(property.houseKey, DEMO_HOUSE_KEY))).length, 0);
  const left = await db.select().from(appUser).where(inArray(appUser.id, [realUser]));
  assert.equal(left.length, 1, 'настоящий житель на месте');
});

test('ensureDemo заводит дом один раз, заданным паролем, и включает его на входе', async () => {
  const db = testDb();
  const first = await ensureDemo(db, { ukPassword: 'local-check-pass' });
  assert.equal(first.created, true);
  assert.equal(first.ukPassword, 'local-check-pass');
  assert.equal(await isDemoEnabled(db), true);

  const [dsp] = await db.select().from(dispatcher).where(eq(dispatcher.login, 'demo-uk'));
  assert.ok(await verifyPassword('local-check-pass', dsp.passwordHash));

  const requestsBefore = (await db.select().from(request)).length;
  const second = await ensureDemo(db, { ukPassword: 'other' });
  assert.equal(second.created, false, 'второй запуск ничего не пересоздаёт');
  assert.equal((await db.select().from(request)).length, requestsBefore);
  const [same] = await db.select().from(dispatcher).where(eq(dispatcher.login, 'demo-uk'));
  assert.equal(same.passwordHash, dsp.passwordHash, 'пароль не сменился');
});
