import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GigaChat, GigaChatError, type HttpRequest, type HttpResponse } from './client.ts';

/**
 * Клиент GigaChat без сети.
 *
 * Главное: токен не запрашивается на каждое сообщение (его выдают
 * на 30 минут, а просить можно не чаще 10 раз в секунду), модель
 * обязана вызвать ИМЕННО нашу функцию, а любой её уход в сторону —
 * ошибка, которую бот превратит в запасной ответ.
 */

const FN = {
  name: 'classify',
  description: 'Разобрать сообщение жителя',
  parameters: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] },
};

function fake(chatReplies: Array<(req: HttpRequest) => HttpResponse>) {
  const calls: HttpRequest[] = [];
  let tokenCalls = 0;
  let now = 1_000_000;
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    calls.push(req);
    if (req.url.endsWith('/oauth')) {
      tokenCalls += 1;
      return { status: 200, text: JSON.stringify({ access_token: `tok${tokenCalls}`, expires_at: now + 30 * 60_000 }) };
    }
    const next = chatReplies.shift();
    if (!next) throw new Error('лишний запрос к модели');
    return next(req);
  };
  const client = new GigaChat({
    authKey: 'a2V5', scope: 'GIGACHAT_API_PERS', model: 'GigaChat-2',
    transport, now: () => now,
  });
  return {
    client, calls,
    tokenCalls: () => tokenCalls,
    advance: (ms: number) => { now += ms; },
  };
}

const answer = (args: unknown, usage = 1234): HttpResponse => ({
  status: 200,
  text: JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '', function_call: { name: 'classify', arguments: args } }, finish_reason: 'function_call' }],
    usage: { prompt_tokens: usage - 34, completion_tokens: 34, total_tokens: usage },
  }),
});

test('вызов функции: форма запроса и разбор ответа', async () => {
  const f = fake([() => answer({ intent: 'bills' })]);
  const result = await f.client.callFunction([{ role: 'user', content: 'че за цифры в квитке' }], FN);

  assert.deepEqual(result.args, { intent: 'bills' });
  assert.equal(result.totalTokens, 1234);

  const [auth, chat] = f.calls;
  assert.equal(auth.method, 'POST');
  assert.equal(auth.headers.Authorization, 'Basic a2V5');
  assert.match(auth.headers.RqUID, /^[0-9a-f-]{36}$/);
  assert.equal(auth.body, 'scope=GIGACHAT_API_PERS');

  assert.equal(chat.headers.Authorization, 'Bearer tok1');
  const body = JSON.parse(chat.body ?? '');
  assert.equal(body.model, 'GigaChat-2');
  assert.deepEqual(body.function_call, { name: 'classify' }, 'модель обязана вызвать именно нашу функцию');
  assert.equal(body.functions[0].name, 'classify');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'че за цифры в квитке' }]);
});

test('аргументы строкой тоже принимаем', async () => {
  const f = fake([() => answer('{"intent":"meters"}')]);
  const result = await f.client.callFunction([{ role: 'user', content: 'показания' }], FN);
  assert.deepEqual(result.args, { intent: 'meters' });
});

test('токен живёт до конца срока и обновляется заранее', async () => {
  const f = fake([() => answer({ intent: 'a' }), () => answer({ intent: 'b' }), () => answer({ intent: 'c' })]);
  await f.client.callFunction([{ role: 'user', content: '1' }], FN);
  f.advance(20 * 60_000);
  await f.client.callFunction([{ role: 'user', content: '2' }], FN);
  assert.equal(f.tokenCalls(), 1, 'через 20 минут токен ещё годен');
  f.advance(9.5 * 60_000);
  await f.client.callFunction([{ role: 'user', content: '3' }], FN);
  assert.equal(f.tokenCalls(), 2, 'за минуту до конца срока берём новый');
});

test('401 от модели: новый токен и одна повторная попытка', async () => {
  const f = fake([() => ({ status: 401, text: '{"message":"Unauthorized"}' }), () => answer({ intent: 'x' })]);
  const result = await f.client.callFunction([{ role: 'user', content: '1' }], FN);
  assert.deepEqual(result.args, { intent: 'x' });
  assert.equal(f.tokenCalls(), 2);
});

test('модель ответила текстом вместо функции — ошибка bad_response', async () => {
  const f = fake([() => ({
    status: 200,
    text: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Привет!' }, finish_reason: 'stop' }], usage: { total_tokens: 50 } }),
  })]);
  await assert.rejects(
    f.client.callFunction([{ role: 'user', content: '1' }], FN),
    (e: unknown) => e instanceof GigaChatError && e.code === 'bad_response' && e.totalTokens === 50,
  );
});

test('квота кончилась или сервер упал — ошибка http с кодом', async () => {
  const f = fake([() => ({ status: 402, text: '{"message":"Payment Required"}' })]);
  await assert.rejects(
    f.client.callFunction([{ role: 'user', content: '1' }], FN),
    (e: unknown) => e instanceof GigaChatError && e.code === 'http' && e.status === 402,
  );
});

test('chat: вызов функции или текст, роль function уходит как есть', async () => {
  const f = fake([
    () => answer({ period: 'last' }),
    () => ({
      status: 200,
      text: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'К оплате 4 850,00 ₽.' } }], usage: { total_tokens: 900 } }),
    }),
  ]);
  const first = await f.client.chat([{ role: 'user', content: 'скока платить' }], [FN]);
  assert.deepEqual(first.call, { name: 'classify', args: { period: 'last' } });
  assert.equal(first.content, undefined);

  const second = await f.client.chat([
    { role: 'user', content: 'скока платить' },
    { role: 'assistant', content: '', function_call: { name: 'classify', arguments: { period: 'last' } } },
    { role: 'function', name: 'classify', content: '{"total":"4 850,00 ₽"}' },
  ], [FN]);
  assert.equal(second.content, 'К оплате 4 850,00 ₽.');
  assert.equal(second.totalTokens, 900);

  const body = JSON.parse(f.calls.at(-1)!.body!);
  assert.equal(body.function_call, 'auto');
  assert.equal(body.messages[2].role, 'function');
  assert.equal(body.messages[2].name, 'classify');
});

test('chat: пустой ответ — ошибка с потраченными токенами', async () => {
  const f = fake([() => ({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '' } }], usage: { total_tokens: 50 } }) })]);
  await assert.rejects(f.client.chat([{ role: 'user', content: 'x' }], [FN]), (e: GigaChatError) => e.totalTokens === 50);
});

test('chat: встроенный фильтр GigaChat — отдельная ошибка, а не его шаблон жителю', async () => {
  const f = fake([() => ({
    status: 200,
    text: JSON.stringify({ choices: [{ message: { content: 'Как и любая языковая модель, GigaChat не обладает собственным мнением…' }, finish_reason: 'blacklist' }], usage: { total_tokens: 40 } }),
  })]);
  await assert.rejects(f.client.chat([{ role: 'user', content: 'грубость' }], [FN]),
    (e: GigaChatError) => e.code === 'blacklist' && e.totalTokens === 40);
});

test('callFunction: встроенный фильтр — та же ошибка blacklist', async () => {
  const f = fake([() => ({
    status: 200,
    text: JSON.stringify({ choices: [{ message: { content: 'Как и любая языковая модель…' }, finish_reason: 'blacklist' }], usage: { total_tokens: 20 } }),
  })]);
  await assert.rejects(f.client.callFunction([{ role: 'user', content: 'грубость' }], FN), (e: GigaChatError) => e.code === 'blacklist');
});
