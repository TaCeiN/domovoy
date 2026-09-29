import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import { setTransport, type Transport } from '../../lib/notify/index.ts';
import {
  testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL, insertRegistryHouse,
} from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';
import { newId } from '../../lib/ids.ts';

/**
 * Вложения к обращению: фотография протечки, скан акта, предписание.
 *
 * ГЛАВНОЕ, ЧТО ПРОВЕРЯЕТСЯ. Файл лежит у нас, а наружу уходит маршрут
 * с проверкой доступа: приём ссылок от клиента убрали в аудит 25 августа,
 * потому что без своего хранилища это был способ подсунуть диспетчеру
 * ссылку на что угодно. И тип файла определяется по содержимому — имя
 * и заголовок приходят из того же запроса, что и сам файл.
 */

process.env.DATABASE_URL = TEST_URL;
// ||=, а не ??=: в заготовке .env.example токен пустой, и пустая строка ломала подписи
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
/** Файлы теста — во временный каталог, а не в рабочий `uploads/` */
process.env.UPLOADS_DIR = join(tmpdir(), 'domovoy-test-uploads');
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

function qr(opts: { flat: string; persAcc: string; last: string; first: string }) {
  return [
    'ST00011', 'Name=ООО "УК Пример"', 'PayeeINN=6100000001', 'KPP=610001001',
    'Sum=485000', 'paymPeriod=082026',
    `lastName=${opts.last}`, `firstName=${opts.first}`,
    `payerAddress=${HOUSE}, кв. ${opts.flat}`, `persAcc=${opts.persAcc}`,
  ].join('|');
}

function initData(id: number, first: string, last: string) {
  return signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: 970000 + id, type: 'DIALOG' }),
    query_id: `q-${id}`,
    user: JSON.stringify({
      id, first_name: first, last_name: last,
      username: null, language_code: 'ru', photo_url: null,
    }),
  }, BOT_TOKEN);
}

const fakeTransport: Transport = { async sendToMax() { /* тесты в сеть не ходят */ } };

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const app = buildApp();
setTransport(fakeTransport);

beforeEach(async () => { if (available) await resetTables(); });
after(async () => {
  setTransport(null);
  await app.close();
  await closeTestDb();
  await closeDb();
  await rm(process.env.UPLOADS_DIR!, { recursive: true, force: true });
});

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
}

/** Реестр заводим до жителя: связка «дом → УК» берётся оттуда. */
async function seedOrg() {
  const { managingOrg } = await import('../../db/schema.ts');
  const { parseAddress } = await import('../../lib/address/normalize.ts');

  const [org] = await testDb().insert(managingOrg).values({
    id: newId('org'), inn: '6100000001', name: 'ООО «УК Пример»',
    shortName: 'УК Пример', regionCode: '61', licenseNumber: '061000001', houseCount: 1,
  }).onConflictDoUpdate({ target: managingOrg.inn, set: { houseCount: 1 } })
    .returning({ id: managingOrg.id });

  await insertRegistryHouse(testDb(), {
    houseKey: parseAddress(HOUSE).houseKey,
    orgId: org.id, regionCode: '61', addressRaw: HOUSE,
  });
}

async function resident(id: number, flat: string, persAcc: string, last = 'Смирнова') {
  await seedOrg();
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(id, 'Анна', last) },
    payload: { qr: qr({ flat, persAcc, last, first: 'Анна' }) },
  });
  const cookie = cookieFrom(res);
  await grantAccess();
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { cookie, propertyId: me.json().properties[0].propertyId };
}

async function newRequest(cookie: string, propertyId: string) {
  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, description: 'Течёт стояк в ванной, вода на полу' },
  });
  return created.json().id ?? created.json().request?.id;
}

