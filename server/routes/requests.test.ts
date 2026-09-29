import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import { setTransport, type Transport } from '../../lib/notify/index.ts';
import { hashPassword } from '../../lib/auth/password.ts';
import { testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL, insertRegistryHouse } from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';
import { dispatcher, property, uk, request } from '../../db/schema.ts';
import { newId } from '../../lib/ids.ts';
import { eq } from 'drizzle-orm';

/**
 * Сквозная петля: житель заводит заявку → она попадает в кабинет УК →
 * диспетчер меняет статус → житель видит обновление и получает уведомление.
 *
 * Ровно это показываем на демо, поэтому проверяем целиком, а не по кускам.
 */

/**
 * Приложение под тестом обязано ходить в ТУ ЖЕ базу, что и фикстуры.
 *
 * Адрес берём из test-db, а не пишем здесь второй раз: пока это были две
 * разные строки, приложение работало с рабочей базой, фикстуры — с тестовой,
 * и все сквозные проверки падали на пустых выборках.
 *
 * Присваиваем безусловно: значение из .env.local указывает на рабочую базу,
 * а её тесты вытирают TRUNCATE-ом.
 */
process.env.DATABASE_URL = TEST_URL;
process.env.DEV_TOOLS = '1';
// ||=, а не ??=: в заготовке .env.example токен пустой, и пустая строка ломала подписи
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const QR =
  'ST00011|Name=ООО "УК Пример"|PersonalAcc=40702810952090030727|BankName=ПАО Сбербанк|' +
  'BIC=046015602|CorrespAcc=30101810600000000602|Sum=485000|Purpose=Оплата за ЖКУ|' +
  'PayeeINN=6100000001|KPP=610001001|lastName=Смирнова|firstName=Анна|middleName=Игоревна|' +
  'payerAddress=344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3, кв. 15|' +
  'persAcc=4460153|paymPeriod=082026|category=001';

function initData(id: number, first: string, last: string) {
  return signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: 800000 + id, type: 'DIALOG' }),
    query_id: `q-${id}`,
    user: JSON.stringify({
      id, first_name: first, last_name: last,
      username: null, language_code: 'ru', photo_url: null,
    }),
  }, BOT_TOKEN);
}

const anna = () => initData(90001, 'Анна', 'Смирнова');

/** Транспорт-заглушка: тесты не должны ходить в сеть. */
const sent: { chatId: number; text: string; payload?: string }[] = [];
const fakeTransport: Transport = {
  async sendToMax(chatId, text, payload) { sent.push({ chatId, text, payload }); },
};

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const app = buildApp();
setTransport(fakeTransport);

beforeEach(async () => {
  if (!available) return;
  await resetTables();
  sent.length = 0;
});
after(async () => {
  setTransport(null);
  await app.close();
  await closeTestDb();
  await closeDb();
});

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
}

/**
 * Житель входит по квитанции и получает куку + свой объект.
 *
 * Реестр заводим ДО входа: связка «дом → УК» берётся оттуда, и объект,
 * созданный раньше реестра, останется без управляющей организации.
 */
async function loginResident() {
  await seedOrg(['344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3']);

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': anna() },
    payload: { qr: QR },
  });
  const cookie = cookieFrom(res);
  // Доступ выдаёт председатель; здесь это фикстура — см. lib/test-db.ts
  await grantAccess();
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { cookie, propertyId: me.json().properties[0].propertyId };
}

/** Диспетчер той же УК, что и объект жителя. */
/**
 * Управляющая организация в реестре и её дом.
 *
 * Создаётся ДО жителя: связка «дом → УК» берётся из реестра лицензий,
 * а не из квитанции, поэтому объект жителя подхватит организацию только
 * если она уже там есть.
 */
async function seedOrg(addresses: string[], suffix = '') {
  const { managingOrg } = await import('../../db/schema.ts');
  const { parseAddress } = await import('../../lib/address/normalize.ts');

  const [org] = await testDb().insert(managingOrg).values({
    id: newId('org'),
    inn: `61000000${suffix || '01'}`,
    name: `ООО «УК Пример${suffix}»`,
    shortName: `УК Пример${suffix}`,
    regionCode: '61',
    licenseNumber: '061000001',
    houseCount: addresses.length,
  }).onConflictDoUpdate({
    target: managingOrg.inn,
    set: { houseCount: addresses.length },
  }).returning({ id: managingOrg.id });

  const orgId = org.id;

  for (const address of addresses) {
    const key = parseAddress(address).houseKey;
    await insertRegistryHouse(testDb(), {
      houseKey: key, orgId, regionCode: '61', addressRaw: address,
    });
  }

  return orgId;
}

