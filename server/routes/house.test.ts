import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { buildApp } from '../app.ts';
import { signInitDataForTesting } from '../../lib/max/init-data.ts';
import { setTransport, type Transport } from '../../lib/notify/index.ts';
import { hashPassword } from '../../lib/auth/password.ts';
import { testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL, insertRegistryHouse } from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';
import { dispatcher, uk, property, post } from '../../db/schema.ts';
import { newId } from '../../lib/ids.ts';

/**
 * Жизнь дома: лента, объявления, опросы.
 *
 * Ключевая проверка здесь — что соседи по houseKey видят общее, а жители
 * другого дома не видят ничего. На этом держатся все соседские функции.
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
// ||=, а не ??=: в заготовке .env.example токен пустой, и пустая строка ломала подписи
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

function qr(opts: { last: string; first: string; flat: string; persAcc: string; house?: string }) {
  return [
    'ST00011', 'Name=ООО "УК Пример"', 'PayeeINN=6100000001', 'KPP=610001001',
    'Sum=485000', 'paymPeriod=082026',
    `lastName=${opts.last}`, `firstName=${opts.first}`, 'middleName=Т',
    `payerAddress=${opts.house ?? HOUSE}, кв. ${opts.flat}`,
    `persAcc=${opts.persAcc}`,
  ].join('|');
}

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

/** Настоящий PNG в один пиксель: тип вложения определяется по содержимому. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** Форма с файлом: собираем руками, чтобы не тащить в тесты лишнюю зависимость. */
function fileForm(bytes: Buffer, filename: string, mime: string) {
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

async function login(opts: Parameters<typeof qr>[0], id: number) {
  // Реестр раньше жителя: иначе объект останется без управляющей организации
  await seedOrg([opts.house ?? HOUSE]);

  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(id, opts.first, opts.last) },
    payload: { qr: qr(opts) },
  });
  const cookie = cookieFrom(res);
  // Квитанция заводит заявку, доступ открывает председатель или УК.
  // Здесь это фикстура: файл не про модель доступа — см. lib/test-db.ts
  await grantAccess();
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { cookie, propertyId: me.json().properties[0].propertyId };
}

const anna = () => login({ last: 'Смирнова', first: 'Анна', flat: '15', persAcc: '4460153' }, 90001);
const irina = () => login({ last: 'Волкова', first: 'Ирина', flat: '33', persAcc: '4460331' }, 90002);
const otherHouse = () => login({
  last: 'Дальний', first: 'Пётр', flat: '1', persAcc: '7770001',
  house: '344038, Ростовская обл, г Ростов-на-Дону, ул Совсем Другая, д 1',
}, 90009);

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
  const id = orgId ?? await seedOrg([HOUSE]);
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

async function houseKeyOf(propertyId: string) {
  const rows = await testDb().select().from(property).where(eq(property.id, propertyId));
  return rows[0].houseKey;
}

test('объявление УК видят все жильцы дома', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();

  const created = await app.inject({
    method: 'POST', url: '/api/dispatcher/posts',
    headers: { cookie: dispCookie },
    payload: {
      houseKey: await houseKeyOf(a.propertyId),
      category: 'outage',
      title: 'Отключение воды',
      body: 'Сегодня с 14:00 до 18:00, подъезды 1–3',
    },
  });
  assert.equal(created.statusCode, 201);

  for (const [name, cookie] of [['Анна', a.cookie], ['Ирина', i.cookie]] as const) {
    const feed = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie } });
    assert.equal(feed.json().posts.length, 1, `${name} должна видеть объявление`);
    assert.equal(feed.json().posts[0].author, 'Управляющая компания');
    assert.equal(feed.json().posts[0].categoryLabel, 'Отключение');
  }
});

test('жители другого дома объявление не видят', { skip }, async () => {
  const a = await anna();
  const far = await otherHouse();
  const dispCookie = await loginDispatcher();

  await app.inject({
    method: 'POST', url: '/api/dispatcher/posts',
    headers: { cookie: dispCookie },
    payload: {
      houseKey: await houseKeyOf(a.propertyId),
      category: 'news', title: 'Новость дома', body: 'Что-то произошло у нас',
    },
  });

  const feed = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie: far.cookie } });
  assert.equal(feed.json().posts.length, 0);
});

test('уведомление шлём только про аварийное отключение', { skip }, async () => {
  const a = await anna();
  await irina();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);

  const news = await app.inject({
    method: 'POST', url: '/api/dispatcher/posts',
    headers: { cookie: dispCookie },
    payload: { houseKey, category: 'news', title: 'Новость', body: 'Просто новость дома' },
  });
  assert.equal(news.json().notified, 0, 'ради новости людей не будим');
  assert.equal(sent.length, 0);

  const outage = await app.inject({
    method: 'POST', url: '/api/dispatcher/posts',
    headers: { cookie: dispCookie },
    payload: { houseKey, category: 'outage', title: 'Отключение воды', body: 'С 14:00 до 18:00' },
  });
  assert.equal(outage.json().notified, 2, 'оба жильца дома');
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /Отключение воды/);
});

test('сосед публикует объявление, его видят по дому', { skip }, async () => {
  const a = await anna();
  const i = await irina();

  const created = await app.inject({
    method: 'POST', url: '/api/feed',
    headers: { cookie: a.cookie },
    payload: {
      propertyId: a.propertyId,
      title: 'Продам детский велосипед',
      body: '4–6 лет, состояние хорошее, 3 000 ₽',
      contact: '+7 999 507-22-38',
    },
  });
  assert.equal(created.statusCode, 201);

  const feed = await app.inject({
    method: 'GET', url: '/api/feed?category=market', headers: { cookie: i.cookie },
  });
  assert.equal(feed.json().posts.length, 1);
  assert.equal(feed.json().posts[0].author, 'Смирнова Анна');
  assert.equal(feed.json().posts[0].contact, '+7 999 507-22-38');
});

/**
 * Контакт в объявлении соседа: подтверждённый телефон и ник MAX автора.
 * Номер берётся из профиля в момент показа, флаг лежит у объявления.
 */
test('сосед делится подтверждённым телефоном, соседи видят его и ник MAX', { skip }, async () => {
  const { appUser } = await import('../../db/schema.ts');
  const a = await anna();
  const i = await irina();
  const publish = (sharePhone: boolean, title: string) => app.inject({
    method: 'POST', url: '/api/feed',
    headers: { cookie: a.cookie },
    payload: { propertyId: a.propertyId, title, body: 'Состояние хорошее, 3 000 ₽', sharePhone },
  });

  const unverified = await publish(true, 'Продам велосипед');
  assert.equal(unverified.statusCode, 400, 'без подтверждённого телефона делиться нечем');
  assert.equal(unverified.json().error, 'phone_not_verified');

  await testDb().update(appUser)
    .set({ phone: '+79995072238', phoneVerifiedAt: new Date(), maxUsername: 'anna_s' })
    .where(eq(appUser.maxUserId, 90001));

  assert.equal((await publish(true, 'Продам велосипед')).statusCode, 201);
  assert.equal((await publish(false, 'Отдам коляску')).statusCode, 201);

  const feed = (await app.inject({ method: 'GET', url: '/api/feed?category=market', headers: { cookie: i.cookie } })).json().posts;
  const bike = feed.find((p: { title: string }) => p.title === 'Продам велосипед');
  const pram = feed.find((p: { title: string }) => p.title === 'Отдам коляску');
  assert.equal(bike.phone, '+79995072238');
  assert.equal(bike.maxUsername, 'anna_s');
  assert.equal(bike.mine, false);
  assert.equal(pram.phone, null, 'не поделилась — телефона нет');
  assert.equal(pram.maxUsername, null);

  const own = (await app.inject({ method: 'GET', url: '/api/feed?category=market', headers: { cookie: a.cookie } })).json().posts;
  assert.equal(own.find((p: { title: string }) => p.title === 'Продам велосипед').mine, true);

  // Убрала номер из профиля — объявление больше его не показывает
  await testDb().update(appUser).set({ phoneVerifiedAt: null }).where(eq(appUser.maxUserId, 90001));
  const after = (await app.inject({ method: 'GET', url: '/api/feed?category=market', headers: { cookie: i.cookie } })).json().posts;
  assert.equal(after.find((p: { title: string }) => p.title === 'Продам велосипед').phone, null);
});

