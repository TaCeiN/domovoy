import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MaxBot, deepLink } from './bot-api.ts';

/**
 * Живой запрос к Bot API — только по явному флагу.
 *
 * Раньше условием было просто наличие токена, а он лежит в `.env.local`
 * и подхватывается тестами. То есть каждый `npm test` ходил в сеть
 * на platform-api.max.ru: набор зависел от чужого сервиса и от связи,
 * а после перевыпуска токена — который числится в списке дел — начал бы
 * падать. Получалось, что правильное действие ломает тесты.
 */
const LIVE = process.env.MAX_LIVE_TESTS === '1';
const BOT_TOKEN = process.env.MAX_BOT_TOKEN;

test('диплинк собирается и валидирует payload', () => {
  assert.equal(deepLink('t111_hakaton_bot'), 'https://max.ru/t111_hakaton_bot?startapp');
  assert.equal(deepLink('t111_hakaton_bot', 'invite_A1B2'),
    'https://max.ru/t111_hakaton_bot?startapp=invite_A1B2');
  assert.throws(() => deepLink('t111_hakaton_bot', 'плохой payload'));
});

test('sendMessage требует адресата', async () => {
  const bot = new MaxBot({ token: 'x' });
  await assert.rejects(() => bot.sendMessage({ text: 'привет' }), /нужен chatId или userId/);
});

test('токен уходит заголовком, а не query-параметром', async () => {
  let seenUrl = '', seenAuth = '';
  const bot = new MaxBot({
    token: 'secret-token',
    fetchImpl: (async (url: any, init: any) => {
      seenUrl = String(url);
      seenAuth = init.headers.Authorization;
      return new Response('{}', { status: 200 });
    }) as any,
  });
  await bot.sendMessage({ userId: 42, text: 'привет' });
  assert.equal(seenAuth, 'secret-token');
  assert.ok(!seenUrl.includes('secret-token'), 'токен не должен попадать в URL');
  assert.ok(seenUrl.includes('user_id=42'));
});

test('кнопка open_app уходит с web_app в snake_case', async () => {
  let body: any = null;
  const bot = new MaxBot({
    token: 'x',
    fetchImpl: (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response('{}', { status: 200 });
    }) as any,
  });
  await bot.sendMessage({
    chatId: 7, text: 'Заявка в работе',
    buttons: [[{ type: 'open_app', text: 'Открыть', webApp: 't111_hakaton_bot', payload: 'req_1' }]],
  });

  const btn = body.attachments[0].payload.buttons[0][0];
  // Живой API отвечает «Field 'webApp' cannot be null», если поля нет,
  // и не принимает camelCase — проверено запросом к platform-api.max.ru
  assert.equal(btn.web_app, 't111_hakaton_bot');
  assert.equal(btn.payload, 'req_1');
  assert.equal(btn.webApp, undefined, 'camelCase наружу уходить не должен');
});

test('кнопка open_app кладётся во вложение inline_keyboard', async () => {
  let body: any = null;
  const bot = new MaxBot({
    token: 'x',
    fetchImpl: (async (_u: any, init: any) => {
      body = JSON.parse(init.body);
      return new Response('{}', { status: 200 });
    }) as any,
  });
  await bot.sendMessage({
    chatId: 7, text: 'Заявка в работе',
    buttons: [[{ type: 'open_app', text: 'Открыть заявку', payload: 'req_501' }]],
  });
  assert.equal(body.attachments[0].type, 'inline_keyboard');
  assert.equal(body.attachments[0].payload.buttons[0][0].type, 'open_app');
});

test('живой /me отвечает ботом', {
  skip: LIVE && BOT_TOKEN ? false : 'сетевой тест: MAX_LIVE_TESTS=1 и токен бота',
}, async () => {
  const bot = new MaxBot({ token: BOT_TOKEN! });
  const me = await bot.getMe();
  // Имя бота не проверяем: оно меняется вместе с токеном
  assert.equal(me.is_bot, true);
  assert.ok(me.username, 'у бота должно быть имя');
});
