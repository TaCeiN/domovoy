import type { ChatMessage, ChatTurn, FunctionDef } from '../gigachat/client.ts';
import type { Button } from '../max/bot-api.ts';
import type { IntentContext } from '../bot/intents.ts';
import type { ComplaintDraft } from '../bot/complaint.ts';
import { AGENT_PROMPT } from './prompt.ts';
import { TOOLS, type Tool } from './tools.ts';

/**
 * Разговор Домовёнка с моделью: модель ⇄ инструменты, итог — текст.
 *
 * Модель сама решает, какой инструмент вызвать; результат уходит ей
 * обратно сообщением role=function, и по нему она пишет ответ. Кнопки
 * и экран для автооткрытия собираются только из результатов
 * инструментов. Черновик жалобы завершает разговор: дальше его
 * оформляет код (draftReply в lib/bot/handle.ts).
 *
 * Ошибку модели цикл не ловит — её превращает в запасной ответ
 * вызывающий код, вместе с учётом потраченных токенов.
 */

export const MAX_CALLS = 4;

export interface ChatLlm {
  chat(messages: ChatMessage[], functions: FunctionDef[]): Promise<ChatTurn>;
}

export type AgentResult =
  | { kind: 'answer'; text: string; buttons: Button[][]; open?: string; used: string[]; sources: string[]; tokens: number }
  | { kind: 'draft'; draft: ComplaintDraft; used: string[]; sources: string[]; tokens: number }
  | { kind: 'give_up'; used: string[]; tokens: number };

export async function runAgent({ llm, ctx, history, input, tools = TOOLS, hint, firstCall }: {
  llm: ChatLlm;
  ctx: IntentContext;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  input: string;
  tools?: Record<string, Tool>;
  /**
   * Подсказка из разбора классификатора: какой инструмент вызвать. Lite без
   * неё на «что с моей заявкой» отвечал «проверьте раздел» вместо данных
   * (сквозной прогон 30.09).
   */
  hint?: string;
  /**
   * Первый вызов делает код, до ответа модели: тема понятна классификатору,
   * а подсказку словами модель иногда пропускала — на «что с моей заявкой»
   * переспрашивала вместо того, чтобы посмотреть заявки (бой, 30.09).
   */
  firstCall?: { name: string; args: Record<string, unknown> };
}): Promise<AgentResult> {
  // Системное сообщение у GigaChat только одно и только первым:
  // второе в середине диалога он отвергает, поэтому подсказка — в конце первого
  const messages: ChatMessage[] = [
    { role: 'system', content: hint ? `${AGENT_PROMPT}\n\n${hint}` : AGENT_PROMPT },
    ...history,
    { role: 'user', content: input },
  ];
  const defs = Object.values(tools).map((t) => t.def);
  const used: string[] = [];
  const sources = [input];
  const buttons: Button[][] = [];
  let open: string | undefined;
  let tokens = 0;

  /** Выполнить инструмент и вернуть результат модели сообщением role=function */
  const invoke = async (name: string, args: Record<string, unknown>) => {
    const tool = tools[name];
    const result = tool ? await tool.run(ctx, args) : { data: { error: 'unknown_tool' } };
    used.push(name);
    const json = JSON.stringify(result.data);
    sources.push(json);
    if ('buttons' in result && result.buttons) buttons.push(...result.buttons);
    if ('open' in result && result.open) open = result.open;
    messages.push({ role: 'assistant', content: '', function_call: { name, arguments: args } });
    messages.push({ role: 'function', name, content: json });
    return 'draft' in result ? result.draft : undefined;
  };

  if (firstCall && tools[firstCall.name]) {
    const draft = await invoke(firstCall.name, firstCall.args);
    if (draft) return { kind: 'draft', draft, used, sources, tokens };
  }

  for (let calls = 0; ; calls += 1) {
    const turn = await llm.chat(messages, defs);
    tokens += turn.totalTokens;
    // Lite иногда пишет вызов текстом — «open(target="screen:x")», «[outages]»:
    // выполняем его как настоящий, а ответ модель напишет заново
    if (turn.content && !turn.call) {
      const written = callInText(turn.content, tools);
      if (written) turn.call = written;
      else return { kind: 'answer', text: turn.content, buttons, open, used, sources, tokens };
    }
    if (!turn.call || calls >= MAX_CALLS) return { kind: 'give_up', used, tokens };

    const draft = await invoke(turn.call.name, turn.call.args);
    if (draft) return { kind: 'draft', draft, used, sources, tokens };
  }
}

/**
 * Вызов инструмента, написанный текстом в начале ответа:
 * `open(target="screen:meters")`, `my_requests(number="12")`, `[outages]`.
 * Аргументы — только пары ключ="значение"; остальное не разбираем.
 */
export function callInText(content: string, tools: Record<string, Tool>): { name: string; args: Record<string, unknown> } | null {
  const m = content.trim().match(/^\[?([a-z_]+)\]?\s*(?:\(([^)]*)\))?/);
  if (!m || !tools[m[1]]) return null;
  const args: Record<string, unknown> = {};
  for (const [, key, value] of (m[2] ?? '').matchAll(/([a-z_]+)\s*[=:]\s*["«']?([^"»',]+)["»']?/g)) args[key] = value.trim();
  return { name: m[1], args };
}