test('диспетчер не публикует в чужой дом', { skip }, async () => {
  const far = await otherHouse();
  await anna();
  const dispCookie = await loginDispatcher();

  // Дом Петра обслуживает та же УК по данным квитанции, поэтому берём
  // заведомо несуществующий ключ
  const res = await app.inject({
    method: 'POST', url: '/api/dispatcher/posts',
    headers: { cookie: dispCookie },
    payload: { houseKey: 'выдуманный-ключ', category: 'news', title: 'Тест', body: 'Текст тут' },
  });
  assert.equal(res.statusCode, 403);
  assert.ok(far.propertyId);
});

test('опрос: результаты скрыты до голоса', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();

  const created = await app.inject({
    method: 'POST', url: '/api/dispatcher/polls',
    headers: { cookie: dispCookie },
    payload: {
      houseKey: await houseKeyOf(a.propertyId),
      title: 'Установка шлагбаума',
      options: ['За', 'Против', 'Воздержался'],
    },
  });
  assert.equal(created.statusCode, 201);
  const pollId = created.json().id;

  // До голосования цифр не видно — иначе первые ответы тянут остальные
  const before = await app.inject({
    method: 'GET', url: `/api/polls/${pollId}`, headers: { cookie: a.cookie },
  });
  assert.equal(before.json().showResults, false);
  assert.equal(before.json().options[0].votes, null);
  assert.match(before.json().legalNotice, /Юридической силы/);

  const voted = await app.inject({
    method: 'POST', url: `/api/polls/${pollId}/vote`,
    headers: { cookie: a.cookie },
    payload: { optionId: before.json().options[0].id },
  });
  assert.equal(voted.statusCode, 200);
  assert.equal(voted.json().showResults, true);
  assert.equal(voted.json().options[0].votes, 1);
  assert.equal(voted.json().options[0].percent, 100);

  // Ирина ещё не голосовала — ей цифр не показываем
  const irinaView = await app.inject({
    method: 'GET', url: `/api/polls/${pollId}`, headers: { cookie: i.cookie },
  });
  assert.equal(irinaView.json().showResults, false);
});

test('один человек — один голос, повторный выбор переставляет', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  const created = await app.inject({
    method: 'POST', url: '/api/dispatcher/polls',
    headers: { cookie: dispCookie },
    payload: {
      houseKey: await houseKeyOf(a.propertyId),
      title: 'Шлагбаум', options: ['За', 'Против'],
    },
  });
  const pollId = created.json().id;
  const poll = await app.inject({
    method: 'GET', url: `/api/polls/${pollId}`, headers: { cookie: a.cookie },
  });
  const [za, protiv] = poll.json().options;

  await app.inject({
    method: 'POST', url: `/api/polls/${pollId}/vote`,
    headers: { cookie: a.cookie }, payload: { optionId: za.id },
  });
  const second = await app.inject({
    method: 'POST', url: `/api/polls/${pollId}/vote`,
    headers: { cookie: a.cookie }, payload: { optionId: protiv.id },
  });

  assert.equal(second.json().total, 1, 'голос переставлен, а не добавлен');
  assert.equal(second.json().options.find((o: any) => o.id === protiv.id).votes, 1);
  assert.equal(second.json().options.find((o: any) => o.id === za.id).votes, 0);
});

test('опрос с одним вариантом не создаётся', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  const res = await app.inject({
    method: 'POST', url: '/api/dispatcher/polls',
    headers: { cookie: dispCookie },
    payload: { houseKey: await houseKeyOf(a.propertyId), title: 'Так себе опрос', options: ['За'] },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().message, /два варианта/);
});

test('в чужом доме голосовать нельзя', { skip }, async () => {
  const a = await anna();
  const far = await otherHouse();
  const dispCookie = await loginDispatcher();

  const created = await app.inject({
    method: 'POST', url: '/api/dispatcher/polls',
    headers: { cookie: dispCookie },
    payload: {
      houseKey: await houseKeyOf(a.propertyId),
      title: 'Шлагбаум', options: ['За', 'Против'],
    },
  });

  const res = await app.inject({
    method: 'GET', url: `/api/polls/${created.json().id}`, headers: { cookie: far.cookie },
  });
  assert.equal(res.statusCode, 404, 'чужой опрос даже не виден');
});

test('кабинет показывает, кто из жильцов зарегистрировался', { skip }, async () => {
  await anna();
  await irina();
  const dispCookie = await loginDispatcher();

  const res = await app.inject({
    method: 'GET', url: '/api/dispatcher/accounts', headers: { cookie: dispCookie },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().total, 2);
  assert.equal(res.json().registered, 2);

  const flats = res.json().accounts.map((a: any) => a.flat).sort();
  assert.deepEqual(flats, ['15', '33']);
  assert.equal(res.json().accounts[0].residents[0].role, 'owner');
});

/* ─────────────── председатель совета дома ─────────────── */

/**
 * Три уровня доступа: житель — председатель — УК.
 *
 * Председатель ведёт жизнь СВОЕГО дома: объявления и опросы. К заявкам
 * не допущен: их разбирает УК, у которой подрядчики и ответственность
 * за срок. Учётку заводит УК — так же, как в жизни право председателя
 * подтверждается протоколом собрания, а не заявлением самого человека.
 */

/**
 * УК назначает председателем ЖИТЕЛЯ дома.
 *
 * Пароля больше нет: председатель входит своим обычным аккаунтом,
 * а раздел «Совет дома» просто появляется у него в приложении.
 * Выбирать УК может из всех, кто предъявил квитанцию по этому дому, —
 * включая неподтверждённых, иначе выбирать не из кого.
 */
async function appointChairman(dispCookie: string, houseKey: string, userId: string) {
  return app.inject({
    method: 'POST', url: '/api/dispatcher/chairmen',
    headers: { cookie: dispCookie },
    payload: { houseKey, userId },
  });
}

/** Идентификатор жителя по его сессии. */
async function userIdOf(cookie: string): Promise<string> {
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return me.json().user.id;
}

test('УК назначает председателем жителя дома, без всякого пароля', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);

  // Кандидаты — те, кто предъявил квитанцию по этому дому
  const candidates = await app.inject({
    method: 'GET', url: `/api/dispatcher/chairman-candidates?houseKey=${houseKey}`,
    headers: { cookie: dispCookie },
  });
  assert.equal(candidates.statusCode, 200);
  assert.ok(candidates.json().candidates.length > 0, 'выбирать есть из кого');

  const created = await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().password, undefined, 'пароля больше нет и быть не должно');

  const list = await app.inject({
    method: 'GET', url: '/api/dispatcher/chairmen', headers: { cookie: dispCookie },
  });
  assert.equal(list.json().chairmen.length, 1);
  assert.equal(list.json().chairmen[0].active, true);

  // Раздел «Совет дома» появился у жителя в его же сессии
  const me = await app.inject({
    method: 'GET', url: '/api/chairman/me', headers: { cookie: a.cookie },
  });
  assert.equal(me.json().isChairman, true);
  assert.equal(me.json().houses.length, 1);
});

test('второго действующего председателя на дом не назначить', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);

  const i = await irina();
  await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));
  const second = await appointChairman(dispCookie, houseKey, await userIdOf(i.cookie));
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'already_exists');
});

test('председателя чужого дома УК не назначает', { skip }, async () => {
  const far = await otherHouse();
  await anna();
  const dispCookie = await loginDispatcher();

  // Другая УК с другим домом
  // Чужая УК: своя организация в реестре и СВОЙ дом, а не наш
  const otherUk = await seedOrg(['344038, Ростовская обл, г Ростов-на-Дону, ул Чужая, д. 1'], '97');
  await testDb().insert(dispatcher).values({
    id: newId('dsp'), orgId: otherUk, login: 'other',
    passwordHash: await hashPassword('secret'), name: 'Чужой',
  });
  const otherLogin = await app.inject({
    method: 'POST', url: '/api/dispatcher/login',
    payload: { login: 'other', password: 'secret' },
  });

  const farUser = await userIdOf(far.cookie);
  const res = await appointChairman(cookieFrom(otherLogin), await houseKeyOf(far.propertyId), farUser);
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'foreign_house');

  // А своя УК — назначает
  const ok = await appointChairman(dispCookie, await houseKeyOf(far.propertyId), farUser);
  assert.equal(ok.statusCode, 201);
});

