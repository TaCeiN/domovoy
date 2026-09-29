import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { buildApp } from '../../server/app.ts';
import { signInitDataForTesting } from '../max/init-data.ts';
import { testDb, resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL } from '../test-db.ts';
import { closeDb } from '../../db/client.ts';
import { botDraft, botMiss, post, property } from '../../db/schema.ts';
import { handleMessage, resetCleanupClock, NOT_IT, NO_TEXT, type BotDeps, type Llm } from './handle.ts';
import { AS_IS, NEW_ANYWAY } from './complaint.ts';
import type { Reply } from './intents.ts';

/**
 * Бот MAX целиком, с поддельным GigaChat.
 *
 * Главное: незнакомцу — только приглашение, опасность — сразу номера,
 * суммы пишет код, жалоба доходит до черновика и тогда, когда модель
 * сломалась.
 */

process.env.DATABASE_URL = TEST_URL;
process.env.MAX_BOT_TOKEN ||= 'test-token-for-signing';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;
const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const app = buildApp();
beforeEach(async () => {
  if (!available) return;
  await resetTables();
  resetCleanupClock();
});
after(async () => { await app.close(); await closeTestDb(); await closeDb(); });

function initData(id: number) {
  return signInitDataForTesting({
    auth_date: String(Math.floor(Date.now() / 1000)),
    chat: JSON.stringify({ id: 800000 + id, type: 'DIALOG' }),
    query_id: `q-${id}`,
    user: JSON.stringify({ id, first_name: 'Анна', last_name: 'Смирнова', username: null, language_code: 'ru', photo_url: null }),
  }, BOT_TOKEN);
}

/** Житель, вошедший через MAX: квитанция на 4 850 ₽ за август. */
async function resident(maxId: number, { confirmed = true, flat = '15', acc = '4460153' } = {}) {
  const qr = [
    'ST00011', 'Name=ООО "УК Пример"', 'PayeeINN=6100000001', 'KPP=610001001',
    'Sum=485000', 'paymPeriod=082026', 'lastName=Смирнова', 'firstName=Анна', 'middleName=Т',
    `payerAddress=${HOUSE}, кв. ${flat}`, `persAcc=${acc}`,
  ].join('|');
  const res = await app.inject({
    method: 'POST', url: '/api/auth/qr', headers: { 'x-max-init-data': initData(maxId) }, payload: { qr },
  });
  assert.ok(res.statusCode < 300, `вход по квитанции: ${res.body}`);
  if (confirmed) await grantAccess();
  const raw = res.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
  return { cookie };
}

function harness(answers: Array<Record<string, unknown> | Error>, extra: Partial<BotDeps> = {}) {
  const sent: Reply[] = [];
  const asked: string[] = [];
  const llm: Llm = {
    async callFunction(messages) {
      asked.push(messages[messages.length - 1].content);
      const next = answers.shift();
      if (!next) throw new Error('лишнее обращение к модели');
      if (next instanceof Error) throw next;
      return { args: next, totalTokens: 1500 };
    },
  };
  const deps: BotDeps = {
    db: testDb(), llm, botUsername: 'test_bot',
    send: async (_id, reply) => { sent.push(reply); },
    ...extra,
  };
  let mid = 0;
  const say = (maxUserId: number, text: string) => handleMessage(deps, { maxUserId, text, mid: `mid-${++mid}` });
  return { sent, asked, say, deps };
}

const flat = (r: Reply) => (r.buttons ?? []).flat();
const payloads = (r: Reply) => flat(r).map((b) => (b.type === 'open_app' ? b.payload ?? '' : b.text));

test('незнакомец: приглашение войти по квитанции, модель не вызывается', { skip }, async () => {
  const h = harness([]);
  await h.say(555, 'сколько платить');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /отсканируйте QR-код с квитанции/);
  assert.equal(flat(h.sent[0])[0].type, 'open_app');
  assert.equal(h.asked.length, 0);
});

test('опасность: номера сразу, до модели и даже незнакомцу', { skip }, async () => {
  const h = harness([]);
  await h.say(556, 'пахнет газом в подъезде');
  assert.match(h.sent[0].text, /112/);
  assert.match(h.sent[0].text, /104/);
  assert.equal(h.asked.length, 0);
});

