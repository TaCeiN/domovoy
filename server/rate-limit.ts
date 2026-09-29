import type { FastifyReply, FastifyRequest } from 'fastify';
import { consume, type RateLimit } from '../lib/rate-limit.ts';

export { LIMITS, resetRateLimits, consume } from '../lib/rate-limit.ts';
export type { RateLimit } from '../lib/rate-limit.ts';

/**
 * HTTP-обвязка над счётчиком.
 *
 * Сам счётчик живёт в lib/rate-limit.ts и про Fastify не знает: его
 * сбрасывают тесты между прогонами, а тянуть ради этого веб-фреймворк
 * в общий код незачем.
 *
 * Возвращает `true`, когда обработчику надо остановиться, — так же,
 * как это делает `requireUser`.
 */
export function limited(
  request: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  rule: RateLimit,
  extraKey?: string,
): boolean {
  const key = `${scope}:${extraKey ?? request.ip}`;
  const verdict = consume(key, rule);
  if (verdict.allowed) return false;

  request.log.warn({ scope, ip: request.ip }, 'превышена частота запросов');
  reply
    .code(429)
    .header('Retry-After', String(verdict.retryAfter))
    .send({
      error: 'too_many_requests',
      message: `Слишком много попыток. Попробуйте через ${verdict.retryAfter} с.`,
    });
  return true;
}
