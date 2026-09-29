import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { buildApp } from './app.ts';
import { signInitDataForTesting } from '../lib/max/init-data.ts';
import { hashPassword } from '../lib/auth/password.ts';
import { parseAddress } from '../lib/address/normalize.ts';
import { newId } from '../lib/ids.ts';
import {
  testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL, insertRegistryHouse,
} from '../lib/test-db.ts';
import { closeDb } from '../db/client.ts';
import { consume, LIMITS, resetRateLimits } from '../lib/rate-limit.ts';
import {
  appUser, managingOrg, dispatcher, chairman, request as requestTable,
} from '../db/schema.ts';

/**
 * Проверки на дыры, найденные аудитом 25 августа.
 *
 * Отдельный файл, потому что они не про одну тему: это разные места,
 * связанные общим свойством — каждая ломалась на обычном вводе или
 * на обычном действии, а не на выдуманном сценарии.
 */

process.env.DATABASE_URL = TEST_URL;
process.env.DEV_TOOLS = '1';
// ||=, а не ??=: в заготовке .env.example токен пустой, и пустая строка ломала подписи
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

const QR = [
  'ST00011', 'Name=ООО "УК Трианон"', 'PayeeINN=6168108630', 'KPP=616801001',
  'Sum=381630', 'paymPeriod=042026', 'lastName=Крутых', 'firstName=Сергей',
  `payerAddress=${HOUSE}, кв. 27`, 'persAcc=987654331',
].join('|');

function initData(id: number, first: string, last: string) {
  return signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: 800000 + id, type: 'DIALOG' }),
    user: JSON.stringify({
      id, first_name: first, last_name: last,
      username: null, language_code: 'ru', photo_url: null,
    }),
  }, BOT_TOKEN);
}

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const app = buildApp();
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await app.close(); await closeTestDb(); await closeDb(); });

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
}

/** Дом в реестре, кабинет УК и председатель — минимальная обстановка. */
async function seedHouse() {
  const houseKey = parseAddress(HOUSE).houseKey;

  const [org] = await testDb().insert(managingOrg).values({
    id: newId('org'), inn: '6168108630', name: 'ООО «УК Трианон»',
    shortName: 'УК Трианон', regionCode: '61',
  }).returning({ id: managingOrg.id });

  await insertRegistryHouse(testDb(), {
    houseKey, orgId: org.id, regionCode: '61', addressRaw: HOUSE,
  });

  await testDb().insert(dispatcher).values({
    id: newId('dsp'), orgId: org.id, login: 'disp',
    passwordHash: await hashPassword('secret'), name: 'Диспетчер',
  });

  return { orgId: org.id, houseKey };
}

/**
 * Председатель дома с его сессией ЖИТЕЛЯ.
 *
 * Отдельного входа больше нет: председатель — такой же житель, права
 * выводятся из таблицы `chairman` по его `app_user`. Поэтому фикстура
 * заводит человека через обычную квитанцию, а потом ставит ему роль.
 */
async function seedChairman(houseKey: string, orgId: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70900, 'Пётр', 'Председателев') },
    payload: {
      qr: QR.replace('кв. 27', 'кв. 1').replace('persAcc=987654331', 'persAcc=987654301'),
    },
  });
  await grantAccess();

  const cookie = cookieFrom(res);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const userId = me.json().user.id;

  const chairmanId = newId('chr');
  await testDb().insert(chairman).values({
    id: chairmanId, orgId, houseKey, userId, name: 'Председателев Пётр',
  });

  return { cookie, chairmanId, userId };
}

async function loginAs(url: string, login: string, password: string) {
  const res = await app.inject({ method: 'POST', url, payload: { login, password } });
  return cookieFrom(res);
}

/** Житель с подтверждённым доступом. */
async function resident() {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70001, 'Сергей', 'Крутых') },
    payload: { qr: QR },
  });
  await grantAccess();
  const cookie = cookieFrom(res);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { cookie, propertyId: me.json().properties[0].propertyId };
}

/* ─────────────── О-1: оценка заявки ─────────────── */

/**
 * `stars < 1 || stars > 5` пропускала NaN: он не меньше единицы и не больше
 * пятёрки, оба сравнения дают false. Запрос без поля доходил до вставки
 * и падал в базе на колонке integer — житель видел «Что-то пошло не так».
 */