test('ПЕТЛЯ: председатель публикует объявление дома, жильцы видят подпись', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();

  await appointChairman(dispCookie, await houseKeyOf(a.propertyId), await userIdOf(a.cookie));
  // Председатель входит своей же сессией жителя — второго входа нет
  const chair = { cookie: a.cookie };

  const posted = await app.inject({
    method: 'POST', url: '/api/chairman/posts',
    headers: { cookie: chair.cookie },
    payload: {
      category: 'meeting',
      title: 'Собрание жильцов в субботу',
      body: 'Во дворе в 12:00 обсуждаем детскую площадку',
    },
  });
  assert.equal(posted.statusCode, 201);

  for (const [name, cookie] of [['Анна', a.cookie], ['Ирина', i.cookie]] as const) {
    const feed = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie } });
    const found = feed.json().posts.find((p: { title: string }) => /Собрание/.test(p.title));
    assert.ok(found, `${name} должна видеть объявление председателя`);
    assert.match(found.author, /Председатель совета дома/);
    assert.match(found.author, /Смирнова Анна/);
  }
});

test('аварийное объявление председателя будит дом уведомлением', { skip }, async () => {
  const a = await anna();
  await irina();
  const dispCookie = await loginDispatcher();
  await appointChairman(dispCookie, await houseKeyOf(a.propertyId), await userIdOf(a.cookie));
  const chair = { cookie: a.cookie };

  const res = await app.inject({
    method: 'POST', url: '/api/chairman/posts',
    headers: { cookie: chair.cookie },
    payload: { category: 'outage', title: 'Прорвало трубу', body: 'Воды не будет до вечера' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().notified, 2, 'оба жильца дома получают уведомление');
});

test('председатель не ведёт очередь УК и не меняет статус', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  await appointChairman(dispCookie, await houseKeyOf(a.propertyId), await userIdOf(a.cookie));
  const chair = { cookie: a.cookie };

  const request = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: a.cookie },
    payload: { propertyId: a.propertyId, category: 'Другое', description: 'Что-то сломалось в подъезде' },
  });

  // Очередь УК председателю не отдаётся
  const queue = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests', headers: { cookie: chair.cookie },
  });
  assert.equal(queue.statusCode, 401);

  const change = await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${request.json().id}/status`,
    headers: { cookie: chair.cookie }, payload: { status: 'done' },
  });
  assert.equal(change.statusCode, 401, 'смена статуса заявки — только УК');
});

test('председатель ведёт только свой дом', { skip }, async () => {
  const a = await anna();
  const far = await otherHouse();
  const dispCookie = await loginDispatcher();

  await appointChairman(dispCookie, await houseKeyOf(a.propertyId), await userIdOf(a.cookie));
  const chair = { cookie: a.cookie };

  await app.inject({
    method: 'POST', url: '/api/chairman/posts',
    headers: { cookie: chair.cookie },
    payload: { category: 'news', title: 'Новость дома', body: 'Покрасили подъезд' },
  });

  const feed = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie: far.cookie } });
  assert.equal(feed.json().posts.length, 0, 'чужой дом объявления не видит');
});

test('снятый председатель теряет права немедленно', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  const created = await appointChairman(
    dispCookie, await houseKeyOf(a.propertyId), await userIdOf(a.cookie),
  );

  const before = await app.inject({
    method: 'GET', url: '/api/chairman/me', headers: { cookie: a.cookie },
  });
  assert.equal(before.json().isChairman, true);

  const revoked = await app.inject({
    method: 'POST', url: `/api/dispatcher/chairmen/${created.json().id}/revoke`,
    headers: { cookie: dispCookie }, payload: {},
  });
  assert.equal(revoked.statusCode, 200);

  /**
   * Гасить сессию не нужно и нечего.
   *
   * Права председателя проверяются по таблице `chairman` на КАЖДОМ
   * запросе, а не зашиваются в сессию при входе, — поэтому снятие
   * закрывает доступ той же секундой само по себе. Раньше здесь была
   * отдельная сессия председателя, и её приходилось убивать руками.
   */
  const after = await app.inject({
    method: 'GET', url: '/api/chairman/me', headers: { cookie: a.cookie },
  });
  assert.equal(after.json().isChairman, false, 'права снялись');

  const posted = await app.inject({
    method: 'POST', url: '/api/chairman/posts', headers: { cookie: a.cookie },
    payload: { category: 'news', title: 'Уже нельзя', body: 'Больше не председатель' },
  });
  assert.equal(posted.statusCode, 403);

  // А жителем он остался: своя квартира на месте
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: a.cookie } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().properties.length, 1);
});

/**
 * Дом можно передать другому жителю: снять одного, назначить второго.
 * Прежний путь «сбросить пароль» исчез вместе с паролями.
 */
test('после снятия УК назначает другого жителя', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);

  const first = await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));
  await app.inject({
    method: 'POST', url: `/api/dispatcher/chairmen/${first.json().id}/revoke`,
    headers: { cookie: dispCookie }, payload: {},
  });

  const second = await appointChairman(dispCookie, houseKey, await userIdOf(i.cookie));
  assert.equal(second.statusCode, 201);

  const meA = await app.inject({
    method: 'GET', url: '/api/chairman/me', headers: { cookie: a.cookie },
  });
  const meI = await app.inject({
    method: 'GET', url: '/api/chairman/me', headers: { cookie: i.cookie },
  });
  assert.equal(meA.json().isChairman, false);
  assert.equal(meI.json().isChairman, true);
});

/* ─────────────── кто что публикует ─────────────── */

/**
 * Разделение досок.
 *
 * «Соседи предлагают» — доска жителей: «продам велосипед», «ищу репетитора».
 * «Объявления дома» — голос дома: отключения, собрания, новости. Житель туда
 * писать не может, иначе объявление от соседа неотличимо от объявления УК.
 */
test('житель публикует только в доску соседей', { skip }, async () => {
  const a = await anna();

  const created = await app.inject({
    method: 'POST', url: '/api/feed', headers: { cookie: a.cookie },
    payload: {
      propertyId: a.propertyId,
      title: 'Отключение воды',
      body: 'Пытаюсь выдать себя за УК',
      category: 'outage',
    },
  });
  assert.equal(created.statusCode, 201);

  const feed = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie: a.cookie } });
  const post = feed.json().posts[0];
  assert.equal(post.category, 'market', 'категорию задаёт сервер, а не житель');
  assert.equal(post.type, 'resident');
  assert.notEqual(post.author, 'Управляющая компания');
});

test('председатель не публикует в доску соседей', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  await appointChairman(dispCookie, await houseKeyOf(a.propertyId), await userIdOf(a.cookie));
  const chair = { cookie: a.cookie };

  const res = await app.inject({
    method: 'POST', url: '/api/chairman/posts',
    headers: { cookie: chair.cookie },
    payload: { category: 'market', title: 'Продам велосипед', body: 'Почти новый' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'bad_category');
});

/* ─────────────── срок жизни объявления ─────────────── */

test('истёкшее объявление помечено, а не выдаётся за актуальное', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);

  await app.inject({
    method: 'POST', url: '/api/dispatcher/posts', headers: { cookie: dispCookie },
    payload: {
      houseKey, category: 'outage', title: 'Отключение воды',
      body: 'Сегодня с 14:00 до 18:00',
      expiresAt: new Date(Date.now() - 3600_000).toISOString(),
    },
  });

  const feed = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie: a.cookie } });
  assert.equal(feed.json().posts.length, 1, 'из ленты не пропадает — это история дома');
  assert.equal(feed.json().posts[0].expired, true);
});

test('снятое объявление пропадает из ленты жителя', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);

  const created = await app.inject({
    method: 'POST', url: '/api/dispatcher/posts', headers: { cookie: dispCookie },
    payload: { houseKey, category: 'outage', title: 'Отключение воды', body: 'Ошиблись домом' },
  });

  const removed = await app.inject({
    method: 'DELETE', url: `/api/dispatcher/posts/${created.json().id}`,
    headers: { cookie: dispCookie },
  });
  assert.equal(removed.statusCode, 200);

  const feed = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie: a.cookie } });
  assert.equal(feed.json().posts.length, 0);

  // У того, кто публикует, снятое остаётся видно
  const managed = await app.inject({
    method: 'GET', url: '/api/dispatcher/posts', headers: { cookie: dispCookie },
  });
  assert.equal(managed.json().posts.length, 1);
  assert.equal(managed.json().posts[0].removed, true);
});

test('чужое объявление председатель снять не может', { skip }, async () => {
  const a = await anna();
  const far = await otherHouse();
  const dispCookie = await loginDispatcher();

  await appointChairman(dispCookie, await houseKeyOf(a.propertyId), await userIdOf(a.cookie));
  const chair = { cookie: a.cookie };

  const foreign = await app.inject({
    method: 'POST', url: '/api/dispatcher/posts', headers: { cookie: dispCookie },
    payload: {
      houseKey: await houseKeyOf(far.propertyId),
      category: 'news', title: 'Новость чужого дома', body: 'Не твоё дело',
    },
  });

  const res = await app.inject({
    method: 'DELETE', url: `/api/chairman/posts/${foreign.json().id}`,
    headers: { cookie: chair.cookie },
  });
  assert.equal(res.statusCode, 404);
});

test('опрос председателя виден жильцам и считает голоса', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();
  await appointChairman(dispCookie, await houseKeyOf(a.propertyId), await userIdOf(a.cookie));
  const chair = { cookie: a.cookie };

  const poll = await app.inject({
    method: 'POST', url: '/api/chairman/polls', headers: { cookie: chair.cookie },
    payload: {
      title: 'Ставим ли качели во дворе',
      options: ['За', 'Против'],
    },
  });
  assert.equal(poll.statusCode, 201);

  const list = await app.inject({ method: 'GET', url: '/api/polls', headers: { cookie: i.cookie } });
  const mine = list.json().polls.find((p: { id: string }) => p.id === poll.json().id);
  assert.ok(mine, 'сосед видит опрос председателя');

  const optionId = mine.options[0].id;
  await app.inject({
    method: 'POST', url: `/api/polls/${poll.json().id}/vote`,
    headers: { cookie: i.cookie }, payload: { optionId },
  });

  const forChair = await app.inject({
    method: 'GET', url: '/api/chairman/polls', headers: { cookie: chair.cookie },
  });
  const seen = forChair.json().polls.find((p: { id: string }) => p.id === poll.json().id);
  assert.equal(seen.total, 1);
  assert.equal(seen.byChairman, true);
});

/**
 * Дом без управляющей организации — ТСЖ, непосредственное управление,
 * частный дом — раньше не мог завести опрос: `poll.org_id` был notNull,
 * а назначить председателя такому дому мог только оператор напрямую
 * (см. lib/house/chairman.ts, kind: 'operator'), в обход УК-диспетчера.
 * Совет дома обязан работать и здесь — это и проверяем.
 */
test('председатель дома без управляющей организации заводит опрос', { skip }, async () => {
  const { createChairman } = await import('../../lib/house/chairman.ts');

  // Реестр НЕ заводим: объект жителя останется без управляющей организации
  const houseAddress = '344038, Ростовская обл, г Ростов-на-Дону, ул Без УК, д. 9';
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(90020, 'Фёдор', 'Одинцов') },
    payload: { qr: qr({ last: 'Одинцов', first: 'Фёдор', flat: '4', persAcc: '3330004', house: houseAddress }) },
  });
  const cookie = cookieFrom(res);
  await grantAccess();
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const houseKey = await houseKeyOf(me.json().properties[0].propertyId);

  const appointed = await createChairman(testDb(), {
    houseKey, userId: await userIdOf(cookie), by: { kind: 'operator', who: 'владелец' },
  });
  assert.ok(appointed.ok, 'дом без УК тоже может получить председателя');

  const created = await app.inject({
    method: 'POST', url: '/api/chairman/polls', headers: { cookie },
    payload: { title: 'Нанимаем ли дворника вскладчину', options: ['За', 'Против'] },
  });
  assert.equal(created.statusCode, 201, JSON.stringify(created.json()));

  const list = await app.inject({ method: 'GET', url: '/api/polls', headers: { cookie } });
  const mine = list.json().polls.find((p: { id: string }) => p.id === created.json().id);
  assert.ok(mine, 'опрос дома без УК виден жителям как любой другой');
});

/**
 * Две доски, а не одна лента с фильтром.
 *
 * «Объявления дома» — голос дома: отключения, собрания, новости от УК
 * и председателя. «Соседи предлагают» — доска жителей. Рядом с объявлением
 * УК «продам велосипед» обесценивает первое, а объявление соседа начинает
 * выглядеть официальным.
 */
test('доска дома и доска соседей не смешиваются', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);

  await app.inject({
    method: 'POST', url: '/api/dispatcher/posts', headers: { cookie: dispCookie },
    payload: { houseKey, category: 'news', title: 'Покрасили подъезд', body: 'Работы завершены' },
  });
  await app.inject({
    method: 'POST', url: '/api/feed', headers: { cookie: a.cookie },
    payload: { propertyId: a.propertyId, title: 'Продам велосипед', body: 'Почти новый, детский' },
  });

  const house = await app.inject({
    method: 'GET', url: '/api/feed?scope=house', headers: { cookie: a.cookie },
  });
  assert.equal(house.json().posts.length, 1);
  assert.equal(house.json().posts[0].title, 'Покрасили подъезд');

  const market = await app.inject({
    method: 'GET', url: '/api/feed?scope=market', headers: { cookie: a.cookie },
  });
  assert.equal(market.json().posts.length, 1);
  assert.equal(market.json().posts[0].category, 'market');

  // Без scope приходит всё: главному экрану нужен один запрос
  const all = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie: a.cookie } });
  assert.equal(all.json().posts.length, 2);
});

/**
 * Адрес, указанный жителем, сверяет УК.
 *
 * Обещание «управляющая компания подтвердит» должно чем-то заканчиваться:
 * иначе интерфейс говорит жителю то, чего в системе не происходит.
 */
test('УК видит несверенный адрес и подтверждает его', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();

  const accounts = await app.inject({
    method: 'GET', url: '/api/dispatcher/accounts', headers: { cookie: dispCookie },
  });
  assert.equal(accounts.statusCode, 200);

  /**
   * Кабинет показывает ОБЪЕКТЫ со списком лицевых счетов, а не строку
   * на каждый счёт: у квартиры их бывает четыре, и дом на сотню квартир
   * превратился бы в четыре сотни строк.
   */
  const mine = accounts.json().accounts.find(
    (x: { accounts: { persAcc: string }[] }) =>
      x.accounts.some((a) => a.persAcc === '4460153'),
  );
  assert.ok(mine, 'объект жителя должен быть в списке УК');
  assert.equal(mine.addressSource, 'receipt', 'адрес пришёл из квитанции');

  // Помечаем адрес как выбранный жителем — так выглядит слепая квитанция
  const { property } = await import('../../db/schema.ts');
  await testDb().update(property)
    .set({ addressSource: 'resident' })
    .where(eq(property.id, a.propertyId));

  const before = await app.inject({
    method: 'GET', url: '/api/dispatcher/accounts', headers: { cookie: dispCookie },
  });
  const pending = before.json().accounts.find(
    (x: { accounts: { persAcc: string }[] }) =>
      x.accounts.some((a) => a.persAcc === '4460153'),
  );
  assert.equal(pending.addressSource, 'resident');
  assert.equal(pending.addressVerified, false);

  const verified = await app.inject({
    method: 'POST', url: `/api/dispatcher/properties/${a.propertyId}/verify-address`,
    headers: { cookie: dispCookie }, payload: {},
  });
  assert.equal(verified.statusCode, 200);

  const after = await app.inject({
    method: 'GET', url: '/api/dispatcher/accounts', headers: { cookie: dispCookie },
  });
  const done = after.json().accounts.find(
    (x: { accounts: { persAcc: string }[] }) =>
      x.accounts.some((a) => a.persAcc === '4460153'),
  );
  assert.equal(done.addressSource, 'uk');
  assert.equal(done.addressVerified, true);

  // И житель видит это у себя
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: a.cookie } });
  assert.equal(me.json().properties[0].addressSource, 'uk');
});

test('чужой объект УК не подтверждает', { skip }, async () => {
  const far = await otherHouse();
  await anna();

  const otherUk = await seedOrg(['344038, Ростовская обл, г Ростов-на-Дону, ул Третья, д. 1'], '96');
  await testDb().insert(dispatcher).values({
    id: newId('dsp'), orgId: otherUk, login: 'third',
    passwordHash: await hashPassword('secret'), name: 'Чужой',
  });
  const login = await app.inject({
    method: 'POST', url: '/api/dispatcher/login',
    payload: { login: 'third', password: 'secret' },
  });

  const res = await app.inject({
    method: 'POST', url: `/api/dispatcher/properties/${far.propertyId}/verify-address`,
    headers: { cookie: cookieFrom(login) }, payload: {},
  });
  assert.equal(res.statusCode, 404);
});

/* ─────────────── УК добавляет дом руками ─────────────── */

/**
 * Реестр ГИС ЖКХ покрывает не всё.
 *
 * Треть организаций не отдаёт свои дома, а смена управляющей компании
 * доходит до реестра неделями. Без ручного ввода жители таких домов
 * остаются без УК, хотя компания уже работает в сервисе.
 */
test('УК добавляет свой дом вручную, и жители попадают к ней', { skip }, async () => {
  const dispCookie = await loginDispatcher();
  const address = '344038, Ростовская обл, г Ростов-на-Дону, ул Новая, д. 7';

  const added = await app.inject({
    method: 'POST', url: '/api/dispatcher/houses',
    headers: { cookie: dispCookie }, payload: { address },
  });
  assert.equal(added.statusCode, 201);
  assert.equal(added.json().alreadyMine, false);

  const houses = await app.inject({
    method: 'GET', url: '/api/dispatcher/houses', headers: { cookie: dispCookie },
  });
  assert.ok(
    houses.json().houses.some((h: { address: string }) => /ул Новая, д\. 7/.test(h.address)),
    'дом появился в фонде организации',
  );
});

/**
 * Житель, пришедший РАНЬШЕ, чем УК добавила дом, догоняется сразу.
 *
 * Иначе он остался бы без управляющей организации до следующего скана
 * квитанции — то есть, скорее всего, навсегда.
 */
test('добавление дома догоняет жителей, пришедших раньше', { skip }, async () => {
  const dispCookie = await loginDispatcher();

  /**
   * Житель входит НАПРЯМУЮ, без фикстуры реестра: его дома в реестре нет,
   * ровно как у трети организаций ГИС ЖКХ.
   */
  const orphanHouse = '344038, Ростовская обл, г Ростов-на-Дону, ул Ничейная, д 3';
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(90077, 'Павел', 'Ничейный') },
    payload: {
      qr: qr({ last: 'Ничейный', first: 'Павел', flat: '5', persAcc: '7770077', house: orphanHouse }),
    },
  });
  const far = { cookie: cookieFrom(res) };
  // Заявка заведена; доступ здесь фикстура — тест про догон реестра
  await grantAccess();

  const before = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: far.cookie },
  });
  assert.equal(before.json().properties[0].ukName, null, 'дома ещё нет в реестре');

  const added = await app.inject({
    method: 'POST', url: '/api/dispatcher/houses',
    headers: { cookie: dispCookie },
    payload: { address: orphanHouse },
  });
  assert.equal(added.statusCode, 201);

  const after = await app.inject({
    method: 'GET', url: '/api/me', headers: { cookie: far.cookie },
  });
  assert.ok(after.json().properties[0].ukName, 'управляющая организация подтянулась');
});

test('чужой дом забрать нельзя', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();

  // Вторая УК пытается забрать дом первой
  const otherOrg = await seedOrg(['344038, Ростовская обл, г Ростов-на-Дону, ул Пустая, д. 2'], '95');
  await testDb().insert(dispatcher).values({
    id: newId('dsp'), orgId: otherOrg, login: 'greedy',
    passwordHash: await hashPassword('secret'), name: 'Чужой',
  });
  const login = await app.inject({
    method: 'POST', url: '/api/dispatcher/login',
    payload: { login: 'greedy', password: 'secret' },
  });

  const res = await app.inject({
    method: 'POST', url: '/api/dispatcher/houses',
    headers: { cookie: cookieFrom(login) },
    payload: { address: HOUSE },
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'taken');
  assert.match(res.json().message, /закреплён за/);

  // И дом остался у первой
  const houses = await app.inject({
    method: 'GET', url: '/api/dispatcher/houses', headers: { cookie: dispCookie },
  });
  assert.ok(houses.json().houses.some((h: { address: string }) => h.address === HOUSE));
  void a;
});

/**
 * Дом, который оператор отдал другой организации, тоже чужой.
 *
 * Находка аудита 26 сентября: проверка смотрела только на реестровую
 * УК. Дом ТСЖ, закреплённый оператором (человеческий слой `org_id`),
 * у которого реестровой УК нет, любая УК забирала себе одной формой.
 */
test('дом, закреплённый оператором за ТСЖ, УК не забирает', { skip }, async () => {
  const dispCookie = await loginDispatcher();
  const { managingOrg, house } = await import('../../db/schema.ts');
  const { parseAddress } = await import('../../lib/address/normalize.ts');

  const address = '344038, Ростовская обл, г Ростов-на-Дону, ул Товарищеская, д. 5';
  const key = parseAddress(address).houseKey!;
  const [tsz] = await testDb().insert(managingOrg).values({
    id: newId('org'), inn: '6100000777', name: 'ТСЖ «Товарищеская 5»', regionCode: '61',
  }).returning({ id: managingOrg.id });
  await testDb().insert(house).values({
    houseKey: key, addressRaw: address, form: 'tsj', orgId: tsz.id, source: 'operator',
  });

  const res = await app.inject({
    method: 'POST', url: '/api/dispatcher/houses',
    headers: { cookie: dispCookie }, payload: { address },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'taken');
});

test('адрес без номера дома не принимается', { skip }, async () => {
  const dispCookie = await loginDispatcher();

  const res = await app.inject({
    method: 'POST', url: '/api/dispatcher/houses',
    headers: { cookie: dispCookie },
    payload: { address: 'Ростовская область, где-то там' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'bad_address');
});

/* ─────────────── дом без формы управления просит подключить его ─────────────── */

/**
 * Житель дома, которого нет в реестре лицензий.
 *
 * В отличие от anna()/irina() реестр НЕ заводим — у houseKey нет
 * реестрового слоя в house, ровно как у трети организаций ГИС ЖКХ. Форма дома
 * остаётся 'unknown': никто ещё не сказал, кто за домом стоит.
 */
async function residentWithoutUk(
  appInstance: typeof app,
  options: { confirm?: boolean } = {},
) {
  // По умолчанию привязку подтверждаем — фикстура нужна и тестам, которым
  // важен только сам объект, а не статус привязки. Но `confirm: false`
  // обязателен для теста ниже: смысл заявки «подключите дом» именно
  // в том, что её подаёт НЕПОДТВЕРЖДЁННЫЙ житель — подтверждать его
  // как раз некому, пока дома нет ни председателя, ни УК.
  const { confirm = true } = options;
  const houseAddress = '344038, Ростовская обл, г Ростов-на-Дону, ул Без Формы, д. 12';
  const res = await appInstance.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(90030, 'Глеб', 'Тихонов') },
    payload: {
      qr: qr({ last: 'Тихонов', first: 'Глеб', flat: '7', persAcc: '5550007', house: houseAddress }),
    },
  });
  const token = res.json().token;
  if (confirm) {
    // Заявка на доступ заведена; доступ здесь фикстура — тест не про модель доступа
    await grantAccess();
  }

  const me = await appInstance.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${token}` },
  });
  return { token, propertyId: me.json().properties[0].propertyId };
}

