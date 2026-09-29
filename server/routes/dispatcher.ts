import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { dispatcher, post } from '../../db/schema.ts';
import { verifyPasswordOrBurnTime } from '../../lib/auth/password.ts';
import {
  createDispatcherSession, resolveDispatcherSession, destroySession, SESSION_COOKIE,
  type SessionDispatcher,
} from '../../lib/auth/session.ts';
import { readAttachment } from '../../lib/requests/attachments.ts';
import { savePostPhoto, PHOTO_CODES, PHOTO_MESSAGES } from '../../lib/house/photos.ts';
import {
  listForDispatcher, getForDispatcher, changeStatus, addDispatcherComment, STATUSES, type RequestStatus,
} from '../../lib/requests/service.ts';
import {
  createPost, createPoll, notifyHouse, houseAccounts, removePost, managedPosts,
  listPollsForHouses, verifyPropertyAddress, orgHouses, orgById, orgOwnsHouse,
  addHouseToOrg,
  POST_CATEGORIES, POLL_ERRORS, type PostCategory,
} from '../../lib/house/service.ts';
import {
  createChairman, revokeChairman, listChairmen, chairmanCandidates,
} from '../../lib/house/chairman.ts';
import {
  contactKinds, listContacts, saveContact, findContact, removeContact, readContactBody,
} from '../../lib/house/contacts.ts';
import { claimsForDispatcher, decidersForHouse } from '../../lib/auth/claims.ts';
import { parseOptionalDate, parseOptionalDateOrUndefined } from '../../lib/dates.ts';
import { limited, LIMITS } from '../rate-limit.ts';
import { db, setSessionCookie, clearSessionCookie, readSessionToken } from '../context.ts';
import { readLimit, matchesQuery } from '../../lib/lists.ts';
import { readSort, sortRequests } from '../../lib/requests/sort.ts';

/**
 * Кабинет диспетчера УК.
 *
 * Именно он продаётся управляющей компании: очередь заявок со сроками
 * и видимой просрочкой. Приложение жителя без этого кабинета — витрина,
 * в которой статусы никто не проставляет.
 */

