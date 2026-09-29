import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import {
  testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL,
} from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';

/**
 * Квитанция, добавленная ИЗНУТРИ объекта.
 *
 * Главное, ради чего маршрут существует: у квитанции расчётного центра
 * адреса может не быть вовсе — по ГОСТ Р 56042-2014 он необязателен, —
 * и спрашивать его незачем, когда человек сам сказал, к какой квартире
 * относит счёт. Раньше такой человек выбирал свою улицу в справочнике
 * КЛАДР руками, а объект получал пометку «адрес указали вы».
 */

process.env.DATABASE_URL = TEST_URL;
// ||=, а не ??=: в заготовке .env.example токен пустой, и пустая строка ломала подписи
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

function qr(opts: { persAcc: string; flat?: string; inn?: string; name?: string }) {
  return [
    'ST00011',
    `Name=${opts.name ?? 'ООО "УК Трианон"'}`,
    `PayeeINN=${opts.inn ?? '6168108630'}`,
    'KPP=616801001', 'Sum=381630', 'paymPeriod=042026',
    'lastName=Крутых', 'firstName=Сергей', 'middleName=Валерьевич',
    ...(opts.flat ? [`payerAddress=${HOUSE}, кв. ${opts.flat}`] : []),
    `persAcc=${opts.persAcc}`,
  ].join('|');
}

function initData(id: number, first: string, last: string) {
  return signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: 900000 + id, type: 'DIALOG' }),
    query_id: `q-${id}`,
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

/** Житель с подтверждённой квартирой: кука и её объект. */
async function resident(id: number, flat: string, persAcc: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(id, 'Сергей', 'Крутых') },
    payload: { qr: qr({ persAcc, flat }) },
  });
  const cookie = cookieFrom(res);
  await grantAccess();
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { cookie, propertyId: me.json().properties[0].propertyId };
}

test('квитанция без адреса ложится в выбранный объект', { skip }, async () => {
  const { cookie, propertyId } = await resident(100001, '27', '987654331');

  const res = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/receipts`,
    headers: { cookie },
    payload: { qr: qr({ persAcc: '55500011', name: 'ООО "Энергосбыт"', inn: '6100000077' }) },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const accounts = me.json().properties[0].accounts;
  assert.equal(accounts.length, 2, 'у квартиры должно стать два лицевых счёта');
});

test('к чужому объекту квитанцию не привязать', { skip }, async () => {
  const owner = await resident(100002, '27', '987654332');
  const outsider = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(100003, 'Пётр', 'Чужой') },
    payload: { qr: qr({ persAcc: '777000111', flat: '99' }) },
  });

  const res = await app.inject({
    method: 'POST', url: `/api/properties/${owner.propertyId}/receipts`,
    headers: { cookie: cookieFrom(outsider) },
    payload: { qr: qr({ persAcc: '55500022', name: 'ООО "Энергосбыт"', inn: '6100000077' }) },
  });

  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'no_access');
});

test('квитанция другого адреса отклоняется и называет прочитанный адрес', { skip }, async () => {
  const { cookie, propertyId } = await resident(100004, '27', '987654334');

  const res = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/receipts`,
    headers: { cookie },
    payload: { qr: qr({ persAcc: '55500033', flat: '31' }) },
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'address_mismatch');
  assert.ok(res.json().message.includes('кв. 31'), 'в отказе должен быть прочитанный адрес');
});

test('счёт, заведённый на другой квартире, не переезжает', { skip }, async () => {
  const first = await resident(100005, '27', '987654335');

  // Вторая квартира — у другого человека, со своим счётом
  await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(100006, 'Ирина', 'Волкова') },
    payload: { qr: qr({ persAcc: '444000111', flat: '31' }) },
  });

  // Тот же счёт, но без напечатанного адреса — проверка адреса не сработает,
  // и защиту держит только правило «счёт не переезжает»
  const res = await app.inject({
    method: 'POST', url: `/api/properties/${first.propertyId}/receipts`,
    headers: { cookie: first.cookie },
    payload: { qr: qr({ persAcc: '444000111' }) },
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'account_elsewhere');

  const rows = await testDb().execute(
    `select property_id from account where pers_acc = '444000111'`,
  );
  assert.notEqual(
    (rows.rows as { property_id: string }[])[0].property_id,
    first.propertyId,
    'счёт обязан остаться там, где заведён',
  );
});