test('оценка без числа отвечает 400, а не 500', { skip }, async () => {
  await seedHouse();
  const { cookie, propertyId } = await resident();

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, description: 'Течёт кран в ванной, вода на полу' },
  });
  assert.equal(created.statusCode, 201);

  await testDb().update(requestTable)
    .set({ status: 'done' })
    .where(eq(requestTable.id, created.json().id));

  for (const payload of [{}, { stars: 3.7 }, { stars: 'много' }, { stars: 0 }, { stars: 6 }]) {
    const res = await app.inject({
      method: 'POST', url: `/api/requests/${created.json().id}/rating`,
      headers: { cookie }, payload,
    });
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)} должен давать 400`);
  }

  const ok = await app.inject({
    method: 'POST', url: `/api/requests/${created.json().id}/rating`,
    headers: { cookie }, payload: { stars: 5 },
  });
  assert.equal(ok.statusCode, 200);
});

/* ─────────────── О-2: даты ─────────────── */

/**
 * `new Date('завтра')` уезжал в Postgres как Invalid Date и ронял запрос
 * в 500. Пять мест подряд: срок объявления, дата закрытия опроса
 * и окно вызова мастера.
 */
test('нераспознанная дата отвечает 400, а не роняет сервер', { skip }, async () => {
  const { houseKey } = await seedHouse();
  const dispCookie = await loginAs('/api/dispatcher/login', 'disp', 'secret');
  const { cookie, propertyId } = await resident();

  const post = await app.inject({
    method: 'POST', url: '/api/dispatcher/posts', headers: { cookie: dispCookie },
    payload: { houseKey, category: 'news', title: 'Тест', body: 'Тестовое', expiresAt: 'завтра' },
  });
  assert.equal(post.statusCode, 400);
  assert.equal(post.json().error, 'bad_date');

  const poll = await app.inject({
    method: 'POST', url: '/api/dispatcher/polls', headers: { cookie: dispCookie },
    payload: { houseKey, title: 'Опрос', options: ['да', 'нет'], closesAt: 'никогда' },
  });
  assert.equal(poll.statusCode, 400);

  const master = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: {
      propertyId, kind: 'master',
      description: 'Нужен сантехник, течёт стояк', slotStart: 'завтра днём',
    },
  });
  assert.equal(master.statusCode, 400);
});

/* ─────────────── О-3: сообщение об ошибке ─────────────── */

test('битый JSON объясняет себя, а не отвечает «что-то пошло не так»', { skip }, async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'content-type': 'application/json' },
    payload: '{ это не json',
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /JSON/i, 'причина должна доезжать до человека');
});

/* ─────────────── О-4: границы опроса ─────────────── */

test('опрос с сотней вариантов не создаётся', { skip }, async () => {
  const { houseKey } = await seedHouse();
  const dispCookie = await loginAs('/api/dispatcher/login', 'disp', 'secret');

  const res = await app.inject({
    method: 'POST', url: '/api/dispatcher/polls', headers: { cookie: dispCookie },
    payload: {
      houseKey, title: 'Опрос',
      options: Array.from({ length: 100 }, (_, i) => `вариант ${i}`),
    },
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'too_many_options');
});

/* ─────────────── Б-7: границы прав председателя ─────────────── */

/**
 * `removePost` при вызове из кабинета председателя проверял только дом.
 * Объявление УК относится к тому же дому, поэтому проверку проходило —
 * и председатель снимал аварийное объявление управляющей компании.
 */
test('председатель не снимает объявление управляющей компании', { skip }, async () => {
  const { houseKey, orgId } = await seedHouse();
  const dispCookie = await loginAs('/api/dispatcher/login', 'disp', 'secret');
  const { cookie: chairCookie } = await seedChairman(houseKey, orgId);

  const ukPost = await app.inject({
    method: 'POST', url: '/api/dispatcher/posts', headers: { cookie: dispCookie },
    payload: { houseKey, category: 'outage', title: 'Отключение воды', body: 'Воды не будет до 18:00' },
  });
  assert.equal(ukPost.statusCode, 201);

  const attempt = await app.inject({
    method: 'DELETE', url: `/api/chairman/posts/${ukPost.json().id}`,
    headers: { cookie: chairCookie },
  });
  assert.equal(attempt.statusCode, 404, 'объявление УК председателю не подчиняется');

  const stillThere = await app.inject({
    method: 'GET', url: '/api/dispatcher/posts', headers: { cookie: dispCookie },
  });
  assert.equal(stillThere.json().posts[0].removed, false);

  // А своё — снимает
  const own = await app.inject({
    method: 'POST', url: '/api/chairman/posts', headers: { cookie: chairCookie },
    payload: { category: 'news', title: 'Субботник', body: 'В субботу в десять' },
  });
  const removed = await app.inject({
    method: 'DELETE', url: `/api/chairman/posts/${own.json().id}`,
    headers: { cookie: chairCookie },
  });
  assert.equal(removed.statusCode, 200);
});

/* ─────────────── Б-5: ограничение частоты ─────────────── */

test('перебор квитанций упирается в лимит', { skip }, async () => {
  resetRateLimits();

  let lastStatus = 0;
  for (let i = 0; i < LIMITS.receipt.limit + 2; i++) {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/qr',
      payload: { qr: QR.replace('persAcc=987654331', `persAcc=90000000${i}`) },
    });
    lastStatus = res.statusCode;
  }

  assert.equal(lastStatus, 429, 'после лимита сервер обязан отказывать');
});

test('перебор пароля кабинета упирается в лимит', { skip }, async () => {
  await seedHouse();
  resetRateLimits();

  let lastStatus = 0;
  for (let i = 0; i < LIMITS.login.limit + 2; i++) {
    const res = await app.inject({
      method: 'POST', url: '/api/dispatcher/login',
      payload: { login: 'disp', password: `попытка-${i}` },
    });
    lastStatus = res.statusCode;
  }

  assert.equal(lastStatus, 429);
});

test('счётчик отпускает по истечении окна', () => {
  resetRateLimits();
  const rule = { limit: 2, windowMs: 1 };

  assert.equal(consume('k', rule).allowed, true);
  assert.equal(consume('k', rule).allowed, true);
  assert.equal(consume('k', rule).allowed, false);
});

/* ─────────────── Б-2: адрес не утекает до подтверждения ─────────────── */

/**
 * Зная только ИНН получателя и номер лицевого счёта — оба напечатаны
 * на любой квитанции и оба перебираются, — посторонний получал в /api/me
 * полный адрес чужой квартиры с номером. Связка «лицевой счёт → квартира»
 * живёт только в биллинге УК, и раздавать её мы права не имеем.
 */
test('адрес чужой квартиры не отдаётся неподтверждённому', { skip }, async () => {
  await resident();

  // У постороннего есть только номер счёта и ИНН: адреса в его QR нет
  const blind = [
    'ST00011', 'Name=ООО "УК Трианон"', 'PayeeINN=6168108630',
    'Sum=100', 'paymPeriod=042026', 'persAcc=987654331',
  ].join('|');

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70099, 'Пётр', 'Чужой') },
    payload: { qr: blind },
  });
  assert.equal(res.statusCode, 202);

  const me = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${res.json().token}` },
  });

  /**
   * С 27 августа ожидающий объект приходит в приложение — но БЕЗ адреса,
   * если человек не принёс адрес сам. Здесь он не принёс: в его строке QR
   * только номер счёта и ИНН. Значит объект есть, а адреса в нём нет,
   * и связку «лицевой счёт → квартира» он по-прежнему не узнаёт.
   */
  const props = me.json().properties;
  assert.equal(props.length, 1, 'своя заявка — это его объект уровня 0');
  assert.equal(props[0].accessLevel, 'self', 'дом и соседи закрыты');
  assert.equal(props[0].addressRaw, null, 'адрес не отдаём');
  assert.equal(props[0].street, null);
  assert.equal(props[0].flat, null);
  assert.equal(props[0].houseKey, null, 'и ключа дома тоже');
  assert.equal(me.json().myPendingAccess.length, 1, 'свою заявку человек видит');
  assert.ok(!/Ленина/.test(me.body), 'адреса нет нигде в ответе');
});

