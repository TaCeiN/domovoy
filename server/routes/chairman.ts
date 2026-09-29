import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { property } from '../../db/schema.ts';
import { chairmanRolesOf, type ChairmanRole } from '../../lib/auth/session.ts';
import {
  createPost, createPoll, notifyHouse, removePost, managedPosts, listPollsForHouses,
  POST_CATEGORIES, POLL_ERRORS, type PostCategory,
} from '../../lib/house/service.ts';
import {
  claimsForChairman, approveClaim, rejectClaim, CLAIM_CODES, CLAIM_MESSAGES,
} from '../../lib/auth/claims.ts';
import { houseOverview } from '../../lib/house/overview.ts';
import {
  contactKinds, listContacts, saveContact, findContact, removeContact, readContactBody,
} from '../../lib/house/contacts.ts';
import { parseOptionalDate, parseOptionalDateOrUndefined } from '../../lib/dates.ts';
import {
  listForHouse, getForHouse, addChairmanComment, countAwaitingChairman,
} from '../../lib/requests/service.ts';
import { readAttachment } from '../../lib/requests/attachments.ts';
import { db, requireUser } from '../context.ts';
import { readLimit, matchesQuery } from '../../lib/lists.ts';

/**
 * Совет дома — раздел внутри приложения жителя.
 *
 * НЕ ОТДЕЛЬНЫЙ КАБИНЕТ И НЕ ВТОРОЙ ПРОФИЛЬ. Председатель — такой же
 * житель этого дома, и вход у него один. Права выводятся из его сессии:
 * есть ли у `app_user` действующая строка в `chairman`.
 *
 * Прежде это была веб-страница с собственным логином и паролем. Второй
 * аккаунт заставлял человека помнить, «под кем он сейчас», а в советах
 * домов большинство — люди старшего возраста, для которых это худший
 * вид путаницы. Режимов в приложении нет: «Совет дома» — обычный раздел
 * с обычной кнопкой «Назад».
 *
 * Может: подтверждать жителей своего дома, вести объявления и опросы,
 * видеть сводку по квартирам, читать обращения дома в УК и отвечать
 * в переписке.
 *
 * Не может: менять статус обращения и удалять его. Статусами
 * распоряжается управляющая компания: у неё подрядчики, регламент
 * и ответственность за срок. Председатель, меняющий статус заявки, —
 * это ответственность без полномочий. Для дома без УК жалоба всё равно
 * не остаётся ничьей: до задачи 10 приложение обещало «обращение увидит
 * совет дома», хотя доступа для этого не существовало, — теперь
 * председатель действительно её читает и может ответить словами.
 */

/**
 * Председательство текущего жителя.
 *
 * Дом можно указать явно — на случай, если человек возглавляет совет
 * в двух домах. Без указания берётся единственный, а при нескольких
 * приложение обязано спросить.
 */
