import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateInitData,
  signInitDataForTesting,
  extractWebAppData,
} from './init-data.ts';

const BOT_TOKEN = process.env.MAX_BOT_TOKEN ?? 'test-token-not-a-real-secret';

const nowSeconds = () => Math.floor(Date.now() / 1000);

function makeParams(overrides: Record<string, string> = {}) {
  return {
    auth_date: String(nowSeconds()),
    chat: JSON.stringify({ id: 12345, type: 'DIALOG' }),
    ip: '192.168.0.1',
    query_id: '4c0ab423-342b-4e45-aea4-2747dbc500cd',
    user: JSON.stringify({
      id: 67890,
      first_name: 'Сергей',
      last_name: 'Крутых',
      username: null,
      language_code: 'ru',
      photo_url: null,
    }),
    ...overrides,
  };
}

test('подписанные параметры проходят проверку', () => {
  const initData = signInitDataForTesting(makeParams(), BOT_TOKEN);
  const result = validateInitData(initData, { botToken: BOT_TOKEN });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.user.id, 67890);
  assert.equal(result.data.user.first_name, 'Сергей');
  assert.equal(result.data.chat?.type, 'DIALOG');
  assert.equal(result.data.queryId, '4c0ab423-342b-4e45-aea4-2747dbc500cd');
});

test('кириллица и пробелы в значениях не ломают подпись', () => {
  const params = makeParams({
    user: JSON.stringify({
      id: 1,
      first_name: 'Анна Мария',
      last_name: 'Смирнова-Заречная',
      username: null,
      language_code: 'ru',
      photo_url: 'https://i.oneme.ru/i?r=abc&x=1',
    }),
  });
  const result = validateInitData(signInitDataForTesting(params, BOT_TOKEN), {
    botToken: BOT_TOKEN,
  });
  assert.equal(result.ok, true);
});

test('подменённый user_id отвергается', () => {
  const initData = signInitDataForTesting(makeParams(), BOT_TOKEN);
  const tampered = initData.replace('67890', '11111');

  const result = validateInitData(tampered, { botToken: BOT_TOKEN });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'bad_signature');
});

test('чужой токен не подходит', () => {
  const initData = signInitDataForTesting(makeParams(), BOT_TOKEN);
  const result = validateInitData(initData, { botToken: BOT_TOKEN + 'x' });
  assert.equal(result.ok, false);
});

test('просроченные данные отвергаются', () => {
  const twoHoursAgo = String(nowSeconds() - 2 * 60 * 60);
  const initData = signInitDataForTesting(makeParams({ auth_date: twoHoursAgo }), BOT_TOKEN);

  const result = validateInitData(initData, { botToken: BOT_TOKEN });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'expired');
});

test('два параметра hash отвергаются', () => {
  const initData = signInitDataForTesting(makeParams(), BOT_TOKEN);
  const result = validateInitData(initData + '&hash=deadbeef', { botToken: BOT_TOKEN });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'hash_duplicated');
});

test('без hash отвергается', () => {
  const initData = signInitDataForTesting(makeParams(), BOT_TOKEN);
  const withoutHash = initData.split('&').filter((p) => !p.startsWith('hash=')).join('&');

  const result = validateInitData(withoutHash, { botToken: BOT_TOKEN });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'hash_missing');
});

test('пустой вход отвергается', () => {
  assert.equal(validateInitData('', { botToken: BOT_TOKEN }).ok, false);
});

