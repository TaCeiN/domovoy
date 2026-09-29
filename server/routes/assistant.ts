import type { FastifyInstance } from 'fastify';
import { handleAppMessage, type Llm } from '../../lib/bot/handle.ts';
import { createLlm } from '../../lib/bot/runtime.ts';
import { perKey } from '../../lib/bot/queue.ts';
import { db, requireUser } from '../context.ts';
import { limited, LIMITS } from '../rate-limit.ts';

/**
 * Домовой — помощник внутри мини-приложения.
 *
 * Тот же разговор, что у бота MAX (lib/bot/handle.ts), но по сессии
 * жителя: работает и в браузере, где аккаунта MAX нет. Модель по-прежнему
 * видит только текст жителя, ответ собирает код.
 *
 */

let llm: Llm | null | undefined;

/** Для тестов: поддельная модель; undefined — снова из окружения. */
export function setAssistantLlm(value: Llm | null | undefined) {
  llm = value;
}

// Два сообщения одного жителя подряд разбираются по очереди: память
// диалога общая, и второй ответ должен видеть первый
const serial = perKey();

export async function assistantRoutes(app: FastifyInstance) {
  app.post('/api/assistant', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    if (limited(request, reply, 'assistant', LIMITS.assistant, user.id)) return;

    const body = request.body as { text?: unknown; propertyId?: unknown } | null;
    const text = typeof body?.text === 'string' ? body.text : '';
    if (!text.trim()) {
      return reply.code(400).send({ error: 'empty', message: 'Напишите вопрос' });
    }
    const propertyId = typeof body?.propertyId === 'string' ? body.propertyId : undefined;

    const replies = await serial(user.id, () => handleAppMessage({
      db: db(),
      llm: llm !== undefined ? llm : createLlm(),
      dailyMessages: Number(process.env.BOT_DAILY_MESSAGES) || 30,
      dailyTokens: Number(process.env.GIGACHAT_DAILY_TOKENS) || 800_000,
    }, { userId: user.id, propertyId, text }));

    return reply.send({ replies });
  });
}