test('жалоба: уточнение кнопками, затем черновик с кнопкой в форму', { skip }, async () => {
  const anna = await resident(91001);
  const h = harness([
    { intent: 'complaint', category: 'Сантехника', text: 'В квартире нет воды 15 дней.', ask: 'Какой воды нет?', options: ['Горячей', 'Холодной', 'Никакой'] },
    { intent: 'complaint', category: 'Сантехника', text: 'В квартире нет горячей воды 15 дней. Прошу сообщить срок восстановления.', ask: 'Ещё вопрос?', options: ['а', 'б'] },
  ]);

  await h.say(91001, 'схуяли нет воды уже 15 дней');
  assert.equal(h.sent[0].text, 'Какой воды нет?');
  assert.deepEqual(payloads(h.sent[0]), ['Горячей', 'Холодной', 'Никакой']);

  await h.say(91001, 'Горячей');
  assert.match(h.asked[1], /^Жалоба: В квартире нет воды 15 дней\.\nНа вопрос «Какой воды нет\?» житель ответил: Горячей/,
    'второй шаг — очищенный текст с ответом, а не исходное сообщение с матом');
  assert.doesNotMatch(h.asked[1], /схуяли/);
  const reply = h.sent[1];
  assert.match(reply.text, /Подготовил обращение/);
  assert.match(reply.text, /нет горячей воды 15 дней/);
  assert.doesNotMatch(reply.text, /Ещё вопрос/, 'второй раз не переспрашиваем');
  const button = flat(reply).find((b) => b.type === 'open_app');
  assert.ok(button && button.type === 'open_app' && /^d_[A-Z0-9]+$/.test(button.payload ?? ''));

  const drafts = await testDb().select().from(botDraft);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].category, 'Сантехника');

  // Черновик открывается в мини-приложении у владельца
  const id = `bdr_${(button as { payload: string }).payload.slice(2)}`;
  const opened = await app.inject({ method: 'GET', url: `/api/bot/drafts/${id}`, headers: { cookie: anna.cookie } });
  assert.equal(opened.statusCode, 200);
});

test('повтор жалобы: сначала напомнить о заявке, по кнопке — новый черновик', { skip }, async () => {
  const anna = await resident(91001);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: anna.cookie } });
  const made = await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: anna.cookie },
    payload: { propertyId: me.json().properties[0].propertyId, category: 'Лифт', description: 'Не работает лифт' },
  });
  assert.equal(made.statusCode, 201);

  const h = harness([{ intent: 'complaint', category: 'Лифт', text: 'Лифт не работает третий день.' }]);
  await h.say(91001, 'лифт опять сдох');
  assert.match(h.sent[0].text, /уже есть обращение № \d+/);
  assert.ok(payloads(h.sent[0]).some((p) => p.startsWith('r_')));
  assert.ok(payloads(h.sent[0]).includes(NEW_ANYWAY));

  await h.say(91001, NEW_ANYWAY);
  assert.match(h.sent[1].text, /Подготовил обращение/);
  assert.equal(h.asked.length, 1, 'кнопка модели не требует');
});

test('модель сломалась — жалоба оформляется словами человека', { skip }, async () => {
  await resident(91001);
  const h = harness([new Error('таймаут')]);
  await h.say(91001, 'в подвале воняет уже неделю');
  assert.match(h.sent[0].text, /Не получилось разобрать/);
  assert.ok(payloads(h.sent[0]).includes(AS_IS));

  await h.say(91001, AS_IS);
  assert.match(h.sent[1].text, /«в подвале воняет уже неделю»/);
  const misses = await testDb().select().from(botMiss);
  assert.equal(misses[0].reason, 'llm_error');
});

test('начисления: сумму пишет код из базы, а не модель', { skip }, async () => {
  await resident(91001);
  const h = harness([{ intent: 'bills', text: 'начислено 999 999 ₽' }]);
  await h.say(91001, 'скока платить');
  assert.match(h.sent[0].text, /4\s?850/);
  assert.doesNotMatch(h.sent[0].text, /999/);
  assert.ok(payloads(h.sent[0]).includes('s_payment'));
  assert.ok(payloads(h.sent[0]).includes(NOT_IT));
});

test('лента закрыта до подтверждения квартиры', { skip }, async () => {
  await resident(91001, { confirmed: false });
  const h = harness([{ intent: 'feed' }]);
  await h.say(91001, 'чо нового в доме');
  assert.match(h.sent[0].text, /откроется, когда председатель или управляющая компания подтвердит/);
});

test('повтор события MAX и дневной лимит', { skip }, async () => {
  await resident(91001);
  const h = harness([{ intent: 'greeting' }], { dailyMessages: 1 });
  await handleMessage(h.deps, { maxUserId: 91001, text: 'привет', mid: 'same' });
  await handleMessage(h.deps, { maxUserId: 91001, text: 'привет', mid: 'same' });
  assert.equal(h.sent.length, 1, 'повтор того же события не отвечается');

  await h.say(91001, 'ещё раз привет');
  assert.match(h.sent[1].text, /На сегодня/);
});

