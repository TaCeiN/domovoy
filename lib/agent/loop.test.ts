import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, MAX_CALLS, type ChatLlm } from './loop.ts';
import type { Tool } from './tools.ts';
import type { IntentContext } from '../bot/intents.ts';
import type { ChatMessage, ChatTurn } from '../gigachat/client.ts';

/**
 * Цикл модель ⇄ инструменты без базы и сети.
 *
 * Главное: результат инструмента возвращается модели сообщением
 * role=function, кнопки собираются только из инструментов, у цикла есть
 * потолок шагов, а неизвестный инструмент не роняет разговор.
 */

const ctx = {} as IntentContext;

const bills: Tool = {
  topic: 'bills',
  def: { name: 'my_bills', description: 'начисления', parameters: { type: 'object', properties: {} } },
  run: async () => ({ data: { total: '4 850,00 ₽' } }),
};
const opener: Tool = {
  def: { name: 'open', description: 'открыть', parameters: { type: 'object', properties: {} } },
  run: async () => ({ data: { opened: 'Счётчики' }, buttons: [[{ type: 'message', text: 'Счётчики' }]], open: 's_meters' }),
};
const drafter: Tool = {
  def: { name: 'draft_complaint', description: 'жалоба', parameters: { type: 'object', properties: {} } },
  run: async () => ({ data: { drafted: true }, draft: { category: 'Лифт', text: 'Лифт не работает.' } }),
};
const tools = { my_bills: bills, open: opener, draft_complaint: drafter };

function script(steps: Array<Omit<ChatTurn, 'totalTokens'>>) {
  const seen: ChatMessage[][] = [];
  const llm: ChatLlm = {
    async chat(messages) {
      seen.push(structuredClone(messages));
      const next = steps.shift();
      if (!next) throw new Error('лишнее обращение к модели');
      return { ...next, totalTokens: 100 };
    },
  };
  return { llm, seen };
}

test('инструмент → результат модели → текст', async () => {
  const { llm, seen } = script([{ call: { name: 'my_bills', args: {} } }, { content: 'К оплате 4 850,00 ₽.' }]);
  const r = await runAgent({ llm, ctx, history: [], input: 'скока платить', tools });
  assert.equal(r.kind, 'answer');
  if (r.kind !== 'answer') return;
  assert.equal(r.text, 'К оплате 4 850,00 ₽.');
  assert.deepEqual(r.used, ['my_bills']);
  assert.equal(r.tokens, 200);
  assert.ok(r.sources.some((s) => s.includes('4 850,00 ₽')));
  const last = seen[1].at(-1)!;
  assert.equal(last.role, 'function');
  assert.equal(last.name, 'my_bills');
  assert.equal(seen[1].at(-2)!.function_call?.name, 'my_bills');
});

test('кнопки и экран — только от инструмента', async () => {
  const { llm } = script([{ call: { name: 'open', args: { target: 'screen:meters' } } }, { content: 'Открываю счётчики.' }]);
  const r = await runAgent({ llm, ctx, history: [], input: 'открой счётчики', tools });
  assert.equal(r.kind, 'answer');
  if (r.kind !== 'answer') return;
  assert.equal(r.open, 's_meters');
  assert.equal(r.buttons.length, 1);
});

test('жалоба завершает цикл черновиком', async () => {
  const { llm, seen } = script([{ call: { name: 'draft_complaint', args: {} } }]);
  const r = await runAgent({ llm, ctx, history: [], input: 'лифт сдох', tools });
  assert.equal(r.kind, 'draft');
  if (r.kind !== 'draft') return;
  assert.equal(r.draft.category, 'Лифт');
  assert.equal(seen.length, 1, 'после черновика модель не зовём');
});

test(`больше ${MAX_CALLS} вызовов подряд — отказ`, async () => {
  const { llm } = script(Array.from({ length: MAX_CALLS + 1 }, () => ({ call: { name: 'my_bills', args: {} } })));
  const r = await runAgent({ llm, ctx, history: [], input: 'x', tools });
  assert.equal(r.kind, 'give_up');
});

test('неизвестный инструмент — ошибка модели, а не падение', async () => {
  const { llm, seen } = script([{ call: { name: 'rm_rf', args: {} } }, { content: 'Такого я не умею.' }]);
  const r = await runAgent({ llm, ctx, history: [], input: 'x', tools });
  assert.equal(r.kind, 'answer');
  assert.match(seen[1].at(-1)!.content, /unknown_tool/);
});

test('история диалога уходит модели между системным промптом и сообщением', async () => {
  const { llm, seen } = script([{ content: 'Пожалуйста!' }]);
  await runAgent({ llm, ctx, history: [{ role: 'user', content: 'привет' }, { role: 'assistant', content: 'Здравствуйте!' }], input: 'спасибо', tools });
  assert.deepEqual(seen[0].map((m) => m.role), ['system', 'user', 'assistant', 'user']);
});

test('подсказка разбора — в конце единственного системного сообщения', async () => {
  const { llm, seen } = script([{ content: 'Смотрю.' }]);
  await runAgent({ llm, ctx, history: [], input: 'что с заявкой', tools, hint: 'Вызови my_requests.' });
  assert.deepEqual(seen[0].map((m) => m.role), ['system', 'user'], 'системное у GigaChat одно и первым');
  assert.match(seen[0][0].content, /my_requests/);
});

test('вызов инструмента, написанный текстом, выполняется по-настоящему', async () => {
  const { llm, seen } = script([
    { content: 'open(target="screen:meters")\nОткрываю счётчики.' },
    { content: 'Открыл счётчики.' },
  ]);
  const r = await runAgent({ llm, ctx, history: [], input: 'открой счётчики', tools });
  assert.equal(r.kind, 'answer');
  if (r.kind !== 'answer') return;
  assert.equal(r.text, 'Открыл счётчики.');
  assert.equal(r.open, 's_meters');
  assert.deepEqual(r.used, ['open']);
  assert.equal(seen[1].at(-1)!.role, 'function');
});

test('имя инструмента в квадратных скобках — тоже вызов', async () => {
  const { llm } = script([{ content: '[my_bills] Сейчас посмотрю.' }, { content: 'К оплате 4 850,00 ₽.' }]);
  const r = await runAgent({ llm, ctx, history: [], input: 'скока платить', tools });
  assert.equal(r.kind, 'answer');
  if (r.kind !== 'answer') return;
  assert.deepEqual(r.used, ['my_bills']);
});

test('первый вызов делает код: модель сразу получает данные', async () => {
  const { llm, seen } = script([{ content: 'К оплате 4 850,00 ₽.' }]);
  const r = await runAgent({ llm, ctx, history: [], input: 'скока платить', tools, firstCall: { name: 'my_bills', args: {} } });
  assert.equal(r.kind, 'answer');
  if (r.kind !== 'answer') return;
  assert.deepEqual(r.used, ['my_bills']);
  assert.equal(seen[0].at(-1)!.role, 'function', 'данные уже в первом запросе к модели');
  assert.equal(seen[0].at(-2)!.function_call?.name, 'my_bills');
});
