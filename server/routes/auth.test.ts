import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import { signContactForTesting } from '../../lib/max/contact.ts';
import {
  testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL, insertRegistryHouse,
} from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';
import { newId } from '../../lib/ids.ts';

/**
 * Сквозные проверки входа через HTTP.
 *
 * Порт не поднимаем: fastify.inject() прогоняет запрос через весь стек
 * приложения в памяти. Тесты не дерутся за порт и не оставляют висящих
 * процессов.
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

const REAL_QR =
  'ST00011|Name=ООО "УК Трианон"|PersonalAcc=40702810952090030727|BankName=ПАО Сбербанк|' +
  'BIC=046015602|CorrespAcc=30101810600000000602|Sum=381630|Purpose=Оплата за ЖКУ|' +
  'PayeeINN=6168108630|PayerINN=|KPP=616801001|lastName=Крутых|firstName=Сергей|' +
  'middleName=Валерьевич|payerAddress=344038, Ростовская обл, г Ростов-на-Дону, ' +
  'пр-кт Ленина, д. 85, к. 3, кв. 27|persAcc=987654331|paymPeriod=042026|category=001';

function initDataFor(id: number, firstName: string, lastName: string, chatId = 700000 + id) {
  return signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: chatId, type: 'DIALOG' }),
    query_id: `q-${id}`,
    user: JSON.stringify({
      id, first_name: firstName, last_name: lastName,
      username: null, language_code: 'ru', photo_url: null,
    }),
  }, BOT_TOKEN);
}

const sergey = () => initDataFor(424242, 'Сергей', 'Крутых');
const stranger = () => initDataFor(555555, 'Пётр', 'Чужой');

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const app = buildApp();
beforeEach(async () => { if (available) await resetTables(); });
after(async () => { await app.close(); await closeTestDb(); await closeDb(); });

/** Достаёт куку сессии из ответа. */
function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
}

test('подделанные initData отвергаются', { skip }, async () => {
  const forged = sergey().replace('424242', '999999');
  const res = await app.inject({
    method: 'POST', url: '/api/auth/max',
    headers: { 'x-max-init-data': forged },
  });

  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'bad_init_data');
});

test('без initData вход через MAX невозможен', { skip }, async () => {
  const res = await app.inject({ method: 'POST', url: '/api/auth/max' });
  assert.equal(res.statusCode, 401);
});

test('незнакомому человеку предлагаем отсканировать квитанцию', { skip }, async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/max',
    headers: { 'x-max-init-data': sergey() },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'needs_receipt');
  assert.equal(res.json().name, 'Крутых Сергей');
});

test('скан квитанции внутри MAX заводит заявку, а не выдаёт квартиру', { skip }, async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });

  /**
   * 202, а не 200: заявка принята, но доступа ещё нет.
   *
   * Раньше здесь было «человек стал собственником». Правило поменялось
   * не из вкуса: строку платёжного QR можно набрать руками, и сервер
   * не отличит её от снятой камерой — значит предъявление квитанции
   * доказывает только желание, а не проживание.
   */
  assert.equal(res.statusCode, 202);
  const body = res.json();
  assert.equal(body.status, 'pending');
  assert.ok(body.bindingId, 'заявку надо чем-то дополнить');
  assert.equal(body.claimComplete, false, 'о себе человек ещё не рассказал');
  assert.ok(cookieFrom(res).includes('zd_session'), 'сессия нужна, чтобы дозаполнить заявку');

  // Данных квартиры в ответе нет вовсе
  assert.ok(!/Ленина/.test(res.body), 'адрес до подтверждения не отдаём');

  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(res) },
  });
  /**
   * Объект в списке ЕСТЬ, но на уровне 0.
   *
   * С 27 августа ожидающий объект приходит в приложение: по нему открыты
   * свои квитанции, счётчики, аналитика и жалоба в УК — сервер это и так
   * разрешал (`canSeeOwn` пропускает `pending`), а показать было нечем.
   * Доступ к дому и соседям по-прежнему закрыт, и виден он по статусу.
   */
  const mine = me.json().properties;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].status, 'pending', 'подтверждения ещё нет');
  assert.equal(mine[0].accessLevel, 'self', 'дом и соседи закрыты');
  assert.equal(me.json().myPendingAccess.length, 1, 'заявка тоже видна');
});

test('повторный вход через MAX не требует квитанции', { skip }, async () => {
  await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();

  // Новый заход: куки нет, только подпись MAX
  const res = await app.inject({
    method: 'POST', url: '/api/auth/max',
    headers: { 'x-max-init-data': sergey() },
  });
  assert.equal(res.json().status, 'ok');

  const me = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { cookie: cookieFrom(res) },
  });
  assert.equal(me.json().user.name, 'Крутых Сергей');
  assert.equal(me.json().user.viaMax, true);
  assert.equal(me.json().properties.length, 1);
});

test('чужой человек с той же квитанцией получает отказ, а не доступ', { skip }, async () => {
  await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': stranger() },
    payload: { qr: REAL_QR },
  });

  assert.equal(res.statusCode, 202);
  assert.equal(res.json().status, 'pending');
  // ФИО собственника в ответе быть не должно: кто сканирует — неизвестно
  assert.ok(!/Крутых/.test(res.body), 'имя собственника не раскрываем');

  /**
   * Сессия выдаётся сразу — но она пустая.
   *
   * Без неё браузер не помнил, кто он, и каждый скан плодил новый запрос
   * доступа; домочадец не мог войти даже после подтверждения. Ценой этого
   * решения было бы раздать доступ раньше времени, поэтому здесь и
   * проверяем главное: привязок у человека нет, чужих данных он не видит.
   */
  const token = res.json().token;
  assert.ok(token, 'токен нужен, чтобы повторный скан узнал того же человека');

  const me = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(me.statusCode, 200);
  const strangerProps = me.json().properties;
  assert.equal(strangerProps.length, 1, 'своя заявка — это его объект уровня 0');
  assert.equal(strangerProps[0].accessLevel, 'self', 'дом и соседи закрыты');
  assert.ok(!/Крутых/.test(JSON.stringify(strangerProps)), 'чужого имени нет');
  assert.equal(me.json().myPendingAccess.length, 1, 'зато видно собственный запрос');

  // Повторный скан той же квитанции не создаёт второй запрос
  const again = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': stranger(), authorization: `Bearer ${token}` },
    payload: { qr: REAL_QR },
  });
  assert.equal(again.statusCode, 202);

  const meAgain = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(meAgain.json().myPendingAccess.length, 1, 'запрос должен остаться один');
});

test('собственник подтверждает домочадца — и человек входит', { skip }, async () => {
  const ownerRes = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  // Собственника подтвердил председатель; здесь это фикстура
  await grantAccess();
  const ownerCookie = cookieFrom(ownerRes);

  const memberRes = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': stranger() },
    payload: { qr: REAL_QR },
  });
  const memberToken = memberRes.json().token;

  // Домочадец рассказывает о себе: без этого подтверждать нечего
  await app.inject({
    method: 'POST', url: `/api/properties/claims/${memberRes.json().bindingId}`,
    headers: { authorization: `Bearer ${memberToken}` },
    payload: { name: 'Чужой Пётр', flat: '27' },
  });

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: ownerCookie } });
  const pending = me.json().pendingRequests;
  assert.equal(pending.length, 1, 'собственник видит заявку домочадца');
  assert.equal(pending[0].claimedName, 'Чужой Пётр');

  const approve = await app.inject({
    method: 'POST', url: `/api/properties/${pending[0].bindingId}/approve`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(approve.statusCode, 200);

  const second = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': stranger() },
    payload: { qr: REAL_QR },
  });
  assert.equal(second.json().status, 'ok');
  assert.equal(second.json().role, 'member', 'собственников штампует только председатель');
});