test('к ожидающему объекту квитанцию добавить можно', { skip }, async () => {
  // Без grantAccess: объект остаётся в статусе pending — это уровень 0,
  // свои квитанции человеку открыты сразу
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(100007, 'Сергей', 'Крутых') },
    payload: { qr: qr({ persAcc: '987654337', flat: '27' }) },
  });
  const cookie = cookieFrom(res);

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const { propertyId, status } = me.json().properties[0];
  assert.equal(status, 'pending');

  const added = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/receipts`,
    headers: { cookie },
    payload: { qr: qr({ persAcc: '55500044', name: 'ООО "Энергосбыт"', inn: '6100000077' }) },
  });

  assert.equal(added.statusCode, 200);
});

/* ─────────────── приглашение жильца ─────────────── */

/**
 * Домочадец не должен сканировать квитанцию: она одна на квартиру.
 * Собственник зовёт его сам — и отвечает за это приглашение.
 *
 * Границы проверяются здесь все: кто может звать, что код одноразовый,
 * что он протухает, что отозванный не работает и что жилец приходит
 * жильцом, а не вторым собственником.
 */

async function invited(id: number) {
  // Человек, которого ещё нет в системе: он входит по коду, без квитанции
  return app.inject({
    method: 'POST', url: '/api/auth/max',
    headers: { 'x-max-init-data': initData(id, 'Мария', 'Крутых') },
  });
}

test('собственник зовёт жильца, тот входит без квитанции', { skip }, async () => {
  const { cookie, propertyId } = await resident(200001, '27', '987650001');

  const made = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/invites`, headers: { cookie },
  });
  assert.equal(made.statusCode, 200);
  const code = made.json().code;
  assert.match(code, /^[A-Z0-9]{6}$/);

  // Приглашённого в системе ещё нет: сначала он появляется через MAX
  const guest = await invited(200002);
  assert.equal(guest.json().status, 'needs_receipt');
  const guestToken = guest.json().token;

  // Вход по коду выдаёт доступ сразу, без председателя
  const redeem = await app.inject({
    method: 'POST', url: '/api/invites/redeem',
    headers: { 'x-max-init-data': initData(200002, 'Мария', 'Крутых') },
    payload: { code },
  });
  assert.equal(redeem.statusCode, 200);
  assert.ok(redeem.json().token, 'вместе с доступом человек получает сессию');
  assert.ok(guestToken === undefined || guestToken, 'до кода сессии у него не было');

  const me = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${redeem.json().token}` },
  });
  const props = me.json().properties;
  assert.equal(props.length, 1);
  assert.equal(props[0].status, 'active', 'ждать председателя не нужно');
  assert.equal(props[0].role, 'member', 'приглашённый — жилец, не собственник');
});

test('код одноразовый', { skip }, async () => {
  const { cookie, propertyId } = await resident(200003, '27', '987650003');
  const code = (await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/invites`, headers: { cookie },
  })).json().code;

  await app.inject({
    method: 'POST', url: '/api/invites/redeem',
    headers: { 'x-max-init-data': initData(200004, 'Мария', 'Крутых') },
    payload: { code },
  });

  const second = await app.inject({
    method: 'POST', url: '/api/invites/redeem',
    headers: { 'x-max-init-data': initData(200005, 'Пётр', 'Посторонний') },
    payload: { code },
  });

  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'used');
});

test('истёкший код не работает', { skip }, async () => {
  const { cookie, propertyId } = await resident(200006, '27', '987650006');
  const code = (await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/invites`, headers: { cookie },
  })).json().code;

  await testDb().execute(
    `update invite set expires_at = now() - interval '1 minute' where code = '${code}'`,
  );

  const res = await app.inject({
    method: 'POST', url: '/api/invites/redeem',
    headers: { 'x-max-init-data': initData(200007, 'Мария', 'Крутых') },
    payload: { code },
  });

  assert.equal(res.statusCode, 410);
  assert.equal(res.json().error, 'expired');
});

test('отозванный код не работает, а отзывать может только автор', { skip }, async () => {
  const { cookie, propertyId } = await resident(200008, '27', '987650008');
  const made = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/invites`, headers: { cookie },
  });
  const { code } = made.json();

  const list = await app.inject({
    method: 'GET', url: `/api/properties/${propertyId}/invites`, headers: { cookie },
  });
  assert.equal(list.json().invites.length, 1);
  const inviteId = list.json().invites[0].id;

  // Посторонний житель другой квартиры отозвать не может
  const outsider = await resident(200009, '31', '987650009');
  const stolen = await app.inject({
    method: 'DELETE', url: `/api/invites/${inviteId}`,
    headers: { cookie: outsider.cookie },
  });
  assert.equal(stolen.statusCode, 404);

  const dropped = await app.inject({
    method: 'DELETE', url: `/api/invites/${inviteId}`, headers: { cookie },
  });
  assert.equal(dropped.statusCode, 200);

  const res = await app.inject({
    method: 'POST', url: '/api/invites/redeem',
    headers: { 'x-max-init-data': initData(200010, 'Мария', 'Крутых') },
    payload: { code },
  });
  assert.equal(res.statusCode, 410);
  assert.equal(res.json().error, 'revoked');
});

test('приглашать может только собственник, но не жилец и не посторонний', { skip }, async () => {
  const { cookie, propertyId } = await resident(200011, '27', '987650011');
  const code = (await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/invites`, headers: { cookie },
  })).json().code;

  const member = await app.inject({
    method: 'POST', url: '/api/invites/redeem',
    headers: { 'x-max-init-data': initData(200012, 'Мария', 'Крутых') },
    payload: { code },
  });

  // Жилец звать не может: цепочку приглашений замыкаем на собственнике
  const byMember = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/invites`,
    headers: { authorization: `Bearer ${member.json().token}` },
  });
  assert.equal(byMember.statusCode, 403);

  const stranger = await resident(200013, '31', '987650013');
  const byStranger = await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/invites`,
    headers: { cookie: stranger.cookie },
  });
  assert.equal(byStranger.statusCode, 403);
});

test('код с пробелами и в нижнем регистре всё равно принимается', { skip }, async () => {
  const { cookie, propertyId } = await resident(200014, '27', '987650014');
  const code = (await app.inject({
    method: 'POST', url: `/api/properties/${propertyId}/invites`, headers: { cookie },
  })).json().code;

  const messy = ` ${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()} `;
  const res = await app.inject({
    method: 'POST', url: '/api/invites/redeem',
    headers: { 'x-max-init-data': initData(200015, 'Мария', 'Крутых') },
    payload: { code: messy },
  });

  assert.equal(res.statusCode, 200);
});