/** Настоящий PNG в один пиксель: тип определяется по содержимому. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Форма с файлом: собираем руками, чтобы не тащить в тесты лишнюю зависимость. */
function form(bytes: Buffer, filename: string, mime: string) {
  const boundary = '----domovoytest';
  const crlf = '\r\n';
  const head = Buffer.from(
    `--${boundary}${crlf}`
    + `Content-Disposition: form-data; name="file"; filename="${filename}"${crlf}`
    + `Content-Type: ${mime}${crlf}${crlf}`,
  );
  const tail = Buffer.from(`${crlf}--${boundary}--${crlf}`);
  return {
    payload: Buffer.concat([head, bytes, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

test('житель прикладывает фотографию, и она видна в обращении', { skip }, async () => {
  const { cookie, propertyId } = await resident(90050, '15', '4460153');
  const requestId = await newRequest(cookie, propertyId);

  const file = form(PNG, 'протечка.png', 'image/png');
  const res = await app.inject({
    method: 'POST', url: `/api/requests/${requestId}/files`,
    headers: { cookie, ...file.headers }, payload: file.payload,
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().file.mime, 'image/png');

  const detail = await app.inject({
    method: 'GET', url: `/api/requests/${requestId}`, headers: { cookie },
  });
  const photos = detail.json().photos;
  assert.equal(photos.length, 1);
  assert.equal(photos[0].name, 'протечка.png');

  const got = await app.inject({ method: 'GET', url: photos[0].url, headers: { cookie } });
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.equal(got.headers['x-content-type-options'], 'nosniff', 'иначе браузер додумает тип сам');
  assert.equal(got.rawPayload.length, PNG.length, 'файл отдаётся байт в байт');
});

test('сосед не видит вложение и не может приложить своё', { skip }, async () => {
  const owner = await resident(90051, '15', '4460153');
  const requestId = await newRequest(owner.cookie, owner.propertyId);

  const file = form(PNG, 'протечка.png', 'image/png');
  await app.inject({
    method: 'POST', url: `/api/requests/${requestId}/files`,
    headers: { cookie: owner.cookie, ...file.headers }, payload: file.payload,
  });
  const photos = (await app.inject({
    method: 'GET', url: `/api/requests/${requestId}`, headers: { cookie: owner.cookie },
  })).json().photos;

  const neighbour = await resident(90052, '17', '4460173', 'Волкова');

  const stolen = await app.inject({
    method: 'GET', url: photos[0].url, headers: { cookie: neighbour.cookie },
  });
  assert.equal(stolen.statusCode, 404, 'чужого обращения для него не существует');

  const pushed = await app.inject({
    method: 'POST', url: `/api/requests/${requestId}/files`,
    headers: { cookie: neighbour.cookie, ...file.headers }, payload: file.payload,
  });
  assert.equal(pushed.statusCode, 404);
});

test('тип берём из содержимого, а не из имени и заголовка', { skip }, async () => {
  const { cookie, propertyId } = await resident(90053, '15', '4460153');
  const requestId = await newRequest(cookie, propertyId);

  // Исполняемый файл, притворяющийся картинкой и именем, и Content-Type
  const evil = form(Buffer.from('MZ EXECUTABLE PAYLOAD'), 'фото.png', 'image/png');
  const res = await app.inject({
    method: 'POST', url: `/api/requests/${requestId}/files`,
    headers: { cookie, ...evil.headers }, payload: evil.payload,
  });

  assert.equal(res.statusCode, 415);
  assert.equal(res.json().error, 'bad_type');
});

test('больше пяти файлов к обращению не приложить', { skip }, async () => {
  const { cookie, propertyId } = await resident(90054, '15', '4460153');
  const requestId = await newRequest(cookie, propertyId);

  const file = form(PNG, 'фото.png', 'image/png');
  for (let i = 0; i < 5; i += 1) {
    const ok = await app.inject({
      method: 'POST', url: `/api/requests/${requestId}/files`,
      headers: { cookie, ...file.headers }, payload: file.payload,
    });
    assert.equal(ok.statusCode, 200, `файл ${i + 1} должен приниматься`);
  }

  const sixth = await app.inject({
    method: 'POST', url: `/api/requests/${requestId}/files`,
    headers: { cookie, ...file.headers }, payload: file.payload,
  });
  assert.equal(sixth.statusCode, 409);
  assert.equal(sixth.json().error, 'too_many');
});