test('подтвердить доступ может только собственник', { skip }, async () => {
  await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  // Собственник подтверждён председателем; здесь это фикстура
  await grantAccess();

  const strangerRes = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': stranger() },
    payload: { qr: REAL_QR },
  });
  assert.equal(strangerRes.statusCode, 202);
  const strangerToken = strangerRes.json().token;

  await app.inject({
    method: 'POST', url: `/api/properties/claims/${strangerRes.json().bindingId}`,
    headers: { authorization: `Bearer ${strangerToken}` },
    payload: { name: 'Чужой Пётр', flat: '27' },
  });

  const owner = await app.inject({
    method: 'POST', url: '/api/auth/max',
    headers: { 'x-max-init-data': sergey() },
  });
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(owner) } });
  const bindingId = me.json().pendingRequests[0].bindingId;

  /**
   * Заявитель пытается подтвердить сам себя. Это и есть та самая петля,
   * из-за которой один скрипт захватывал дом: если право подтверждать
   * выводится из заявки, оно ничего не охраняет.
   */
  const attempt = await app.inject({
    method: 'POST', url: `/api/properties/${bindingId}/approve`,
    headers: { authorization: `Bearer ${strangerToken}` },
  });
  assert.equal(attempt.statusCode, 403);
});

test('битый QR отвергается с понятным сообщением', { skip }, async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: { qr: 'https://example.com' },
  });
  await grantAccess();
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /не платёжный QR/i);
});

test('выход убивает ВСЕ сессии человека, а не только текущую', { skip }, async () => {
  /**
   * Почему все. Внутри MAX сессия заводится при КАЖДОМ открытии мини-аппа
   * (`/api/auth/max`), и за неделю их набирается десяток. Выход, который
   * убивал только текущую, оставлял остальные живыми: человек нажимал
   * «Выйти», а его пропуск продолжал действовать. Для явного действия
   * это неверно — «выйти» значит выйти отовсюду.
   */
  const first = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  const firstCookie = cookieFrom(first);

  // Второе открытие мини-аппа: та же личность, новая сессия
  const second = await app.inject({
    method: 'POST', url: '/api/auth/max',
    headers: { 'x-max-init-data': sergey() },
    payload: {},
  });
  assert.equal(second.json().status, 'ok', 'второй вход должен пройти');
  const secondCookie = cookieFrom(second);

  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: firstCookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: secondCookie } })).statusCode, 200);

  await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: secondCookie } });

  assert.equal((await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: secondCookie } })).statusCode, 401);
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: firstCookie } })).statusCode,
    401,
    'старая сессия того же человека тоже должна закрыться',
  );
});

test('телефон из requestContact подтверждается подписью', { skip }, async () => {
  const login = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  const cookie = cookieFrom(login);

  const authDate = String(Math.floor(Date.now() / 1000));
  const hash = signContactForTesting('+7 999 123-45-67', authDate, 424242, BOT_TOKEN);

  const ok = await app.inject({
    method: 'POST', url: '/api/auth/phone',
    headers: { cookie },
    payload: { phone: '+7 999 123-45-67', authDate, hash },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().phone, '79991234567');

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.json().user.phoneVerified, true);

  // Подменённый номер с той же подписью не проходит
  const bad = await app.inject({
    method: 'POST', url: '/api/auth/phone',
    headers: { cookie },
    payload: { phone: '79990000000', authDate, hash },
  });
  assert.equal(bad.statusCode, 400);
});