test('житель дома без управления просит подключить дом (привязка ещё не подтверждена)', { skip }, async () => {
  // Это и есть основной сценарий заявки: подтверждать привязку некому,
  // пока у дома нет ни председателя, ни УК, — а заявку подать нужно.
  const { token, propertyId } = await residentWithoutUk(app, { confirm: false });

  const res = await app.inject({
    method: 'POST',
    url: '/api/house/claim',
    headers: { authorization: `Bearer ${token}` },
    payload: { propertyId, note: 'У нас ТСЖ, УК никогда не было' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().created, true, 'неподтверждённый житель тоже вправе подать заявку');
});

test('житель дома без управления просит подключить дом (привязка подтверждена)', { skip }, async () => {
  const { token, propertyId } = await residentWithoutUk(app);

  const res = await app.inject({
    method: 'POST',
    url: '/api/house/claim',
    headers: { authorization: `Bearer ${token}` },
    payload: { propertyId, note: 'У нас ТСЖ, УК никогда не было' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().created, true);

  const again = await app.inject({
    method: 'POST',
    url: '/api/house/claim',
    headers: { authorization: `Bearer ${token}` },
    payload: { propertyId },
  });
  assert.equal(again.json().created, false, 'двойной тап не плодит заявок');
});

test('/api/me отдаёт состояние дома, а не только УК', { skip }, async () => {
  const { token } = await residentWithoutUk(app);

  const res = await app.inject({
    method: 'GET', url: '/api/me',
    headers: { authorization: `Bearer ${token}` },
  });

  const property = res.json().properties[0];
  assert.equal(property.houseManagement.form, 'unknown');
  assert.equal(property.houseManagement.hasChairman, false);
  assert.equal(property.houseManagement.canAskOperator, true, 'иначе житель в тупике');
});

/* ─────────────── обращения дома глазами председателя (задача 10) ─────────────── */

/**
 * Обнаружено при разборе задачи 3: экран жалобы обещал жителю дома без УК
 * «обращение увидит совет дома», а доступа для этого не было вовсе —
 * `requestScope`/`scopeAllows` в lib/requests/service.ts считают права
 * только по квартирам самого жителя. Здесь проверяется отдельный путь
 * председателя по `houseKey` (`listForHouse`/`getForHouse`/`addChairmanComment`).
 */

/**
 * Житель того же дома, чья привязка к квартире ещё НЕ подтверждена.
 *
 * В отличие от `login()` не вызывает `grantAccess()`: смысл теста —
 * убедиться, что председатель видит обращение именно НЕПОДТВЕРЖДЁННОГО
 * жителя, а грант его подтвердил бы раньше, чем заявка успеет что-то
 * проверить.
 */
async function pendingResident(opts: Parameters<typeof qr>[0], id: number) {
  await seedOrg([opts.house ?? HOUSE]);
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(id, opts.first, opts.last) },
    payload: { qr: qr(opts) },
  });
  const cookie = cookieFrom(res);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  return { cookie, propertyId: me.json().properties[0].propertyId };
}

/**
 * Председатель двух домов.
 *
 * Без `houseKey` сервер берёт первое председательство, и раздел
 * «Совет дома» раньше никогда не доходил до второго дома: его жители
 * ждали подтверждения, а председатель их не видел.
 */
test('председатель двух домов видит и подтверждает жителей второго дома по houseKey', { skip }, async () => {
  const { parseAddress } = await import('../../lib/address/normalize.ts');
  const OTHER = '344038, Ростовская обл, г Ростов-на-Дону, ул Совсем Другая, д 1';
  const otherKey = parseAddress(OTHER).houseKey;

  const a = await anna();
  await login({ last: 'Смирнова', first: 'Анна', flat: '5', persAcc: '5550005', house: OTHER }, 90001);
  const dispCookie = await loginDispatcher(await seedOrg([HOUSE, OTHER]));
  const userId = await userIdOf(a.cookie);
  assert.equal((await appointChairman(dispCookie, await houseKeyOf(a.propertyId), userId)).statusCode, 201);
  assert.equal((await appointChairman(dispCookie, otherKey, userId)).statusCode, 201);

  // Новый житель второго дома — без grantAccess: ждёт председателя
  const scan = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(90020, 'Олег', 'Новиков') },
    payload: { qr: qr({ last: 'Новиков', first: 'Олег', flat: '9', persAcc: '5550009', house: OTHER }) },
  });
  await app.inject({
    method: 'POST', url: `/api/properties/claims/${scan.json().bindingId}`,
    headers: { cookie: cookieFrom(scan) },
    payload: { name: 'Новиков Олег Иванович', flat: '9', note: 'живу с весны' },
  });

  const me = await app.inject({ method: 'GET', url: '/api/chairman/me', headers: { cookie: a.cookie } });
  assert.equal(me.json().houses.length, 2);

  const first = await app.inject({ method: 'GET', url: '/api/chairman/claims', headers: { cookie: a.cookie } });
  const second = await app.inject({
    method: 'GET', url: `/api/chairman/claims?houseKey=${encodeURIComponent(otherKey)}`, headers: { cookie: a.cookie },
  });
  assert.equal(
    first.json().claims.length + second.json().claims.length, 1,
    'житель второго дома в очереди ровно одного дома',
  );
  assert.equal(second.json().claims.length, 1, 'по houseKey видна очередь второго дома');

  const approved = await app.inject({
    method: 'POST', url: `/api/chairman/claims/${scan.json().bindingId}/approve`,
    headers: { cookie: a.cookie }, payload: { role: 'member', houseKey: otherKey },
  });
  assert.equal(approved.statusCode, 200);
});

