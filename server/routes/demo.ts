import type { FastifyInstance } from 'fastify';
import { db, verifyMax, setSessionCookie } from '../context.ts';
import { listRoles, takeRole, releasedFor, enterRole } from '../../lib/demo/roles.ts';
import { isDemoEnabled } from '../../lib/demo/setting.ts';

/**
 * Демо-дом на экране входа.
 *
 * Подпись MAX необязательна: в MAX роль держится на аккаунте эксперта,
 * в браузере вход — просто сессия персонажа без держателя. Выключенное
 * в кабинете оператора демо отвечает 404 — блока на экране нет.
 */
export async function demoRoutes(app: FastifyInstance) {
  const who = (max: NonNullable<ReturnType<typeof verifyMax>>) =>
    [max.user.first_name, max.user.last_name ? `${max.user.last_name.charAt(0)}.` : ''].filter(Boolean).join(' ');

  const off = { error: 'no_demo', message: 'Демо-дом сейчас выключен' };

  app.get('/api/demo/roles', async (request, reply) => {
    if (!await isDemoEnabled(db())) return reply.code(404).send(off);
    const max = verifyMax(request);
    const roles = await listRoles(db(), max?.user.id ?? -1);
    if (roles.length === 0) return reply.code(404).send(off);
    return reply.send({ roles, released: max ? await releasedFor(db(), max.user.id) : null, inMax: Boolean(max) });
  });

  app.post('/api/demo/roles/:key/take', async (request, reply) => {
    if (!await isDemoEnabled(db())) return reply.code(404).send(off);
    const { key } = request.params as { key: string };
    const body = (request.body ?? {}) as { takeover?: boolean; unlinkMine?: boolean };
    const max = verifyMax(request);

    if (!max) {
      const web = await enterRole(db(), key);
      if (!web.ok) return reply.code(404).send({ error: 'not_found', message: 'Такой роли нет' });
      setSessionCookie(reply, web.token, web.expiresAt);
      return reply.send({ token: web.token });
    }

    const result = await takeRole(db(), {
      key, maxUserId: max.user.id, maxChatId: max.chat?.id ?? null, name: who(max),
      takeover: body.takeover === true, unlinkMine: body.unlinkMine === true,
    });
    if (result.ok) {
      setSessionCookie(reply, result.token, result.expiresAt);
      return reply.send({ token: result.token });
    }
    if (result.reason === 'not_found') return reply.code(404).send({ error: 'not_found', message: 'Такой роли нет' });
    if (result.reason === 'taken') {
      return reply.code(409).send({ error: 'taken', holderName: result.holderName, heldSince: result.heldSince,
        message: 'Роль сейчас у другого эксперта' });
    }
    return reply.code(409).send({ error: 'has_own', ownName: result.ownName,
      message: 'К вашему аккаунту MAX уже привязан житель' });
  });
}