/**
 * Тот же перебор, но целится не в адрес, а в название управляющей
 * организации внутри `houseManagement`.
 *
 * Дом обязан быть зарегистрирован (`seedHouse`) — иначе `orgName` и так
 * пуст, и проверка ничего не доказывает. Посторонний по-прежнему приносит
 * только ИНН получателя и номер счёта, но у ТСЖ/УК обычно один-два дома
 * на организацию, так что название — это то же раскрытие «счёт → адрес»,
 * от которого защищены соседние поля.
 */
test('название управляющей организации не отдаётся неподтверждённому', { skip }, async () => {
  await seedHouse();
  await resident();

  // Тот же посторонний: знает только ИНН получателя и номер лицевого счёта
  const blind = [
    'ST00011', 'Name=ООО "УК Трианон"', 'PayeeINN=6168108630',
    'Sum=100', 'paymPeriod=042026', 'persAcc=987654331',
  ].join('|');

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70098, 'Пётр', 'Чужой') },
    payload: { qr: blind },
  });
  assert.equal(res.statusCode, 202);

  const me = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${res.json().token}` },
  });

  const body = me.json();
  const props = body.properties;
  assert.equal(props.length, 1, 'своя заявка — это его объект уровня 0');
  assert.equal(
    props[0].houseManagement, null,
    'непринесённый адрес — houseManagement целиком null, а не урезанный объект',
  );
  assert.equal(body.myPendingAccess.length, 1, 'свою заявку человек видит');
  assert.equal(
    body.myPendingAccess[0].houseManagement, null,
    'то же самое поле в экране ожидания заявки — тоже целиком null',
  );
});

/**
 * Тот же перебор, но целится в поле `ukName` (и соседние `ukFullName`,
 * `ukPhone`) самого объекта `properties[0]`, а не в `houseManagement`.
 *
 * Ревью нашло дыру рядом с уже защищённым `houseManagement.orgName`:
 * `ukName` собирался из `...r` без гейта `hideAddress` и отдавал название
 * УК/ТСЖ открытым текстом даже тогда, когда `houseManagement` уже null.
 * Организаций на один-два дома немного, и название почти так же
 * однозначно указывает на квартиру, как сам адрес. Заодно проверяем
 * `ukFullName` и `ukPhone` — те же поля организации, найденные рядом.
 */
test('название и телефон УК не отдаются неподтверждённому через поле ukName', { skip }, async () => {
  await seedHouse();
  await resident();

  // Тот же посторонний: знает только ИНН получателя и номер лицевого счёта
  const blind = [
    'ST00011', 'Name=ООО "УК Трианон"', 'PayeeINN=6168108630',
    'Sum=100', 'paymPeriod=042026', 'persAcc=987654331',
  ].join('|');

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70097, 'Пётр', 'Чужой') },
    payload: { qr: blind },
  });
  assert.equal(res.statusCode, 202);

  const me = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${res.json().token}` },
  });

  const props = me.json().properties;
  assert.equal(props.length, 1, 'своя заявка — это его объект уровня 0');
  assert.equal(props[0].ukName, null, 'название УК не отдаём без своего адреса');
  assert.equal(props[0].ukFullName, null, 'и полное название тоже');
  assert.equal(props[0].ukPhone, null, 'и телефон УК тоже');
});