test('председатель видит обращение соседней квартиры своего дома', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);
  await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: i.cookie },
    payload: { propertyId: i.propertyId, category: 'Сантехника', description: 'Течёт кран на кухне' },
  });
  assert.equal(created.statusCode, 201);

  const list = await app.inject({
    method: 'GET', url: '/api/chairman/requests', headers: { cookie: a.cookie },
  });
  assert.equal(list.statusCode, 200);
  assert.ok(
    list.json().requests.some((r: { id: string }) => r.id === created.json().id),
    'сосед по дому виден председателю',
  );

  const detail = await app.inject({
    method: 'GET', url: `/api/chairman/requests/${created.json().id}`, headers: { cookie: a.cookie },
  });
  assert.equal(detail.statusCode, 200);
  assert.match(detail.json().description, /Течёт кран/);
  assert.ok(detail.json().events.length > 0, 'переписка видна вместе с обращением');
  assert.equal(detail.json().hasOrg, true, 'председателя назначил диспетчер своей УК — она у дома есть');
});

/**
 * ДЕФЕКТ 5: экран совета дома писал «статус меняет только управляющая
 * компания» даже жителю дома, у которого УК нет вовсе, — и это была
 * неправда: статус не менял в таком доме никто. Карточка обращения обязана
 * честно сообщать председателю, есть ли у его дома УК (`hasOrg`).
 */
