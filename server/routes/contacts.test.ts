import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import { hashPassword } from '../../lib/auth/password.ts';
import {
  testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL, insertRegistryHouse,
} from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';
import { admin, adminAction, dispatcher, managingOrg, property } from '../../db/schema.ts';
import { newId } from '../../lib/ids.ts';
import { parseAddress } from '../../lib/address/normalize.ts';

/**
 * Телефоны дома: кто пишет, кто читает.
 *
 * Пишут председатель своего дома, УК своих домов и оператор — с записью
 * в журнал. Житель только читает, и только если ему открыт адрес.
 */

process.env.DATABASE_URL = TEST_URL;
// ||=, а не ??=: в заготовке .env.example токен пустой, и пустая строка ломала подписи
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';
const OTHER = '344038, Ростовская обл, г Ростов-на-Дону, ул Совсем Другая, д 1';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const app = buildApp();
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await app.close(); await closeTestDb(); await closeDb(); });

function qr(flat: string, persAcc: string, house = HOUSE) {
  return [
    'ST00011', 'Name=ООО "УК Пример"', 'PayeeINN=6100000001', 'KPP=610001001',
    'Sum=485000', 'paymPeriod=082026', 'lastName=Смирнова', 'firstName=Анна', 'middleName=Т',
    `payerAddress=${house}, кв. ${flat}`, `persAcc=${persAcc}`,
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

/** Организация в реестре и её дома — до жителей, иначе объект останется без УК. */
async function seedOrg(inn: string, addresses: string[]) {
  const [org] = await testDb().insert(managingOrg).values({
    id: newId('org'), inn, name: `ООО «УК ${inn}»`, shortName: `УК ${inn}`, regionCode: '61',
  }).returning({ id: managingOrg.id });
  for (const address of addresses) {
    await insertRegistryHouse(testDb(), {
      houseKey: parseAddress(address).houseKey, orgId: org.id, regionCode: '61', addressRaw: address,
    });
  }
  return org.id;
}

async function resident(flat: string, persAcc: string, id: number, house = HOUSE) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(id) },
    payload: { qr: qr(flat, persAcc, house) },
  });
  const cookie = cookieFrom(res);
  // Фикстура доступа — файл не про модель доступа, см. lib/test-db.ts
  await grantAccess();
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return {
    cookie,
    propertyId: me.json().properties[0].propertyId as string,
    userId: me.json().user.id as string,
  };
}

async function dispatcherCookie(orgId: string) {
  await testDb().insert(dispatcher).values({
    id: newId('dsp'), orgId, login: 'disp', passwordHash: await hashPassword('secret'), name: 'Диспетчер',
  });
  const res = await app.inject({
    method: 'POST', url: '/api/dispatcher/login', payload: { login: 'disp', password: 'secret' },
  });
  return cookieFrom(res);
}

async function adminHeaders() {
  await testDb().insert(admin).values({
    id: newId('adm'), login: 'operator', passwordHash: await hashPassword('sekret-parol-123'), name: 'Оператор Ольга',
  });
  const res = await app.inject({
    method: 'POST', url: '/api/admin/login', payload: { login: 'operator', password: 'sekret-parol-123' },
  });
  return { authorization: `Bearer ${res.json().token}` };
}

async function houseKeyOf(propertyId: string) {
  const [row] = await testDb().select().from(property).where(eq(property.id, propertyId));
  return row.houseKey;
}

const LIFT = { kind: 'lift', phone: '+7 (863) 200-00-01', note: 'круглосуточно' };