/* ─────────────── Б-13: здоровье не рассказывает про стенд ─────────────── */

test('проверка живости в бою не рассказывает про базу', { skip }, async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: 'ok' });
    assert.ok(!/postgres|localhost|5433/i.test(res.body), 'драйвер и хост наружу не уходят');
  } finally {
    process.env.NODE_ENV = before;
  }

  // Вне продакшена подробности остаются: их читает npm run prod:health
  const dev = await app.inject({ method: 'GET', url: '/api/health' });
  assert.ok(dev.json().db, 'в разработке диагностика нужна');
});

/**
 * Б-8: вход по квитанции вне MAX в бою закрыт.
 *
 * Строку платёжного QR можно набрать руками, и сервер не отличит её
 * от снятой камерой. Значит без подписи платформы предъявлять нечего.
 */
test('в бою вход по квитанции без MAX закрыт', { skip }, async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/qr', payload: { qr: QR },
    });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'web_login_disabled');
  } finally {
    process.env.NODE_ENV = before;
  }
});

/* ─────────────── Д-2: гонка номеров заявок ─────────────── */

/**
 * Номер считался как `max(number) + 1` отдельным запросом. Из пяти
 * одновременных заявок проходили две, три отвечали 500 — и это не про
 * толпу жильцов, а про двойной тап по кнопке «Отправить».
 */
test('одновременные заявки получают разные номера, а не 500', { skip }, async () => {
  await seedHouse();
  const { cookie, propertyId } = await resident();

  const results = await Promise.all(
    Array.from({ length: 5 }, () => app.inject({
      method: 'POST', url: '/api/requests', headers: { cookie },
      payload: { propertyId, description: 'Течёт кран в ванной, вода на полу' },
    })),
  );

  const codes = results.map((r) => r.statusCode);
  assert.deepEqual(codes, [201, 201, 201, 201, 201], `получили ${codes.join(', ')}`);

  const numbers = results.map((r) => r.json().number);
  assert.equal(new Set(numbers).size, 5, 'номера обязаны быть разными');
});

/* ─────────────── очередь заявок у председателя ─────────────── */

test('ПЕТЛЯ: заявка жителя → очередь председателя → доступ открыт', { skip }, async () => {
  const { houseKey, orgId } = await seedHouse();
  const { cookie: chairCookie } = await seedChairman(houseKey, orgId);

  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70002, 'Мария', 'Иванова') },
    payload: { qr: QR.replace('кв. 27', 'кв. 54').replace('persAcc=987654331', 'persAcc=987654354') },
  });
  assert.equal(scan.statusCode, 202);
  assert.equal(scan.json().hasChairman, true, 'человек должен знать, кого он ждёт');

  const token = scan.json().token;

  // Пока о себе не рассказал — подтверждать нечего
  const early = await app.inject({
    method: 'GET', url: '/api/chairman/claims', headers: { cookie: chairCookie },
  });
  assert.equal(early.json().claims[0].complete, false);

  const blind = await app.inject({
    method: 'POST', url: `/api/chairman/claims/${scan.json().bindingId}/approve`,
    headers: { cookie: chairCookie }, payload: { role: 'owner' },
  });
  assert.equal(blind.statusCode, 409, 'вслепую подтверждать нельзя');

  await app.inject({
    method: 'POST', url: `/api/properties/claims/${scan.json().bindingId}`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Иванова Мария Петровна', flat: '54', note: 'живу с 2019 года' },
  });

  const queue = await app.inject({
    method: 'GET', url: '/api/chairman/claims', headers: { cookie: chairCookie },
  });
  assert.equal(queue.json().total, 1);
  assert.equal(queue.json().claims[0].claimedName, 'Иванова Мария Петровна');
  assert.equal(queue.json().claims[0].note, 'живу с 2019 года');
  assert.equal(queue.json().claims[0].complete, true);

  const approved = await app.inject({
    method: 'POST', url: `/api/chairman/claims/${scan.json().bindingId}/approve`,
    headers: { cookie: chairCookie }, payload: { role: 'owner' },
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().role, 'owner');

  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.json().properties.length, 1, 'доступ открыт');
  assert.equal(me.json().properties[0].role, 'owner');
});