test('/api/me без сессии отвечает 401, а не падает', { skip }, async () => {
  const res = await app.inject({ method: 'GET', url: '/api/me' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'unauthorized');
});

test('неизвестный метод API отдаёт JSON, а не HTML', { skip }, async () => {
  const res = await app.inject({ method: 'GET', url: '/api/nope' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

/* ─────────────── квитанция без адреса ─────────────── */

/**
 * Реальная квитанция расчётного центра.
 *
 * По ГОСТ Р 56042-2014 обязательны только реквизиты получателя и сумма,
 * поэтому ФИО и адрес плательщика в ней просто отсутствуют. Платёж по
 * такому коду проходит, а кто и за какую квартиру платит — знает лишь
 * биллинг получателя.
 */
const BLIND_QR =
  'ST00012|Name=ГУП РО "ИВЦ ЖКХ"|PersonalAcc=40602810652090000005|' +
  'BankName=ПАО Юго-Западный банк Сбербанка России|BIC=046015602|' +
  'CorrespAcc=30101810600000000602|PayeeINN=6167004596|Sum=7471|' +
  'persAcc=857000000015641|paymPeriod=0823|ServiceName=30747|';

/** Справочник одного города: тестам не нужны все сорок тысяч улиц региона. */
async function seedRegistry() {
  const { region, addressObject, house } = await import('../../db/schema.ts');
  const { parseAddress } = await import('../../lib/address/normalize.ts');

  await testDb().insert(region).values({
    code: '61', name: 'Ростовская обл', status: 'loaded',
    source: 'тест', placeCount: 1, streetCount: 1, loadedAt: new Date(),
  }).onConflictDoNothing();

  // Адресное дерево ГАР: субъект → город → проспект
  await testDb().insert(addressObject).values([
    { guid: 'f10763dc-63e3-48db-83e1-9c566fe3092b', regionCode: '61', parentGuid: null, level: 1, type: 'обл', name: 'Ростовская', searchName: 'ростовская' },
    { guid: 'c1cfe4b9-f7c2-423c-abfa-6ed1c05a15c5', regionCode: '61', parentGuid: 'f10763dc-63e3-48db-83e1-9c566fe3092b', level: 5, type: 'г', name: 'Ростов-на-Дону', searchName: 'ростов-на-дону' },
    { guid: '0a1b2c3d-0000-4000-8000-000000000875', regionCode: '61', parentGuid: 'c1cfe4b9-f7c2-423c-abfa-6ed1c05a15c5', level: 8, type: 'пр-кт', name: 'Ленина', searchName: 'ленина' },
  ]).onConflictDoNothing();

  // Два дома проспекта из ГАР: 85/3 записан корпусом, как в реестре
  for (const number of ['85, к. 3', '101']) {
    const address = `обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. ${number}`;
    await testDb().insert(house).values({
      houseKey: parseAddress(address).houseKey, addressRaw: address, regionCode: '61',
      streetGuid: '0a1b2c3d-0000-4000-8000-000000000875',
    }).onConflictDoNothing();
  }

  return { streetCode: '0a1b2c3d-0000-4000-8000-000000000875' };
}

test('дома улицы отдаются списком в естественном порядке номеров', { skip }, async () => {
  const { streetCode } = await seedRegistry();

  const res = await app.inject({ method: 'GET', url: `/api/address/houses?street=${streetCode}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json().houses.map((h: { number: string }) => h.number), ['85 к3', '101']);

  const bad = await app.inject({ method: 'GET', url: '/api/address/houses?street=ленина' });
  assert.equal(bad.statusCode, 400);
});

test('ПЕТЛЯ: житель выбирает дом из списка и попадает к соседям с квитанцией', { skip }, async () => {
  const { streetCode } = await seedRegistry();

  const neighbourRes = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();

  const houses = await app.inject({ method: 'GET', url: `/api/address/houses?street=${streetCode}` });
  const chosen = houses.json().houses.find((h: { number: string }) => h.number === '85 к3');

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: { qr: BLIND_QR, address: { houseKey: chosen.houseKey, flat: '30' } },
  });
  await grantAccess();
  assert.equal(res.statusCode, 202);

  const mine = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(res) } })).json().properties[0];
  const theirs = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(neighbourRes) } })).json().properties[0];
  assert.equal(mine.houseKey, theirs.houseKey, 'дом из списка — тот же дом, что в квитанции соседа');
  assert.match(mine.addressRaw, /д. 85, к. 3, кв. 30$/);
});

test('несуществующий дом из списка не принимается', { skip }, async () => {
  await seedRegistry();
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: { qr: BLIND_QR, address: { houseKey: 'нет-такого', flat: '1' } },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'house_not_found');
});

test('период вида MMYY больше не теряется', { skip }, async () => {
  const { parseReceipt } = await import('../../lib/qr/receipt.ts');
  const parsed = parseReceipt(BLIND_QR);

  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.receipt.period, '2023-08', 'ИВЦ пишет период как MMYY');
  assert.equal(parsed.receipt.payer.address, null, 'адреса в такой квитанции нет');
});

test('квитанция без адреса не заводит безадресный объект', { skip }, async () => {
  await seedRegistry();

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr', payload: { qr: BLIND_QR },
  });
  await grantAccess();

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().status, 'needs_address');
  assert.equal(res.json().regionCode, '61', 'регион берём из ИНН получателя');

  // Ни объекта, ни пустого ключа дома в базе не появилось
  const { property } = await import('../../db/schema.ts');
  const rows = await testDb().select().from(property);
  assert.equal(rows.length, 0, 'объект без адреса создавать нельзя');
});

test('регион без справочника честно называет себя неподключённым', { skip }, async () => {
  // ИНН московского получателя: первые две цифры — код субъекта
  const moscow = BLIND_QR.replace('PayeeINN=6167004596', 'PayeeINN=7707083893');

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr', payload: { qr: moscow },
  });
  await grantAccess();

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().status, 'region_not_loaded');
  assert.equal(res.json().regionCode, '77');
  assert.match(res.json().message, /не загружен/i);
});

test('ПЕТЛЯ: житель выбирает адрес и попадает к своим соседям', { skip }, async () => {
  const { streetCode } = await seedRegistry();

  // Сосед с полной квитанцией: адрес в ней напечатан
  const neighbourRes = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  const neighbourCookie = cookieFrom(neighbourRes);

  /**
   * Квартира у жителя своя — 30-я. Сосед из 27-й живёт в том же доме,
   * и проверяем мы именно это: адрес из справочника обязан дать тот же
   * ключ дома, что адрес, напечатанный в чужой квитанции.
   */
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: {
      qr: BLIND_QR,
      address: { streetCode, house: '85', block: '3', flat: '30' },
    },
  });
  await grantAccess();

  assert.equal(res.statusCode, 202, 'заявка принята, доступ откроет председатель');
  assert.equal(res.json().status, 'pending');

  /**
   * Главная проверка: адрес из справочника обязан дать ТОТ ЖЕ ключ дома,
   * что и адрес из квитанции. Иначе сосед со «слепой» квитанцией окажется
   * в отдельном доме, и вся жизнь дома для него будет пустой.
   */
  const cookie = cookieFrom(res);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const mine = me.json().properties[0];

  const neighbourMe = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: neighbourCookie },
  });

  assert.equal(mine.houseKey, neighbourMe.json().properties[0].houseKey, 'дом должен совпасть');
  assert.equal(mine.addressSource, 'resident', 'адрес указан жителем, а не квитанцией');
  assert.equal(mine.addressVerifiedAt, null, 'и пока не подтверждён УК');
});

/**
 * Возврат по «слепой» квитанции не должен требовать адрес заново.
 *
 * Житель вышел из аккаунта и сканирует ту же квитанцию. Адреса в ней нет,
 * поэтому сервер спрашивал его СНОВА — а после ввода имени собственника
 * спрашивал в третий раз, и человек ходил по кругу: адрес → имя → адрес.
 *
 * Спрашивать незачем: лицевой счёт уже привязан к объекту, и адрес этого
 * объекта у нас есть. Он и берётся.
 */
test('повторный вход по квитанции без адреса не спрашивает адрес заново', { skip }, async () => {
  const { streetCode } = await seedRegistry();

  // Первый вход: адрес пришлось указать руками
  const first = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: BLIND_QR, address: { streetCode, house: '85', block: '3', flat: '27' } },
  });
  await grantAccess();
  assert.equal(first.json().status, 'pending');

  // Вышел и сканирует ту же квитанцию — адрес спрашивать больше не надо
  const again = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: BLIND_QR },
  });
  await grantAccess();

  assert.notEqual(again.json().status, 'needs_address', 'адрес уже известен по лицевому счёту');
  assert.equal(again.statusCode, 200, 'доступ уже подтверждён — это обычный вход');
  assert.equal(again.json().status, 'ok');
});

/**
 * Тот же круг, но в браузере: там ещё и спрашивают, кто пришёл.
 *
 * Ответив «я собственник» и назвав имя, человек снова получал форму
 * адреса — потому что адрес в этом запросе не передаётся, а сервер
 * требовал его в каждом.
 */
test('слепая квитанция второй раз не спрашивает адрес ни у кого', { skip }, async () => {
  const { streetCode } = await seedRegistry();

  const first = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: BLIND_QR, address: { streetCode, house: '85', block: '3', flat: '27' } },
  });
  await grantAccess();
  assert.equal(first.json().status, 'pending');

  /**
   * Другой человек с той же слепой квитанцией.
   *
   * Адрес у нас уже есть — он привязан к лицевому счёту, — поэтому
   * спрашивать его второй раз незачем. Раньше здесь спрашивалось имя,
   * потом снова адрес, и человек ходил по кругу.
   */
  const other = await app.inject({
    method: 'POST', url: '/api/auth/qr', payload: { qr: BLIND_QR },
  });

  assert.notEqual(
    other.json().error, 'needs_address',
    'адрес известен по лицевому счёту — круг «адрес → имя → адрес» закрыт',
  );
  assert.equal(other.json().status, 'pending');

  // И адреса в ответе по-прежнему нет: заявка ещё не подтверждена
  assert.ok(!/Ленина/.test(other.body), 'чужой адрес не раскрываем');
});

/**
 * Отклонённый запрос доступа не должен превращаться в вечное ожидание.
 *
 * Собственник отклоняет чужую заявку тем же `revoke`, что и отзыв доступа:
 * привязка становится `revoked`. Но при повторном сканировании код видел
 * ЛЮБУЮ существующую привязку и новую заявку не создавал — человек читал
 * «Запрос отправлен», а собственнику не приходило ничего, потому что он
 * видит только `invited`.
 */
test('после отказа повторное сканирование создаёт новый запрос', { skip }, async () => {
  const ownerRes = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  const ownerCookie = cookieFrom(ownerRes);

  const strangerRes = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': stranger() },
    payload: { qr: REAL_QR },
  });
  await app.inject({
    method: 'POST', url: `/api/properties/claims/${strangerRes.json().bindingId}`,
    headers: { authorization: `Bearer ${strangerRes.json().token}` },
    payload: { name: 'Чужой Пётр', flat: '27' },
  });

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: ownerCookie } });
  const pending = me.json().pendingRequests;
  assert.equal(pending.length, 1);

  // Отказ
  const rejected = await app.inject({
    method: 'POST', url: `/api/properties/${pending[0].bindingId}/revoke`,
    headers: { cookie: ownerCookie },
  });
  assert.equal(rejected.statusCode, 200);

  const afterReject = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: ownerCookie },
  });
  assert.equal(afterReject.json().pendingRequests.length, 0, 'заявка ушла из списка');

  // Человек сканирует снова — собственник обязан увидеть запрос заново
  const again = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': stranger() },
    payload: { qr: REAL_QR },
  });
  assert.equal(again.json().status, 'pending');

  const meAgain = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: ownerCookie },
  });
  assert.equal(
    meAgain.json().pendingRequests.length, 1,
    'иначе человек ждёт подтверждения, которого никто у собственника не просит',
  );
});

/**
 * ФИО собственника нельзя показывать тому, кто сканирует квитанцию.
 *
 * Мы не знаем, кто перед нами. А проверка «войти собственником» состоит
 * ровно в том, чтобы назвать ФИО собственника, — и экран это ФИО печатал.
 * Проверка выдавала собственный ответ: посторонний читал имя и вводил его.
 *
 * Отдельно: у квитанций расчётных центров ФИО плательщика не печатается
 * вовсе. Там мы раскрывали имя, которого у сканирующего не было ни откуда.
 */
test('ФИО собственника не уходит тому, кто сканирует чужую квитанцию', { skip }, async () => {
  await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();

  const noLeak = (body: string, where: string) => {
    assert.ok(!/Крутых/.test(body), `${where}: фамилия собственника не должна уходить клиенту`);
    assert.ok(!/Сергей/.test(body), `${where}: имя собственника не должно уходить клиенту`);
  };

  /**
   * Раньше здесь были ТРИ разных ответа на три разные догадки:
   * «этот счёт уже привязан», «не сходится с данными собственника»
   * и молчаливый вход. По ним перебирались и номера счетов, и фамилии —
   * причём верная фамилия сразу выдавала сессию собственника.
   *
   * Теперь ответ один и тот же, что бы сканирующий ни назвал.
   */
  const anonymous = await app.inject({
    method: 'POST', url: '/api/auth/qr', payload: { qr: REAL_QR },
  });
  assert.equal(anonymous.json().status, 'pending');
  noLeak(anonymous.body, 'без имени');

  const wrongName = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: { qr: REAL_QR, name: 'Пётр Самозванцев' },
  });
  assert.equal(wrongName.json().status, 'pending');
  noLeak(wrongName.body, 'чужое имя');

  const rightName = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: { qr: REAL_QR, name: 'Крутых Сергей' },
  });
  assert.equal(
    rightName.json().status, 'pending',
    'угаданное ФИО больше не открывает кабинет собственника',
  );
});

test('улица обязана быть из справочника', { skip }, async () => {
  await seedRegistry();

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: {
      qr: BLIND_QR,
      address: { streetCode: '99999999-9999-4999-8999-999999999999', house: '1', flat: '2' },
    },
  });
  await grantAccess();

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'street_not_found');
});

test('без номера дома адрес не принимается', { skip }, async () => {
  const { streetCode } = await seedRegistry();

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: { qr: BLIND_QR, address: { streetCode, house: '', flat: '27' } },
  });
  await grantAccess();
  assert.equal(res.statusCode, 400);
});

/**
 * Частный дом — не ошибка ввода.
 *
 * Квартиры у него нет вовсе, и требовать её номер значило бы закрыть вход
 * всему частному сектору: а это, по данным КЛАДР, большинство адресов
 * страны.
 */
test('частный дом привязывается без номера квартиры', { skip }, async () => {
  const { streetCode } = await seedRegistry();

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: { qr: BLIND_QR, address: { streetCode, house: '15А' } },
  });
  await grantAccess();

  assert.equal(res.statusCode, 202, 'заявка принята');

  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(res) },
  });
  const mine = me.json().properties[0];
  assert.match(mine.addressRaw, /д\. 15А$/, 'адрес заканчивается домом, без «кв.»');
  assert.equal(mine.house, '15а');
  assert.equal(mine.flat, '', 'у частного дома квартиры нет');
  assert.ok(mine.houseKey, 'ключ дома нужен и частному дому');
});

/**
 * Сквозная проверка ДЕФЕКТА 1: declaredPrivate обязан дойти от экрана
 * выбора адреса до правила частного дома ВСЕМ маршрутом, а не только
 * внутри canOwnPrivateHouse. До этой правки поле не передавал ни один
 * маршрут и ни один экран — грепом строка declaredPrivate не находилась
 * ни в server/, ни в public/, — и правило не срабатывало никогда: первый
 * житель частного дома вечно ждал председателя, которого неоткуда взять.
 *
 * Проверяем именно HTTP-путь (не canOwnPrivateHouse напрямую), потому что
 * не хватало ровно шва между экраном и функцией.
 */
test('человек выбирает свой дом на экране адреса — и получает подтверждённый доступ сразу', { skip }, async () => {
  const { streetCode } = await seedRegistry();

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: {
      qr: BLIND_QR,
      address: { streetCode, house: '21' },
      declaredPrivate: true,
    },
  });
  await grantAccess();

  assert.equal(res.statusCode, 200, 'частный дом впускает хозяином сразу, а не заводит заявку');
  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().role, 'owner');
  assert.equal(res.json().firstTime, true);

  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(res) },
  });
  const mine = me.json().properties[0];
  assert.equal(mine.accessLevel, 'full', 'доступ подтверждён, ждать председателя не нужно');
  assert.equal(mine.flat, '', 'у частного дома квартиры нет');
});

test('тот же выбор, но с номером квартиры, — обычная заявка, а не хозяйство', { skip }, async () => {
  const { streetCode } = await seedRegistry();

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: {
      qr: BLIND_QR,
      address: { streetCode, house: '21', flat: '5' },
      declaredPrivate: true,
    },
  });
  await grantAccess();

  /**
   * Слово человека — пятое из пяти условий правила, а не пропуск.
   * Номер квартиры доказывает, что объект в МКД, и declaredPrivate
   * его не перебивает — иначе кто угодно объявлял бы себя хозяином
   * целого дома, вписав в форму заведомо чужую квартиру.
   */
  assert.equal(res.statusCode, 202, 'с номером квартиры — обычная заявка председателю');
  assert.equal(res.json().status, 'pending');
});

test('корпус и строение доезжают до адреса', { skip }, async () => {
  const { streetCode } = await seedRegistry();

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    payload: {
      qr: BLIND_QR,
      address: { streetCode, house: '8А', block: '2', building: '54', flat: '3' },
    },
  });
  await grantAccess();

  assert.equal(res.statusCode, 202);

  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(res) },
  });
  assert.match(me.json().properties[0].addressRaw, /д\. 8А, к\. 2, стр\. 54, кв\. 3$/);
});

test('подсказка улиц ищет без учёта регистра и «ё»', { skip }, async () => {
  await seedRegistry();

  const res = await app.inject({
    method: 'GET', url: '/api/address/streets?region=61&q=ЛЕН',
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().streets.length, 1);
  assert.equal(res.json().streets[0].label, 'пр-кт Ленина, г Ростов-на-Дону');
});

test('подсказка по незагруженному региону отвечает 409, а не пустотой', { skip }, async () => {
  await seedRegistry();

  const res = await app.inject({
    method: 'GET', url: '/api/address/streets?region=77&q=твер',
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'region_not_loaded');
  assert.deepEqual(res.json().available.map((r: { code: string }) => r.code), ['61']);
});

test('подсказка улиц понимает пункт в запросе и тип улицы', { skip }, async () => {
  await seedRegistry();
  const { addressObject } = await import('../../db/schema.ts');
  // В области десятки улиц Ленина: житель Аксая уточняет свой город
  await testDb().insert(addressObject).values([
    { guid: 'aksai-0000-4000-8000-000000000001', regionCode: '61', parentGuid: 'f10763dc-63e3-48db-83e1-9c566fe3092b', level: 5, type: 'г', name: 'Аксай', searchName: 'аксай' },
    { guid: 'aksai-0000-4000-8000-000000000002', regionCode: '61', parentGuid: 'aksai-0000-4000-8000-000000000001', level: 8, type: 'ул', name: 'Ленина', searchName: 'ленина' },
  ]);
  const labels = async (q: string) => (await app.inject({
    method: 'GET', url: `/api/address/streets?region=61&q=${encodeURIComponent(q)}`,
  })).json().streets.map((s: { label: string }) => s.label);

  assert.deepEqual(await labels('Ленина Аксай'), ['ул Ленина, г Аксай']);
  assert.deepEqual(await labels('аксай, ленина'), ['ул Ленина, г Аксай'], 'пункт первым — тоже');
  assert.equal((await labels('ул Ленина')).length, 2, 'тип улицы в запросе не мешает');
  assert.deepEqual(await labels('г Ростов-на-Дону пр-кт Лен'), ['пр-кт Ленина, г Ростов-на-Дону']);
  assert.deepEqual(await labels('Ленина Батайск'), [], 'чужой пункт не подменяется любым');
});

/* ─────────────── несколько квитанций на одну квартиру ─────────────── */

/**
 * За квартиру платят нескольким организациям: ЖКУ управляющей компании,
 * свет энергосбыту, газ межрегионгазу, вывоз мусора регоператору.
 *
 * Раньше объектом недвижимости был ЛИЦЕВОЙ СЧЁТ, и одна квартира
 * превращалась в четыре «адреса»: начисления дробились, счётчики висели
 * на одном из них, а заявка о протечке уезжала в энергосбыт.
 */
function utilityQr(opts: { name: string; inn: string; persAcc: string; sum: number }) {
  return [
    'ST00011',
    `Name=${opts.name}`,
    'PersonalAcc=40702810952090030727',
    'BankName=ПАО Сбербанк',
    'BIC=046015602',
    'CorrespAcc=30101810600000000602',
    `Sum=${opts.sum}`,
    'PayeeINN=' + opts.inn,
    'payerAddress=344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3, кв. 27',
    `persAcc=${opts.persAcc}`,
    'paymPeriod=042026',
  ].join('|');
}

const LIGHT = utilityQr({
  name: 'ПАО "ТНС энерго Ростов-на-Дону"', inn: '6168002922',
  persAcc: '611500999', sum: 78000,
});
const WASTE = utilityQr({
  name: 'ООО "Экоцентр" вывоз ТКО', inn: '6168078923',
  persAcc: '77120099', sum: 16200,
});

test('четыре квитанции одной квартиры дают один адрес', { skip }, async () => {
  const first = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  const cookie = cookieFrom(first);

  for (const qr of [LIGHT, WASTE]) {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/qr', headers: { cookie }, payload: { qr },
    });
    await grantAccess();
    assert.equal(res.statusCode, 200, 'подтверждённый житель просто добавляет счёт');
  }

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const properties = me.json().properties;

  assert.equal(properties.length, 1, 'квартира одна, а не три');
  assert.equal(properties[0].accounts.length, 3, 'а лицевых счёта три');

  const services = properties[0].accounts.map((a: { service: string }) => a.service).sort();
  assert.deepEqual(services, ['electricity', 'housing', 'waste']);
});

test('сумма к оплате складывается по всем квитанциям квартиры', { skip }, async () => {
  const first = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  const cookie = cookieFrom(first);

  await app.inject({
    method: 'POST', url: '/api/auth/qr', headers: { cookie }, payload: { qr: LIGHT },
  });
  await grantAccess();

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const bill = me.json().properties[0].bill;

  // 3816.30 за ЖКУ плюс 780.00 за свет — деньги за квартиру, а не за счёт
  assert.equal(bill.outstandingKopecks, 381630 + 78000);
  assert.equal(bill.unpaidCount, 2);
});

test('начисления подписаны получателем', { skip }, async () => {
  const first = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  const cookie = cookieFrom(first);
  await app.inject({
    method: 'POST', url: '/api/auth/qr', headers: { cookie }, payload: { qr: LIGHT },
  });
  await grantAccess();

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const propertyId = me.json().properties[0].propertyId;

  const bills = await app.inject({
    method: 'GET', url: `/api/properties/${propertyId}/bills`, headers: { cookie },
  });
  assert.equal(bills.statusCode, 200);

  const list = bills.json().bills;
  assert.ok(
    list.some((b: { serviceLabel: string }) => b.serviceLabel === 'ЖКУ'),
    'жилищная квитанция подписана как ЖКУ',
  );
  assert.ok(
    list.some((b: { serviceLabel: string; provider: string }) =>
      b.serviceLabel === 'Электроэнергия' && /ТНС/.test(b.provider)),
    'квитанция за свет подписана энергосбытом',
  );
});

/**
 * Заявка не ждёт управляющую организацию.
 *
 * Энергосбыт получатель платежа, но не управляющая организация: у него
 * нет ни сантехников, ни обязанности по общему имуществу. Раньше это
 * закрывало приём заявок целиком, отвечая отказом `no_managing_uk`.
 * Теперь ДАТИРОВАННОЕ доказательство жалобы остаётся у жителя даже
 * без известного адресата — это и есть ядро продукта.
 */
test('квартира, заведённая по счёту за свет, всё равно принимает заявку', { skip }, async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: LIGHT },
  });
  await grantAccess();
  assert.equal(res.statusCode, 202, 'первая квитанция — это заявка');

  const cookie = cookieFrom(res);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const mine = me.json().properties[0];
  assert.equal(mine.ukName, null, 'управляющая организация ещё неизвестна');

  const request = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: {
      propertyId: mine.propertyId, category: 'Сантехника',
      description: 'Течёт стояк в ванной, вода на полу',
    },
  });
  assert.equal(request.statusCode, 201, 'адресата нет, но доказательство остаётся');
});

/**
 * Управляющую организацию даёт РЕЕСТР, а не квитанция.
 *
 * Раньше она выводилась из ИНН получателя платежа — и это было неверно
 * по сути: получатель и управляющий домом разные лица. Проверено на живых
 * данных ГИС ЖКХ: расчётного центра, который печатает квитанции за ЖКУ,
 * в реестре управляющих организаций нет вовсе.
 */
test('дом из реестра лицензий получает управляющую организацию', { skip }, async () => {
  const { managingOrg } = await import('../../db/schema.ts');
  const { parseAddress } = await import('../../lib/address/normalize.ts');

  const address = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';
  const orgId = newId('org');

  await testDb().insert(managingOrg).values({
    id: orgId, inn: '6168108630', name: 'ООО «УК Трианон»', shortName: 'УК Трианон',
    regionCode: '61', licenseNumber: '061000777', houseCount: 1,
  });
  await insertRegistryHouse(testDb(), {
    houseKey: parseAddress(address).houseKey,
    orgId, regionCode: '61', addressRaw: address,
  });

  // Заходим по квитанции ЗА СВЕТ: управляющая всё равно определится по дому
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: LIGHT },
  });
  await grantAccess();
  const cookie = cookieFrom(res);

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const mine = me.json().properties[0];
  assert.equal(mine.ukName, 'УК Трианон', 'УК берётся из реестра, а не из получателя платежа');

  const request = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: {
      propertyId: mine.propertyId, category: 'Сантехника',
      description: 'Течёт стояк в ванной, вода на полу',
    },
  });
  assert.equal(request.statusCode, 201, 'заявке есть кому уйти');
});
/* ─────────────── реестр управляющих организаций ─────────────── */

/**
 * Управляющая компания приходит из реестра лицензий, а не из квитанции.
 *
 * Это не деталь реализации, а суть: получатель платежа и управляющий домом
 * — разные лица. Свет, газ и мусор идут ресурсникам напрямую, жилищную
 * квитанцию печатает расчётный центр. Проверено на живых данных ГИС ЖКХ:
 * ИНН ГУП РО «ИВЦ ЖКХ» в реестре управляющих организаций отсутствует.
 */
async function seedLicenceRegistry(addresses: string[], inn = '6100000042') {
  const { managingOrg } = await import('../../db/schema.ts');
  const { parseAddress } = await import('../../lib/address/normalize.ts');

  const [org] = await testDb().insert(managingOrg).values({
    id: newId('org'), inn, name: `ООО «УК ${inn}»`, shortName: `УК ${inn}`,
    regionCode: '61', licenseNumber: '061000042', houseCount: addresses.length,
  }).onConflictDoUpdate({ target: managingOrg.inn, set: { houseCount: addresses.length } })
    .returning({ id: managingOrg.id });

  for (const address of addresses) {
    await insertRegistryHouse(testDb(), {
      houseKey: parseAddress(address).houseKey,
      orgId: org.id, regionCode: '61', addressRaw: address,
    });
  }

  return org.id;
}

const HOUSE_ADDRESS = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

test('дом вне реестра тоже принимает заявку — без адресата', { skip }, async () => {
  // Реестр НЕ заводим: дом системе неизвестен
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  assert.equal(res.statusCode, 202, 'заявка принимается и без реестра');

  const cookie = cookieFrom(res);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const mine = me.json().properties[0];
  assert.equal(mine.ukName, null, 'управляющая организация неизвестна');

  const request = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: {
      propertyId: mine.propertyId, category: 'Сантехника',
      description: 'Течёт стояк в ванной, вода на полу',
    },
  });
  assert.equal(request.statusCode, 201, 'заявка сохраняется даже без известного адресата');
});

/**
 * Адрес из реестра ГИС ЖКХ и адрес из квитанции обязаны дать один ключ.
 *
 * Порядок слов в них разный: реестр пишет «обл Ростовская», квитанция —
 * «Ростовская обл». Пока нормализация сохраняла порядок, дом из реестра
 * и дом жителя были разными домами, и вся связка не работала.
 */
test('адрес реестра и адрес квитанции дают один ключ дома', { skip }, async () => {
  const { parseAddress } = await import('../../lib/address/normalize.ts');

  const fromRegistry = parseAddress('344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3');
  const fromReceipt = parseAddress(HOUSE_ADDRESS);

  assert.equal(fromRegistry.houseKey, fromReceipt.houseKey);
  assert.equal(fromRegistry.region, 'ростовская область');
});

test('дом в реестре назначает управляющую организацию сам', { skip }, async () => {
  // Реестр приходит РАНЬШЕ жителя — так и бывает в жизни
  await seedLicenceRegistry([HOUSE_ADDRESS]);

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  const cookie = cookieFrom(res);

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const mine = me.json().properties[0];
  assert.equal(mine.ukName, 'УК 6100000042');

  const request = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: {
      propertyId: mine.propertyId, category: 'Сантехника',
      description: 'Течёт стояк в ванной, вода на полу',
    },
  });
  assert.equal(request.statusCode, 201);
});

/**
 * Реестр могли загрузить уже после того, как житель привязался.
 * Повторное обращение к объекту обязано подхватить организацию —
 * иначе человеку пришлось бы заново сканировать квитанцию.
 */
test('реестр, загруженный позже жителя, догоняет его объект', { skip }, async () => {
  const first = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  const cookie = cookieFrom(first);

  const before = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(before.json().properties[0].ukName, null);

  await seedLicenceRegistry([HOUSE_ADDRESS]);

  // Повторная привязка той же квитанции — обычное действие жителя
  await app.inject({
    method: 'POST', url: '/api/auth/qr', headers: { cookie }, payload: { qr: REAL_QR },
  });
  await grantAccess();

  const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(after.json().properties[0].ukName, 'УК 6100000042');
});

/* ─────────────── дом, записанный по-разному ─────────────── */

/**
 * Реестр ГИС ЖКХ пишет «Ленина 85/3», квитанция — «Ленина 85, к. 3».
 *
 * Это один дом. Но дробь мы намеренно не приравниваем к корпусу: на
 * пересечении улиц дробью нумеруют самостоятельные дома, и слепое
 * слияние поселило бы чужих людей вместе. Компромисс: ключ строгий,
 * а поиск по реестру идёт по нескольким кандидатам, и совпадение
 * подтверждается записью в реестре.
 *
 * Масштаб: из 13 637 домов Ростовской области 2082 записаны дробью
 * и 971 с корпусом.
 */
test('дробь и корпус находят один дом через реестр', { skip }, async () => {
  const { managingOrg } = await import('../../db/schema.ts');
  const { parseAddress } = await import('../../lib/address/normalize.ts');

  // В реестре дом записан ДРОБЬЮ — так его отдаёт ГИС ЖКХ
  const registryAddress = '344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. 85/3';
  const orgId = newId('org');

  await testDb().insert(managingOrg).values({
    id: orgId, inn: '6168108630', name: 'ООО «УК Трианон»', shortName: 'УК Трианон',
    regionCode: '61', houseCount: 1,
  });
  await insertRegistryHouse(testDb(), {
    houseKey: parseAddress(registryAddress).houseKey,
    orgId, regionCode: '61', addressRaw: registryAddress,
  });

  // Житель приходит с квитанцией, где КОРПУС
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  const cookie = cookieFrom(res);

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const mine = me.json().properties[0];

  assert.equal(mine.ukName, 'УК Трианон', 'дом нашёлся, несмотря на разное написание');
  assert.equal(
    mine.houseKey,
    parseAddress(registryAddress).houseKey,
    'ключ берётся из реестра — иначе соседи разойдутся между собой',
  );
});

/**
 * Ключ из реестра сводит соседей вместе.
 *
 * Один принёс квитанцию с «85/3», другой с «85, к. 3». Без канонизации
 * по реестру они оказались бы в разных домах и не увидели бы друг друга.
 */
/**
 * Дом показывается в написании РЕЕСТРА, а не квитанции.
 *
 * Квитанция печатает «д. 85, к. 3», реестр ГИС ЖКХ пишет «д. 85/3». Дом
 * один и тот же — ключ берётся из реестра, и связка с УК работает. Но
 * житель видел «Ленина 85к3», а его управляющая компания в своём кабинете
 * — «Ленина 85/3». Один дом двумя строками: житель не уверен, что попал
 * куда надо, а соседи в ленте выглядят живущими по разным адресам.
 */
test('дом показывается в написании реестра, квартира остаётся своя', { skip }, async () => {
  const { managingOrg } = await import('../../db/schema.ts');
  const { parseAddress } = await import('../../lib/address/normalize.ts');

  const registryAddress = '344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. 85/3';
  const orgId = newId('org');
  await testDb().insert(managingOrg).values({
    id: orgId, inn: '6168108632', name: 'ООО «УК Трианон»', shortName: 'УК Трианон',
    regionCode: '61', houseCount: 1,
  });
  await insertRegistryHouse(testDb(), {
    houseKey: parseAddress(registryAddress).houseKey,
    orgId, regionCode: '61', addressRaw: registryAddress,
  });

  // Квитанция пишет корпусом: «д. 85, к. 3, кв. 27»
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();
  assert.equal(res.statusCode, 202, 'первая квитанция — это заявка');

  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(res) },
  });
  const mine = me.json().properties[0];

  /**
   * Дробь разбирается как корпус — с тех пор, как их приравняли.
   *
   * Раньше здесь стояло `house === '85/3'` и `block === null`: дробь
   * считалась частью номера. Теперь «85/3» и «85, к. 3» — одна и та же
   * пара «дом + корпус», поэтому и поля разложены одинаково, каким бы
   * из двух способов адрес ни был напечатан.
   *
   * Строка адреса при этом остаётся реестровой: житель и его УК видят
   * один и тот же текст.
   */
  assert.equal(mine.house, '85', 'номер дома');
  assert.equal(mine.block, '3', 'дробь реестра разобрана как корпус');
  assert.equal(mine.flat, '27', 'квартира остаётся жительская');
  assert.match(mine.addressRaw, /85\/3/, 'строка адреса тоже реестровая');
  assert.match(mine.addressRaw, /кв\. 27/, 'и с квартирой жителя');
});

/**
 * Квитанция без региона всё равно находит свой дом в реестре.
 *
 * ЖИВОЙ СЛУЧАЙ, из-за которого это написано. Квитанция начинается сразу
 * с города: «г Ростов-на-Дону, пр-кт Ленина, д.85 корп. 3, кв.27» —
 * региона в ней нет вовсе, по ГОСТ он и не обязателен. Реестр ГИС ЖКХ
 * тот же дом пишет с регионом. Строгие ключи разошлись, дом не нашёлся:
 * житель в приложении остался без управляющей компании, а в кабинете
 * компании его не было — при том что дом у неё в списке есть.
 *
 * Дробь тут ни при чём: она к этому моменту уже приравнена к корпусу.
 * Это второй, независимый разлом того же места.
 */
test('дом находится, когда в квитанции нет региона', { skip }, async () => {
  const { managingOrg } = await import('../../db/schema.ts');
  const { parseAddress, looseHouseKey } = await import('../../lib/address/normalize.ts');

  const registryAddress = '344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. 85/3';
  const orgId = newId('org');
  await testDb().insert(managingOrg).values({
    id: orgId, inn: '6168108633', name: 'ООО «УК Трианон»', shortName: 'УК Трианон',
    regionCode: '61', houseCount: 1,
  });
  await insertRegistryHouse(testDb(), {
    houseKey: parseAddress(registryAddress).houseKey,
    houseKeyLoose: looseHouseKey(registryAddress),
    orgId, regionCode: '61', addressRaw: registryAddress,
  });

  // Та же квитанция, но региона в адресе нет
  const qr = REAL_QR.replace('344038, Ростовская обл, г Ростов-на-Дону,', 'г Ростов-на-Дону,');
  assert.ok(!qr.includes('Ростовская обл'), 'региона в квитанции действительно нет');

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr },
  });
  await grantAccess();
  assert.equal(res.statusCode, 202, 'первая квитанция — это заявка');

  const me = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(res) },
  });
  const mine = me.json().properties[0];

  assert.equal(mine.ukName, 'УК Трианон', 'управляющая компания найдена');
  assert.equal(
    mine.houseKey ?? parseAddress(mine.addressRaw).houseKey,
    parseAddress(registryAddress).houseKey,
    'ключ взят из реестра — иначе сосед с регионом окажется в другом доме',
  );
});

test('соседи с разным написанием адреса попадают в один дом', { skip }, async () => {
  const { managingOrg } = await import('../../db/schema.ts');
  const { parseAddress } = await import('../../lib/address/normalize.ts');

  const registryAddress = '344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина, д. 85/3';
  const orgId = newId('org');
  await testDb().insert(managingOrg).values({
    id: orgId, inn: '6168108631', name: 'ООО «УК Трианон»', shortName: 'УК Трианон',
    regionCode: '61', houseCount: 1,
  });
  await insertRegistryHouse(testDb(), {
    houseKey: parseAddress(registryAddress).houseKey,
    orgId, regionCode: '61', addressRaw: registryAddress,
  });

  // Первый: корпусом
  const first = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();

  // Второй: дробью, другая квартира
  const fractionQr = REAL_QR
    .replace('д. 85, к. 3, кв. 27', 'д. 85/3, кв. 44')
    .replace('persAcc=987654331', 'persAcc=987654444');

  const second = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initDataFor(90055, 'Иван', 'Соседов') },
    payload: { qr: fractionQr },
  });
  await grantAccess();
  assert.equal(second.statusCode, 202, 'заявка второго соседа принята');

  const meFirst = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(first) },
  });
  const meSecond = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: cookieFrom(second) },
  });

  assert.equal(
    meFirst.json().properties[0].houseKey,
    meSecond.json().properties[0].houseKey,
    'оба живут в одном доме',
  );
});

/**
 * Испорченная кодировка обязана называться своим именем.
 *
 * Нативный сканер MAX отдаёт готовую строку, и если он прочитал win-1251
 * как UTF-8, кириллица заменяется на U+FFFD безвозвратно. Раньше такая
 * строка «успешно разбиралась» (ИНН и лицевой счёт — ASCII, они выживают),
 * спотыкалась на неразбираемом адресе и получала ответ про нехватку
 * лицевого счёта — неправду, из-за которой человек искал проблему не там.
 */
test('испорченная кодировка объясняется честно, а не «нет лицевого счёта»', { skip }, async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: 'ST00011|Name=\uFFFD\uFFFD\uFFFD|PayeeINN=6168108630|persAcc=777' },
  });

  assert.equal(res.statusCode, 400);
  const body = res.json();
  assert.equal(body.error, 'invalid_qr');
  assert.equal(body.reason, 'mangled');
  assert.match(body.message, /кодировк/i, 'сообщение обязано называть настоящую причину');
});

/**
 * Вторая квартира одного человека.
 *
 * Раньше `/api/me` отдавал только подтверждённые объекты, а фронт берёт
 * из этого же списка текущий адрес. Второй адрес не попадал в приложение
 * вовсе — при том, что сервер по нему уже разрешает уровень 0: свои
 * квитанции, счётчики, аналитику и жалобу в УК.
 */
test('вторая квартира приходит в профиль со статусом «ожидает»', { skip }, async () => {
  const first = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  const cookie = cookieFrom(first);
  await grantAccess();

  // Квитанция другой квартиры того же дома: адрес напечатан, значит человек
  // принёс его сам и скрывать нечего
  const secondQr = REAL_QR
    .replace('кв. 27', 'кв. 31')
    .replace('persAcc=987654331', 'persAcc=987654999');

  const added = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { cookie, 'x-max-init-data': sergey() },
    payload: { qr: secondQr },
  });
  assert.equal(added.json().status, 'pending');

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const properties = me.json().properties;

  assert.equal(properties.length, 2);
  const waiting = properties.find((p: { status: string }) => p.status === 'pending');
  assert.ok(waiting, 'ожидающий объект обязан приходить в properties');
  assert.equal(waiting.accessLevel, 'self');
  assert.ok(waiting.addressRaw.includes('кв. 31'));
  assert.equal(typeof waiting.deciders.chairman, 'boolean');
});

/**
 * Адрес ожидающего объекта — только если человек принёс его САМ.
 *
 * Связка «лицевой счёт → квартира» живёт только в биллинге УК. Отдать
 * её тому, кто угадал номер счёта, значит повторить утечку, найденную
 * аудитом 25 августа.
 */
test('ожидающий объект без своего адреса приходит без адреса', { skip }, async () => {
  await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await grantAccess();

  const blind = REAL_QR.replace(/\|payerAddress=[^|]*/, '');
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': stranger() },
    payload: { qr: blind },
  });
  const cookie = cookieFrom(res);

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const [waiting] = me.json().properties;

  assert.equal(waiting.status, 'pending');
  assert.equal(waiting.addressRaw, null);
  assert.equal(waiting.flat, null);
  assert.equal(waiting.houseKey, null);
});

/**
 * Отзыв заявки — настоящее удаление.
 *
 * Человек сообщил ФИО, номер квартиры и свободную строку о себе ради
 * подтверждения и передумал. Пометка «отозвано» оставила бы эти данные
 * в очереди председателя и в базе навсегда, а решения по заявке не было.
 */
test('свою заявку можно отозвать, и строка исчезает из базы', { skip }, async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  const cookie = cookieFrom(res);
  const { bindingId } = res.json();

  await app.inject({
    method: 'POST', url: `/api/properties/claims/${bindingId}`,
    headers: { cookie },
    payload: { name: 'Крутых Сергей', flat: '27', note: 'живу с 2019' },
  });

  const gone = await app.inject({
    method: 'DELETE', url: `/api/properties/claims/${bindingId}`,
    headers: { cookie },
  });
  assert.equal(gone.statusCode, 200);

  const rows = await testDb().execute(
    `select id from user_property where id = '${bindingId}'`,
  );
  assert.equal(rows.rows.length, 0, 'строка заявки должна быть удалена, а не помечена');

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.json().properties.length, 0);
  assert.equal(me.json().myPendingAccess.length, 0);
});

test('чужую заявку отозвать нельзя', { skip }, async () => {
  const mine = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  const { bindingId } = mine.json();

  const other = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': stranger() },
    payload: { qr: REAL_QR.replace('persAcc=987654331', 'persAcc=987650000') },
  });

  const res = await app.inject({
    method: 'DELETE', url: `/api/properties/claims/${bindingId}`,
    headers: { cookie: cookieFrom(other) },
  });

  assert.equal(res.statusCode, 404);

  const rows = await testDb().execute(
    `select id from user_property where id = '${bindingId}'`,
  );
  assert.equal(rows.rows.length, 1, 'чужая заявка остаётся на месте');
});

test('подтверждённую привязку через отзыв заявки не удалить', { skip }, async () => {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  const cookie = cookieFrom(res);
  const { bindingId } = res.json();
  await grantAccess();

  const denied = await app.inject({
    method: 'DELETE', url: `/api/properties/claims/${bindingId}`,
    headers: { cookie },
  });

  assert.equal(denied.statusCode, 409);
  assert.equal(denied.json().error, 'already_decided');

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  assert.equal(me.json().properties.length, 1, 'доступ остался');
});

/**
 * «Приложение вас запомнило» — обещание, которое обязано выполняться.
 *
 * Человек отправил заявку, закрыл мини-апп и открыл заново. Раньше вход
 * через MAX считал человека известным только при ПОДТВЕРЖДЁННОЙ привязке
 * и отвечал `needs_receipt` — приложение уводило на сканирование, хотя
 * заявка отправлена, сессия выдана, а по объекту уже открыт уровень 0.
 */
test('человек с отправленной заявкой входит через MAX без квитанции', { skip }, async () => {
  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  assert.equal(scan.json().status, 'pending');

  // Новый заход в мини-апп: куки нет, есть только подпись платформы
  const again = await app.inject({
    method: 'POST', url: '/api/auth/max',
    headers: { 'x-max-init-data': sergey() },
  });

  assert.equal(again.statusCode, 200);
  assert.equal(again.json().status, 'ok', 'квитанцию заново просить нельзя');
  assert.ok(again.json().token, 'сессия нужна, чтобы открыть уровень 0');

  const me = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${again.json().token}` },
  });
  assert.equal(me.json().properties.length, 1);
  assert.equal(me.json().properties[0].status, 'pending');
});

test('незнакомцу и человеку с отклонённой заявкой квитанция по-прежнему нужна', { skip }, async () => {
  const fresh = await app.inject({
    method: 'POST', url: '/api/auth/max',
    headers: { 'x-max-init-data': stranger() },
  });
  assert.equal(fresh.json().status, 'needs_receipt', 'незнакомец сканирует квитанцию');

  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  await testDb().execute(
    `update user_property set status = 'revoked', reject_reason = 'не тот дом'
      where id = '${scan.json().bindingId}'`,
  );

  const after = await app.inject({
    method: 'POST', url: '/api/auth/max',
    headers: { 'x-max-init-data': sergey() },
  });
  assert.equal(after.json().status, 'needs_receipt', 'после отказа нужна новая квитанция');
});

/**
 * Главная показывает не начисление за месяц, а всё, что человек
 * не отметил оплаченным.
 *
 * Проверяем именно /api/me, а не listBills: правило расчёта у них теперь
 * общее (statusOf), и сломаться может как раз стыковка — то, что маршрут
 * это правило зовёт, а не считает по-своему заново.
 */
test('сумма к оплате не считает отмеченное оплаченным', { skip }, async () => {
  const { bill } = await import('../../db/schema.ts');
  const { eq } = await import('drizzle-orm');

  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  assert.equal(scan.statusCode, 202);
  const cookie = cookieFrom(scan);

  const [first] = await testDb().select().from(bill);
  assert.ok(first, 'скан квитанции обязан завести начисление');

  // Второе начисление по тому же счёту, другой период
  await testDb().insert(bill).values({
    id: newId('bil'),
    accountId: first.accountId,
    propertyId: first.propertyId,
    period: '2026-05',
    sumKopecks: 100000,
    source: 'manual',
  });

  // Первое житель отметил оплаченным
  await testDb().update(bill)
    .set({ paidAt: new Date(), paidKopecks: first.sumKopecks, paidSource: 'resident' })
    .where(eq(bill.id, first.id));

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const [mine] = me.json().properties;

  assert.equal(mine.bill.outstandingKopecks, 100000,
    'отмеченное оплаченным в сумму к оплате не входит');
  assert.equal(mine.bill.unpaidCount, 1);
  assert.equal(mine.bill.hasBills, true);
});

/**
 * QR квитанции для оплаты в банке: житель сохраняет его и платит
 * в банке «по QR из галереи». Ссылка подписана, потому что нативное
 * скачивание MAX не передаёт сессию.
 */
test('свою квитанцию житель получает картинкой QR по подписанной ссылке', { skip }, async () => {
  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  const cookie = cookieFrom(scan);
  const propertyId = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } }))
    .json().properties[0].propertyId;

  const bills = (await app.inject({ method: 'GET', url: `/api/properties/${propertyId}/bills`, headers: { cookie } })).json();
  const [mine] = bills.bills;
  assert.equal(mine.hasQr, true, 'квитанцию принёс он сам — QR есть');

  const link = await app.inject({ method: 'POST', url: `/api/bills/${mine.id}/pay-qr`, headers: { cookie }, payload: {} });
  assert.equal(link.statusCode, 200);
  const { url, fileName } = link.json();
  assert.ok(url.startsWith(`/api/bills/${mine.id}/qr.png?t=`));
  assert.match(url.split('?t=')[1], /^\d+\.[0-9a-f]{64}$/);
  assert.match(fileName, /\.png$/);

  // Без куки: так ходит нативное скачивание MAX
  const png = await app.inject({ method: 'GET', url });
  assert.equal(png.statusCode, 200);
  assert.equal(png.headers['content-type'], 'image/png');
  assert.deepEqual([...png.rawPayload.subarray(0, 4)], [137, 80, 78, 71]);

  const last = url.slice(-1);
  const forged = await app.inject({ method: 'GET', url: url.slice(0, -1) + (last === '0' ? '1' : '0') });
  assert.equal(forged.statusCode, 403, 'подделанная подпись');

  // Посторонний не получает ни ссылки, ни QR с чужой фамилией и адресом
  const other = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': stranger() },
    payload: { qr: REAL_QR.replace('persAcc=987654331', 'persAcc=111222333').replace('кв. 27', 'кв. 28') },
  });
  const strangerLink = await app.inject({
    method: 'POST', url: `/api/bills/${mine.id}/pay-qr`, headers: { cookie: cookieFrom(other) }, payload: {},
  });
  assert.equal(strangerLink.statusCode, 403);
});

