import type { FastifyInstance } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readDraft } from '../../lib/bot/drafts.ts';
import { createRuntime, type BotRuntime } from '../../lib/bot/runtime.ts';
import { incomingFromUpdate } from '../../lib/bot/updates.ts';
import { db, requireUser } from '../context.ts';

/**
 * Бот MAX: вебхук и черновики для мини-приложения.
 *
 * Кнопка бота «Подтвердить заявку» открывает мини-приложение с `d_<id>`,
 * и форма жалобы забирает черновик отсюда. Чужой, протухший или уже
 * отправленный черновик — одна и та же 404: человеку всё равно, почему,
 * а форма откроется пустой.
 *
 */

let runtime: BotRuntime | null | undefined;

/** Для тестов: свой бот с поддельными отправкой и моделью. */
export function setBotRuntime(value: BotRuntime | null | undefined) {
  runtime = value;
}

function botRuntime(): BotRuntime | null {
  if (runtime === undefined) runtime = createRuntime(db);
  return runtime;
}

/** Сравнение секрета без утечки по времени: хеши одной длины. */
function sameSecret(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function botRoutes(app: FastifyInstance) {
  app.get('/api/bot/drafts/:id', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };
    const draft = await readDraft(db(), user.id, id);
    if (!draft) {
      return reply.code(404).send({ error: 'draft_gone', message: 'Черновик устарел — опишите заново' });
    }
    return reply.send(draft);
  });

  /**
   * Сообщения боту от MAX.
   *
   * Ответ 200 — сразу, разбор — в фоне: MAX ждёт не дольше 30 секунд
   * и повторяет событие, а GigaChat может думать и дольше. Повтор
   * отсекается по mid в `bot_seen`.
   */
  app.post('/api/max/webhook', async (request, reply) => {
    const secret = process.env.BOT_WEBHOOK_SECRET;
    if (!secret) return reply.code(404).send({ error: 'not_found' });
    if (!sameSecret(request.headers['x-max-bot-api-secret'], secret)) {
      return reply.code(401).send({ error: 'bad_secret' });
    }

    const incoming = incomingFromUpdate(request.body);
    const bot = botRuntime();
    if (bot && incoming) bot.enqueue(incoming);
    return reply.send({ ok: true });
  });
}