async function loginDispatcher(orgId?: string) {
  const id = orgId ?? await seedOrg(['344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3']);
  await testDb().insert(dispatcher).values({
    id: newId('dsp'), orgId: id, login: 'disp',
    passwordHash: await hashPassword('secret'), name: 'Диспетчер',
  });
  const res = await app.inject({
    method: 'POST', url: '/api/dispatcher/login',
    payload: { login: 'disp', password: 'secret' },
  });
  return cookieFrom(res);
}

const QR_NO_UK =
  'ST00011|Name=ООО "Энергосбыт"|PersonalAcc=40702810900000000123|BankName=ПАО Сбербанк|' +
  'BIC=046015602|CorrespAcc=30101810600000000602|Sum=250000|Purpose=Оплата за электроэнергию|' +
  'PayeeINN=6100000090|KPP=610001001|lastName=Заводской|firstName=Игорь|middleName=Игоревич|' +
  'payerAddress=344010, Ростовская обл, г Ростов-на-Дону, ул Садовая, д. 9|' +
  'persAcc=7770009|paymPeriod=082026|category=001';

/**
 * Житель дома, которого нет в реестре управляющих организаций.
 *
 * Реестр (`seedOrg`) для этого адреса намеренно не вызывается: houseKey
 * объекта не должен иметь реестрового слоя в `house`, иначе проверка ядра
 * продукта для дома без УК ничего бы не проверяла.
 */
async function residentWithoutUk() {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(90040, 'Игорь', 'Заводской') },
    payload: { qr: QR_NO_UK },
  });
  const token = res.json().token;
  const me = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${token}` },
  });
  return { token, propertyId: me.json().properties[0].propertyId };
}

test('житель заводит заявку и получает номер со сроком', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();

  const res = await app.inject({
    method: 'POST', url: '/api/requests',
    headers: { cookie },
    payload: { propertyId, category: 'Сантехника', description: 'Течёт стояк в ванной, вода на полу' },
  });

  assert.equal(res.statusCode, 201);
  assert.equal(res.json().number, '00001');
  assert.equal(res.json().slaHours, 24, 'сантехника — сутки');
});

test('слишком короткое описание не принимается', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const res = await app.inject({
    method: 'POST', url: '/api/requests',
    headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'ой' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /подробнее/i);
});

test('заявку нельзя завести по чужому объекту', { skip }, async () => {
  const { cookie } = await loginResident();
  const foreign = newId('prp');

  const res = await app.inject({
    method: 'POST', url: '/api/requests',
    headers: { cookie },
    payload: { propertyId: foreign, category: 'Другое', description: 'Что-нибудь сломалось тут' },
  });
  assert.equal(res.statusCode, 403);
});

test('авария получает срок два часа, а не общие трое суток', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const res = await app.inject({
    method: 'POST', url: '/api/requests',
    headers: { cookie },
    payload: { propertyId, category: 'Авария', description: 'Прорвало трубу в подвале дома' },
  });
  assert.equal(res.json().slaHours, 2);
});

test('ПЕТЛЯ: заявка → кабинет УК → смена статуса → житель видит', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();

  const created = await app.inject({
    method: 'POST', url: '/api/requests',
    headers: { cookie },
    payload: { propertyId, category: 'Сантехника', description: 'Течёт стояк в ванной, вода на полу' },
  });
  const requestId = created.json().id;

  // 1. Заявка видна диспетчеру
  const queue = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests',
    headers: { cookie: dispCookie },
  });
  assert.equal(queue.statusCode, 200);
  assert.equal(queue.json().counters.new, 1);
  const inQueue = queue.json().requests[0];
  assert.equal(inQueue.number, '00001');
  assert.equal(inQueue.authorName, 'Смирнова Анна');
  assert.match(inQueue.flat, /15/);

  // Дом выбирается из списка, без поиска: список пришёл с очередью
  const [queueHouse] = queue.json().houses;
  assert.equal(queueHouse.open, 1);
  const byHouse = await app.inject({
    method: 'GET', url: `/api/dispatcher/requests?house=${encodeURIComponent(queueHouse.houseKey)}&sort=newest`,
    headers: { cookie: dispCookie },
  });
  assert.equal(byHouse.json().total, 1);
  const otherHouse = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests?house=nope',
    headers: { cookie: dispCookie },
  });
  assert.equal(otherHouse.json().total, 0);

  // 2. Диспетчер берёт в работу и назначает мастера
  const change = await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${requestId}/status`,
    headers: { cookie: dispCookie },
    payload: { status: 'in_work', assigneeName: 'Виктор С.' },
  });
  assert.equal(change.statusCode, 200);
  assert.equal(change.json().notified, true, 'житель должен получить уведомление');

  // 3. Уведомление ушло в MAX с кнопкой возврата в приложение
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /в работе/);
  assert.match(sent[0].text, /Виктор С\./);
  assert.equal(sent[0].payload, 'req_1');

  // 4. Житель видит новый статус и запись в истории
  const detail = await app.inject({
    method: 'GET', url: `/api/requests/${requestId}`,
    headers: { cookie },
  });
  assert.equal(detail.json().status, 'in_work');
  assert.equal(detail.json().statusLabel, 'в работе');
  assert.equal(detail.json().assigneeName, 'Виктор С.');
  assert.equal(detail.json().events.length, 2, 'создание и назначение мастера');
  assert.match(detail.json().events[1].text, /Виктор С\./);
});