test('отказ приходит с причиной, а очередь пустеет', { skip }, async () => {
  const { houseKey, orgId } = await seedHouse();
  const { cookie: chairCookie } = await seedChairman(houseKey, orgId);

  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70003, 'Захар', 'Захватов') },
    payload: { qr: QR },
  });
  await app.inject({
    method: 'POST', url: `/api/properties/claims/${scan.json().bindingId}`,
    headers: { authorization: `Bearer ${scan.json().token}` },
    payload: { name: 'Захватов Захар', flat: '27' },
  });

  const noReason = await app.inject({
    method: 'POST', url: `/api/chairman/claims/${scan.json().bindingId}/reject`,
    headers: { cookie: chairCookie }, payload: {},
  });
  assert.equal(noReason.statusCode, 400, 'без причины отказывать нельзя');

  const rejected = await app.inject({
    method: 'POST', url: `/api/chairman/claims/${scan.json().bindingId}/reject`,
    headers: { cookie: chairCookie },
    payload: { reason: 'В 27-й живёт другая семья' },
  });
  assert.equal(rejected.statusCode, 200);

  const queue = await app.inject({
    method: 'GET', url: '/api/chairman/claims', headers: { cookie: chairCookie },
  });
  assert.equal(queue.json().total, 0);

  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${scan.json().token}` },
  });
  assert.equal(me.json().properties.length, 0);
  assert.equal(me.json().myPendingAccess[0].rejectReason, 'В 27-й живёт другая семья');
});

test('председатель чужого дома в очередь не попадает', { skip }, async () => {
  const { orgId } = await seedHouse();

  const otherKey = parseAddress('344038, Ростовская обл, г Ростов-на-Дону, ул Другая, д 1').houseKey;
  await insertRegistryHouse(testDb(), {
    houseKey: otherKey, orgId, regionCode: '61',
    addressRaw: '344038, Ростовская обл, г Ростов-на-Дону, ул Другая, д 1',
  });
  // Председатель ДРУГОГО дома: житель с квартирой на «ул Другая»
  const foreignRes = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70901, 'Иван', 'Другов') },
    payload: {
      qr: QR
        .replace('344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3, кв. 27',
                 '344038, Ростовская обл, г Ростов-на-Дону, ул Другая, д 1, кв. 5')
        .replace('persAcc=987654331', 'persAcc=987650005'),
    },
  });
  await grantAccess();
  const foreignCookie = cookieFrom(foreignRes);
  const foreignMe = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: foreignCookie },
  });

  await testDb().insert(chairman).values({
    id: newId('chr'), orgId, houseKey: otherKey,
    userId: foreignMe.json().user.id, name: 'Другов Иван',
  });

  // Заявка на ПЕРВЫЙ дом
  await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70004, 'Сергей', 'Крутых') },
    payload: { qr: QR },
  });

  const queue = await app.inject({
    method: 'GET', url: '/api/chairman/claims', headers: { cookie: foreignCookie },
  });

  assert.equal(queue.json().total, 0, 'чужие заявки не видны');
});

/**
 * УК ВИДИТ очередь, но не решает.
 *
 * Прежде диспетчер мог подтвердить жителя сам — это отменено: он заходит
 * в кабинет хорошо если раз в месяц, и очередь встала бы навсегда.
 * Список остался ему для сведения: видно, что в доме копятся заявки,
 * а председателя нет, — значит его пора назначить.
 */
test('УК видит очередь, но подтвердить не может', { skip }, async () => {
  const { houseKey } = await seedHouse();
  await testDb().delete(chairman).where(eq(chairman.houseKey, houseKey));

  const dispCookie = await loginAs('/api/dispatcher/login', 'disp', 'secret');

  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70005, 'Сергей', 'Крутых') },
    payload: { qr: QR },
  });
  assert.equal(scan.json().hasChairman, false, 'честно говорим, что председателя нет');

  await app.inject({
    method: 'POST', url: `/api/properties/claims/${scan.json().bindingId}`,
    headers: { authorization: `Bearer ${scan.json().token}` },
    payload: { name: 'Крутых Сергей', flat: '27' },
  });

  const queue = await app.inject({
    method: 'GET', url: '/api/dispatcher/claims', headers: { cookie: dispCookie },
  });
  assert.equal(queue.json().total, 1, 'очередь видна');
  assert.equal(queue.json().needChairman.length, 1, 'и видно, что дому нужен председатель');
  assert.equal(queue.json().needChairman[0].waiting, 1);

  // Маршрутов подтверждения у УК больше нет вовсе
  for (const url of [
    `/api/dispatcher/claims/${scan.json().bindingId}/approve`,
    `/api/dispatcher/claims/${scan.json().bindingId}/reject`,
  ]) {
    const res = await app.inject({
      method: 'POST', url, headers: { cookie: dispCookie }, payload: { role: 'owner' },
    });
    assert.equal(res.statusCode, 404, `${url} не должен существовать`);
  }

  // Житель по-прежнему ждёт
  const me = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${scan.json().token}` },
  });
  assert.equal(me.json().properties[0].accessLevel, 'self', 'полного доступа нет');
  assert.equal(me.json().properties[0].status, 'pending');
});

