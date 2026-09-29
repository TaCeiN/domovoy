import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import { setTransport, notify, type Transport } from '../../lib/notify/index.ts';
import {
  testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL,
} from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';

/**
 * Настройки уведомлений.
 *
 * ГЛАВНОЕ ПРАВИЛО, которое проверяется здесь: настройка касается ДОСТАВКИ,
 * а не события. Приглушённое уведомление всё равно записывается и видно
 * в списке внутри приложения — молчит только бот. Иначе человек, который
 * отключил сообщения, не узнал бы о смене статуса своей заявки никогда.
 */

process.env.DATABASE_URL = TEST_URL;
// ||=, а не ??=: в заготовке .env.example токен пустой, и пустая строка ломала подписи
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

const QR = [
  'ST00011', 'Name=ООО "УК Трианон"', 'PayeeINN=6168108630', 'KPP=616801001',
  'Sum=381630', 'paymPeriod=042026', 'lastName=Крутых', 'firstName=Сергей',
  `payerAddress=${HOUSE}, кв. 27`, 'persAcc=987654331',
].join('|');

function initData(id: number) {
  return signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: 950000 + id, type: 'DIALOG' }),
    query_id: `q-${id}`,
    user: JSON.stringify({
      id, first_name: 'Сергей', last_name: 'Крутых',
      username: null, language_code: 'ru', photo_url: null,
    }),
  }, BOT_TOKEN);
}

const sent: { chatId: number; text: string }[] = [];
const fakeTransport: Transport = {
  async sendToMax(chatId, text) { sent.push({ chatId, text }); },
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

async function resident(id = 300001) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(id) },
    payload: { qr: QR },
  });
  const cookie = cookieFrom(res);
  await grantAccess();
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { cookie, userId: me.json().user.id };
}

test('по умолчанию приходит всё', { skip }, async () => {
  const { cookie } = await resident();

  const res = await app.inject({
    method: 'GET', url: '/api/notifications/settings', headers: { cookie },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().mode, 'all');
  assert.equal(res.json().kinds.payment_reminder, true);
  assert.ok(res.json().available.length >= 6, 'экрану нужны описания видов');
});

test('режим «только важное» глушит второстепенное, но не заявки', { skip }, async () => {
  const { cookie, userId } = await resident(300002);

  await app.inject({
    method: 'POST', url: '/api/notifications/settings',
    headers: { cookie }, payload: { mode: 'important' },
  });

  await notify(testDb(), {
    userId, kind: 'payment_reminder',
    title: 'Новая квитанция', body: 'Пришло начисление за август',
  });
  assert.equal(sent.length, 0, 'начисления в режиме «только важное» не шлём');

  await notify(testDb(), {
    userId, kind: 'request_status',
    title: 'Заявка в работе', body: 'Диспетчер взял обращение',
  });
  assert.equal(sent.length, 1, 'своя заявка — это важное');

  // Событие всё равно записано: список в приложении показывает оба
  const list = await app.inject({
    method: 'GET', url: '/api/notifications', headers: { cookie },
  });
  assert.equal(list.json().notifications.length, 2, 'приглушённое не исчезает');
});

test('выключенные уведомления не доходят вовсе', { skip }, async () => {
  const { cookie, userId } = await resident(300003);

  await app.inject({
    method: 'POST', url: '/api/notifications/settings',
    headers: { cookie }, payload: { mode: 'off' },
  });

  await notify(testDb(), {
    userId, kind: 'request_status',
    title: 'Заявка в работе', body: 'Диспетчер взял обращение',
  });

  assert.equal(sent.length, 0);
});

test('правка одного переключателя переводит режим в «свой»', { skip }, async () => {
  const { cookie } = await resident(300004);

  await app.inject({
    method: 'POST', url: '/api/notifications/settings',
    headers: { cookie }, payload: { mode: 'important' },
  });

  const saved = await app.inject({
    method: 'POST', url: '/api/notifications/settings',
    headers: { cookie },
    payload: { mode: 'important', kinds: { payment_reminder: true } },
  });

  assert.equal(saved.json().mode, 'custom', 'человек вышел из пресета');
  assert.equal(saved.json().kinds.payment_reminder, true);
  assert.equal(saved.json().kinds.meters_reminder, false, 'остальное осталось как было');

  const again = await app.inject({
    method: 'GET', url: '/api/notifications/settings', headers: { cookie },
  });
  assert.equal(again.json().mode, 'custom', 'настройка пережила перезаход');
});

test('набор, совпавший с пресетом, пресетом и остаётся', { skip }, async () => {
  const { cookie } = await resident(300005);

  const saved = await app.inject({
    method: 'POST', url: '/api/notifications/settings',
    headers: { cookie },
    payload: {
      mode: 'custom',
      kinds: {
        request_status: true, request_assigned: true, access_request: true,
        outage: true, meters_reminder: true, payment_reminder: true,
      },
    },
  });

  assert.equal(saved.json().mode, 'all', 'это ровно «все», а не «свой»');
});

/**
 * Клиент шлёт ОДНУ изменённую галочку, без режима.
 *
 * Так устроен экран: человек трогает переключатель, остальное сервер
 * знает сам. Пока сервер считал такой запрос от «всё включено», включение
 * одного вида молча возвращало все остальные — в режиме «только важное»
 * человек включал счётчики и получал обратно ещё и начисления.
 */
test('включение одной галочки не воскрешает остальные', { skip }, async () => {
  const { cookie } = await resident(300006);

  await app.inject({
    method: 'POST', url: '/api/notifications/settings',
    headers: { cookie }, payload: { mode: 'important' },
  });

  const saved = await app.inject({
    method: 'POST', url: '/api/notifications/settings',
    headers: { cookie }, payload: { kinds: { payment_reminder: true } },
  });

  assert.equal(saved.json().mode, 'custom');
  assert.equal(saved.json().kinds.payment_reminder, true);
  assert.equal(saved.json().kinds.meters_reminder, false, 'счётчики остались выключенными');
});

/**
 * СПИСОК, ОБРЕЗАННЫЙ МОЛЧА, ЧЕЛОВЕК ПРИНИМАЕТ ЗА ПОЛНЫЙ.
 *
 * За год у жителя набирается пара сотен событий, а маршрут отдавал
 * последние пятьдесят и ничего про остальные не говорил. Тот, кто ищет
 * уведомление трёхмесячной давности, долистывал до конца и решал,
 * что оно пропало.
 */
test('список говорит, сколько уведомлений всего, и умеет отдать больше', { skip }, async () => {
  const { cookie, userId } = await resident(300010);

  for (let i = 1; i <= 60; i++) {
    await notify(testDb(), {
      userId, kind: 'request_status',
      title: `Событие ${i}`, body: 'Смена статуса заявки',
    });
  }

  const first = await app.inject({
    method: 'GET', url: '/api/notifications', headers: { cookie },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().notifications.length, 50, 'по умолчанию — полсотни');
  assert.equal(first.json().total, 60, 'но известно, что их шестьдесят');

  const more = await app.inject({
    method: 'GET', url: '/api/notifications?limit=100', headers: { cookie },
  });
  assert.equal(more.json().notifications.length, 60, '«Показать ещё» доходит до конца');

  const greedy = await app.inject({
    method: 'GET', url: '/api/notifications?limit=100000', headers: { cookie },
  });
  assert.equal(greedy.json().notifications.length, 60);
  assert.equal(greedy.json().total, 60, 'потолок не превращает список в выгрузку истории');
});