test('диспетчер не видит заявки чужой УК', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });

  // Диспетчер другой управляющей компании
  const otherUk = await seedOrg(['344038, Ростовская обл, г Ростов-на-Дону, ул Чужая, д. 1'], '99');
  await testDb().insert(dispatcher).values({
    id: newId('dsp'), orgId: otherUk, login: 'other',
    passwordHash: await hashPassword('secret'), name: 'Чужой диспетчер',
  });
  const res = await app.inject({
    method: 'POST', url: '/api/dispatcher/login',
    payload: { login: 'other', password: 'secret' },
  });

  const queue = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests',
    headers: { cookie: cookieFrom(res) },
  });
  assert.equal(queue.json().requests.length, 0);
});

test('недопустимый переход статуса отвергается', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });
  const id = created.json().id;

  // Закрываем заявку
  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'in_work' },
  });
  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'done' },
  });

  // Выполненную назад в работу не возвращаем — заводится новая заявка
  const res = await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'in_work' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'bad_transition');
});

test('отклонение без причины не проходит', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Просьба покрасить мою дверь' },
  });

  const res = await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${created.json().id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'rejected' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /причину/i);
});

test('отклонённая заявка объясняет жителю причину', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Просьба покрасить мою дверь' },
  });

  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${created.json().id}/status`,
    headers: { cookie: dispCookie },
    payload: { status: 'rejected', rejectReason: 'Работы внутри квартиры не входят в зону УК' },
  });

  const detail = await app.inject({
    method: 'GET', url: `/api/requests/${created.json().id}`, headers: { cookie },
  });
  assert.equal(detail.json().status, 'rejected');
  assert.match(detail.json().rejectReason, /не входят в зону УК/);
  assert.match(sent[0].text, /не входят в зону УК/);
});

test('оценить можно только выполненную заявку', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });
  const id = created.json().id;

  const early = await app.inject({
    method: 'POST', url: `/api/requests/${id}/rating`,
    headers: { cookie }, payload: { stars: 5 },
  });
  assert.equal(early.statusCode, 400, 'незакрытую заявку оценивать нечего');

  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'in_work' },
  });
  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'done' },
  });

  const ok = await app.inject({
    method: 'POST', url: `/api/requests/${id}/rating`,
    headers: { cookie }, payload: { stars: 5, comment: 'Быстро приехали' },
  });
  assert.equal(ok.statusCode, 200);

  const detail = await app.inject({
    method: 'GET', url: `/api/requests/${id}`, headers: { cookie },
  });
  assert.equal(detail.json().rating.stars, 5);
});

test('чужую заявку по прямой ссылке не открыть', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });

  // Другой житель другого дома
  const otherLogin = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(90009, 'Пётр', 'Чужой') },
    payload: { qr: QR.replace('persAcc=4460153', 'persAcc=5550001').replace('кв. 15', 'кв. 99') },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/requests/${created.json().id}`,
    headers: { cookie: cookieFrom(otherLogin) },
  });
  assert.equal(res.statusCode, 404);
});

test('кабинет закрыт без логина, пароль проверяется', { skip }, async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/dispatcher/requests' })).statusCode, 401);

  const orgId = await seedOrg(['344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3']);
  await testDb().insert(dispatcher).values({
    id: newId('dsp'), orgId, login: 'd2',
    passwordHash: await hashPassword('right'), name: 'Д',
  });

  const bad = await app.inject({
    method: 'POST', url: '/api/dispatcher/login',
    payload: { login: 'd2', password: 'wrong' },
  });
  assert.equal(bad.statusCode, 401);

  const good = await app.inject({
    method: 'POST', url: '/api/dispatcher/login',
    payload: { login: 'd2', password: 'right' },
  });
  assert.equal(good.statusCode, 200);
});