/* ─────────────── Ф-1: счётчики можно завести ─────────────── */

/**
 * Вставка в таблицу `meter` существовала ТОЛЬКО в тестах: ни маршрута,
 * ни импорта, ни seed-скрипта. Значит список счётчиков был пуст у каждого
 * реального жителя, форма передачи показаний недостижима, а вся ловля
 * опечаток и аналитика по расходу — код, который в бою не выполняется.
 */
test('ПЕТЛЯ: житель заводит счётчик и передаёт показания', { skip }, async () => {
  await seedHouse();
  const { cookie, propertyId } = await resident();

  const before = await app.inject({
    method: 'GET', url: `/api/properties/${propertyId}/meters`, headers: { cookie },
  });
  assert.equal(before.json().meters.length, 0);
  assert.ok(before.json().kinds.length > 0, 'форме нужен список видов');

  const added = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/meters`, headers: { cookie },
    payload: { kind: 'cold' },
  });
  assert.equal(added.statusCode, 201);

  const list = await app.inject({
    method: 'GET', url: `/api/properties/${propertyId}/meters`, headers: { cookie },
  });
  assert.equal(list.json().meters.length, 1);
  assert.equal(list.json().meters[0].label, 'Холодная вода');
  /**
   * Заводского номера и поверки в ответе больше нет: дневнику они
   * не нужны, а форма с тремя полями вместо одного бросается на середине.
   */
  assert.equal(list.json().meters[0].serial, undefined);
  assert.equal(list.json().meters[0].verificationDue, undefined);

  const reading = await app.inject({
    method: 'POST', url: `/api/meters/${added.json().meterId}/readings`,
    headers: { cookie }, payload: { value: '221.4' },
  });
  assert.equal(reading.statusCode, 201);
});

test('второй счётчик того же вида не заводится', { skip }, async () => {
  await seedHouse();
  const { cookie, propertyId } = await resident();

  const first = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/meters`,
    headers: { cookie }, payload: { kind: 'cold' },
  });
  assert.equal(first.statusCode, 201);

  const second = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/meters`,
    headers: { cookie }, payload: { kind: 'cold' },
  });
  assert.equal(second.statusCode, 409);
});

test('счётчик на чужой квартире не завести', { skip }, async () => {
  await seedHouse();
  const { propertyId } = await resident();

  const outsider = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70088, 'Пётр', 'Чужой') },
    payload: { qr: QR.replace('кв. 27', 'кв. 99').replace('persAcc=987654331', 'persAcc=987654399') },
  });
  await grantAccess();

  const attempt = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/meters`,
    headers: { authorization: `Bearer ${outsider.json().token}` },
    payload: { kind: 'gas' },
  });
  assert.equal(attempt.statusCode, 403);
});

/* ─────────────── Ф-2: уведомления можно прочитать ─────────────── */

/**
 * Уведомления писались в базу с самого начала, но маршрута чтения
 * не существовало, а колонка `read` не использовалась. Для жителя
 * из браузера канал доставки мёртв полностью: сообщения бота приходят
 * только внутри MAX.
 */
