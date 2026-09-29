import type { FastifyInstance } from 'fastify';
import { attachReceipt } from '../../lib/auth/attach.ts';
import {
  createInvite, listInvites, revokeInvite, redeemInvite,
  REDEEM_CODES, REDEEM_MESSAGES,
} from '../../lib/auth/invites.ts';
import { repairEncoding } from '../../lib/qr/encoding.ts';
import {
  db, requireUser, verifyMax, readSessionToken, setSessionCookie,
} from '../context.ts';
import { createSession, resolveSession, findOrCreateMaxUser } from '../../lib/auth/session.ts';
import { limited, LIMITS } from '../rate-limit.ts';

/** Квитанции, которые человек относит к своему объекту. */
export async function propertyRoutes(app: FastifyInstance) {
  app.post('/api/properties/:propertyId/receipts', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { propertyId } = request.params as { propertyId: string };
    const body = request.body as { qr?: string; client?: string; source?: string };
    const qrString = typeof body?.qr === 'string' ? body.qr.trim() : '';

    if (!qrString) {
      return reply.code(400).send({
        error: 'no_qr',
        message: 'Отсканируйте или сфотографируйте квитанцию',
      });
    }

    const result = await attachReceipt(db(), { userId: user.id, propertyId, qrString });

    /**
     * Та же строка телеметрии, что на входе: без неё нельзя понять,
     * портит ли клиент MAX кодировку win-1251 именно на этом пути.
     */
    const probe = repairEncoding(qrString);
    request.log.info({
      scan: result.status === 'ok' ? 'accept' : 'reject',
      route: 'attach',
      source: body?.source ?? 'unknown',
      client: body?.client ?? null,
      header: qrString.slice(0, 7),
      repaired: probe.repaired,
      reason: result.status === 'ok' ? undefined : result.status,
    }, 'attach receipt');

    if (result.status === 'ok') {
      return reply.send({ status: 'ok', persAcc: result.persAcc });
    }

    if (result.status === 'no_access') {
      return reply.code(403).send({
        error: 'no_access',
        message: 'Нет доступа к объекту',
      });
    }

    if (result.status === 'account_elsewhere') {
      return reply.code(409).send({
        error: 'account_elsewhere',
        message: 'Этот лицевой счёт привязан к другой квартире. '
          + 'Перенести его может только управляющая компания',
      });
    }

    if (result.status === 'address_mismatch') {
      /**
       * Прочитанный адрес показываем целиком: он напечатан в квитанции,
       * которую человек только что держал в руках, и пришёл из его же
       * запроса — новых сведений о чужой квартире это не даёт.
       */
      return reply.code(409).send({
        error: 'address_mismatch',
        message: 'Эта квитанция по другому адресу — в ней напечатано: '
          + `${result.printedAddress}. Добавьте её через «Добавить недвижимость»`,
      });
    }

    return reply.code(400).send({
      error: 'invalid_qr',
      reason: result.reason,
      message: result.reason === 'mangled'
        ? 'Код прочитался с испорченной кодировкой. Сфотографируйте квитанцию: '
          + 'с фотографии приложение разберёт код само.'
        : 'Это не платёжный QR-код. Отсканируйте код с квитанции ЖКУ.',
    });
  });

  /**
   * Пригласить жильца.
   *
   * Право есть только у подтверждённого собственника этой квартиры:
   * он ручается за приглашённого, и поэтому доступ открывается сразу,
   * без председателя.
   */
  app.post('/api/properties/:propertyId/invites', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { propertyId } = request.params as { propertyId: string };
    const result = await createInvite(db(), user.id, propertyId);

    if (!result.ok) {
      return reply.code(403).send({
        error: 'not_owner',
        message: 'Приглашать жильцов может только собственник этой квартиры',
      });
    }

    return reply.send({
      status: 'ok',
      code: result.invite.code,
      expiresAt: result.invite.expiresAt,
    });
  });

  app.get('/api/properties/:propertyId/invites', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { propertyId } = request.params as { propertyId: string };
    return reply.send({ invites: await listInvites(db(), user.id, propertyId) });
  });

  app.delete('/api/invites/:inviteId', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { inviteId } = request.params as { inviteId: string };
    const ok = await revokeInvite(db(), user.id, inviteId);

    if (!ok) {
      return reply.code(404).send({
        error: 'not_found',
        message: 'Приглашение не найдено или им уже воспользовались',
      });
    }

    return reply.send({ status: 'ok' });
  });

  /**
   * Принять приглашение.
   *
   * Отдельно от входа по квитанции: здесь человека впускает не строка QR,
   * а поручительство собственника. Частоту ограничиваем — код короткий,
   * и перебор должен упираться в счётчик, а не в удачу.
   */
  app.post('/api/invites/redeem', async (request, reply) => {
    if (limited(request, reply, 'invite', LIMITS.receipt)) return;

    /**
     * Приглашённого человека в системе может ещё не быть вовсе.
     *
     * У него нет ни квитанции, ни сессии — только код и подпись
     * мессенджера. Поэтому здесь, как и на входе по квитанции, личность
     * подтверждает платформа, а учётка заводится на месте. В браузере
     * такого доказательства нет, и там нужна уже открытая сессия.
     */
    const max = verifyMax(request);
    const session = await resolveSession(db(), readSessionToken(request));
    let user: { id: string } | null = session;
    let freshSession = false;

    if (!user && max) {
      user = await findOrCreateMaxUser(db(), {
        maxUserId: max.user.id,
        firstName: max.user.first_name,
        lastName: max.user.last_name,
        username: max.user.username,
        photoUrl: max.user.photo_url,
        chatId: max.chat?.id ?? null,
      });
      freshSession = true;
    }

    if (!user) {
      return reply.code(401).send({
        error: 'unauthorized',
        message: 'Откройте приложение через мессенджер MAX — там вход по коду работает без квитанции',
      });
    }

    const body = request.body as { code?: string };
    const result = await redeemInvite(db(), user.id, body?.code ?? '');

    if (!result.ok) {
      return reply.code(REDEEM_CODES[result.reason]).send({
        error: result.reason,
        message: REDEEM_MESSAGES[result.reason],
      });
    }

    /**
     * Сессию выдаём только после успешного кода: иначе перебор кодов
     * плодил бы учётки и сессии на каждую попытку.
     */
    let token: string | undefined;
    if (freshSession) {
      const created = await createSession(db(), user.id, 'max');
      setSessionCookie(reply, created.token, created.expiresAt);
      token = created.token;
    }

    return reply.send({
      status: 'ok',
      propertyId: result.propertyId,
      addressRaw: result.addressRaw,
      token,
    });
  });
}