test('председателю дома без УК карточка обращения говорит об этом честно', { skip }, async () => {
  const { createChairman } = await import('../../lib/house/chairman.ts');

  // Реестр НЕ заводим: объект жителя останется без управляющей организации
  const houseAddress = '344038, Ростовская обл, г Ростов-на-Дону, ул Без Кабинета, д. 11';
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr',
    headers: { 'x-max-init-data': initData(90030, 'Олег', 'Скворцов') },
    payload: { qr: qr({ last: 'Скворцов', first: 'Олег', flat: '2', persAcc: '3330011', house: houseAddress }) },
  });
  const cookie = cookieFrom(res);
  await grantAccess();
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
  const propertyId = me.json().properties[0].propertyId;
  const houseKey = await houseKeyOf(propertyId);

  const appointed = await createChairman(testDb(), {
    houseKey, userId: await userIdOf(cookie), by: { kind: 'operator', who: 'владелец' },
  });
  assert.ok(appointed.ok, 'дом без УК тоже может получить председателя — через оператора');

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie },
    payload: { propertyId, category: 'Другое', description: 'Проверка честности карточки без УК' },
  });
  assert.equal(created.statusCode, 201, JSON.stringify(created.json()));

  const detail = await app.inject({
    method: 'GET', url: `/api/chairman/requests/${created.json().id}`, headers: { cookie },
  });
  assert.equal(
    detail.json().hasOrg, false,
    'дом без УК — статус не изменит никто, приложение обязано сказать это честно',
  );
});

test('председатель не видит обращение чужого дома', { skip }, async () => {
  const a = await anna();
  const far = await otherHouse();
  const dispCookie = await loginDispatcher();
  await appointChairman(dispCookie, await houseKeyOf(a.propertyId), await userIdOf(a.cookie));

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: far.cookie },
    payload: { propertyId: far.propertyId, category: 'Другое', description: 'Проблема в чужом доме' },
  });
  assert.equal(created.statusCode, 201);

  const list = await app.inject({
    method: 'GET', url: '/api/chairman/requests', headers: { cookie: a.cookie },
  });
  assert.equal(list.json().requests.length, 0, 'чужой дом не виден вовсе');

  const detail = await app.inject({
    method: 'GET', url: `/api/chairman/requests/${created.json().id}`, headers: { cookie: a.cookie },
  });
  assert.equal(detail.statusCode, 404);
});

test('председатель видит обращение, заведённое неподтверждённым жителем', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);
  await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));

  const pending = await pendingResident(
    { last: 'Гостев', first: 'Олег', flat: '47', persAcc: '4460447' }, 90050,
  );

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: pending.cookie },
    payload: { propertyId: pending.propertyId, category: 'Другое', description: 'Заявка от неподтверждённого' },
  });
  assert.equal(created.statusCode, 201, 'уровень 0: жалоба не ждёт подтверждения председателя');

  const list = await app.inject({
    method: 'GET', url: '/api/chairman/requests', headers: { cookie: a.cookie },
  });
  assert.ok(
    list.json().requests.some((r: { id: string }) => r.id === created.json().id),
    'обращение неподтверждённого жителя видно председателю — он и есть тот, кто подтверждает',
  );
});

test('ответ председателя появляется в переписке, и его видит автор', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);
  await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: i.cookie },
    payload: { propertyId: i.propertyId, category: 'Другое', description: 'Шумят соседи по вечерам' },
  });

  const commented = await app.inject({
    method: 'POST', url: `/api/chairman/requests/${created.json().id}/comment`,
    headers: { cookie: a.cookie }, payload: { text: 'Обсудим на собрании в субботу' },
  });
  assert.equal(commented.statusCode, 201);

  const seenByAuthor = await app.inject({
    method: 'GET', url: `/api/requests/${created.json().id}`, headers: { cookie: i.cookie },
  });
  const reply = seenByAuthor.json().events.find((e: { actor: string }) => e.actor === 'chairman');
  assert.ok(reply, 'автор видит ответ председателя в своей переписке');
  assert.match(reply.text, /Обсудим на собрании/);
  assert.equal(reply.actorName, 'Смирнова Анна');

  // Статус не поменялся: председатель не распоряжается заявками, это дело УК
  assert.equal(seenByAuthor.json().status, 'new');
});