test('житель видит уведомления, которых не получил сообщением', { skip }, async () => {
  await seedHouse();
  const dispCookie = await loginAs('/api/dispatcher/login', 'disp', 'secret');
  const { cookie, propertyId } = await resident();

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, description: 'Течёт кран в ванной, вода на полу' },
  });

  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${created.json().id}/status`,
    headers: { cookie: dispCookie },
    payload: { status: 'in_work', assigneeName: 'Петров И., сантехник' },
  });

  const list = await app.inject({
    method: 'GET', url: '/api/notifications', headers: { cookie },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().notifications.length, 1);
  assert.equal(list.json().unread, 1);
  assert.match(list.json().notifications[0].title, /в работе/);
  assert.equal(list.json().notifications[0].delivered, false, 'в браузере сообщение не ушло');

  await app.inject({ method: 'POST', url: '/api/notifications/read', headers: { cookie } });

  const after = await app.inject({
    method: 'GET', url: '/api/notifications', headers: { cookie },
  });
  assert.equal(after.json().unread, 0);
});

test('чужие уведомления не видны и не помечаются', { skip }, async () => {
  await seedHouse();
  const { cookie, propertyId } = await resident();
  const dispCookie = await loginAs('/api/dispatcher/login', 'disp', 'secret');

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, description: 'Течёт кран в ванной, вода на полу' },
  });
  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${created.json().id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'in_work' },
  });

  const outsider = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70077, 'Пётр', 'Чужой') },
    payload: { qr: QR.replace('кв. 27', 'кв. 88').replace('persAcc=987654331', 'persAcc=987654388') },
  });
  await grantAccess();

  const theirs = await app.inject({
    method: 'GET', url: '/api/notifications',
    headers: { authorization: `Bearer ${outsider.json().token}` },
  });
  assert.equal(theirs.json().notifications.length, 0, 'чужих уведомлений быть не должно');

  const mine = await app.inject({
    method: 'GET', url: '/api/notifications', headers: { cookie },
  });
  assert.equal(mine.json().unread, 1, 'а своё осталось непрочитанным');
});

/* ─────────────── уровень 0: жалоба не ждёт подтверждения ─────────────── */

/**
 * Ядро продукта — доказательство, что человек пожаловался, и неудаляемый
 * след в архиве УК. Ставить перед этим чужое одобрение значит закрыть
 * продукт на замок: председателя у дома может не быть вовсе.
 */
test('заявку в УК можно подать до подтверждения председателем', { skip }, async () => {
  await seedHouse();

  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70110, 'Сергей', 'Крутых') },
    payload: { qr: QR },
  });
  assert.equal(scan.statusCode, 202, 'доступ ещё не подтверждён');
  const token = scan.json().token;

  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.json().properties[0].accessLevel, 'self', 'полного доступа нет');
  const pending = me.json().myPendingAccess[0];
  assert.ok(pending.propertyId, 'но объект для жалобы известен');

  const complaint = await app.inject({
    method: 'POST', url: '/api/requests',
    headers: { authorization: `Bearer ${token}` },
    payload: { propertyId: pending.propertyId, description: 'В подъезде нет света третий день' },
  });
  assert.equal(complaint.statusCode, 201, 'жалоба должна проходить');
  assert.ok(complaint.json().number, 'и получать номер');

  // И она видна ему же
  const list = await app.inject({
    method: 'GET', url: '/api/requests', headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(list.json().active.length, 1);
});

test('свои квитанции и счётчики видны до подтверждения, соседи — нет', { skip }, async () => {
  await seedHouse();

  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70111, 'Сергей', 'Крутых') },
    payload: { qr: QR },
  });
  const token = scan.json().token;
  const auth = { authorization: `Bearer ${token}` };
  const propertyId = (await app.inject({
    method: 'GET', url: '/api/me', headers: auth,
  })).json().myPendingAccess[0].propertyId;

  // Своё — можно
  assert.equal((await app.inject({
    method: 'GET', url: `/api/properties/${propertyId}/bills`, headers: auth,
  })).statusCode, 200);
  assert.equal((await app.inject({
    method: 'GET', url: `/api/properties/${propertyId}/meters`, headers: auth,
  })).statusCode, 200);
  assert.equal((await app.inject({
    method: 'GET', url: `/api/properties/${propertyId}/analytics`, headers: auth,
  })).statusCode, 200);

  // Чужое — нельзя
  assert.equal((await app.inject({
    method: 'GET', url: `/api/properties/${propertyId}/household`, headers: auth,
  })).statusCode, 403, 'состав жильцов — это уже про других людей');
  assert.equal((await app.inject({
    method: 'GET', url: '/api/feed', headers: auth,
  })).json().posts.length, 0, 'ленты дома до подтверждения нет');
});

/**
 * Адрес из СВОЕЙ квитанции скрывать бессмысленно — человек держит её
 * в руках. Скрывать надо тот, что сервер поднял по номеру счёта.
 */
test('свой адрес виден до подтверждения, чужой — нет', { skip }, async () => {
  await seedHouse();

  const mine = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70112, 'Сергей', 'Крутых') },
    payload: { qr: QR },
  });
  const mineMe = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${mine.json().token}` },
  });
  assert.match(
    mineMe.json().myPendingAccess[0].addressRaw, /Ленина/,
    'адрес из своей квитанции показываем',
  );

  // А теперь посторонний: в его QR адреса нет вовсе
  const blind = [
    'ST00011', 'Name=ООО "УК Трианон"', 'PayeeINN=6168108630',
    'Sum=100', 'paymPeriod=042026', 'persAcc=987654331',
  ].join('|');

  const other = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(70113, 'Пётр', 'Чужой') },
    payload: { qr: blind },
  });
  const otherMe = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${other.json().token}` },
  });
  assert.equal(
    otherMe.json().myPendingAccess[0].addressRaw, null,
    'адрес, поднятый по номеру счёта, не наш, чтобы его раздавать',
  );
});

/* ─────────────── совет дома внутри приложения ─────────────── */

/**
 * Отдельного входа у председателя больше нет: он заходит как житель,
 * а права выводятся из роли. Второй аккаунт заставлял человека помнить,
 * «под кем он сейчас», — а в советах домов большинство пожилые.
 */
test('председатель работает своей же сессией жителя', { skip }, async () => {
  const { houseKey, orgId } = await seedHouse();
  const { cookie } = await seedChairman(houseKey, orgId);

  const me = await app.inject({
    method: 'GET', url: '/api/chairman/me', headers: { cookie },
  });
  assert.equal(me.json().isChairman, true);
  assert.equal(me.json().houses.length, 1);
  assert.ok(me.json().houses[0].houseLabel, 'адрес дома словами, а не хеш');

  // Той же сессией он остаётся обычным жителем
  const resident = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(resident.statusCode, 200);
  assert.equal(resident.json().properties.length, 1);
});

test('обычный житель в совет дома не попадает', { skip }, async () => {
  await seedHouse();
  const { cookie } = await resident();

  const me = await app.inject({
    method: 'GET', url: '/api/chairman/me', headers: { cookie },
  });
  assert.equal(me.json().isChairman, false);

  const house = await app.inject({
    method: 'GET', url: '/api/chairman/house', headers: { cookie },
  });
  assert.equal(house.statusCode, 403);
});

/**
 * Сводка по дому. Оплата ПОКВАРТИРНО и без ФИО: кто именно не заплатил,
 * председателю знать не нужно и по 152-ФЗ не положено.
 */
test('сводка дома: квартиры, жильцы, счета, оплата, счётчики', { skip }, async () => {
  const { houseKey, orgId } = await seedHouse();
  const { cookie: chairCookie } = await seedChairman(houseKey, orgId);
  const { cookie, propertyId } = await resident();

  await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/meters`,
    headers: { cookie }, payload: { kind: 'cold' },
  });

  const overview = await app.inject({
    method: 'GET', url: '/api/chairman/house', headers: { cookie: chairCookie },
  });
  assert.equal(overview.statusCode, 200);

  const data = overview.json();
  assert.ok(data.totals.flats >= 2, 'квартира жителя и квартира председателя');
  assert.ok(data.disclaimer.length > 0, 'оговорка едет вместе с числами');

  /**
   * Четыре состояния оплаты обязаны складываться в число квартир.
   *
   * Без графы «ждут оплаты» сумма плиток не сходилась с числом квартир,
   * и председатель считал разницу должниками: на доме в 60 квартир
   * «42 оплачено, 0 просрочено» оставляло 18 квартир необъяснёнными.
   */
  const t = data.totals;
  assert.equal(
    t.paid + t.due + t.overdue + t.unknown, t.flats,
    'состояния оплаты покрывают все квартиры без остатка',
  );

  const flat = data.flats.find((f: { flat: string }) => f.flat === '27');
  assert.ok(flat, 'квартира жителя в сводке есть');
  assert.equal(flat.residents.length, 1, 'кто живёт — видно');
  assert.equal(flat.accounts.length, 1, 'лицевой счёт — видно');
  assert.equal(flat.accounts[0].persAcc, '987654331');
  assert.equal(flat.meters.length, 1, 'счётчик — видно');
  assert.equal(flat.payment.state, 'overdue', 'квитанция за апрель 2026 давно просрочена');

  /**
   * Имён в блоке оплаты быть не должно: состояние привязано к квартире,
   * а не к человеку.
   */
  assert.equal(Object.keys(flat.payment).sort().join(','), 'paidCount,period,state,totalCount');
});