test('очередь считает просроченные', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Авария', description: 'Прорвало трубу в подвале дома' },
  });

  // Отматываем срок в прошлое
  const { request: requestTable } = await import('../../db/schema.ts');
  await testDb().update(requestTable)
    .set({ slaDueAt: new Date(Date.now() - 3600_000) })
    .where(eq(requestTable.id, created.json().id));

  const queue = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests', headers: { cookie: dispCookie },
  });
  assert.equal(queue.json().counters.overdue, 1);
  assert.equal(queue.json().requests[0].sla, 'overdue');
  assert.match(queue.json().requests[0].slaLabel, /просрочено/);
});

/* ─────────────── диалог по заявке ─────────────── */

/**
 * Статус «нужны уточнения» без вопроса — тупик: житель видит, что от него
 * чего-то ждут, но не знает чего, и звонит в УК. Ровно от этого звонка
 * приложение должно избавлять, поэтому вопрос обязателен.
 */
test('уточнения нельзя запросить без вопроса жителю', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });

  const res = await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${created.json().id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'need_info' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'question_required');
});

test('ПЕТЛЯ УТОЧНЕНИЙ: диспетчер спросил → житель ответил → заявка снова в работе', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Сантехника', description: 'Течёт стояк в ванной, вода на полу' },
  });
  const id = created.json().id;

  // 1. Диспетчер задаёт вопрос
  const ask = await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie },
    payload: { status: 'need_info', comment: 'В какой стояк упирается течь — холодный или горячий?' },
  });
  assert.equal(ask.statusCode, 200);

  // 2. Житель видит вопрос и признак «ход за вами»
  const asked = await app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: { cookie } });
  assert.equal(asked.json().status, 'need_info');
  assert.equal(asked.json().awaitingResident, true, 'житель должен видеть, что ход за ним');
  assert.match(asked.json().events.at(-1).text, /холодный или горячий/);
  assert.equal(asked.json().events.at(-1).actor, 'dispatcher');

  // 3. Житель отвечает
  const reply = await app.inject({
    method: 'POST', url: `/api/requests/${id}/comment`,
    headers: { cookie }, payload: { text: 'Холодный, под ванной' },
  });
  assert.equal(reply.statusCode, 201);
  assert.equal(reply.json().status, 'in_work', 'ответ возвращает заявку в работу');

  // 4. Ответ виден в истории жителя от его имени
  const answered = await app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: { cookie } });
  assert.equal(answered.json().status, 'in_work');
  assert.equal(answered.json().awaitingResident, false);
  assert.ok(
    answered.json().events.some((e: { actor: string; text: string }) =>
      e.actor === 'resident' && /Холодный/.test(e.text)),
    'ответ жителя должен попасть в историю',
  );

  // 5. Диспетчер видит ответ в карточке и пометку в очереди
  const card = await app.inject({
    method: 'GET', url: `/api/dispatcher/requests/${id}`, headers: { cookie: dispCookie },
  });
  assert.equal(card.statusCode, 200);
  assert.ok(
    card.json().events.some((e: { actor: string; text: string }) =>
      e.actor === 'resident' && /Холодный/.test(e.text)),
    'диспетчер обязан видеть ответ жителя',
  );

  const queue = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests', headers: { cookie: dispCookie },
  });
  assert.equal(queue.json().counters.awaiting_uk, 1);
  assert.equal(queue.json().requests[0].awaitingUk, true);
  assert.match(queue.json().requests[0].lastMessage.text, /Холодный/);
});

test('житель может дополнить заявку и без вопроса диспетчера', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });

  const res = await app.inject({
    method: 'POST', url: `/api/requests/${created.json().id}/comment`,
    headers: { cookie }, payload: { text: 'Дверь перестала закрываться совсем' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().status, 'new', 'статус не трогаем — вопроса не было');
});

test('пустой ответ не принимается', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });

  const res = await app.inject({
    method: 'POST', url: `/api/requests/${created.json().id}/comment`,
    headers: { cookie }, payload: { text: '  ' },
  });
  assert.equal(res.statusCode, 400);
});

test('к закрытой заявке дописать нельзя — заводится новая', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });
  const id = created.json().id;

  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'in_work' },
  });
  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'done' },
  });

  const res = await app.inject({
    method: 'POST', url: `/api/requests/${id}/comment`,
    headers: { cookie }, payload: { text: 'А проблема вернулась' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'closed');
});

test('в чужую заявку не написать', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });

  const otherLogin = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(90011, 'Пётр', 'Чужой') },
    payload: { qr: QR.replace('persAcc=4460153', 'persAcc=5550002').replace('кв. 15', 'кв. 98') },
  });

  const res = await app.inject({
    method: 'POST', url: `/api/requests/${created.json().id}/comment`,
    headers: { cookie: cookieFrom(otherLogin) }, payload: { text: 'Тоже хочу сюда написать' },
  });
  assert.equal(res.statusCode, 404);
});