test('без ключа GigaChat бот не молчит', { skip }, async () => {
  await resident(91001);
  const h = harness([], { llm: null });
  await h.say(91001, 'нет света в подъезде');
  assert.match(h.sent[0].text, /Не получилось разобрать/);
});

test('«Не то» записывает прошлое сообщение в непонятые', { skip }, async () => {
  await resident(91001);
  const h = harness([{ intent: 'meters' }]);
  await h.say(91001, 'а чё по свету');
  await h.say(91001, NOT_IT);
  const misses = await testDb().select().from(botMiss).where(eq(botMiss.reason, 'not_it'));
  assert.equal(misses[0].text, 'а чё по свету');
});

test('две квартиры: сначала спросить адрес, потом разобрать исходное сообщение', { skip }, async () => {
  await resident(91001, { flat: '15', acc: '4460153' });
  await resident(91001, { flat: '33', acc: '4460331' });
  const h = harness([{ intent: 'contacts' }]);
  await h.say(91001, 'телефон лифтеров');
  assert.equal(h.sent[0].text, 'По какому адресу?');
  const choice = payloads(h.sent[0]).find((p) => p.includes('кв. 33'));
  assert.ok(choice, `варианты: ${payloads(h.sent[0]).join(' | ')}`);

  await h.say(91001, choice!);
  assert.equal(h.asked[0], 'телефон лифтеров');
  assert.match(h.sent[1].text, /112/);
});

test('лицевые счета: номера в чат не пишем, ведём кнопкой на экран счетов', { skip }, async () => {
  await resident(91050, { acc: '4460153' });
  const h = harness([{ intent: 'accounts' }]);
  await h.say(91050, 'какие у меня лицевые счета');
  const reply = h.sent[0];
  assert.doesNotMatch(reply.text, /4460153/, 'номер лицевого счёта в переписку не уходит');
  assert.ok(payloads(reply).includes('s_accounts'));
});

test('«открой счётчики»: ответ с кнопкой, приложение переходит само', { skip }, async () => {
  await resident(91060);
  const h = harness([{ intent: 'navigate', screen: 'meters' }, { intent: 'navigate', screen: 'нет_такого' }]);
  await h.say(91060, 'открой счётчики');
  assert.match(h.sent[0].text, /Открываю «Показания счётчиков»/);
  assert.equal(h.sent[0].open, 's_meters', 'в мини-приложении экран открывается сам');
  assert.ok(payloads(h.sent[0]).includes('s_meters'));

  await h.say(91060, 'открой что-нибудь');
  assert.equal(h.sent[1].open, undefined, 'выдуманный моделью экран не открываем');
  assert.ok(payloads(h.sent[1]).includes(''), 'только «Открыть приложение»');
});

test('экран дома до подтверждения квартиры не открывается, «Совет дома» — не председателю', { skip }, async () => {
  await resident(91061, { confirmed: false });
  const h = harness([{ intent: 'navigate', screen: 'feed' }, { intent: 'navigate', screen: 'council' }]);
  await h.say(91061, 'покажи объявления');
  assert.match(h.sent[0].text, /откроется, когда председатель/);
  assert.equal(h.sent[0].open, undefined);
  await h.say(91061, 'открой совет дома');
  assert.match(h.sent[1].text, /не председатель/);
  assert.equal(h.sent[1].open, undefined);
});

test('жалоба на мусор не цепляется за открытую заявку про дверь той же категории', { skip }, async () => {
  const anna = await resident(91062);
  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: anna.cookie } });
  await app.inject({
    method: 'POST', url: '/api/requests', headers: { cookie: anna.cookie },
    payload: { propertyId: me.json().properties[0].propertyId, category: 'Общее имущество', description: 'Сломана дверь в подъезде' },
  });
  const h = harness([{ intent: 'complaint', category: 'Общее имущество', text: 'Мусор не вывозят неделю. Прошу организовать вывоз.' }]);
  await h.say(91062, 'Не вывозят мусор');
  assert.match(h.sent[0].text, /Подготовил обращение/, 'сразу черновик, а не «у вас уже есть обращение»');
});

test('аналитика: итоги по месяцам считает код', { skip }, async () => {
  await resident(91063);
  const h = harness([{ intent: 'analytics' }]);
  await h.say(91063, 'сколько я трачу на коммуналку');
  assert.match(h.sent[0].text, /4\s850,00/);
  assert.ok(payloads(h.sent[0]).includes('s_analytics'));
});