test('председатель видит только свой дом', { skip }, async () => {
  const { houseKey, orgId } = await seedHouse();
  const { cookie: chairCookie } = await seedChairman(houseKey, orgId);

  const otherKey = parseAddress('344038, Ростовская обл, г Ростов-на-Дону, ул Иная, д 7').houseKey;
  await insertRegistryHouse(testDb(), {
    houseKey: otherKey, orgId, regionCode: '61',
    addressRaw: '344038, Ростовская обл, г Ростов-на-Дону, ул Иная, д 7',
  });

  const foreign = await app.inject({
    method: 'GET', url: `/api/chairman/house?houseKey=${otherKey}`,
    headers: { cookie: chairCookie },
  });
  assert.equal(foreign.statusCode, 403);
});

/**
 * Предполётный запрос обязан пропускать ВСЕ заголовки, которые шлёт фронт.
 *
 * ЧЕМ ЭТО СТОИЛО. Фронт на GitHub Pages, API на своём домене — значит любой
 * запрос с нестандартным заголовком браузер сперва проверяет запросом
 * OPTIONS. Стоило добавить `X-Scan-Platform` в клиент и забыть про этот
 * список, как внутри MAX перестало работать ВСЁ: браузер блокировал запрос
 * целиком, `fetch` падал с TypeError, и приложение показывало «сервер
 * недоступен» — при полностью живом сервере.
 *
 * Поэтому список проверяется тестом, а не глазами: следующий заголовок
 * добавят так же незаметно.
 */
test('CORS пропускает все заголовки, которые шлёт фронт', { skip }, async () => {
  const FRONT_HEADERS = [
    'content-type',
    'authorization',
    'x-max-init-data',
    'x-scan-platform',
  ];

  const res = await app.inject({
    method: 'OPTIONS',
    url: '/api/auth/qr',
    headers: {
      origin: 'http://localhost:3000',
      'access-control-request-method': 'POST',
      'access-control-request-headers': FRONT_HEADERS.join(','),
    },
  });

  const allowed = (res.headers['access-control-allow-headers'] ?? '')
    .toString().toLowerCase().split(',').map((h) => h.trim());

  for (const header of FRONT_HEADERS) {
    assert.ok(
      allowed.includes(header),
      `${header} не разрешён — браузер заблокирует запрос целиком`,
    );
  }
});
