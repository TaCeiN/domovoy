import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import {
  testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL,
} from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';
import { createDraft } from '../../lib/bot/drafts.ts';
import { createRuntime } from '../../lib/bot/runtime.ts';
import type { Reply } from '../../lib/bot/intents.ts';
import { setBotRuntime } from './bot.ts';

/**
 * Черновик жалобы от бота — со стороны мини-приложения.
 *
 * Черновик выдаётся только его владельцу, а заявка по нему уходит
 * обычным POST /api/requests: всё, что закреплено про жалобы, в силе.
 */

process.env.DATABASE_URL = TEST_URL;
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const app = buildApp();
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await app.close(); await closeTestDb(); await closeDb(); });

function qr(flat: string, persAcc: string) {
  return [
    'ST00011', 'Name=ООО "УК Пример"', 'PayeeINN=6100000001', 'KPP=610001001',
    'Sum=485000', 'paymPeriod=082026', 'lastName=Смирнова', 'firstName=Анна', 'middleName=Т',
    `payerAddress=${HOUSE}, кв. ${flat}`, `persAcc=${persAcc}`,
  ].join('|');
}

function initData(id: number) {
  return signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: 800000 + id, type: 'DIALOG' }),
    query_id: `q-${id}`,
    user: JSON.stringify({
      id, first_name: 'Анна', last_name: 'Смирнова', username: null, language_code: 'ru', photo_url: null,
    }),
  }, BOT_TOKEN);
}

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
}

async function resident(flat: string, persAcc: string, id: number) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(id) },
    payload: { qr: qr(flat, persAcc) },
  });
  const cookie = cookieFrom(res);
  await grantAccess();
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return {
    cookie,
    propertyId: me.json().properties[0].propertyId as string,
    userId: me.json().user.id as string,
  };
}

const WATER = { category: 'Сантехника', text: 'В квартире нет воды уже 15 дней.' };

test('черновик получает только владелец', { skip }, async () => {
  const anna = await resident('15', '4460153', 91001);
  const oleg = await resident('33', '4460331', 91002);
  const id = await createDraft(testDb(), { userId: anna.userId, propertyId: anna.propertyId, ...WATER });

  const own = await app.inject({ method: 'GET', url: `/api/bot/drafts/${id}`, headers: { cookie: anna.cookie } });
  assert.equal(own.statusCode, 200);
  assert.deepEqual(own.json(), { propertyId: anna.propertyId, ...WATER });

  const alien = await app.inject({ method: 'GET', url: `/api/bot/drafts/${id}`, headers: { cookie: oleg.cookie } });
  assert.equal(alien.statusCode, 404);
  assert.equal(alien.json().error, 'draft_gone');

  const anon = await app.inject({ method: 'GET', url: `/api/bot/drafts/${id}` });
  assert.equal(anon.statusCode, 401);
});

test('заявка по черновику гасит его; чужой draftId заявку не ломает', { skip }, async () => {
  const anna = await resident('15', '4460153', 91001);
  const oleg = await resident('33', '4460331', 91002);
  const annaDraft = await createDraft(testDb(), { userId: anna.userId, propertyId: anna.propertyId, ...WATER });

  const alien = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: oleg.cookie },
    payload: { propertyId: oleg.propertyId, category: 'Лифт', description: 'Не работает лифт', draftId: annaDraft },
  });
  assert.equal(alien.statusCode, 201, 'жалоба уходит, даже если draftId чужой');
  const still = await app.inject({ method: 'GET', url: `/api/bot/drafts/${annaDraft}`, headers: { cookie: anna.cookie } });
  assert.equal(still.statusCode, 200, 'чужой черновик не погашен');

  const sent = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: anna.cookie },
    payload: { propertyId: anna.propertyId, category: WATER.category, description: WATER.text, draftId: annaDraft },
  });
  assert.equal(sent.statusCode, 201);
  const gone = await app.inject({ method: 'GET', url: `/api/bot/drafts/${annaDraft}`, headers: { cookie: anna.cookie } });
  assert.equal(gone.statusCode, 404, 'второй раз форма черновиком не заполняется');
});

/** Вебхук с поддельными отправкой и моделью: MAX и GigaChat не трогаем. */
function webhookBot() {
  const sent: Array<{ to: number; reply: Reply }> = [];
  const runtime = createRuntime(testDb, {
    MAX_BOT_TOKEN: 'x', MAX_BOT_USERNAME: 'test_bot',
  }, {
    send: async (to, reply) => { sent.push({ to, reply }); },
    llm: { callFunction: async () => ({ args: { intent: 'greeting' }, totalTokens: 10 }) },
  });
  setBotRuntime(runtime);
  return { sent, runtime: runtime! };
}

const update = (userId: number, text: string, mid: string, chatType = 'dialog') => ({
  update_type: 'message_created',
  timestamp: Date.now(),
  message: {
    sender: { user_id: userId, is_bot: false },
    recipient: { chat_type: chatType },
    body: { mid, text },
  },
});

test('вебхук: без секрета — 401, с секретом — ответ в личку', { skip }, async () => {
  process.env.BOT_WEBHOOK_SECRET = 'webhook-secret-1';
  const { sent, runtime } = webhookBot();

  const bad = await app.inject({
    method: 'POST', url: '/api/max/webhook',
    headers: { 'x-max-bot-api-secret': 'wrong' }, payload: update(777, 'привет', 'm1'),
  });
  assert.equal(bad.statusCode, 401);

  const ok = await app.inject({
    method: 'POST', url: '/api/max/webhook',
    headers: { 'x-max-bot-api-secret': 'webhook-secret-1' }, payload: update(777, 'привет', 'm2'),
  });
  assert.equal(ok.statusCode, 200);
  await runtime.idle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 777);
  assert.match(sent[0].reply.text, /QR-код с квитанции/, 'незнакомцу — приглашение');

  // Групповой чат — молчим
  await app.inject({
    method: 'POST', url: '/api/max/webhook',
    headers: { 'x-max-bot-api-secret': 'webhook-secret-1' }, payload: update(777, 'привет', 'm3', 'chat'),
  });
  await runtime.idle();
  assert.equal(sent.length, 1);

  setBotRuntime(undefined);
  delete process.env.BOT_WEBHOOK_SECRET;
});

test('вебхук выключен, пока не задан секрет', { skip }, async () => {
  delete process.env.BOT_WEBHOOK_SECRET;
  const res = await app.inject({ method: 'POST', url: '/api/max/webhook', payload: update(1, 'x', 'm') });
  assert.equal(res.statusCode, 404);
});