/**
 * Регрессия задачи 2. Пометка «ход за УК» считалась как «последним
 * в переписке написал житель» — это работало, пока ролей было две.
 * С появлением председателя его ответ гасил пометку так же, как ответ
 * диспетчера, хотя управляющая компания по-прежнему не ответила.
 * Гасить пометку должен только диспетчер.
 */
test('ответ председателя не гасит пометку «ход за УК»', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);
  await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: i.cookie },
    payload: { propertyId: i.propertyId, category: 'Другое', description: 'Шумят соседи по вечерам' },
  });
  const requestId = created.json().id;

  // Житель дополняет обращение — и это сигнал «ход за УК»
  const residentReply = await app.inject({
    method: 'POST', url: `/api/requests/${requestId}/comment`,
    headers: { cookie: i.cookie }, payload: { text: 'Стало ещё громче, когда стемнело' },
  });
  assert.equal(residentReply.statusCode, 201);

  // Председатель отвечает словами — статусами и очередью УК он не распоряжается
  const chairmanReply = await app.inject({
    method: 'POST', url: `/api/chairman/requests/${requestId}/comment`,
    headers: { cookie: a.cookie }, payload: { text: 'Обсудим на собрании' },
  });
  assert.equal(chairmanReply.statusCode, 201);

  const queue = await app.inject({
    method: 'GET', url: '/api/dispatcher/requests', headers: { cookie: dispCookie },
  });
  const row = queue.json().requests.find((r: { id: string }) => r.id === requestId);
  assert.ok(row, 'обращение должно остаться в очереди УК');
  assert.equal(row.awaitingUk, true, 'ответ председателя не должен гасить пометку «ждёт УК»');

  const card = await app.inject({
    method: 'GET', url: `/api/dispatcher/requests/${requestId}`, headers: { cookie: dispCookie },
  });
  assert.equal(card.json().awaitingUk, true, 'то же самое должно быть видно в карточке заявки');
});

test('закрытому обращению председатель дописать не может', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);
  await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: i.cookie },
    payload: { propertyId: i.propertyId, category: 'Другое', description: 'Заявка на закрытие' },
  });

  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${created.json().id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'in_work' },
  });
  await app.inject({
    method: 'POST', url: `/api/dispatcher/requests/${created.json().id}/status`,
    headers: { cookie: dispCookie }, payload: { status: 'done' },
  });

  const commented = await app.inject({
    method: 'POST', url: `/api/chairman/requests/${created.json().id}/comment`,
    headers: { cookie: a.cookie }, payload: { text: 'Уже поздно отвечать' },
  });
  assert.equal(commented.statusCode, 409);
  assert.equal(commented.json().error, 'closed');
});

test('снятый председатель теряет доступ к обращениям дома', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);
  const appointed = await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: i.cookie },
    payload: { propertyId: i.propertyId, category: 'Другое', description: 'Что-то сломалось' },
  });

  const revoked = await app.inject({
    method: 'POST', url: `/api/dispatcher/chairmen/${appointed.json().id}/revoke`,
    headers: { cookie: dispCookie }, payload: {},
  });
  assert.equal(revoked.statusCode, 200);

  const list = await app.inject({
    method: 'GET', url: '/api/chairman/requests', headers: { cookie: a.cookie },
  });
  assert.equal(list.statusCode, 403);
  assert.equal(list.json().error, 'not_a_chairman');

  const detail = await app.inject({
    method: 'GET', url: `/api/chairman/requests/${created.json().id}`, headers: { cookie: a.cookie },
  });
  assert.equal(detail.statusCode, 403);

  const comment = await app.inject({
    method: 'POST', url: `/api/chairman/requests/${created.json().id}/comment`,
    headers: { cookie: a.cookie }, payload: { text: 'Уже нельзя' },
  });
  assert.equal(comment.statusCode, 403);
});

/**
 * Единственный новый маршрут доступа к файлам без своего теста
 * (задача 5). Вложения к обращению — фотографии из чужой квартиры,
 * и правило проекта такое: публичных ссылок у них нет, каждый запрос
 * файла проверяет, видно ли человеку само обращение. У `getForHouse`
 * это уже проверено для карточки обращения — здесь та же проверка
 * должна закрывать и сам файл.
 */
test('председатель скачивает вложение обращения своего дома', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);
  await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: i.cookie },
    payload: { propertyId: i.propertyId, category: 'Сантехника', description: 'Течёт кран на кухне' },
  });
  const requestId = created.json().id;

  const file = fileForm(PNG, 'протечка.png', 'image/png');
  const uploaded = await app.inject({
    method: 'POST', url: `/api/requests/${requestId}/files`,
    headers: { cookie: i.cookie, ...file.headers }, payload: file.payload,
  });
  assert.equal(uploaded.statusCode, 200);
  const fileId = uploaded.json().file.id;

  const got = await app.inject({
    method: 'GET',
    url: `/api/chairman/requests/${requestId}/files/${fileId}?houseKey=${houseKey}`,
    headers: { cookie: a.cookie },
  });
  assert.equal(got.statusCode, 200);
  assert.equal(got.headers['content-type'], 'image/png');
  assert.equal(got.rawPayload.length, PNG.length, 'файл отдаётся байт в байт');
});

test('председатель не получает вложение обращения чужого дома', { skip }, async () => {
  const a = await anna();
  const far = await otherHouse();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);
  await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));

  const created = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: far.cookie },
    payload: { propertyId: far.propertyId, category: 'Другое', description: 'Проблема в чужом доме' },
  });
  const requestId = created.json().id;

  const file = fileForm(PNG, 'фото.png', 'image/png');
  const uploaded = await app.inject({
    method: 'POST', url: `/api/requests/${requestId}/files`,
    headers: { cookie: far.cookie, ...file.headers }, payload: file.payload,
  });
  assert.equal(uploaded.statusCode, 200);
  const fileId = uploaded.json().file.id;

  const stolen = await app.inject({
    method: 'GET',
    url: `/api/chairman/requests/${requestId}/files/${fileId}?houseKey=${houseKey}`,
    headers: { cookie: a.cookie },
  });
  assert.equal(stolen.statusCode, 404, 'чужого обращения для председателя не существует');
});

/**
 * ПОТОЛОК ЛЕНТЫ ДОМА.
 *
 * За год дом накапливает больше сотни объявлений, и все они ехали одним
 * ответом — десять экранов прокрутки и лишний трафик там, где человек
 * читает две верхние карточки.
 */
test('лента отдаётся полусотней и говорит, сколько объявлений всего', { skip }, async () => {
  const a = await anna();
  const houseKey = await houseKeyOf(a.propertyId);

  for (let i = 1; i <= 60; i++) {
    await testDb().insert(post).values({
      id: newId('pst'),
      houseKey,
      type: 'uk',
      category: 'news',
      title: `Объявление ${i}`,
      body: 'Проверка потолка выдачи',
    });
  }

  const first = await app.inject({ method: 'GET', url: '/api/feed', headers: { cookie: a.cookie } });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().posts.length, 50, 'лента обрезана');
  assert.equal(first.json().total, 60, 'но сказано, сколько их всего');

  const more = await app.inject({
    method: 'GET', url: '/api/feed?limit=100', headers: { cookie: a.cookie },
  });
  assert.equal(more.json().posts.length, 60);

  /** Потолок считается ПОСЛЕ разделения досок, иначе счётчик соврёт */
  const houseOnly = await app.inject({
    method: 'GET', url: '/api/feed?scope=house', headers: { cookie: a.cookie },
  });
  assert.equal(houseOnly.json().total, 60, 'объявления соседей сюда не попадают');
});

/**
 * ПРЕДСЕДАТЕЛЬ ЗАХОДИТ РАЗ В НЕДЕЛЮ.
 *
 * Ему нужен экран «что сейчас горит», а не архив дома за год: свиток
 * на 359 строк без вкладок, поиска и потолка отвечал на вопрос
 * «что нового» только листанием двадцати восьми экранов.
 */
