import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import { hashPassword } from '../../lib/auth/password.ts';
import { testDb, resetTables, closeTestDb, isDbAvailable, TEST_URL, insertRegistryHouse } from '../../lib/test-db.ts';
import { resident } from '../../lib/pick/fixtures.ts';
import { closeDb } from '../../db/client.ts';
import {
  admin, appUser, dispatcher, houseClaim, houseReview, managingOrg, property, request, userProperty,
} from '../../db/schema.ts';
import { newId } from '../../lib/ids.ts';
import { parseAddress } from '../../lib/address/normalize.ts';
import { houseState } from '../../lib/house/form.ts';
import { listActions, recordAction } from '../../lib/admin/audit.ts';
import { openHouseClaims } from '../../lib/house/claim.ts';

/**
 * Кабинет оператора сервиса.
 *
 * ГЛАВНАЯ ПРОВЕРКА ЗДЕСЬ — что закрыт КАЖДЫЙ маршрут, а не выборочные.
 * Маршрут, который забыли закрыть, ничем не отличается от закрытого,
 * пока его не дёрнешь: он просто отвечает. А отвечает он всем.
 */

process.env.DATABASE_URL = TEST_URL;
// ||=, а не ??=: в заготовке .env.example токен пустой, и пустая строка ломала подписи
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const ADMIN_LOGIN = 'operator';
const ADMIN_PASSWORD = 'sekret-parol-123';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const app = await buildApp();
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await app.close(); await closeTestDb(); await closeDb(); });

/** Учётка оператора плюс вход: возвращает токен и id. */
test('события оператора: список, счётчик и отметка «просмотрено» с записью в журнал', { skip }, async () => {
  const { token } = await adminToken();
  const headers = { authorization: `Bearer ${token}` };
  const db = testDb();
  const userId = newId('usr');
  const propertyId = newId('prp');
  await db.insert(appUser).values({ id: userId, fullName: 'Житель без реестра' });
  await db.insert(property).values({ id: propertyId, houseKey: 'нет-в-реестре', addressRaw: 'г Аксай, ул Новая, д. 9, кв. 1', flat: '1' });
  const bindingId = newId('ubd');
  await db.insert(userProperty).values({ id: bindingId, userId, propertyId, role: 'member', status: 'pending' });

  const list = await app.inject({ method: 'GET', url: '/api/admin/events', headers });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().unseen.unknown_house, 1);
  assert.equal(list.json().rows[0].address, 'г Аксай, ул Новая, д. 9, кв. 1');

  const seen = await app.inject({
    method: 'POST', url: '/api/admin/events/seen', headers,
    payload: { items: [{ kind: 'unknown_house', refId: bindingId }, { kind: 'выдумка', refId: 'x' }] },
  });
  assert.equal(seen.json().marked, 1);

  const after = await app.inject({ method: 'GET', url: '/api/admin/events?unseen=1', headers });
  assert.equal(after.json().rows.length, 0);

  const audit = await app.inject({ method: 'GET', url: '/api/admin/audit', headers });
  assert.ok(audit.json().rows.some((r: { action: string }) => r.action === 'events.seen'));

  const anon = await app.inject({ method: 'GET', url: '/api/admin/events' });
  assert.equal(anon.statusCode, 401);
});

