import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/client.ts';
import { resolveSession, SESSION_COOKIE, type SessionUser } from '../lib/auth/session.ts';
import { validateInitData, type MaxInitData } from '../lib/max/init-data.ts';

/**
 * Общий контекст запроса: кто пришёл и с какой платформы.
 *
 * Данные MAX проверяются ТОЛЬКО здесь, на сервере, и только по подписи.
 * Клиентскому initDataUnsafe не верим ни в каком виде: к max_user_id
 * привязан лицевой счёт, адрес и история платежей.
 */

export const db = () => getDb();

export interface Auth {
  user: SessionUser | null;
  max: MaxInitData | null;
}

/**
 * Фрагмент URL браузер на сервер не отправляет, поэтому клиент обязан
 * передать initData явно — заголовком X-Max-Init-Data или в теле запроса.
 */
export function readInitData(request: FastifyRequest): string | null {
  const header = request.headers['x-max-init-data'];
  if (typeof header === 'string' && header.length > 0) return header;

  const body = request.body as { initData?: unknown } | undefined;
  if (body && typeof body.initData === 'string' && body.initData.length > 0) {
    return body.initData;
  }
  return null;
}

export function verifyMax(request: FastifyRequest): MaxInitData | null {
  const raw = readInitData(request);
  if (!raw) return null;

  const token = process.env.MAX_BOT_TOKEN;
  if (!token) {
    request.log.warn('MAX_BOT_TOKEN не задан — вход через MAX недоступен');
    return null;
  }

  const result = validateInitData(raw, { botToken: token });
  if (!result.ok) {
    request.log.warn({ reason: result.reason }, 'initData не прошли проверку');
    return null;
  }
  return result.data;
}

/**
 * Токен сессии: сначала заголовок, потом кука.
 *
 * Заголовок — основной путь: фронт живёт на GitHub Pages, API на другом
 * домене, и сторонняя кука там работает через раз (вебвью на iOS режет
 * её борьбой с трекингом). Кука остаётся для локальной разработки,
 * где статика и API на одном origin.
 */
export function readSessionToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    const value = header.slice(7).trim();
    if (value) return value;
  }
  return request.cookies?.[SESSION_COOKIE];
}

export async function authenticate(request: FastifyRequest): Promise<Auth> {
  return {
    user: await resolveSession(db(), readSessionToken(request)),
    max: verifyMax(request),
  };
}

/** Ставит куку сессии. httpOnly обязателен: JS не должен читать токен. */
export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Обёртка для защищённых маршрутов. */
export async function requireUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionUser | null> {
  const auth = await authenticate(request);
  if (!auth.user) {
    reply.code(401).send({ error: 'unauthorized', message: 'Нужно войти' });
    return null;
  }
  return auth.user;
}
