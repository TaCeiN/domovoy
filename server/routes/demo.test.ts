import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import { testDb, resetTables, closeTestDb, isDbAvailable, TEST_URL } from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';
import { seedDemo } from '../../lib/demo/seed.ts';
import { setDemoEnabled } from '../../lib/demo/setting.ts';

process.env.DATABASE_URL = TEST_URL;
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
process.env.UPLOADS_DIR = join(tmpdir(), 'domovoy-test-uploads-demo');
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы';
const app = await buildApp();
after(async () => { await app.close(); await closeDb(); await closeTestDb(); });
beforeEach(async () => {
  if (!available) return;
  await resetTables();
  await seedDemo(testDb());
  await setDemoEnabled(testDb(), true);
});

function initData(id: number, first: string) {
  return signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: 900000 + id, type: 'DIALOG' }),
    query_id: `q-${id}`,
    user: JSON.stringify({ id, first_name: first, last_name: 'Эксперт', username: null, language_code: 'ru', photo_url: null }),
  }, BOT_TOKEN);
}

test('выключенное демо — 404 и флаг в /api/config', { skip }, async () => {
  await setDemoEnabled(testDb(), false);
  const roles = await app.inject({ method: 'GET', url: '/api/demo/roles' });
  assert.equal(roles.statusCode, 404);
  const config = await app.inject({ method: 'GET', url: '/api/config' });
  assert.equal(config.json().demoEnabled, false);
});

test('в MAX роль берут и дальше входят обычным /api/auth/max', { skip }, async () => {
  const headers = { 'x-max-init-data': initData(6001, 'Иван') };
  const list = await app.inject({ method: 'GET', url: '/api/demo/roles', headers });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().inMax, true);

  const take = await app.inject({ method: 'POST', url: '/api/demo/roles/chairman/take', headers, payload: {} });
  assert.equal(take.statusCode, 200);
  assert.ok(take.json().token);

  const login = await app.inject({ method: 'POST', url: '/api/auth/max', headers });
  assert.equal(login.json().status, 'ok');
});

test('занятая роль в MAX — 409 с именем держателя', { skip }, async () => {
  await app.inject({ method: 'POST', url: '/api/demo/roles/chairman/take',
    headers: { 'x-max-init-data': initData(6001, 'Иван') }, payload: {} });
  const res = await app.inject({ method: 'POST', url: '/api/demo/roles/chairman/take',
    headers: { 'x-max-init-data': initData(6002, 'Мария') }, payload: {} });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'taken');
  assert.match(res.json().holderName, /Иван/);
});

test('из браузера — сессия персонажа, главная открывается', { skip }, async () => {
  const take = await app.inject({ method: 'POST', url: '/api/demo/roles/owner12/take', payload: {} });
  assert.equal(take.statusCode, 200);
  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${take.json().token}` },
  });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().properties[0].demo, true);
  assert.equal(me.json().user.name, 'Кузнецов Андрей Павлович');
});