async function requireChairman(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<ChairmanRole | null> {
  const user = await requireUser(request, reply);
  if (!user) return null;

  const roles = await chairmanRolesOf(db(), user.id);
  if (roles.length === 0) {
    reply.code(403).send({
      error: 'not_a_chairman',
      message: 'Этот раздел доступен председателю совета дома',
    });
    return null;
  }

  const asked = (request.query as { houseKey?: string })?.houseKey
    ?? (request.body as { houseKey?: string } | undefined)?.houseKey;

  if (asked) {
    const found = roles.find((r) => r.houseKey === asked);
    if (!found) {
      reply.code(403).send({ error: 'not_a_chairman', message: 'Это не ваш дом' });
      return null;
    }
    return found;
  }

  return roles[0];
}

/** Адрес дома для человека: берём любой объект и убираем квартиру. */
async function houseLabel(houseKey: string): Promise<string> {
  const rows = await db()
    .select({ addressRaw: property.addressRaw })
    .from(property)
    .where(eq(property.houseKey, houseKey))
    .limit(1);

  const raw = rows[0]?.addressRaw;
  return raw ? raw.replace(/,\s*кв\.?\s*[^,]+$/i, '') : houseKey;
}

/**
 * Совпадает ли обращение дома с тем, что ищет председатель.
 *
 * Правила те же, что у диспетчера: голое число — это номер обращения
 * или квартиры и ничего больше, слова ищутся по заголовку. Адрес
 * в поиске не участвует: дом у председателя один, и адрес не различает
 * ни одной строки.
 */
function matchesHouseRequest(
  r: { number: number; title: string; flat: string | null },
  q: string,
): boolean {
  if (!q) return true;

  const padded = String(r.number).padStart(5, '0');
  const digits = q.match(/\d+/)?.[0];

  if (digits) {
    if (Number(digits) === r.number || digits === padded) return true;
    if ((r.flat ?? '').trim() === digits) return true;
  }
  if (digits === q.replace(/\s+/g, '')) return false;

  return matchesQuery([r.title], q);
}

export async function chairmanRoutes(app: FastifyInstance) {
  /**
   * Кто я как председатель и сколько дел ждёт.
   *
   * Два счётчика нужны главному экрану жителя: карточка «Совет дома»
   * появляется, если ненулевое хотя бы одно из двух чисел. `pendingClaims`
   * был один — с обращениями дом без УК, где все жители уже подтверждены,
   * оставался без входа в раздел с главной, хотя жалоба туда уже пришла
   * и лежала непрочитанной. `awaitingRequests` — то же число, что нужно
   * и разделу «Совет дома»: там его тоже берут отсюда, а не тянут
   * ради него всю переписку дома на клиент.
   */
  app.get('/api/chairman/me', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const roles = await chairmanRolesOf(db(), user.id);
    if (roles.length === 0) return reply.send({ isChairman: false, houses: [] });

    const houses = await Promise.all(roles.map(async (role) => ({
      chairmanId: role.id,
      houseKey: role.houseKey,
      // houseKey — хеш, показывать его человеку нельзя: экран выглядит
      // отладочным, и председатель не уверен, что ведёт свой дом
      houseLabel: await houseLabel(role.houseKey),
      ukId: role.ukId,
      pendingClaims: (await claimsForChairman(db(), role.houseKey)).length,
      awaitingRequests: await countAwaitingChairman(db(), role.houseKey),
    })));

    return reply.send({ isChairman: true, name: roles[0].name, houses });
  });

  /**
   * Сводка по дому: квартиры, оплата, жильцы, счётчики.
   *
   * ОПЛАТА ПОКВАРТИРНО, БЕЗ ФИО. Кто именно не заплатил — председателю
   * знать не нужно и по 152-ФЗ не положено: оператор персональных данных
   * управляющая компания, а он постороннее физлицо. «Кв. 27 не оплачена»
   * для разговора хватает.
   *
   * Состав жильцов при этом виден: человек и так называет председателю
   * своё имя в заявке на доступ, показывать его дальше — не новая утечка.
   */
  app.get('/api/chairman/house', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    return reply.send(await houseOverview(db(), me.houseKey));
  });

  /**
   * Телефоны дома: лифтёрская, диспетчерская, домофон.
   *
   * Председатель вписывает номера своего дома; жители видят их на экране
   * аварийных служб с подписью «добавил председатель совета дома».
   */
  app.get('/api/chairman/contacts', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;
    return reply.send({ kinds: contactKinds(), contacts: await listContacts(db(), me.houseKey) });
  });

  app.post('/api/chairman/contacts', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const result = await saveContact(db(), {
      houseKey: me.houseKey, ...readContactBody(request.body), role: 'chairman', by: me.id,
    });
    if (!result.ok) return reply.code(400).send({ error: result.reason, message: result.message });
    return reply.code(201).send({ status: 'ok', id: result.id });
  });

  app.post('/api/chairman/contacts/:id/remove', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const found = await findContact(db(), id);
    if (!found || found.houseKey !== me.houseKey) {
      return reply.code(404).send({ error: 'not_found', message: 'Такого номера в доме нет' });
    }
    await removeContact(db(), id);
    return reply.send({ ok: true });
  });

  /** Объявления своего дома: опубликованные, истёкшие и снятые. */
  app.get('/api/chairman/posts', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;
    const posts = await managedPosts(db(), { houseKeys: [me.houseKey] });
    const limit = readLimit((request.query as { limit?: string })?.limit);
    return reply.send({ posts: posts.slice(0, limit), total: posts.length });
  });

  app.post('/api/chairman/posts', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const body = request.body as {
      category?: PostCategory; title?: string; body?: string; expiresAt?: string;
    };

    const title = (body?.title ?? '').trim();
    const text = (body?.body ?? '').trim();
    const category = body?.category ?? 'news';

    if (!POST_CATEGORIES.includes(category) || category === 'market') {
      return reply.code(400).send({
        error: 'bad_category',
        message: 'Категория должна быть одной из: outage, meeting, news',
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

    const id = await createPost(db(), {
      houseKey: me.houseKey,
      ukId: me.ukId,
      authorId: null,
      chairmanId: me.id,
      type: 'chair',
      category,
      title,
      body: text,
      expiresAt: expires.date,
    });

    const notified = category === 'outage'
      // Срок едет в сообщение: ради него его и вводят — «нет воды до 18:00»
      ? await notifyHouse(db(), me.houseKey, title, text, expires.date)
      : 0;

    return reply.code(201).send({ status: 'ok', id, notified });
  });

  /**
   * Снять объявление совета дома. Только своего дома и только своё —
   * объявление управляющей компании председателю не подчиняется.
   */
  app.delete('/api/chairman/posts/:id', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const ok = await removePost(db(), id, { houseKey: me.houseKey, types: ['chair'] });
    if (!ok) {
      return reply.code(404).send({
        error: 'not_found',
        message: 'Объявление не найдено или опубликовано не советом дома',
      });
    }
    return reply.send({ status: 'ok' });
  });

  /* ─────────────── заявки жителей на доступ ─────────────── */

  /**
   * Очередь заявок своего дома.
   *
   * Это главное, ради чего у председателя есть кабинет. Квитанция
   * не доказывает, что человек живёт в квартире, — доказать это может
   * только тот, кто знает соседей. Председателя выбирает собрание,
   * а подтверждает УК: он и есть тот человек.
   */
  app.get('/api/chairman/claims', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const claims = await claimsForChairman(db(), me.houseKey);
    return reply.send({ total: claims.length, claims });
  });

  app.post('/api/chairman/claims/:id/approve', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const body = request.body as { role?: string };
    // Роль называет председатель: по квитанции собственник и домочадец
    // выглядят одинаково, она всегда выписана на собственника
    const role = body?.role === 'owner' ? 'owner' : 'member';

    const result = await approveClaim(
      db(), { kind: 'chairman', id: me.id, houseKey: me.houseKey }, id, role,
    );
    if (!result.ok) return reply.code(CLAIM_CODES[result.reason]).send({
      error: result.reason,
      message: CLAIM_MESSAGES[result.reason],
    });

    return reply.send({ status: 'ok', role: result.role });
  });

  app.post('/api/chairman/claims/:id/reject', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const body = request.body as { reason?: string };
    const reason = (body?.reason ?? '').trim();

    // Причина обязательна: человек должен понимать, что делать дальше
    if (reason.length < 3) {
      return reply.code(400).send({
        error: 'reason_required',
        message: 'Напишите, почему отказ — иначе человек не поймёт, что делать',
      });
    }

    const result = await rejectClaim(
      db(), { kind: 'chairman', id: me.id, houseKey: me.houseKey }, id, reason,
    );
    if (!result.ok) return reply.code(CLAIM_CODES[result.reason]).send({
      error: result.reason,
      message: CLAIM_MESSAGES[result.reason],
    });

    return reply.send({ status: 'ok' });
  });

  app.get('/api/chairman/polls', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;
    return reply.send({ polls: await listPollsForHouses(db(), [me.houseKey]) });
  });

  app.post('/api/chairman/polls', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const body = request.body as {
      title?: string; description?: string; options?: string[]; closesAt?: string;
    };

    if (!(body?.title ?? '').trim()) {
      return reply.code(400).send({ error: 'bad_input', message: 'Нужен заголовок опроса' });
    }

    const closes = parseOptionalDateOrUndefined(body?.closesAt);
    if (!closes.ok) {
      return reply.code(400).send({
        error: 'bad_date',
        message: 'Не удалось разобрать дату закрытия. Оставьте поле пустым, если срока нет',
      });
    }

    const created = await createPoll(db(), {
      ukId: me.ukId,
      chairmanId: me.id,
      houseKey: me.houseKey,
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

  /* ─────────────── обращения дома ─────────────── */

  /**
   * Обращения дома, свежие первыми.
   *
   * Единственное новое право в этой задаче: раньше цепочка адресата
   * обещала жителю «обращение увидит совет дома», а самого доступа
   * не существовало — председатель видел ровно то же, что любой житель.
   * Для дома на ТСЖ или непосредственном управлении жалоба не приходила
   * никуда. Видно всё, включая обращения неподтверждённых жителей: их
   * подтверждает тот же председатель, и ждать подтверждения ради этого
   * права было бы замкнутым кругом.
   */
  app.get('/api/chairman/requests', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const all = await listForHouse(db(), me.houseKey);

    /**
     * Вкладки «Открытые / Все» — тот же приём, что у жителя.
     *
     * Председатель заходит раз в неделю и спрашивает «что сейчас горит»,
     * а получал архив дома за год одним свитком. Плиток по статусам
     * здесь нет намеренно: он не разбирает очередь, а шесть плиток заняли
     * бы первый экран телефона целиком.
     */
    const query = request.query as { tab?: string; q?: string; limit?: string };
    const openOnly = query?.tab === 'open';
    const byTab = openOnly ? all.filter((r) => !r.closed) : all;

    /** Поиск по номеру, квартире и заголовку. Адреса нет: дом один. */
    const q = (query?.q ?? '').trim();
    const found = byTab.filter((r) => matchesHouseRequest(r, q));
    const rows = found.slice(0, readLimit(query?.limit));

    return reply.send({
      /** Счётчики обеих вкладок приходят всегда — иначе вкладка врёт о себе */
      counts: {
        open: all.filter((r) => !r.closed).length,
        all: all.length,
      },
      total: found.length,
      requests: rows.map((r) => ({
        id: r.id,
        number: String(r.number).padStart(5, '0'),
        kind: r.kind,
        category: r.category,
        title: r.title,
        status: r.status,
        statusLabel: r.statusLabel,
        closed: r.closed,
        sla: r.sla,
        slaLabel: r.slaLabel,
        flat: r.flat,
        authorName: r.authorName,
        createdAt: r.createdAt,
        lastMessage: r.lastMessage,
      })),
    });
  });

  /** Карточка обращения: переписка и вложения — то же, что видит житель. */
  app.get('/api/chairman/requests/:id', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const found = await getForHouse(db(), me.houseKey, id);
    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Обращение не найдено' });
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
      sla: found.sla,
      slaLabel: found.slaLabel,
      flat: found.flat,
      authorName: found.authorName,
      assigneeName: found.assigneeName,
      rejectReason: found.rejectReason,
      createdAt: found.createdAt,
      closedAt: found.closedAt,
      /**
       * Есть ли у дома управляющая компания — председатель дома без УК
       * не должен читать «статус меняет только управляющая компания»:
       * у его дома её нет, и статус не изменит никто.
       */
      hasOrg: me.ukId !== null,
      // rating НЕ отдаём: это оценка и отзыв жителя о работе УК, к делу
      // председателя не относится и брифом не заказано — лишним чужим
      // данным по проводу ходить незачем
      events: found.events,
      photos: found.photos,
    });
  });

  /**
   * Ответ председателя.
   *
   * Только реплика в переписке — ни статуса, ни удаления здесь нет
   * и быть не может: см. заголовок файла.
   */
  app.post('/api/chairman/requests/:id/comment', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const body = request.body as { text?: string };

    const result = await addChairmanComment(db(), {
      houseKey: me.houseKey,
      chairmanName: me.name,
      requestId: id,
      text: body?.text ?? '',
    });

    if (!result.ok) {
      const messages: Record<string, string> = {
        empty: 'Напишите ответ — пустое сообщение не поможет',
        not_found: 'Обращение не найдено',
        closed: 'Обращение закрыто — дописать в него нельзя',
      };
      const codes: Record<string, number> = { empty: 400, not_found: 404, closed: 409 };
      return reply.code(codes[result.reason]).send({
        error: result.reason,
        message: messages[result.reason],
      });
    }

    return reply.code(201).send({ status: 'ok' });
  });

  /**
   * Файл вложения к обращению дома.
   *
   * Доступ — как у самой карточки: `getForHouse` вернёт `null`, если
   * обращение из чужого дома, и до чтения файла дело не дойдёт.
   */
  app.get('/api/chairman/requests/:id/files/:fileId', async (request, reply) => {
    const me = await requireChairman(request, reply);
    if (!me) return;

    const { id, fileId } = request.params as { id: string; fileId: string };
    const found = await getForHouse(db(), me.houseKey, id);
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
