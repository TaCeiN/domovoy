import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.ts';
import { resetTables, closeTestDb, grantAccess, isDbAvailable, TEST_URL } from '../../lib/test-db.ts';
import { closeDb } from '../../db/client.ts';
import { resetCleanupClock, type Llm } from '../../lib/bot/handle.ts';
import { resetRateLimits } from '../rate-limit.ts';
import { setAssistantLlm } from './assistant.ts';

/**
 * Домовой в мини-приложении: тот же разговор, что у бота MAX, по сессии.
 */

process.env.DATABASE_URL = TEST_URL;
const HOUSE = '344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85, к. 3';

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

const app = buildApp();
beforeEach(async () => {
  if (!available) return;
  await resetTables();
  resetRateLimits();
  resetCleanupClock();
});
after(async () => { setAssistantLlm(undefined); await app.close(); await closeTestDb(); await closeDb(); });

/** Житель из браузера — без аккаунта MAX, квитанция на 4 850 ₽ за август. */
async function resident() {
  const qr = [
    'ST00011', 'Name=ООО "УК Пример"', 'PayeeINN=6100000001', 'KPP=610001001',
    'Sum=485000', 'paymPeriod=082026', 'lastName=Смирнова', 'firstName=Анна', 'middleName=Т',
    `payerAddress=${HOUSE}, кв. 15`, 'persAcc=4460153',
  ].join('|');
  const res = await app.inject({ method: 'POST', url: '/api/auth/qr', payload: { qr } });
  assert.ok(res.statusCode < 300, `вход по квитанции: ${res.body}`);
  await grantAccess();
  const raw = res.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : [raw]).filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
}

function fakeLlm(answers: Array<Record<string, unknown>>) {
  const calls: string[] = [];
  const llm: Llm = {
    async callFunction(messages) {
      calls.push(messages[messages.length - 1].content);
      const next = answers.shift();
      if (!next) throw new Error('лишнее обращение к модели');
      return { args: next, totalTokens: 1500 };
    },
  };
  setAssistantLlm(llm);
  return calls;
}

const ask = (cookie: string, text: string) =>
  app.inject({ method: 'POST', url: '/api/assistant', headers: { cookie }, payload: { text } });

test('без сессии Домовой не отвечает', { skip }, async () => {
  const res = await app.inject({ method: 'POST', url: '/api/assistant', payload: { text: 'привет' } });
  assert.equal(res.statusCode, 401);
});

test('житель из браузера без MAX: ответ по своей квартире, суммы пишет код', { skip }, async () => {
  const cookie = await resident();
  fakeLlm([{ intent: 'bills' }]);
  const res = await ask(cookie, 'скока платить');
  assert.equal(res.statusCode, 200);
  const [first] = res.json().replies;
  assert.match(first.text, /4\s?850/);
  assert.equal(first.mood, undefined);
});

test('опасность: номера сразу и тревожный Домовой, модель не нужна для номеров', { skip }, async () => {
  const cookie = await resident();
  fakeLlm([{ intent: 'complaint', category: 'Авария', text: 'В подъезде пахнет газом.' }]);
  const res = await ask(cookie, 'пахнет газом в подъезде');
  const [first] = res.json().replies;
  assert.equal(first.mood, 'alert');
  assert.match(first.text, /104/);
});

test('жалоба: черновик с кнопкой в форму и довольный Домовой', { skip }, async () => {
  const cookie = await resident();
  fakeLlm([{ intent: 'complaint', category: 'Лифт', text: 'Лифт не работает третий день.' }]);
  const res = await ask(cookie, 'лифт сдох третий день');
  const last = res.json().replies.at(-1);
  assert.equal(last.mood, 'done');
  const payloads = (last.buttons ?? []).flat().map((b: { payload?: string }) => b.payload ?? '');
  assert.ok(payloads.some((p: string) => p.startsWith('d_')), `кнопка черновика: ${JSON.stringify(last.buttons)}`);
});

test('пустой вопрос — 400', { skip }, async () => {
  const cookie = await resident();
  const res = await ask(cookie, '   ');
  assert.equal(res.statusCode, 400);
});