test('карточка у диспетчера отдаёт историю, жителя и допустимые переходы', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Лифт', description: 'Лифт застревает между этажами' },
  });
  const id = created.json().id;

  const card = await app.inject({
    method: 'GET', url: `/api/dispatcher/requests/${id}`, headers: { cookie: dispCookie },
  });
  assert.equal(card.statusCode, 200);
  assert.equal(card.json().number, '00001');
  assert.equal(card.json().authorName, 'Смирнова Анна');
  assert.match(card.json().flat, /15/);
  assert.equal(card.json().events.length, 1, 'событие о создании');
  assert.deepEqual(card.json().allowed, ['in_work', 'need_info', 'rejected']);
});

test('карточку чужой УК диспетчеру не открыть', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });

  const otherUk = await seedOrg(['344038, Ростовская обл, г Ростов-на-Дону, ул Чужая, д. 2'], '98');
  await testDb().insert(dispatcher).values({
    id: newId('dsp'), orgId: otherUk, login: 'other2',
    passwordHash: await hashPassword('secret'), name: 'Чужой диспетчер',
  });
  const login = await app.inject({
    method: 'POST', url: '/api/dispatcher/login',
    payload: { login: 'other2', password: 'secret' },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/dispatcher/requests/${created.json().id}`,
    headers: { cookie: cookieFrom(login) },
  });
  assert.equal(res.statusCode, 404);
});

/**
 * Комментарий диспетчера не должен вытеснять из истории имя мастера
 * и причину отклонения: житель читает ленту событий, а не поля карточки.
 */
test('в истории остаются и комментарий, и назначенный мастер', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Сантехника', description: 'Течёт стояк в ванной, вода на полу' },
  });
  const id = created.json().id;

  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie },
    payload: { status: 'in_work', assigneeName: 'Виктор С.', comment: 'Будем сегодня после 16:00' },
  });

  const detail = await app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: { cookie } });
  const events = detail.json().events;
  const fact = events.at(-2);
  const said = events.at(-1);
  // Факт смены статуса — плашкой по центру, слова диспетчера — его сообщением
  assert.equal(fact.type, 'status');
  assert.match(fact.text, /Виктор С\./);
  assert.doesNotMatch(fact.text, /после 16:00/);
  assert.equal(said.type, 'comment');
  assert.equal(said.actor, 'dispatcher');
  assert.equal(said.text, 'Будем сегодня после 16:00');
});

test('в истории остаются и комментарий, и причина отклонения', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Просьба покрасить мою дверь' },
  });
  const id = created.json().id;

  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie },
    payload: {
      status: 'rejected',
      rejectReason: 'Работы внутри квартиры не входят в зону УК',
      comment: 'Могу подсказать подрядчика',
    },
  });

  const detail = await app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: { cookie } });
  const events = detail.json().events;
  assert.equal(events.at(-2).type, 'status');
  assert.equal(events.at(-2).text, 'Заявка закрыта без выполнения');
  const said = events.at(-1);
  assert.equal(said.type, 'comment');
  assert.equal(said.actor, 'dispatcher');
  assert.match(said.text, /не входят в зону УК/);
  assert.match(said.text, /подрядчика/);
});

test('вопрос диспетчера — его сообщением, а в середине только «запросил уточнения»', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Сантехника', description: 'Течёт стояк в ванной, вода на полу' },
  });
  const id = created.json().id;

  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/status`,
    headers: { cookie: dispCookie },
    payload: { status: 'need_info', comment: 'Какой этаж?' },
  });

  const events = (await app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: { cookie } })).json().events;
  assert.deepEqual(
    events.slice(-2).map((e: { type: string; text: string }) => [e.type, e.text]),
    [['status', 'Диспетчер запросил уточнения'], ['comment', 'Какой этаж?']],
  );
});

/**
 * Окно приёма мастера доезжает до диспетчера.
 *
 * Поля в схеме и в API были с самого начала, а выбрать окно в приложении
 * было нечем: под заголовком «Когда удобно принять мастера» висела пустая
 * полоса. Житель оставался без ответа на главный для него вопрос — когда
 * сидеть дома, — а диспетчер всё равно звонил уточнять.
 */