test('покрытие: сводка по пунктам, улицы пункта и точки в границах карты', { skip }, async () => {
  const { token } = await adminToken();
  const headers = { authorization: `Bearer ${token}` };
  const db = testDb();
  const { addressObject, house, region } = await import('../../db/schema.ts');
  const { resetCoverageCache } = await import('../../lib/coverage/snapshot.ts');
  resetCoverageCache();

  await db.insert(region).values({ code: '61', name: 'Ростовская обл', status: 'loaded', placeCount: 1, streetCount: 1 });
  await db.insert(addressObject).values([
    { guid: 'g-r', regionCode: '61', parentGuid: null, level: 1, type: 'обл', name: 'Ростовская', searchName: 'ростовская' },
    { guid: 'g-d', regionCode: '61', parentGuid: 'g-r', level: 2, type: 'р-н', name: 'Кагальницкий', searchName: 'кагальницкий' },
    { guid: 'g-p', regionCode: '61', parentGuid: 'g-d', level: 6, type: 'с', name: 'Новобатайск', searchName: 'новобатайск' },
    { guid: 'g-s', regionCode: '61', parentGuid: 'g-p', level: 8, type: 'ул', name: 'Октябрьская', searchName: 'октябрьская' },
  ]);
  await db.insert(house).values([
    { houseKey: 'h1', addressRaw: 'обл Ростовская, р-н Кагальницкий, с Новобатайск, ул Октябрьская, д. 1', regionCode: '61', streetGuid: 'g-s', garMkd: true, lat: 46.9, lon: 39.9 },
    { houseKey: 'h2', addressRaw: 'обл Ростовская, р-н Кагальницкий, с Новобатайск, ул Октябрьская, д. 2', regionCode: '61', streetGuid: 'g-s' },
  ]);

  const places = await app.inject({ method: 'GET', url: '/api/admin/coverage/places?region=61', headers });
  assert.equal(places.statusCode, 200);
  const place = places.json().places[0];
  assert.equal(place.name, 'Новобатайск');
  assert.equal(place.district, 'Кагальницкий');
  assert.equal(place.total, 2);
  assert.equal(place.mkd.kind, 1);
  assert.equal(place.likely, 1);

  const streets = await app.inject({ method: 'GET', url: '/api/admin/coverage/streets?region=61&place=g-p', headers });
  assert.equal(streets.json().streets[0].name, 'Октябрьская');

  const points = await app.inject({ method: 'GET', url: '/api/admin/coverage/points?region=61&bbox=46,39,47,40', headers });
  assert.deepEqual(points.json().rows, [[46.9, 39.9, 1, 0, 0, 'h1']]);

  const bad = await app.inject({ method: 'GET', url: '/api/admin/coverage/points?region=61&bbox=x', headers });
  assert.equal(bad.statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/admin/coverage/places?region=61' })).statusCode, 401);
});

async function adminToken() {
  const id = newId('adm');
  await testDb().insert(admin).values({
    id,
    login: ADMIN_LOGIN,
    passwordHash: await hashPassword(ADMIN_PASSWORD),
    name: 'Оператор Ольга',
  });

  const res = await app.inject({
    method: 'POST', url: '/api/admin/login',
    payload: { login: ADMIN_LOGIN, password: ADMIN_PASSWORD },
  });
  assert.equal(res.statusCode, 200, 'подготовка: вход оператора');
  return { token: res.json().token as string, adminId: id };
}

/** Диспетчер УК — чужая сессия, которой админка открываться не должна. */
async function dispatcherToken() {
  const orgId = newId('org');
  await testDb().insert(managingOrg).values({
    id: orgId, inn: '6100000777', name: 'ООО УК «Чужая»', regionCode: '61',
  });
  await testDb().insert(dispatcher).values({
    id: newId('dsp'), orgId, login: 'disp',
    passwordHash: await hashPassword('secret'), name: 'Диспетчер',
  });
  const res = await app.inject({
    method: 'POST', url: '/api/dispatcher/login',
    payload: { login: 'disp', password: 'secret' },
  });
  return res.json().token as string;
}

/** Житель — тоже чужая сессия. */
async function residentToken() {
  const initData = signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: 900001, type: 'DIALOG' }),
    query_id: 'q-adm',
    user: JSON.stringify({
      id: 900001, first_name: 'Сергей', last_name: 'Крутых',
      username: null, language_code: 'ru', photo_url: null,
    }),
  }, BOT_TOKEN);

  const res = await app.inject({
    method: 'POST', url: '/api/auth/max', payload: { initData },
  });
  return res.json().token as string;
}

/**
 * Список закрытых маршрутов.
 *
 * Пополняется вместе с маршрутами — это дешевле, чем один раз забыть.
 * Метод и адрес взяты те же, что в бою: закрытость проверяется на том
 * же пути, по которому пойдёт настоящий запрос.
 */