/**
 * Просрочка считается отдельно: главная красит сумму красным, а нижняя
 * строка говорит, у скольких начислений срок уже прошёл.
 */
test('начисления с истёкшим сроком считаются отдельно', { skip }, async () => {
  const { bill } = await import('../../db/schema.ts');

  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': sergey() },
    payload: { qr: REAL_QR },
  });
  const cookie = cookieFrom(scan);

  const [first] = await testDb().select().from(bill);

  /**
   * Срок — десятое число месяца, следующего за расчётным. Период берём
   * далеко в будущем, чтобы тест не начал падать сам собой в календаре:
   * такое начисление просроченным не станет никогда.
   */
  await testDb().insert(bill).values({
    id: newId('bil'),
    accountId: first.accountId,
    propertyId: first.propertyId,
    period: '2099-01',
    sumKopecks: 50000,
    source: 'manual',
  });

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const [mine] = me.json().properties;

  // Период из REAL_QR — 042026, срок по нему истёк; 2099-01 ещё нет
  assert.equal(mine.bill.overdueCount, 1, 'просрочено ровно одно из двух');
  assert.equal(mine.bill.unpaidCount, 2, 'не отмечено оплаченным ни одно');
  assert.equal(mine.bill.outstandingKopecks, first.sumKopecks + 50000);
});