test('председатель вписывает лифтёрскую, сосед её видит', { skip }, async () => {
  const orgId = await seedOrg('6100000001', [HOUSE]);
  const anna = await resident('15', '4460153', 90001);
  const irina = await resident('33', '4460331', 90002);
  const houseKey = await houseKeyOf(anna.propertyId);

  const disp = await dispatcherCookie(orgId);
  const appoint = await app.inject({
    method: 'POST', url: '/api/dispatcher/chairmen', headers: { cookie: disp },
    payload: { houseKey, userId: anna.userId },
  });
  assert.equal(appoint.statusCode, 201, 'подготовка: председатель назначен');

  const saved = await app.inject({
    method: 'POST', url: '/api/chairman/contacts', headers: { cookie: anna.cookie },
    payload: { houseKey, ...LIFT },
  });
  assert.equal(saved.statusCode, 201);

  const seen = await app.inject({
    method: 'GET', url: `/api/properties/${irina.propertyId}/house-contacts`, headers: { cookie: irina.cookie },
  });
  assert.equal(seen.statusCode, 200);
  assert.equal(seen.json().contacts[0].title, 'Лифтёрская служба');
  assert.equal(seen.json().contacts[0].phone, '+7 (863) 200-00-01');
  assert.equal(seen.json().contacts[0].updatedByRole, 'chairman');

  // Житель, не председатель, писать не может
  const denied = await app.inject({
    method: 'POST', url: '/api/chairman/contacts', headers: { cookie: irina.cookie },
    payload: { houseKey, ...LIFT },
  });
  assert.equal(denied.statusCode, 403);

  const removed = await app.inject({
    method: 'POST', url: `/api/chairman/contacts/${saved.json().id}/remove`, headers: { cookie: anna.cookie },
    payload: { houseKey },
  });
  assert.equal(removed.statusCode, 200);
});

test('номера чужого объекта не отдаются', { skip }, async () => {
  await seedOrg('6100000001', [HOUSE]);
  await seedOrg('6100000002', [OTHER]);
  const anna = await resident('15', '4460153', 90001);
  const stranger = await resident('1', '7770001', 90009, OTHER);

  const foreign = await app.inject({
    method: 'GET', url: `/api/properties/${anna.propertyId}/house-contacts`, headers: { cookie: stranger.cookie },
  });
  assert.equal(foreign.statusCode, 403);
});

test('УК пишет в свои дома и не пишет в чужие', { skip }, async () => {
  const mine = await seedOrg('6100000001', [HOUSE]);
  await seedOrg('6100000002', [OTHER]);
  const disp = await dispatcherCookie(mine);
  const myKey = encodeURIComponent(parseAddress(HOUSE).houseKey);
  const otherKey = encodeURIComponent(parseAddress(OTHER).houseKey);

  const ok = await app.inject({
    method: 'POST', url: `/api/dispatcher/houses/${myKey}/contacts`,
    headers: { cookie: disp }, payload: { kind: 'uk_dispatch', phone: '8 800 100-00-00' },
  });
  assert.equal(ok.statusCode, 201);

  const list = await app.inject({
    method: 'GET', url: `/api/dispatcher/houses/${myKey}/contacts`, headers: { cookie: disp },
  });
  assert.equal(list.json().contacts[0].updatedByRole, 'dispatcher');
  assert.ok(list.json().kinds.some((k: { kind: string }) => k.kind === 'lift'));

  const bad = await app.inject({
    method: 'POST', url: `/api/dispatcher/houses/${myKey}/contacts`,
    headers: { cookie: disp }, payload: { kind: 'lift', phone: 'звоните' },
  });
  assert.equal(bad.statusCode, 400);

  const foreign = await app.inject({
    method: 'POST', url: `/api/dispatcher/houses/${otherKey}/contacts`,
    headers: { cookie: disp }, payload: LIFT,
  });
  assert.equal(foreign.statusCode, 403);
});

test('оператор пишет в любой дом, и это попадает в журнал', { skip }, async () => {
  await seedOrg('6100000001', [HOUSE]);
  const headers = await adminHeaders();
  const key = encodeURIComponent(parseAddress(HOUSE).houseKey);

  const saved = await app.inject({
    method: 'POST', url: `/api/admin/houses/${key}/contacts`, headers, payload: LIFT,
  });
  assert.equal(saved.statusCode, 201);

  const card = await app.inject({ method: 'GET', url: `/api/admin/houses/${key}`, headers });
  assert.equal(card.json().contacts[0].kind, 'lift');
  assert.ok(card.json().contactKinds.length > 0);

  const removed = await app.inject({
    method: 'POST', url: `/api/admin/houses/${key}/contacts/${saved.json().id}/remove`, headers,
  });
  assert.equal(removed.statusCode, 200);

  const journal = await testDb().select().from(adminAction);
  assert.deepEqual(journal.map((r) => r.action).sort(), ['house.contact.remove', 'house.contact.save']);
});