test('вызов мастера с окном приёма виден в кабинете УК', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();

  const start = new Date(Date.now() + 20 * 3600_000);
  const end = new Date(start.getTime() + 5 * 3600_000);

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: {
      propertyId, kind: 'master', category: 'Сантехника',
      description: 'Не закрывается кран на кухне, капает постоянно',
      slotStart: start.toISOString(), slotEnd: end.toISOString(),
    },
  });
  assert.equal(created.statusCode, 201);

  const mine = await app.inject({
    method: 'GET', url: `/api/requests/${created.json().id}`, headers: { cookie },
  });
  assert.equal(new Date(mine.json().masterSlotStart).toISOString(), start.toISOString());

  const card = await app.inject({
    method: 'GET', url: `/api/dispatcher/requests/${created.json().id}`,
    headers: { cookie: dispCookie },
  });
  assert.equal(card.json().kind, 'master');
  assert.equal(new Date(card.json().masterSlotStart).toISOString(), start.toISOString());
  assert.equal(new Date(card.json().masterSlotEnd).toISOString(), end.toISOString());
});

/**
 * Обращение принадлежит КВАРТИРЕ, а не дому.
 *
 * Три границы, и все три проверяются здесь:
 *   — подтверждённый в квартире видит её обращения (муж видит заявку жены);
 *   — сосед из другой квартиры не видит ничего;
 *   — предъявивший квитанцию, но НЕ подтверждённый, видит только свои:
 *     иначе снимок чужой квитанции открывал переписку жильцов с УК.
 */

/** Второй человек в той же квартире: та же квитанция, другой аккаунт. */
async function secondResidentSameFlat() {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(90031, 'Пётр', 'Смирнов') },
    payload: { qr: QR },
  });
  return cookieFrom(res);
}

/** Житель другой квартиры того же дома. */
async function neighbour() {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(90032, 'Ирина', 'Волкова') },
    payload: {
      qr: QR.replace('кв. 15', 'кв. 16').replace('persAcc=4460153', 'persAcc=4460163'),
    },
  });
  return cookieFrom(res);
}

test('обращение квартиры видно подтверждённому жильцу этой квартиры', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, description: 'В подъезде не горит свет третий день' },
  });
  const requestId = created.json().id ?? created.json().request?.id;

  const second = await secondResidentSameFlat();
  await grantAccess();

  const list = await app.inject({
    method: 'GET', url: '/api/requests', headers: { cookie: second },
  });
  assert.equal(list.json().active.length, 1, 'жилец квартиры видит её обращения');

  const one = await app.inject({
    method: 'GET', url: `/api/requests/${requestId}`, headers: { cookie: second },
  });
  assert.equal(one.statusCode, 200);
});

test('сосед из другой квартиры обращения не видит', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, description: 'В подъезде не горит свет третий день' },
  });
  const requestId = created.json().id ?? created.json().request?.id;

  const other = await neighbour();
  await grantAccess();

  const list = await app.inject({
    method: 'GET', url: '/api/requests', headers: { cookie: other },
  });
  assert.equal(list.json().active.length, 0);

  const one = await app.inject({
    method: 'GET', url: `/api/requests/${requestId}`, headers: { cookie: other },
  });
  assert.equal(one.statusCode, 404, 'чужой квартиры для него не существует');
});

test('неподтверждённый видит только своё обращение, а не чужие', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, description: 'В подъезде не горит свет третий день' },
  });
  const requestId = created.json().id ?? created.json().request?.id;

  // Тот же адрес, но заявка НЕ подтверждена: grantAccess здесь не зовём
  const stranger = await secondResidentSameFlat();

  const list = await app.inject({
    method: 'GET', url: '/api/requests', headers: { cookie: stranger },
  });
  assert.equal(list.json().active.length, 0, 'чужие обращения ему не показываем');

  const one = await app.inject({
    method: 'GET', url: `/api/requests/${requestId}`, headers: { cookie: stranger },
  });
  assert.equal(one.statusCode, 404);

  const comment = await app.inject({
    method: 'POST', url: `/api/requests/${requestId}/comment`,
    headers: { cookie: stranger },
    payload: { text: 'а я тут живу вообще-то' },
  });
  assert.notEqual(comment.statusCode, 200, 'и писать в чужое обращение он не может');

  // А своё собственное — видит и пишет: это уровень 0, ядро продукта
  const own = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: stranger },
    payload: { propertyId, description: 'Течёт кран на кухне, вода не перекрывается' },
  });
  assert.equal(own.statusCode, 201);
  const mine = await app.inject({
    method: 'GET', url: '/api/requests', headers: { cookie: stranger },
  });
  assert.equal(mine.json().active.length, 1, 'своё обращение остаётся видно');
});

/* ─────────────── обращение без адресата: дом без УК ─────────────── */

/**
 * Ядро продукта: у жителя остаётся ДАТИРОВАННОЕ доказательство поданной
 * жалобы, и оно не зависит от того, есть ли у дома управляющая
 * организация. Раньше этот же запрос отвечал 409 `no_managing_uk`.
 */