test('start_param из диплинка доезжает', () => {
  const params = makeParams({ start_param: 'invite_A1B2C3' });
  const result = validateInitData(signInitDataForTesting(params, BOT_TOKEN), {
    botToken: BOT_TOKEN,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.startParam, 'invite_A1B2C3');
});

test('принимает и полный URL с фрагментом, и голое значение', () => {
  const initData = signInitDataForTesting(makeParams(), BOT_TOKEN);
  const fullUrl =
    'https://our-app.example/#WebAppData=' +
    encodeURIComponent(initData) +
    '&WebAppPlatform=web&WebAppVersion=26.2.8';

  assert.equal(extractWebAppData(fullUrl), initData);
  assert.equal(validateInitData(fullUrl, { botToken: BOT_TOKEN }).ok, true);
  assert.equal(validateInitData(initData, { botToken: BOT_TOKEN }).ok, true);
});

test('пример структуры из документации MAX разбирается', () => {
  // Значения — из примера на dev.max.ru/docs/webapps/validation.
  // Подпись пересчитана нашим токеном: оригинальный hash в документации заменён
  // на <calculated_hash>, поэтому сверить можно только структуру, не подпись.
  const params = {
    auth_date: String(nowSeconds()),
    chat: JSON.stringify({ id: 12345, type: 'DIALOG' }),
    ip: '192.168.0.1',
    query_id: '4c0ab423-342b-4e45-aea4-2747dbc500cd',
    user: JSON.stringify({
      id: 67890,
      first_name: 'Max',
      last_name: 'User',
      username: null,
      language_code: 'ru',
      photo_url: null,
    }),
  };
  const result = validateInitData(signInitDataForTesting(params, BOT_TOKEN), {
    botToken: BOT_TOKEN,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.data.user.first_name, 'Max');
  assert.equal(result.data.ip, '192.168.0.1');
});

/* ─────────── кодирование пробела плюсом ─────────── */

/**
 * Пробел в подписанных данных не должен ломать проверку.
 *
 * ЧТО СЛУЧИЛОСЬ В БОЮ. У одного участника теста вход падал с
 * `bad_signature`, у остальных работал. Разница — название чата
 * «Хакатон 111», в нём пробел. Значение WebAppData доставали через
 * `URLSearchParams`, а он по правилам форм превращает «+» в пробел;
 * внутренние значения читались `decodeURIComponent`, который так НЕ делает.
 * Две несогласованные трактовки одного символа — и строка, по которой
 * считается подпись, расходится с той, что подписал мессенджер.
 *
 * Клиенты кодируют пробел по-разному: где-то «%20», где-то «+».
 * Проверка обязана принимать оба варианта — секрет всё равно нужен,
 * так что перебор двух трактовок ничего не ослабляет.
 */
test('пробел, закодированный плюсом, не ломает подпись', () => {
  const params = {
    user: JSON.stringify({ id: 77, first_name: 'Ярослав', last_name: 'Потапов' }),
    chat: JSON.stringify({ id: 5, title: 'Хакатон 111' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };

  const signed = signInitDataForTesting(params, BOT_TOKEN);
  // Так это выглядит у клиента, который кодирует пробел плюсом
  const plusEncoded = signed.replace(/%20/g, '+');
  assert.notEqual(plusEncoded, signed, 'в тестовых данных обязан быть пробел');

  const result = validateInitData(plusEncoded, { botToken: BOT_TOKEN });
  assert.equal(result.ok, true, `подпись должна сойтись, а вышло: ${result.ok ? '' : result.reason}`);
});

/**
 * Тот же пробел, но во ВНЕШНЕЙ обёртке фрагмента.
 *
 * MAX кладёт параметры во фрагмент вида `WebAppData=...&WebAppPlatform=web`.
 * Значение оттуда доставалось `URLSearchParams`, и он менял «+» на пробел
 * ВНУТРИ уже закодированной строки — то есть портил её до всякого разбора.
 */
test('плюс внутри фрагмента WebAppData не портит данные', () => {
  const params = {
    user: JSON.stringify({ id: 78, first_name: 'Мария' }),
    chat: JSON.stringify({ id: 6, title: 'Совет дома 12' }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };

  const signed = signInitDataForTesting(params, BOT_TOKEN).replace(/%20/g, '+');
  const fragment = `#WebAppData=${encodeURIComponent(signed)}&WebAppPlatform=android`;

  const result = validateInitData(fragment, { botToken: BOT_TOKEN });
  assert.equal(result.ok, true, `подпись должна сойтись, а вышло: ${result.ok ? '' : result.reason}`);
});