/** Объявление УК об отключении в доме жителя — как публикует его кабинет УК */
async function outagePost({ title, body, hoursLeft = 20 }: { title: string; body: string; hoursLeft?: number }) {
  const [prop] = await testDb().select({ houseKey: property.houseKey }).from(property).limit(1);
  await testDb().insert(post).values({
    id: `pst_${Math.random().toString(36).slice(2, 10)}`, houseKey: prop.houseKey, type: 'uk', category: 'outage',
    title, body, expiresAt: new Date(Date.now() + hoursLeft * 3600_000),
  });
}

test('номер скорой: отвечает код, без модели — номера служб и 112', { skip }, async () => {
  await resident(91101);
  const h = harness([]);
  await h.say(91101, 'какой номер у скорой');
  assert.equal(h.asked.length, 0, 'модель не нужна');
  assert.match(h.sent[0].text, /скорая — 103/);
  assert.match(h.sent[0].text, /112/);
});

test('«когда отключение воды»: объявление УК с текстом и сроком, без модели', { skip }, async () => {
  await resident(91102);
  await outagePost({ title: 'Отключение горячей воды', body: 'Завтра с 9:00 до 18:00 — замена задвижки в подвале 2 подъезда.' });
  const h = harness([]);
  await h.say(91102, 'когда отключение воды');
  assert.equal(h.asked.length, 0);
  assert.match(h.sent[0].text, /Отключение горячей воды/);
  assert.match(h.sent[0].text, /с 9:00 до 18:00/);
});

test('отключений нет — так и говорит, а не «я отвечаю по данным дома»', { skip }, async () => {
  await resident(91103);
  const h = harness([]);
  await h.say(91103, 'когда дадут воду');
  assert.match(h.sent[0].text, /объявлений об отключениях нет/i);
});

test('«нет горячей воды» при объявленном отключении: сначала объявление, обращение — по кнопке', { skip }, async () => {
  await resident(91104);
  await outagePost({ title: 'Отключение горячей воды', body: 'Завтра с 9:00 до 18:00.' });
  const h = harness([
    { intent: 'complaint', category: 'Сантехника', text: 'Нет горячей воды.', ask: 'Какой воды нет?', options: ['Горячей', 'Холодной'] },
  ]);
  await h.say(91104, 'нет горячей воды');
  assert.match(h.sent[0].text, /Отключение горячей воды/);
  assert.ok(payloads(h.sent[0]).includes(NEW_ANYWAY), 'обращение всё равно можно оформить');
  assert.equal((await testDb().select().from(botDraft)).length, 0, 'черновик — только по кнопке');

  await h.say(91104, NEW_ANYWAY);
  assert.equal((await testDb().select().from(botDraft)).length, 1);
});

test('стикер или фото без текста: бот не молчит', { skip }, async () => {
  const h = harness([]);
  await h.say(91105, NO_TEXT);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /словами/);
  assert.equal(h.asked.length, 0);
});

test('«спасибо» — короткий ответ, а не «я отвечаю по данным дома»', { skip }, async () => {
  await resident(91106);
  const h = harness([]);
  await h.say(91106, 'спасибо');
  assert.equal(h.asked.length, 0);
  assert.match(h.sent[0].text, /Пожалуйста/);
});

test('человеку плохо: только номера 112 и 103 — без модели и без предложения жалобы', { skip }, async () => {
  await resident(91107);
  const h = harness([]);
  await h.say(91107, 'соседке плохо, не встает');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /103/);
  assert.equal(h.asked.length, 0);
});

test('«нет горячей воды» при объявленном отключении — и без ключа GigaChat', { skip }, async () => {
  await resident(91108);
  await outagePost({ title: 'Отключение горячей воды', body: 'Завтра с 9:00 до 18:00.' });
  const h = harness([], { llm: null });
  await h.say(91108, 'нет горячей воды');
  assert.match(h.sent[0].text, /Отключение горячей воды/);
});

test('«какой долг у кв. 15» — про чужие квартиры не рассказываю, без модели', { skip }, async () => {
  await resident(91109);
  const h = harness([]);
  await h.say(91109, 'какой долг у кв. 40');
  assert.equal(h.asked.length, 0);
  assert.match(h.sent[0].text, /чужие квартиры не рассказываю/);
  assert.doesNotMatch(h.sent[0].text, /Начислено/);
});

test('вопрос о законе — не консультирую, телефон УК', { skip }, async () => {
  await resident(91110);
  const h = harness([]);
  await h.say(91110, 'имеют право отключать воду на месяц?');
  assert.equal(h.asked.length, 0);
  assert.match(h.sent[0].text, /по законам не консультирую/i);
});

test('драка в подъезде — 112 и 102, без модели и без жалобы', { skip }, async () => {
  await resident(91111);
  const h = harness([]);
  await h.say(91111, 'в подъезде драка');
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].text, /102/);
  assert.equal(h.asked.length, 0);
});