async function requireDispatcher(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionDispatcher | null> {
  const found = await resolveDispatcherSession(db(), readSessionToken(request));
  if (!found) {
    reply.code(401).send({ error: 'unauthorized', message: 'Войдите в кабинет' });
    return null;
  }
  return found;
}

/**
 * Совпадает ли заявка с тем, что назвали диспетчеру.
 *
 * ЧИСЛО ИЩЕТСЯ ДВУМЯ СПОСОБАМИ. Номер заявки жители и сами диспетчеры
 * называют без ведущих нулей («двести седьмая»), а на экране он написан
 * как «00207» — совпадать должно и то и другое. Номер квартиры при этом
 * сверяется ТОЧНО: «кв. 7» не должна вытаскивать 17, 27 и 47.
 *
 * Категория в поиск не входит: по слову «лифт» диспетчер ищет заявку
 * про лифт, а не все заявки категории «Лифт» за год.
 */
function matchesRequest(
  r: { number: number; title: string; address: string | null; flat: string | null },
  q: string,
): boolean {
  if (!q) return true;

  const padded = String(r.number).padStart(5, '0');
  const digits = q.match(/\d+/)?.[0];

  if (digits) {
    if (Number(digits) === r.number || digits === padded) return true;
    if ((r.flat ?? '').trim() === digits) return true;
  }

  /**
   * Голое число ищется ТОЛЬКО как номер заявки или квартиры.
   *
   * Подстрокой оно совпало бы с любым адресом: в «д. 85, к. 3, кв. 15»
   * единица встречается дважды, и запрос «1» вытаскивал бы весь дом.
   */
  if (digits === q.replace(/\s+/g, '')) return false;

  return matchesQuery([r.title, r.address], q);
}

export async function dispatcherRoutes(app: FastifyInstance) {
  app.post('/api/dispatcher/login', async (request, reply) => {
    const body = request.body as { login?: string; password?: string };
    const login = (body?.login ?? '').trim();
    const password = body?.password ?? '';

    if (limited(request, reply, 'dispatcher-login', LIMITS.login)) return;

    const rows = await db()
      .select()
      .from(dispatcher)
      .where(eq(dispatcher.login, login))
      .limit(1);

    // Одинаковый ответ И одинаковое время на неверный логин и неверный
    // пароль: иначе перебором выясняется, какие логины существуют
    const ok = await verifyPasswordOrBurnTime(password, rows[0]?.passwordHash);
    if (!ok || !rows[0]) {
      return reply.code(401).send({
        error: 'bad_credentials',
        message: 'Неверный логин или пароль',
      });
    }

    const { token, expiresAt } = await createDispatcherSession(db(), rows[0].id);
    setSessionCookie(reply, token, expiresAt);
    return reply.send({ status: 'ok', token, name: rows[0].name });
  });

  app.post('/api/dispatcher/logout', async (request, reply) => {
    await destroySession(db(), readSessionToken(request));
    clearSessionCookie(reply);
    return reply.send({ status: 'ok' });
  });

  app.get('/api/dispatcher/me', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;
    return reply.send({ id: me.id, name: me.name, ukId: me.ukId });
  });

  /** Очередь: просроченные сверху, закрытые в конце. */
  app.get('/api/dispatcher/requests', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const query = request.query as { status?: string };
    const status = STATUSES.includes(query?.status as RequestStatus)
      ? (query.status as RequestStatus)
      : undefined;

    /**
     * Счётчики считаем по ВСЕЙ очереди, а фильтр применяем только к списку.
     *
     * Иначе они описывают сами себя: с выбранным фильтром «Новые» в графах
     * «В работе» и «Просрочено» стоят нули, и диспетчер видит пустую сводку
     * ровно тогда, когда сводка ему и нужна.
     */
    const all = await listForDispatcher(db(), me.ukId);
    const byStatus = status ? all.filter((r) => r.status === status) : all;

    /**
     * «Просрочено» и «Житель ответил» — не статусы, а признаки, и раньше
     * кабинет отбирал их у себя, уже получив всю очередь. С потолком
     * выдачи так нельзя: восемнадцать просроченных заявок могут целиком
     * оказаться за пределами первых пятидесяти, и самая важная плитка
     * экрана показала бы пустоту.
     */
    const flag = (request.query as { flag?: string })?.flag;
    const byFlag = flag === 'overdue'
      ? byStatus.filter((r) => r.sla === 'overdue' && !r.closedAt)
      : flag === 'awaiting'
        ? byStatus.filter((r) => r.awaitingUk)
        : byStatus;

    /**
     * Поиск: сначала статус, потом запрос.
     *
     * Диспетчер работает по звонку — «мне назвали двести седьмую»
     * или «мне назвали адрес». До этого поля оба сценария решались
     * листанием тридцати экранов глазами.
     */
    /**
     * Дом — выбором из списка, а не поиском. Диспетчер крупной УК думает
     * домами («что у нас на Ленина, 85»), и набирать адрес руками ради
     * этого не должен: список домов с заявками приходит в ответе.
     */
    const houseKey = (request.query as { house?: string })?.house;
    const byHouse = houseKey ? byFlag.filter((r) => r.houseKey === houseKey) : byFlag;

    const q = ((request.query as { q?: string })?.q ?? '').trim();
    const found = sortRequests(
      byHouse.filter((r) => matchesRequest(r, q)),
      readSort((request.query as { sort?: string })?.sort),
    );

    const limit = readLimit((request.query as { limit?: string })?.limit);
    const rows = found.slice(0, limit);

    return reply.send({
      /** Сколько нашлось — это про выдачу, а счётчики ниже про организацию */
      total: found.length,
      counters: {
        total: all.length,
        new: all.filter((r) => r.status === 'new').length,
        in_work: all.filter((r) => r.status === 'in_work').length,
        need_info: all.filter((r) => r.status === 'need_info').length,
        // Житель ответил, а УК ещё нет: без этой графы ответ на уточнение
        // тонет в очереди и заявка стоит, хотя ждут уже не жителя
        awaiting_uk: all.filter((r) => r.awaitingUk).length,
        overdue: all.filter((r) => r.sla === 'overdue' && !r.closedAt).length,
      },
      /** Дома, где у организации есть заявки, — для выбора без поиска */
      houses: queueHouses(all),
      requests: rows.map((r) => ({
        id: r.id,
        number: String(r.number).padStart(5, '0'),
        category: r.category,
        title: r.title,
        description: r.description,
        status: r.status,
        statusLabel: r.statusLabel,
        sla: r.sla,
        slaLabel: r.slaLabel,
        address: r.address,
        street: r.street,
        house: r.house,
        block: r.block,
        flat: r.flat,
        authorName: r.authorName,
        assigneeName: r.assigneeName,
        createdAt: r.createdAt,
        lastMessage: r.lastMessage,
        awaitingUk: r.awaitingUk,
      })),
    });
  });

  /** Карточка заявки: переписка целиком, контакт жителя, доступные переходы. */
  app.get('/api/dispatcher/requests/:id', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const found = await getForDispatcher(db(), me.ukId, id);
    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Заявка не найдена' });
    }

    return reply.send({
      id: found.id,
      number: String(found.number).padStart(5, '0'),
      kind: found.kind,
      category: found.category,
      title: found.title,
      description: found.description,
      status: found.status,
      statusLabel: found.statusLabel,
      closed: found.closed,
      allowed: found.allowed,
      awaitingUk: found.awaitingUk,
      awaitingResident: found.awaitingResident,
      sla: found.sla,
      slaLabel: found.slaLabel,
      address: found.address,
      street: found.street,
      house: found.house,
      block: found.block,
      flat: found.flat,
      authorName: found.authorName,
      authorPhone: found.authorPhone,
      authorPhoneVerified: found.authorPhoneVerified,
      notifiable: found.notifiable,
      assigneeName: found.assigneeName,
      rejectReason: found.rejectReason,
      masterSlotStart: found.masterSlotStart,
      masterSlotEnd: found.masterSlotEnd,
      createdAt: found.createdAt,
      closedAt: found.closedAt,
      events: found.events,
      photos: found.photos,
      rating: found.rating,
    });
  });

  app.post('/api/dispatcher/requests/:id/status', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const body = request.body as {
      status?: RequestStatus; comment?: string;
      assigneeName?: string; rejectReason?: string;
    };

    if (!STATUSES.includes(body?.status as RequestStatus)) {
      return reply.code(400).send({
        error: 'bad_status',
        message: `Статус должен быть одним из: ${STATUSES.join(', ')}`,
      });
    }

    if (body.status === 'rejected' && !body.rejectReason?.trim()) {
      return reply.code(400).send({
        error: 'reason_required',
        message: 'Укажите причину отклонения — житель должен понимать, почему',
      });
    }

    /**
     * «Нужны уточнения» без вопроса — тупик. Житель видит, что от него
     * чего-то ждут, но не знает чего, и звонит в УК: ровно тот звонок,
     * ради снятия которого всё и делается.
     */
    if (body.status === 'need_info' && !body.comment?.trim()) {
      return reply.code(400).send({
        error: 'question_required',
        message: 'Напишите, что именно уточнить — иначе житель не поймёт, чего от него ждут',
      });
    }

    const result = await changeStatus(db(), {
      requestId: id,
      to: body.status as RequestStatus,
      actor: 'dispatcher',
      comment: body.comment,
      assigneeName: body.assigneeName,
      rejectReason: body.rejectReason,
      actorName: me.name,
      ukId: me.ukId,
    });

    if (!result.ok) {
      const messages: Record<string, string> = {
        not_found: 'Заявка не найдена',
        forbidden: 'Заявка относится к другой управляющей компании',
        bad_transition: 'Такой переход статуса недопустим',
      };
      const codes: Record<string, number> = { not_found: 404, forbidden: 403, bad_transition: 409 };
      return reply.code(codes[result.reason]).send({
        error: result.reason,
        message: messages[result.reason],
      });
    }

    return reply.send({ status: 'ok', notified: result.notified });
  });

  /** Сообщение жителю без смены статуса — строка ввода в чате заявки */
  app.post('/api/dispatcher/requests/:id/comment', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const body = request.body as { text?: string };
    const result = await addDispatcherComment(db(), {
      ukId: me.ukId, dispatcherName: me.name, requestId: id, text: body?.text ?? '',
    });

    if (!result.ok) {
      const messages: Record<string, string> = {
        empty: 'Напишите сообщение — пустое житель не поймёт',
        not_found: 'Заявка не найдена',
        forbidden: 'Заявка относится к другой управляющей компании',
        closed: 'Заявка закрыта — написать в неё нельзя',
      };
      const codes: Record<string, number> = { empty: 400, not_found: 404, forbidden: 403, closed: 409 };
      return reply.code(codes[result.reason]).send({ error: result.reason, message: messages[result.reason] });
    }
    return reply.code(201).send({ status: 'ok' });
  });

  /**
   * Дома организации из реестра лицензий.
   *
   * Появляются сразу после подключения УК, ещё до первого жителя: связка
   * «дом → компания» берётся из ГИС ЖКХ, а не из чьей-то квитанции.
   */
  app.get('/api/dispatcher/houses', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const houses = await orgHouses(db(), me.ukId);
    const org = await orgById(db(), me.ukId);

    return reply.send({
      organization: org && {
        name: org.shortName ?? org.name,
        inn: org.inn,
        licenseNumber: org.licenseNumber,
        houseCountByLicense: org.houseCount,
      },
      total: houses.length,
      withResidents: houses.filter((h) => h.linkedProperties > 0).length,
      houses,
    });
  });

  /**
   * Добавить дом в свой фонд вручную.
   *
   * Реестр ГИС ЖКХ отдаёт дома не всех организаций, а смена управляющей
   * компании доходит до него неделями. Без ручного ввода жители таких
   * домов остаются без УК, хотя компания уже работает в сервисе.
   */
  app.post('/api/dispatcher/houses', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const body = request.body as { address?: string };
    const result = await addHouseToOrg(db(), me.ukId, (body?.address ?? '').trim());

    if (!result.ok) {
      if (result.reason === 'taken') {
        return reply.code(409).send({
          error: 'taken',
          message: `Этот дом уже закреплён за «${result.byOrg ?? 'другой организацией'}». `
            + 'Если дом перешёл к вам, вопрос решается через жилищную инспекцию, '
            + 'а не в приложении.',
        });
      }
      return reply.code(400).send({
        error: 'bad_address',
        message: 'Не удалось разобрать адрес. Нужен полный адрес с номером дома, '
          + 'например: 344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85/3',
      });
    }

    return reply.code(201).send({
      status: 'ok',
      houseKey: result.houseKey,
      alreadyMine: result.alreadyMine,
    });
  });

  /**
   * Телефоны дома: УК вписывает их для своих домов по реестру.
   * Жители видят их на экране аварийных служб с подписью «добавила
   * управляющая компания».
   */
  const notYourHouse = { error: 'not_your_house', message: 'Этот дом не за вашей организацией' };

  app.get('/api/dispatcher/houses/:houseKey/contacts', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;
    const { houseKey } = request.params as { houseKey: string };
    if (!await orgOwnsHouse(db(), me.ukId, houseKey)) return reply.code(403).send(notYourHouse);
    return reply.send({ kinds: contactKinds(), contacts: await listContacts(db(), houseKey) });
  });

  app.post('/api/dispatcher/houses/:houseKey/contacts', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;
    const { houseKey } = request.params as { houseKey: string };
    if (!await orgOwnsHouse(db(), me.ukId, houseKey)) return reply.code(403).send(notYourHouse);

    const result = await saveContact(db(), {
      houseKey, ...readContactBody(request.body), role: 'dispatcher', by: me.id,
    });
    if (!result.ok) return reply.code(400).send({ error: result.reason, message: result.message });
    return reply.code(201).send({ status: 'ok', id: result.id });
  });

  app.post('/api/dispatcher/houses/:houseKey/contacts/:id/remove', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;
    const { houseKey, id } = request.params as { houseKey: string; id: string };
    if (!await orgOwnsHouse(db(), me.ukId, houseKey)) return reply.code(403).send(notYourHouse);

    const found = await findContact(db(), id);
    if (!found || found.houseKey !== houseKey) {
      return reply.code(404).send({ error: 'not_found', message: 'Такого номера в доме нет' });
    }
    await removeContact(db(), id);
    return reply.send({ ok: true });
  });

  /** Лицевые счета дома: видно, кто уже зарегистрировался, а кто нет. */
  app.get('/api/dispatcher/accounts', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const accounts = await houseAccounts(db(), me.ukId);
    return reply.send({
      total: accounts.length,
      registered: accounts.filter((a) => a.registered).length,
      accounts,
    });
  });

  /**
   * Подтвердить адрес, который житель выбрал сам.
   *
   * Появляется, когда в квитанции адреса нет: расчётные центры печатают
   * QR без него, и житель указывает дом из справочника. Сверить с лицевым
   * счётом может только УК — у неё биллинг.
   */
  app.post('/api/dispatcher/properties/:id/verify-address', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const ok = await verifyPropertyAddress(db(), me.ukId, id);
    if (!ok) {
      return reply.code(404).send({ error: 'not_found', message: 'Объект не найден' });
    }
    return reply.send({ status: 'ok' });
  });

  /**
   * Объявление жителям дома.
   *
   * Уведомление рассылаем только для аварийных отключений: будить человека
   * ради новости или собрания — верный способ добиться, чтобы он отключил
   * уведомления совсем.
   */
  app.post('/api/dispatcher/posts', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const body = request.body as {
      houseKey?: string; category?: PostCategory; title?: string; body?: string;
      expiresAt?: string;
    };

    const title = (body?.title ?? '').trim();
    const text = (body?.body ?? '').trim();
    const category = body?.category ?? 'news';

    if (!body?.houseKey) {
      return reply.code(400).send({ error: 'no_house', message: 'Не выбран дом' });
    }
    if (!POST_CATEGORIES.includes(category)) {
      return reply.code(400).send({
        error: 'bad_category',
        message: `Категория должна быть одной из: ${POST_CATEGORIES.join(', ')}`,
      });
    }
    if (title.length < 3 || text.length < 5) {
      return reply.code(400).send({ error: 'too_short', message: 'Заполните заголовок и текст' });
    }

    const expires = parseOptionalDate(body?.expiresAt);
    if (!expires.ok) {
      return reply.code(400).send({
        error: 'bad_date',
        message: 'Не удалось разобрать срок актуальности. Оставьте поле пустым, если срока нет',
      });
    }

    // Дом должен числиться за этой УК в реестре лицензий
    if (!await orgOwnsHouse(db(), me.ukId, body.houseKey)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Этот дом не обслуживается вашей УК' });
    }

    const id = await createPost(db(), {
      houseKey: body.houseKey,
      ukId: me.ukId,
      authorId: null,
      type: 'uk',
      category,
      title,
      body: text,
      // Срок актуальности: без него баннер отключения висит вечно
      expiresAt: expires.date,
    });

    const notified = category === 'outage'
      // Срок едет в сообщение: ради него его и вводят — «нет воды до 18:00»
      ? await notifyHouse(db(), body.houseKey, title, text, expires.date)
      : 0;

    return reply.code(201).send({ status: 'ok', id, notified });
  });

  /**
   * Фотография к объявлению своего дома.
   *
   * Отдельный маршрут, а не общий с жителем: у диспетчера своя учётка
   * и своя сессия, `requireUser` его не пропустит. Право то же, что
   * на публикацию, — дом обязан обслуживаться его организацией.
   */
  app.post('/api/dispatcher/posts/:id/photo', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };

    const [row] = await db()
      .select({ houseKey: post.houseKey })
      .from(post)
      .where(eq(post.id, id))
      .limit(1);

    if (!row || !await orgOwnsHouse(db(), me.ukId, row.houseKey)) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Этот дом не обслуживается вашей УК',
      });
    }

    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'no_file', message: 'Выберите фотографию' });
    }

    let bytes: Buffer;
    try {
      bytes = await file.toBuffer();
    } catch {
      return reply.code(413).send({ error: 'too_large', message: PHOTO_MESSAGES.too_large });
    }

    const saved = await savePostPhoto(db(), { postId: id, bytes });
    if (!saved.ok) {
      return reply.code(PHOTO_CODES[saved.reason])
        .send({ error: saved.reason, message: PHOTO_MESSAGES[saved.reason] });
    }

    return reply.send({ status: 'ok' });
  });

  /** Что уже опубликовано по домам УК: со снятыми и истёкшими. */
  app.get('/api/dispatcher/posts', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;
    const posts = await managedPosts(db(), { ukId: me.ukId });
    const limit = readLimit((request.query as { limit?: string })?.limit);
    return reply.send({ posts: posts.slice(0, limit), total: posts.length });
  });

  /**
   * Снять объявление.
   *
   * Без этого «нет воды до 18:00» висело до следующего отключения:
   * срока у объявления не было, убрать его было нечем.
   */
  app.delete('/api/dispatcher/posts/:id', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const ok = await removePost(db(), id, { ukId: me.ukId });
    if (!ok) {
      return reply.code(404).send({ error: 'not_found', message: 'Объявление не найдено' });
    }
    return reply.send({ status: 'ok' });
  });

  /* ─────────────── заявки жителей: ТОЛЬКО ПРОСМОТР ─────────────── */

  /**
   * Кто в домах организации ждёт подтверждения.
   *
   * ПОДТВЕРЖДАТЬ УК НЕ МОЖЕТ, и это осознанно. Диспетчер заходит в кабинет
   * хорошо если раз в месяц — строить на нём ежедневный поток нельзя,
   * жители застряли бы в очереди навсегда. Подтверждает председатель
   * совета дома: он живёт в этом доме и знает соседей в лицо.
   *
   * УК здесь наблюдатель. Смысл списка ровно один: увидеть, что в доме
   * копятся заявки, а председателя нет, — и назначить его. Поэтому
   * кнопок «подтвердить» и «отклонить» тут нет ни одной.
   */
  app.get('/api/dispatcher/claims', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const claims = await claimsForDispatcher(db(), me.ukId);

    /** По каким домам ждут и есть ли там кому подтверждать */
    const houses = new Map<string, { houseKey: string; address: string; waiting: number }>();
    for (const c of claims) {
      const entry = houses.get(c.houseKey)
        ?? { houseKey: c.houseKey, address: c.address, waiting: 0 };
      entry.waiting += 1;
      houses.set(c.houseKey, entry);
    }

    const withChairman = await Promise.all(
      [...houses.values()].map(async (h) => ({
        ...h,
        hasChairman: (await decidersForHouse(db(), h.houseKey)).chairman,
      })),
    );

    return reply.send({
      total: claims.length,
      claims,
      /** Дома, где ждут и подтвердить некому — им нужен председатель */
      needChairman: withChairman.filter((h) => !h.hasChairman),
    });
  });

  /* ─────────────── председатели домов ─────────────── */

  app.get('/api/dispatcher/chairmen', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;
    return reply.send({ chairmen: await listChairmen(db(), me.ukId) });
  });

  /**
   * Назначить председателя.
   *
   * Пароль генерируется здесь и показывается ОДИН раз: в базе только хеш.
   * Диспетчер, знающий пароль председателя, обесценивает его подпись под
   * объявлениями — публиковать «от совета дома» смогла бы сама УК.
   */
  app.post('/api/dispatcher/chairmen', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const body = request.body as { houseKey?: string; userId?: string };

    if (!body?.houseKey) {
      return reply.code(400).send({ error: 'no_house', message: 'Не выбран дом' });
    }
    if (!body?.userId) {
      return reply.code(400).send({
        error: 'no_user',
        message: 'Выберите жителя дома — председателем может стать только он',
      });
    }

    const result = await createChairman(db(), {
      houseKey: body.houseKey,
      userId: body.userId,
      by: { kind: 'dispatcher', orgId: me.ukId, id: me.id },
    });

    if (!result.ok) {
      const messages: Record<string, string> = {
        foreign_house: 'Этот дом не обслуживается вашей УК',
        not_a_resident: 'Этот человек не заявлял о проживании в этом доме',
        already_exists: 'У дома уже есть действующий председатель — сначала снимите его',
      };
      const codes: Record<string, number> = {
        foreign_house: 403, not_a_resident: 400, already_exists: 409,
      };
      return reply.code(codes[result.reason]).send({
        error: result.reason,
        message: messages[result.reason],
      });
    }

    /**
     * Пароля больше нет и передавать нечего.
     *
     * Председатель входит своим обычным аккаунтом жителя — раздел
     * «Совет дома» просто появляется у него в приложении.
     */
    return reply.code(201).send({ status: 'ok', id: result.id, name: result.name });
  });

  /**
   * Из кого можно выбрать председателя.
   *
   * Из всех, кто предъявил квитанцию по этому дому, включая
   * неподтверждённых: пока председателя нет, подтверждать некому,
   * и подтверждённых в доме ноль. Это и есть точка старта дома.
   */
  app.get('/api/dispatcher/chairman-candidates', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const { houseKey } = request.query as { houseKey?: string };
    if (!houseKey) {
      return reply.code(400).send({ error: 'no_house', message: 'Не выбран дом' });
    }

    return reply.send({ candidates: await chairmanCandidates(db(), me.ukId, houseKey) });
  });

  app.post('/api/dispatcher/chairmen/:id/revoke', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const ok = await revokeChairman(db(), { kind: 'dispatcher', orgId: me.ukId, id: me.id }, id);
    if (!ok) {
      return reply.code(404).send({ error: 'not_found', message: 'Председатель не найден' });
    }
    return reply.send({ status: 'ok' });
  });


  /** Опросы по всем домам УК: явка и результаты, без своего голоса. */
  app.get('/api/dispatcher/polls', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const houses = await orgHouses(db(), me.ukId);
    return reply.send({ polls: await listPollsForHouses(db(), houses.map((h) => h.houseKey)) });
  });

  app.post('/api/dispatcher/polls', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const body = request.body as {
      houseKey?: string; title?: string; description?: string;
      options?: string[]; closesAt?: string;
    };

    if (!body?.houseKey || !(body.title ?? '').trim()) {
      return reply.code(400).send({ error: 'bad_input', message: 'Нужны дом и заголовок' });
    }

    const closes = parseOptionalDateOrUndefined(body?.closesAt);
    if (!closes.ok) {
      return reply.code(400).send({
        error: 'bad_date',
        message: 'Не удалось разобрать дату закрытия. Оставьте поле пустым, если срока нет',
      });
    }

    if (!await orgOwnsHouse(db(), me.ukId, body.houseKey)) {
      return reply.code(403).send({ error: 'forbidden', message: 'Этот дом не обслуживается вашей УК' });
    }

    const created = await createPoll(db(), {
      ukId: me.ukId,
      houseKey: body.houseKey,
      title: body.title!.trim(),
      description: body.description?.trim(),
      options: body.options ?? [],
      closesAt: closes.date,
    });

    if (!created.ok) {
      return reply.code(400).send({
        error: created.reason,
        message: POLL_ERRORS[created.reason],
      });
    }

    return reply.code(201).send({ status: 'ok', id: created.id });
  });

  /**
   * Вложение к обращению — глазами управляющей компании.
   *
   * Проверка та же, что у карточки: `getForDispatcher` вернёт `null`,
   * если обращение не из домов этой организации. Публичной ссылки
   * у файла нет ни для кого.
   */
  app.get('/api/dispatcher/requests/:id/files/:fileId', async (request, reply) => {
    const me = await requireDispatcher(request, reply);
    if (!me) return;

    const { id, fileId } = request.params as { id: string; fileId: string };
    const found = await getForDispatcher(db(), me.ukId, id);
    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Обращение не найдено' });
    }

    const file = await readAttachment(db(), id, fileId);
    if (!file) {
      return reply.code(404).send({ error: 'not_found', message: 'Файл не найден' });
    }

    return reply
      .header('Content-Type', file.mime)
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.bytes);
  });

}

/**
 * Дома очереди: части адреса без квартиры и сколько открытых заявок.
 * Подпись собирает кабинет той же функцией, что и строки очереди.
 *
 * Считается по всей очереди, а не по выдаче — иначе выбранный дом
 * оставил бы в списке только себя.
 */
function queueHouses(rows: Array<{
  houseKey: string; status: string; address: string | null;
  street: string | null; house: string | null; block: string | null;
}>) {
  type QueueHouse = {
    houseKey: string; address: string | null; street: string | null;
    house: string | null; block: string | null; open: number; total: number;
  };
  const byKey = new Map<string, QueueHouse>();
  for (const r of rows) {
    const item = byKey.get(r.houseKey) ?? {
      houseKey: r.houseKey, address: r.address, street: r.street,
      house: r.house, block: r.block, open: 0, total: 0,
    };
    item.total += 1;
    if (r.status !== 'done' && r.status !== 'rejected') item.open += 1;
    byKey.set(r.houseKey, item);
  }
  return [...byKey.values()].sort((a, b) =>
    `${a.street ?? a.address} ${a.house}`.localeCompare(`${b.street ?? b.address} ${b.house}`, 'ru', { numeric: true }));
}