const GUARDED: [ 'GET' | 'POST', string ][] = [
  ['GET', '/api/admin/me'],
  ['GET', '/api/admin/audit'],
  ['GET', '/api/admin/houses?q=ленина'],
  ['GET', '/api/admin/houses/test-key'],
  ['GET', '/api/admin/houses/test-key/requests/req_X'],
  ['POST', '/api/admin/houses/test-key/form'],
  ['POST', '/api/admin/houses/test-key/org'],
  ['POST', '/api/admin/houses/test-key/chairman'],
  ['POST', '/api/admin/chairmen/chr_1/revoke'],
  ['GET', '/api/admin/house-claims'],
  ['POST', '/api/admin/house-claims/hcl_1/decide'],
  ['GET', '/api/admin/users?q=иван'],
  ['GET', '/api/admin/users/usr_1'],
  ['POST', '/api/admin/bindings/ubd_1/revoke'],
  ['GET', '/api/admin/orgs?q=трианон'],
  ['POST', '/api/admin/orgs/org_1/dispatcher'],
  ['GET', '/api/admin/tables'],
  ['GET', '/api/admin/tables/app_user'],
];

test('без сессии оператора закрыт каждый маршрут', { skip }, async () => {
  const missing: string[] = [];

  for (const [method, url] of GUARDED) {
    const res = await app.inject({ method, url, payload: {} });
    if (res.statusCode === 404) { missing.push(`${method} ${url}`); continue; }
    assert.equal(res.statusCode, 401, `${method} ${url} обязан быть закрыт`);
  }

  /**
   * Ненаписанный маршрут не считается закрытым — но и падением теста
   * быть не должен, пока кабинет собирается по частям. Список тут
   * ПОЛНЫЙ с самого начала: так забыть закрыть маршрут нельзя —
   * он либо отвечает 401, либо ещё не существует, и это видно.
   *
   * К концу работы список обязан опустеть: это и проверяет тест ниже.
   */
  if (missing.length) {
    console.log(`  ещё не написаны: ${missing.length} из ${GUARDED.length}`);
  }
});

/**
 * Кабинет собран целиком.
 *
 * Держится отдельно от проверки закрытости: пока идёт работа, он
 * пропущен, а в конце снимается пометка — и если какой-то маршрут
 * так и не появился, это видно сразу, а не через полгода.
 */
test('все маршруты кабинета существуют', { skip }, async () => {
  for (const [method, url] of GUARDED) {
    const res = await app.inject({ method, url, payload: {} });
    assert.notEqual(res.statusCode, 404, `${method} ${url} не написан`);
  }
});