test('житель дома без УК подаёт жалобу, и она сохраняется с датой', { skip }, async () => {
  const { token, propertyId } = await residentWithoutUk();

  const res = await app.inject({
    method: 'POST',
    url: '/api/requests',
    headers: { authorization: `Bearer ${token}` },
    payload: {
      propertyId, kind: 'complaint', category: 'Другое',
      description: 'Третий подъезд, течёт с потолка',
    },
  });

  assert.equal(res.statusCode, 201, 'раньше здесь было 409 no_managing_uk');

  const [row] = await testDb()
    .select({ orgId: request.orgId, scope: request.numberScope, number: request.number })
    .from(request);
  assert.equal(row.orgId, null, 'адресата нет, и это законное состояние');
  assert.ok(row.scope.startsWith('house:'), 'нумерация переехала на дом');
  assert.equal(row.number, 1);

  // Обращение видно автору в списке — доказательство никуда не делось
  const list = await app.inject({
    method: 'GET', url: '/api/requests',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(list.json().active.length, 1);
});

test('нумерация в доме без УК сквозная и не сталкивается', { skip }, async () => {
  const { token, propertyId } = await residentWithoutUk();

  for (const description of ['Течёт крыша, третий подъезд', 'Не работает домофон в подъезде']) {
    await app.inject({
      method: 'POST', url: '/api/requests',
      headers: { authorization: `Bearer ${token}` },
      payload: { propertyId, kind: 'complaint', category: 'Другое', description },
    });
  }

  const numbers = (await testDb().select({ number: request.number }).from(request))
    .map((r) => r.number).sort();
  assert.deepEqual(numbers, [1, 2], 'без numberScope обе получили бы номер 1');
});

/**
 * ПОТОЛОК ВЫДАЧИ В АРХИВЕ.
 *
 * За год у квартиры набирается несколько десятков закрытых обращений,
 * и весь архив ехал одним ответом. Режем архив, но НЕ активные: их
 * единицы, и «Показать ещё» на трёх строках — лишняя кнопка там, где
 * человек и так видит всё.
 */
test('архив отдаётся полусотней и говорит, сколько их всего', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const authorId = me.json().user.id;

  for (let i = 1; i <= 60; i++) {
    await testDb().insert(request).values({
      id: newId('req'),
      number: 1000 + i,
      propertyId,
      numberScope: `house:test-${i}`,
      authorId,
      kind: 'complaint',
      category: 'Другое',
      title: `Закрытое обращение ${i}`,
      description: 'Проверка потолка выдачи',
      status: 'done',
    });
  }

  const first = await app.inject({
    method: 'GET', url: `/api/requests?propertyId=${propertyId}`, headers: { cookie },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().archive.length, 50, 'архив обрезан');
  assert.equal(first.json().archiveTotal, 60, 'но сказано, сколько их всего');

  const more = await app.inject({
    method: 'GET', url: `/api/requests?propertyId=${propertyId}&limit=100`, headers: { cookie },
  });
  assert.equal(more.json().archive.length, 60, '«Показать ещё» доходит до конца');

  const active = first.json().active.length;
  assert.equal(active, more.json().active.length, 'активные потолка не знают');
});

/**
 * ДИСПЕТЧЕР РАБОТАЕТ ПО ЗВОНКУ.
 *
 * Всё, что он делает, начинается с «мне назвали номер» или «мне назвали
 * адрес». За год очередь дорастает до 32 экранов прокрутки, и оба
 * сценария решались листанием глазами: поиска не было вовсе.
 */
test('диспетчер ищет по номеру, квартире, адресу и заголовку', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const headers = { cookie: dispCookie };

  const make = async (description: string) => {
    const res = await app.inject({
      method: 'POST', url: '/api/requests',
      headers: { cookie },
      payload: { propertyId, category: 'Лифт', description },
    });
    return res.json().number as string;
  };

  const first = await make('Не закрывается дверь лифта на седьмом этаже');
  await make('Течёт кран на кухне, вода капает на пол');

  // Номер называют как услышали: «первая» и «00001» — это одно и то же
  const byShort = await app.inject({
    method: 'GET', url: `/api/dispatcher/requests?q=${Number(first)}`, headers,
  });
  assert.equal(byShort.json().requests.length, 1);
  assert.equal(byShort.json().requests[0].number, first);

  const byFull = await app.inject({
    method: 'GET', url: `/api/dispatcher/requests?q=${first}`, headers,
  });
  assert.equal(byFull.json().requests.length, 1);

  const byWord = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests?q=лифт', headers,
  });
  assert.equal(byWord.json().requests.length, 1, 'по слову из заголовка');

  const byAddress = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests?q=ленина', headers,
  });
  assert.equal(byAddress.json().requests.length, 2, 'по адресу — весь дом');

  const byFlat = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests?q=кв 15', headers,
  });
  assert.equal(byFlat.json().requests.length, 2, 'по квартире');

  const nothing = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests?q=подвал', headers,
  });
  assert.equal(nothing.json().requests.length, 0);

  /**
   * Счётчики отвечают на вопрос «что в работе у организации», а не
   * «что нашлось»: с выбранным поиском пустая сводка появлялась бы
   * ровно тогда, когда она и нужна.
   */
  assert.equal(nothing.json().counters.total, 2, 'счётчики не зависят от поиска');
  assert.equal(nothing.json().total, 0, 'а вот total — это про найденное');
});

