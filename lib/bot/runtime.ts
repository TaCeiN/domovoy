import { existsSync } from 'node:fs';
import type { Database } from '../../db/client.ts';
import { MaxBot } from '../max/bot-api.ts';
import { GigaChat, readCa } from '../gigachat/client.ts';
import { handleMessage, type BotDeps, type Incoming, type Llm } from './handle.ts';
import { perKey, limit } from './queue.ts';

/**
 * Бот из окружения — один на процесс.
 *
 * Без `MAX_BOT_TOKEN` бота нет совсем. Без `GIGACHAT_AUTH_KEY` он
 * работает «глухим»: опасность, незнакомцы, «откройте приложение»
 * и жалоба словами человека — сломаться из-за пустого ключа нечему.
 *
 * Дневной потолок токенов по умолчанию — бесплатная квота Lite
 * (250 млн до 23.07.2027), делённая на ~300 дней.
 */

export interface BotRuntime {
  /** Поставить сообщение в очередь; ответ уходит в фоне */
  enqueue(msg: Incoming): void;
  /** Дождаться всех разборов — для тестов и остановки */
  idle(): Promise<void>;
}

const DEFAULT_CA = 'certs/russian_trusted_root_ca.crt';

/**
 * GigaChat из окружения с общей очередью на процесс; без ключа — null.
 *
 * Один на бота MAX и Домового в приложении: GIGACHAT_CONCURRENCY — это
 * потолок параллельных запросов к модели у всего сервера, а не у канала.
 */
let shared: { key: string; llm: Llm | null } | null = null;

export function createLlm(env: NodeJS.ProcessEnv = process.env): Llm | null {
  const key = env.GIGACHAT_AUTH_KEY ?? '';
  if (shared && shared.key === key) return shared.llm;
  const caPath = env.GIGACHAT_CA_FILE || (existsSync(DEFAULT_CA) ? DEFAULT_CA : undefined);
  const gigachat = key
    ? new GigaChat({
        authKey: key,
        scope: env.GIGACHAT_SCOPE,
        model: env.GIGACHAT_MODEL,
        apiBase: env.GIGACHAT_API_BASE,
        ca: readCa(caPath),
      })
    : null;
  const gate = limit(Math.max(1, Number(env.GIGACHAT_CONCURRENCY) || 1));
  const llm: Llm | null = gigachat && {
    callFunction: (messages, fn) => gate(() => gigachat.callFunction(messages, fn)),
    chat: (messages, functions) => gate(() => gigachat.chat(messages, functions)),
  };
  shared = { key, llm };
  return llm;
}

export function createRuntime(
  getDb: () => Database,
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<Pick<BotDeps, 'send' | 'llm'>> = {},
): BotRuntime | null {
  const token = env.MAX_BOT_TOKEN;
  const botUsername = env.MAX_BOT_USERNAME;
  if (!token || !botUsername) return null;

  const bot = new MaxBot({ token, baseUrl: env.MAX_API_BASE || undefined });
  const llm = overrides.llm !== undefined ? overrides.llm : createLlm(env);

  const deps = (): BotDeps => ({
    db: getDb(),
    llm,
    botUsername,
    send: overrides.send ?? (async (maxUserId, reply) => {
      await bot.sendMessage({ userId: maxUserId, text: reply.text, buttons: reply.buttons });
    }),
    dailyMessages: Number(env.BOT_DAILY_MESSAGES) || 30,
    dailyTokens: Number(env.GIGACHAT_DAILY_TOKENS) || 800_000,
  });

  const serial = perKey();
  const running = new Set<Promise<unknown>>();

  return {
    enqueue(msg) {
      const job = serial(String(msg.maxUserId), () => handleMessage(deps(), msg))
        .catch((error) => console.error('Бот MAX: сообщение не разобрано', error));
      running.add(job);
      void job.finally(() => running.delete(job));
    },
    async idle() {
      while (running.size) await Promise.all([...running]);
    },
  };
}