test('сессия диспетчера админку не открывает', { skip }, async () => {
  const token = await dispatcherToken();
  const res = await app.inject({
    method: 'GET', url: '/api/admin/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401, 'кабинет УК — не админка');
});

test('сессия жителя админку не открывает', { skip }, async () => {
  const token = await residentToken();
  const res = await app.inject({
    method: 'GET', url: '/api/admin/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 401);
});

test('оператор входит и видит себя', { skip }, async () => {
  const { token } = await adminToken();
  const res = await app.inject({
    method: 'GET', url: '/api/admin/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().login, ADMIN_LOGIN);
  assert.equal(res.json().name, 'Оператор Ольга');
});

test('выключенный оператор теряет и вход, и прежнюю сессию', { skip }, async () => {
  const { token, adminId } = await adminToken();

  await testDb().update(admin).set({ disabledAt: new Date() })
    .where(eq(admin.id, adminId));

  const me = await app.inject({
    method: 'GET', url: '/api/admin/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.statusCode, 401, 'выключение действует немедленно, а не со следующего входа');

  const login = await app.inject({
    method: 'POST', url: '/api/admin/login',
    payload: { login: ADMIN_LOGIN, password: ADMIN_PASSWORD },
  });
  assert.equal(login.statusCode, 401);
});

/* ─────────────── дома ─────────────── */

const HOUSE_ADDRESS = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';
const HOUSE_KEY = parseAddress(HOUSE_ADDRESS).houseKey;

/** Житель дома с неподтверждённой привязкой — обычное начальное состояние. */
async function seedResidentOf(houseKey: string, flat = '27', name = 'Петров Пётр') {
  const userId = newId('usr');
  const propertyId = newId('prp');
  await testDb().insert(appUser).values({ id: userId, fullName: name });
  await testDb().insert(property).values({
    id: propertyId, addressRaw: HOUSE_ADDRESS, houseKey, flat,
  });
  await testDb().insert(userProperty).values({
    id: newId('ubd'), userId, propertyId, role: 'owner', status: 'pending',
  });
  return { userId, propertyId };
}

const houseUrl = (suffix = '') =>
  `/api/admin/houses/${encodeURIComponent(HOUSE_KEY)}${suffix}`;

test('оператор ставит форму дома, и это попадает в журнал', { skip }, async () => {
  const { token } = await adminToken();

  const res = await app.inject({
    method: 'POST', url: houseUrl('/form'),
    headers: { authorization: `Bearer ${token}` },
    payload: { form: 'direct' },
  });
  assert.equal(res.statusCode, 200);

  const state = await houseState(testDb(), HOUSE_KEY);
  assert.equal(state.form, 'direct');

  const log = await listActions(testDb());
  assert.equal(log.rows.length, 1);
  assert.equal(log.rows[0].action, 'house.form');
  assert.match(log.rows[0].summary, /непосредственное управление/i,
    'в журнале человеческое название формы, а не машинный код');
});

test('неизвестная форма отвергается и в журнал не пишется', { skip }, async () => {
  const { token } = await adminToken();

  const res = await app.inject({
    method: 'POST', url: houseUrl('/form'),
    headers: { authorization: `Bearer ${token}` },
    payload: { form: 'что-угодно' },
  });

  assert.equal(res.statusCode, 400);
  assert.equal((await listActions(testDb())).total, 0,
    'журнал про то, что произошло, а не про то, что пытались');
});

test('оператор назначает председателя дому без УК и снимает его', { skip }, async () => {
  const { token } = await adminToken();
  const { userId } = await seedResidentOf(HOUSE_KEY);
  const headers = { authorization: `Bearer ${token}` };

  const made = await app.inject({
    method: 'POST', url: houseUrl('/chairman'), headers, payload: { userId },
  });
  assert.equal(made.statusCode, 200, 'дома нет в реестре — для оператора это не препятствие');
  assert.equal((await houseState(testDb(), HOUSE_KEY)).hasChairman, true);

  const off = await app.inject({
    method: 'POST', url: `/api/admin/chairmen/${made.json().id}/revoke`,
    headers, payload: {},
  });
  assert.equal(off.statusCode, 200);
  assert.equal((await houseState(testDb(), HOUSE_KEY)).hasChairman, false,
    'назначение оператора обратимо — иначе ошибка чинится только руками в базе');

  const log = await listActions(testDb());
  assert.deepEqual(log.rows.map((r) => r.action), ['chairman.revoke', 'chairman.create']);
});

test('карточка дома показывает жителей и обращения', { skip }, async () => {
  const { token } = await adminToken();
  const { userId, propertyId } = await seedResidentOf(HOUSE_KEY);

  await testDb().insert(request).values({
    id: newId('req'), number: 1, numberScope: `house:${HOUSE_KEY}`,
    propertyId, orgId: null, authorId: userId,
    kind: 'complaint', category: 'Другое',
    title: 'Течёт крыша', description: 'Третий подъезд', status: 'new',
  });

  const card = await app.inject({
    method: 'GET', url: houseUrl(), headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(card.statusCode, 200);
  assert.equal(card.json().residents.length, 1);
  assert.equal(card.json().residents[0].name, 'Петров Пётр');
  assert.equal(card.json().requests.length, 1);
  assert.equal(card.json().requests[0].title, 'Течёт крыша');
});

test('карточка дома: что знает реестр и чего не хватает до «подключён»', { skip }, async () => {
  const { token } = await adminToken();
  const db = testDb();
  const { house } = await import('../../db/schema.ts');
  const orgId = newId('org');
  await db.insert(managingOrg).values({
    id: orgId, inn: '6102017830', name: 'ТСЖ «Прогресс»', shortName: 'ТСЖ «Прогресс»', phone: '+79286185189', regionCode: '61',
  });
  await db.insert(house).values({
    houseKey: HOUSE_KEY, addressRaw: 'обл Ростовская, г Аксай, ул Мира, д. 1', regionCode: '61',
    registryForm: 'tsj', registryOrgId: orgId, garMkd: true, garFlats: 58, cadastralNumber: '61:02:0600010:123',
  });

  const card = (await app.inject({ method: 'GET', url: houseUrl(), headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(card.registry.form, 'tsj');
  assert.equal(card.registry.garMkd, true);
  assert.equal(card.registry.garFlats, 58);
  assert.equal(card.registry.cadastralNumber, '61:02:0600010:123');
  assert.equal(card.registry.org.inn, '6102017830');
  assert.equal(card.registry.org.phone, '+79286185189');
  assert.equal(card.registry.org.hasCabinet, false);
  assert.equal(card.coverage.level, 'contact', 'ИНН и телефон есть, председателя и кабинета нет');
});

test('карточка дома вне реестра: реестрового блока нет, уровень — только адрес', { skip }, async () => {
  const { token } = await adminToken();
  await seedResidentOf(HOUSE_KEY);
  const card = (await app.inject({ method: 'GET', url: houseUrl(), headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(card.registry, null);
  assert.equal(card.coverage.level, 'address');
});

test('оператор открывает обращение дома целиком: текст и переписка, только чтение', { skip }, async () => {
  const { token } = await adminToken();
  const { userId, propertyId } = await seedResidentOf(HOUSE_KEY);
  const requestId = newId('req');
  await testDb().insert(request).values({
    id: requestId, number: 7, numberScope: `house:${HOUSE_KEY}`,
    propertyId, orgId: null, authorId: userId,
    kind: 'complaint', category: 'Лифт',
    title: 'Не работает лифт', description: 'Второй подъезд, третий день', status: 'new',
  });
  const headers = { authorization: `Bearer ${token}` };

  const res = await app.inject({ method: 'GET', url: `${houseUrl()}/requests/${requestId}`, headers });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().description, 'Второй подъезд, третий день');
  assert.ok(Array.isArray(res.json().events));
  assert.ok(Array.isArray(res.json().photos));

  // Обращение чужого дома через этот дом не открывается
  const alien = await app.inject({
    method: 'GET', url: `/api/admin/houses/${encodeURIComponent('другой-дом')}/requests/${requestId}`, headers,
  });
  assert.equal(alien.statusCode, 404);
});

/**
 * Ядро продукта: у жителя остаётся доказательство, которое никто
 * не сотрёт, включая оператора. Проверяем не намерение, а отсутствие
 * самих маршрутов.
 */
test('обращение из админки нельзя ни удалить, ни закрыть', { skip }, async () => {
  const { token } = await adminToken();
  const { userId, propertyId } = await seedResidentOf(HOUSE_KEY);
  const requestId = newId('req');

  await testDb().insert(request).values({
    id: requestId, number: 1, numberScope: `house:${HOUSE_KEY}`,
    propertyId, orgId: null, authorId: userId,
    kind: 'complaint', category: 'Другое',
    title: 'Течёт крыша', description: 'Третий подъезд', status: 'new',
  });

  const headers = { authorization: `Bearer ${token}` };
  for (const url of [
    `/api/admin/requests/${requestId}`,
    `/api/admin/requests/${requestId}/status`,
  ]) {
    for (const method of ['POST', 'DELETE'] as const) {
      const res = await app.inject({ method, url, headers, payload: { status: 'done' } });
      assert.equal(res.statusCode, 404, `${method} ${url} не должен существовать`);
    }
  }

  const [row] = await testDb().select().from(request).where(eq(request.id, requestId));
  assert.equal(row.status, 'new', 'обращение не тронуто');
});

test('поиск домов находит по части адреса', { skip }, async () => {
  const { token } = await adminToken();
  await seedResidentOf(HOUSE_KEY);

  const res = await app.inject({
    method: 'GET', url: '/api/admin/houses?q=ленина',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().rows.length, 1);
  assert.equal(res.json().total, 1, 'сколько совпадений всего — без потолка');
  assert.equal(res.json().rows[0].houseKey, HOUSE_KEY);
  assert.equal(res.json().rows[0].residents, 1);
});

test('поиск домов ищет слова по отдельности: «Ленина 85» находит «пр-кт Ленина, д. 85»', { skip }, async () => {
  const { token } = await adminToken();
  await seedResidentOf(HOUSE_KEY);
  const find = async (q: string) => (await app.inject({
    method: 'GET', url: `/api/admin/houses?q=${encodeURIComponent(q)}`,
    headers: { authorization: `Bearer ${token}` },
  })).json();

  assert.equal((await find('Ленина 85')).rows.length, 1, 'так подсказывает поле поиска');
  assert.equal((await find('ростов ленина, 85')).total, 1);
  assert.equal((await find('Ленина 86')).rows.length, 0, 'все слова обязательны');
});

/**
 * ПОИСК, ОБРЕЗАННЫЙ МОЛЧА, ХУЖЕ ПУСТОГО.
 *
 * Оператор ищет дом, получает полсотни строк и не знает, что его дома
 * в списке может не быть. Для дома-двойника с другим написанием адреса
 * это прямой путь к неверному решению: не нашёл — завёл второй.
 */
test('поиск говорит, сколько совпадений всего', { skip }, async () => {
  const { token } = await adminToken();

  for (let i = 1; i <= 60; i++) {
    await testDb().insert(property).values({
      id: newId('prp'),
      addressRaw: `Ростов-на-Дону, пр-кт Ленина, д. ${i}`,
      houseKey: `ростовская обл|ростов-на-дону|ленина пр-кт|${i}`,
      flat: '1',
    });
  }

  const res = await app.inject({
    method: 'GET', url: '/api/admin/houses?q=ленина',
    headers: { authorization: `Bearer ${token}` },
  });

  assert.equal(res.json().rows.length, 50, 'выдача обрезана');
  assert.equal(res.json().total, 60, 'но об этом сказано числом');
});

/**
 * Журнал заведён ради разбора спора через полгода. С потолком в 200
 * записей ответа в нём к этому сроку уже не было.
 */
test('журнал отдаётся страницами, старые записи достижимы', { skip }, async () => {
  const { token, adminId } = await adminToken();
  const headers = { authorization: `Bearer ${token}` };

  for (let i = 1; i <= 60; i++) {
    await recordAction(testDb(), {
      adminId, action: 'house.form', targetKind: 'house', targetId: HOUSE_KEY,
      summary: `запись ${String(i).padStart(3, '0')}`,
    });
  }

  const first = await app.inject({ method: 'GET', url: '/api/admin/audit', headers });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().rows.length, 50);
  assert.equal(first.json().total, 60);
  assert.equal(first.json().page, 1);

  const second = await app.inject({ method: 'GET', url: '/api/admin/audit?page=2', headers });
  assert.equal(second.json().rows.length, 10);
  assert.equal(second.json().page, 2);
  assert.equal(second.json().rows.at(-1).summary, 'запись 001',
    'самая старая запись достижима');
});

/* ─────────────── заявки на подключение ─────────────── */

async function seedHouseClaim(houseKey: string) {
  const { userId } = await seedResidentOf(houseKey, '5', 'Иванова Мария');
  const id = newId('hcl');
  await testDb().insert(houseClaim).values({
    id, houseKey, userId, note: 'У нас ТСЖ, УК никогда не было', status: 'open',
  });
  return id;
}

test('очередь показывает заявки, решение убирает их и пишется в журнал', { skip }, async () => {
  const { token } = await adminToken();
  const claimId = await seedHouseClaim(HOUSE_KEY);
  const headers = { authorization: `Bearer ${token}` };

  const queue = await app.inject({ method: 'GET', url: '/api/admin/house-claims', headers });
  assert.equal(queue.statusCode, 200);
  assert.equal(queue.json().length, 1);
  assert.equal(queue.json()[0].houseKey, HOUSE_KEY);
  assert.equal(queue.json()[0].note, 'У нас ТСЖ, УК никогда не было');

  const done = await app.inject({
    method: 'POST', url: `/api/admin/house-claims/${claimId}/decide`,
    headers, payload: { status: 'done' },
  });
  assert.equal(done.statusCode, 200);
  assert.equal((await openHouseClaims(testDb())).length, 0);
  assert.equal((await listActions(testDb())).rows[0].action, 'house_claim.decide');
});

test('решить можно только открытую заявку', { skip }, async () => {
  const { token } = await adminToken();
  const claimId = await seedHouseClaim(HOUSE_KEY);
  const headers = { authorization: `Bearer ${token}` };
  const url = `/api/admin/house-claims/${claimId}/decide`;

  await app.inject({ method: 'POST', url, headers, payload: { status: 'done' } });
  const again = await app.inject({ method: 'POST', url, headers, payload: { status: 'done' } });

  assert.equal(again.statusCode, 409);
  assert.equal((await listActions(testDb())).total, 1,
    'вторая попытка журнал не засоряет');
});

/* ─────────────── жители ─────────────── */

test('оператор находит жителя и закрывает ему доступ с причиной', { skip }, async () => {
  const { token } = await adminToken();
  const { userId } = await seedResidentOf(HOUSE_KEY);
  const headers = { authorization: `Bearer ${token}` };

  const found = await app.inject({
    method: 'GET', url: '/api/admin/users?q=петров', headers,
  });
  assert.equal(found.statusCode, 200);
  assert.equal(found.json().rows.length, 1);
  assert.equal(found.json().total, 1);
  assert.equal(found.json().rows[0].id, userId);

  const card = await app.inject({
    method: 'GET', url: `/api/admin/users/${userId}`, headers,
  });
  assert.equal(card.json().bindings.length, 1);
  const bindingId = card.json().bindings[0].bindingId;

  const off = await app.inject({
    method: 'POST', url: `/api/admin/bindings/${bindingId}/revoke`,
    headers, payload: { reason: 'Захват частного дома' },
  });
  assert.equal(off.statusCode, 200);
  assert.equal(off.json().wasOwner, true, 'квартира осталась без владельца — это надо показать');

  const log = await listActions(testDb());
  assert.equal(log.rows[0].action, 'binding.revoke');
  assert.match(log.rows[0].summary, /Захват частного дома/, 'причина видна в журнале');
});

test('отзыв без причины отвергается', { skip }, async () => {
  const { token } = await adminToken();
  const { userId } = await seedResidentOf(HOUSE_KEY);
  const headers = { authorization: `Bearer ${token}` };

  const card = await app.inject({ method: 'GET', url: `/api/admin/users/${userId}`, headers });
  const bindingId = card.json().bindings[0].bindingId;

  const off = await app.inject({
    method: 'POST', url: `/api/admin/bindings/${bindingId}/revoke`,
    headers, payload: { reason: '  ' },
  });

  assert.equal(off.statusCode, 400);
  assert.equal((await listActions(testDb())).total, 0);
});

/* ─────────────── организации ─────────────── */

test('оператор заводит кабинет УК, пароль показан один раз', { skip }, async () => {
  const { token } = await adminToken();
  const headers = { authorization: `Bearer ${token}` };

  const orgId = newId('org');
  await testDb().insert(managingOrg).values({
    id: orgId, inn: '6168108630', name: 'ООО УК «Трианон»',
    shortName: 'УК Трианон', regionCode: '61',
  });

  const made = await app.inject({
    method: 'POST', url: `/api/admin/orgs/${orgId}/dispatcher`,
    headers, payload: { login: 'uk-proverka' },
  });
  assert.equal(made.statusCode, 200);
  const password = made.json().password;
  assert.ok(password, 'пароль отдан вызывающему');

  const [row] = await testDb().select().from(dispatcher)
    .where(eq(dispatcher.login, 'uk-proverka'));
  assert.notEqual(row.passwordHash, password, 'в базе только хеш');

  const again = await app.inject({
    method: 'POST', url: `/api/admin/orgs/${orgId}/dispatcher`,
    headers, payload: {},
  });
  assert.equal(again.statusCode, 200);
  assert.notEqual(again.json().password, password, 'повтор сбрасывает пароль');

  const log = await listActions(testDb());
  assert.deepEqual(log.rows.map((r) => r.action), ['dispatcher.reset', 'dispatcher.create']);
  assert.equal(log.rows.some((r) => r.summary.includes(password)), false,
    'пароль в журнал не попадает');
});

test('поиск организаций находит по названию и по ИНН', { skip }, async () => {
  const { token } = await adminToken();
  const headers = { authorization: `Bearer ${token}` };

  await testDb().insert(managingOrg).values({
    id: newId('org'), inn: '6168108630', name: 'ООО УК «Трианон»',
    shortName: 'УК Трианон', regionCode: '61',
  });

  const byName = await app.inject({
    method: 'GET', url: '/api/admin/orgs?q=трианон', headers,
  });
  assert.equal(byName.json().rows.length, 1);
  assert.equal(byName.json().total, 1);

  const byInn = await app.inject({
    method: 'GET', url: '/api/admin/orgs?q=6168108630', headers,
  });
  assert.equal(byInn.json().rows.length, 1);
});

test('неверный пароль и неверный логин отвечают одинаково', { skip }, async () => {
  await adminToken();

  const badPass = await app.inject({
    method: 'POST', url: '/api/admin/login',
    payload: { login: ADMIN_LOGIN, password: 'не тот' },
  });
  const noSuch = await app.inject({
    method: 'POST', url: '/api/admin/login',
    payload: { login: 'нет-такого', password: 'не тот' },
  });

  assert.equal(badPass.statusCode, 401);
  assert.equal(noSuch.statusCode, 401);
  assert.deepEqual(badPass.json(), noSuch.json(),
    'иначе перебором выясняется, какие логины существуют');
});

test('оператор видит отзывы дома и скрывает отзыв с причиной и записью в журнал', { skip }, async () => {
  const { token } = await adminToken();
  const headers = { authorization: `Bearer ${token}` };
  const db = testDb();
  const address = 'обл Ростовская, г Аксай, ул Мира, д. 1';
  const key = parseAddress(address).houseKey;
  await insertRegistryHouse(db, { houseKey: key, addressRaw: address, garFlats: 60 });
  const me = await resident(db, key);
  const reviewId = newId('rev');
  await db.insert(houseReview).values({
    id: reviewId, houseKey: key, userId: me.userId,
    starsUk: 1, starsClean: 1, starsNeighbors: 1, starsQuiet: 1, starsYard: 1, cons: 'сосед из 12 квартиры Иванов',
  });

  const card = await app.inject({ method: 'GET', url: `/api/admin/houses/${key}`, headers });
  assert.equal(card.json().reviews[0].id, reviewId);

  const noReason = await app.inject({ method: 'POST', url: `/api/admin/reviews/${reviewId}/hide`, headers, payload: {} });
  assert.equal(noReason.statusCode, 400);

  const hidden = await app.inject({
    method: 'POST', url: `/api/admin/reviews/${reviewId}/hide`, headers, payload: { reason: 'персональные данные соседа' },
  });
  assert.equal(hidden.statusCode, 200);
  const [row] = await db.select().from(houseReview).where(eq(houseReview.id, reviewId));
  assert.ok(row.hiddenAt);

  const again = await app.inject({ method: 'POST', url: `/api/admin/reviews/${reviewId}/hide`, headers, payload: { reason: 'ещё' } });
  assert.equal(again.statusCode, 404);

  const audit = await app.inject({ method: 'GET', url: '/api/admin/audit', headers });
  assert.ok(audit.json().rows.some((r: { action: string }) => r.action === 'review.hide'));
});