test('поиск и фильтр по статусу работают вместе', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const headers = { cookie: dispCookie };

  const lift = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Лифт', description: 'Лифт шумит на подъёме' },
  });
  await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Лифт', description: 'Лифт застрял между этажами' },
  });

  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${lift.json().id}/status`,
    headers, payload: { status: 'in_work' },
  });

  const found = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests?status=in_work&q=лифт', headers,
  });
  assert.equal(found.json().requests.length, 1, 'сначала статус, потом поиск');
  assert.equal(found.json().requests[0].status, 'in_work');
});

test('очередь отдаётся полусотней и говорит, сколько заявок всего', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const headers = { cookie: dispCookie };

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const authorId = me.json().user.id;

  // Очередь кабинета собирается по организации, а не по квартире:
  // заявка без orgId в неё просто не попадёт
  const [own] = await testDb().select().from(property).where(eq(property.id, propertyId));
  const orgId = own.managingOrgId;

  for (let i = 1; i <= 60; i++) {
    await testDb().insert(request).values({
      id: newId('req'),
      number: 2000 + i,
      propertyId,
      orgId,
      numberScope: String(orgId),
      authorId,
      kind: 'complaint',
      category: 'Другое',
      title: `Заявка ${i}`,
      description: 'Проверка потолка выдачи',
      status: 'new',
    });
  }

  const first = await app.inject({ method: 'GET', url: '/api/dispatcher/requests', headers });
  assert.equal(first.json().requests.length, 50, 'очередь обрезана');
  assert.equal(first.json().total, 60, 'но сказано, сколько их всего');
  assert.equal(first.json().counters.new, 60, 'счётчики считают всё');

  const more = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests?limit=100', headers,
  });
  assert.equal(more.json().requests.length, 60);
});

/**
 * «Просрочено» отбирается ДО потолка выдачи.
 *
 * Раньше кабинет фильтровал признак у себя, получив всю очередь.
 * С потолком так нельзя: просроченные заявки могут целиком оказаться
 * за пределами первых пятидесяти, и самая важная плитка экрана
 * показала бы пустоту при восемнадцати горящих заявках.
 */
test('признак «просрочено» фильтрует на сервере, а не в срезе', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const headers = { cookie: dispCookie };

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const authorId = me.json().user.id;
  const [own] = await testDb().select().from(property).where(eq(property.id, propertyId));
  const orgId = own.managingOrgId;

  const long_ago = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  for (let i = 1; i <= 60; i++) {
    await testDb().insert(request).values({
      id: newId('req'),
      number: 3000 + i,
      propertyId,
      orgId,
      numberScope: String(orgId),
      authorId,
      kind: 'complaint',
      category: 'Другое',
      title: `Заявка ${i}`,
      description: 'Проверка признака просрочки',
      status: 'new',
      // Просрочены только две последние — в первые пятьдесят строк они не попадут
      slaDueAt: i > 58 ? long_ago : new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  }

  const overdue = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests?flag=overdue', headers,
  });
  assert.equal(overdue.json().total, 2, 'нашлись обе просроченные');
  assert.equal(overdue.json().requests.length, 2);
});

test('диспетчер пишет жителю, не меняя статус', { skip }, async () => {
  const { cookie, propertyId } = await loginResident();
  const dispCookie = await loginDispatcher();
  const id = (await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Сантехника', description: 'Течёт стояк в ванной, вода на полу' },
  })).json().id;

  const res = await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/comment`,
    headers: { cookie: dispCookie }, payload: { text: 'Мастер будет завтра' },
  });
  assert.equal(res.statusCode, 201);

  const card = (await app.inject({ method: 'GET', url: `/api/requests/${id}`, headers: { cookie } })).json();
  assert.equal(card.status, 'new', 'статус не тронут');
  const last = card.events.at(-1);
  assert.deepEqual([last.type, last.actor, last.text], ['comment', 'dispatcher', 'Мастер будет завтра']);

  const empty = await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${id}/comment`,
    headers: { cookie: dispCookie }, payload: { text: ' ' },
  });
  assert.equal(empty.statusCode, 400);
});