test('обращения дома: вкладки, поиск и потолок выдачи', { skip }, async () => {
  const a = await anna();
  const i = await irina();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);
  await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));
  const headers = { cookie: a.cookie };

  const open = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: i.cookie },
    payload: { propertyId: i.propertyId, category: 'Лифт', description: 'Лифт застрял между этажами' },
  });
  const closed = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: i.cookie },
    payload: { propertyId: i.propertyId, category: 'Сантехника', description: 'Течёт кран на кухне' },
  });
  // Из «принято» сразу в «выполнено» нельзя — сначала в работу
  for (const status of ['in_work', 'done']) {
    await app.inject({
      method: 'POST', url: `/api/dispatcher/requests/${closed.json().id}/status`,
      headers: { cookie: dispCookie }, payload: { status },
    });
  }

  const all = await app.inject({ method: 'GET', url: '/api/chairman/requests', headers });
  assert.equal(all.json().requests.length, 2);
  assert.equal(all.json().counts.all, 2);
  assert.equal(all.json().counts.open, 1, 'счётчики обеих вкладок приходят всегда');

  const onlyOpen = await app.inject({
    method: 'GET', url: '/api/chairman/requests?tab=open', headers,
  });
  assert.equal(onlyOpen.json().requests.length, 1);
  assert.equal(onlyOpen.json().requests[0].id, open.json().id);
  assert.equal(onlyOpen.json().counts.all, 2, 'счётчик «Все» не зависит от вкладки');

  // «Что было по 47-й квартире» — частый вопрос к председателю
  const byFlat = await app.inject({
    method: 'GET', url: '/api/chairman/requests?q=кв 33', headers,
  });
  assert.equal(byFlat.json().requests.length, 2, 'обе заявки из квартиры 33');

  const byWord = await app.inject({
    method: 'GET', url: '/api/chairman/requests?q=лифт', headers,
  });
  assert.equal(byWord.json().requests.length, 1);
  assert.equal(byWord.json().total, 1);

  const byNumber = await app.inject({
    method: 'GET', url: `/api/chairman/requests?q=${open.json().number}`, headers,
  });
  assert.equal(byNumber.json().requests.length, 1);

  const cut = await app.inject({ method: 'GET', url: '/api/chairman/requests?limit=1', headers });
  assert.equal(cut.json().requests.length, 1, 'потолок режет выдачу');
  assert.equal(cut.json().total, 2, 'но говорит, сколько их всего');
});

/**
 * Объявления в кабинетах тоже с потолком: за год их набирается больше
 * сотни, а форма публикации стоит НАД списком — диспетчеру, зашедшему
 * снять вчерашнее объявление, пришлось бы пролистать год.
 */
test('объявления кабинетов отдаются полусотней и считают все', { skip }, async () => {
  const a = await anna();
  const dispCookie = await loginDispatcher();
  const houseKey = await houseKeyOf(a.propertyId);
  await appointChairman(dispCookie, houseKey, await userIdOf(a.cookie));

  for (let i = 1; i <= 60; i++) {
    await app.inject({
      method: 'POST', url: '/api/dispatcher/posts',
      headers: { cookie: dispCookie },
      payload: { houseKey, category: 'news', title: `Новость ${i}`, body: 'Проверка потолка' },
    });
  }

  const uk = await app.inject({
    method: 'GET', url: '/api/dispatcher/posts', headers: { cookie: dispCookie },
  });
  assert.equal(uk.json().posts.length, 50);
  assert.equal(uk.json().total, 60);

  const chairman = await app.inject({
    method: 'GET', url: '/api/chairman/posts', headers: { cookie: a.cookie },
  });
  assert.equal(chairman.json().posts.length, 50);
  assert.equal(chairman.json().total, 60);

  const more = await app.inject({
    method: 'GET', url: '/api/chairman/posts?limit=100', headers: { cookie: a.cookie },
  });
  assert.equal(more.json().posts.length, 60);
});

/**
 * Фотография объявления.
 *
 * Проверяем две границы: приложить её можно только к своему объявлению,
 * и посмотреть — только тому, кому видно само объявление. Публичной
 * ссылки у фотографии нет, как и у вложений обращений.
 */
test('фотографию можно приложить только к своему объявлению', { skip }, async () => {
  const { cookie: annaCookie, propertyId } = await anna();
  const { cookie: irinaCookie } = await irina();

  const created = await app.inject({
    method: 'POST', url: '/api/feed', headers: { cookie: annaCookie },
    payload: { propertyId, title: 'Отдам велосипед', body: 'Колёса целы, стоит в подъезде' },
  });
  assert.equal(created.statusCode, 201);
  const postId = created.json().id;

  const form = fileForm(PNG, 'bike.png', 'image/png');

  // Соседка по дому объявление видит, но править его не может
  const stranger = await app.inject({
    method: 'POST', url: `/api/posts/${postId}/photo`,
    headers: { cookie: irinaCookie, ...form.headers }, payload: form.payload,
  });
  assert.equal(stranger.statusCode, 403, 'чужое объявление правит только его автор');

  const own = fileForm(PNG, 'bike.png', 'image/png');
  const mine = await app.inject({
    method: 'POST', url: `/api/posts/${postId}/photo`,
    headers: { cookie: annaCookie, ...own.headers }, payload: own.payload,
  });
  assert.equal(mine.statusCode, 200, 'своё — можно');

  // В ленте объявление теперь помечено как «с фотографией»
  const feed = await app.inject({
    method: 'GET', url: '/api/feed?scope=market', headers: { cookie: annaCookie },
  });
  assert.equal(feed.json().posts[0].hasPhoto, true);
});

test('фотография объявления не видна чужому дому', { skip }, async () => {
  const { cookie: annaCookie, propertyId } = await anna();
  const { cookie: farCookie } = await otherHouse();

  const created = await app.inject({
    method: 'POST', url: '/api/feed', headers: { cookie: annaCookie },
    payload: { propertyId, title: 'Отдам велосипед', body: 'Колёса целы, стоит в подъезде' },
  });
  const postId = created.json().id;

  const form = fileForm(PNG, 'bike.png', 'image/png');
  await app.inject({
    method: 'POST', url: `/api/posts/${postId}/photo`,
    headers: { cookie: annaCookie, ...form.headers }, payload: form.payload,
  });

  const foreign = await app.inject({
    method: 'GET', url: `/api/posts/${postId}/photo`, headers: { cookie: farCookie },
  });
  assert.equal(foreign.statusCode, 403, 'публичной ссылки у фотографии нет');

  const own = await app.inject({
    method: 'GET', url: `/api/posts/${postId}/photo`, headers: { cookie: annaCookie },
  });
  assert.equal(own.statusCode, 200);
  assert.equal(own.headers['content-type'], 'image/png');
});

/**
 * Непрочитанные объявления.
 *
 * Прочитано = человек ОТКРЫЛ карточку. Отметка по последнему визиту
 * объявляла бы прочитанными заголовки, которые он только пролистал.
 */
test('объявление считается прочитанным только после открытия', { skip }, async () => {
  const { cookie: annaCookie } = await anna();
  const { cookie: irinaCookie } = await irina();

  const [org] = await testDb().select().from(uk).limit(1);
  const postId = newId('pst');
  await testDb().insert(post).values({
    id: postId,
    houseKey: (await testDb().select().from(property).limit(1))[0].houseKey,
    type: 'uk',
    category: 'news',
    title: 'Покос травы во дворе',
    body: 'В четверг с утра во дворе будет работать техника',
  });

  const before = await app.inject({
    method: 'GET', url: '/api/feed?scope=house', headers: { cookie: annaCookie },
  });
  assert.equal(before.json().posts.find((p: { id: string }) => p.id === postId).unread, true);

  const marked = await app.inject({
    method: 'POST', url: `/api/posts/${postId}/read`, headers: { cookie: annaCookie },
  });
  assert.equal(marked.statusCode, 200);

  const after = await app.inject({
    method: 'GET', url: '/api/feed?scope=house', headers: { cookie: annaCookie },
  });
  assert.equal(after.json().posts.find((p: { id: string }) => p.id === postId).unread, false);

  // Отметка соседа на неё не влияет: прочитанность у каждого своя
  const neighbour = await app.inject({
    method: 'GET', url: '/api/feed?scope=house', headers: { cookie: irinaCookie },
  });
  assert.equal(neighbour.json().posts.find((p: { id: string }) => p.id === postId).unread, true);

  // Повторная отметка не должна давать ошибку: гонка «SELECT, потом INSERT»
  // встречалась в проекте четырежды, поэтому здесь onConflictDoNothing
  const again = await app.inject({
    method: 'POST', url: `/api/posts/${postId}/read`, headers: { cookie: annaCookie },
  });
  assert.equal(again.statusCode, 200);
});
