import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { post, property, userProperty } from '../../db/schema.ts';
import { and } from 'drizzle-orm';
import {
  houseFeed, createPost, listPolls, getPoll, vote, houseKeysFor,
  POST_CATEGORIES, type PostCategory,
} from '../../lib/house/service.ts';
import {
  savePostPhoto, readPostPhoto, removePostPhoto, PHOTO_CODES, PHOTO_MESSAGES,
} from '../../lib/house/photos.ts';
import { markPostRead } from '../../lib/house/reads.ts';
import { chairmanOf } from '../../lib/auth/session.ts';
import type { Database } from '../../db/client.ts';

import { openHouseClaim } from '../../lib/house/claim.ts';
import { contactsForResident } from '../../lib/house/contacts.ts';
import { db, requireUser } from '../context.ts';
import { readLimit } from '../../lib/lists.ts';

/**
 * Кто может приложить фотографию к объявлению.
 *
 * Права те же, что на публикацию, и заводить для фотографии отдельное
 * правило нельзя: разъехавшись, они дадут приложить картинку туда, куда
 * написать было нельзя. Своё предложение правит автор; объявления дома —
 * председатель этого дома. Диспетчер УК ходит своим кабинетом, у него
 * свой маршрут и своя сессия.
 */
async function canEditPost(db: Database, userId: string, postId: string): Promise<boolean> {
  const [row] = await db
    .select({ authorId: post.authorId, houseKey: post.houseKey, type: post.type })
    .from(post)
    .where(eq(post.id, postId))
    .limit(1);

  if (!row) return false;
  if (row.authorId === userId) return true;

  // Объявления УК председателю не принадлежат — как и при снятии объявления
  if (row.type === 'uk') return false;
  return Boolean(await chairmanOf(db, userId, row.houseKey));
}

/** Жизнь дома со стороны жителя: лента, объявления соседей, опросы. */
export async function houseRoutes(app: FastifyInstance) {
  /**
   * Телефоны дома для экрана аварийных служб.
   *
   * Гейт — тот же, что у телефона УК в `/api/me`: кому не называем адрес,
   * тому не называем и номера дома. Жалоба при этом доступна всем сразу —
   * этот маршрут её не касается.
   */
  app.get('/api/properties/:propertyId/house-contacts', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { propertyId } = request.params as { propertyId: string };
    const contacts = await contactsForResident(db(), user.id, propertyId);
    if (contacts === null) {
      return reply.code(403).send({ error: 'no_access', message: 'Это не ваш адрес' });
    }
    return reply.send({ contacts });
  });

  app.get('/api/feed', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const query = request.query as { category?: string; scope?: string };
    const category = POST_CATEGORIES.includes(query?.category as PostCategory)
      ? (query.category as PostCategory)
      : undefined;

    const posts = await houseFeed(db(), user.id, category);

    /**
     * Две разные доски, а не одна лента с фильтром.
     *
     * «Объявления дома» — голос дома: отключения, собрания, новости; пишут
     * их УК и председатель. «Соседи предлагают» — доска жителей. Смешивать
     * нельзя: рядом с объявлением УК «продам велосипед» обесценивает первое,
     * а объявление соседа начинает выглядеть официальным.
     *
     * Потолок считается ПОСЛЕ разделения досок и фильтра по категории:
     * иначе «Показаны 50 из 130» на доске соседей посчитало бы заодно
     * объявления УК, которых там нет.
     */
    const limit = readLimit((request.query as { limit?: string })?.limit);
    const page = (rows: typeof posts) => ({
      posts: rows.slice(0, limit),
      total: rows.length,
    });

    if (query?.scope === 'house') {
      return reply.send(page(posts.filter((p) => p.category !== 'market')));
    }
    if (query?.scope === 'market') {
      return reply.send(page(posts.filter((p) => p.category === 'market')));
    }

    return reply.send(page(posts));
  });

  /** Объявление от соседа: «продам велосипед», «репетитор английского». */
  app.post('/api/feed', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const body = request.body as {
      propertyId?: string; title?: string; body?: string; contact?: string; sharePhone?: boolean;
    };

    const title = (body?.title ?? '').trim();
    const text = (body?.body ?? '').trim();
    if (title.length < 3 || text.length < 5) {
      return reply.code(400).send({
        error: 'too_short',
        message: 'Укажите заголовок и опишите объявление',
      });
    }

    // Объявление привязывается к дому, а дом берётся из объекта жителя
    const rows = await db()
      .select({ houseKey: property.houseKey, ukId: property.managingOrgId })
      .from(userProperty)
      .innerJoin(property, eq(userProperty.propertyId, property.id))
      .where(and(
        eq(userProperty.userId, user.id),
        eq(userProperty.status, 'active'),
        ...(body?.propertyId ? [eq(property.id, body.propertyId)] : []),
      ))
      .limit(1);

    if (!rows[0]) {
      return reply.code(403).send({ error: 'no_property', message: 'Нет доступа к объекту' });
    }

    /**
     * Поделиться можно только телефоном, который подтвердил MAX.
     * Набранный руками номер соседи увидели бы как проверенный.
     */
    const sharePhone = body?.sharePhone === true;
    if (sharePhone && !user.phoneVerified) {
      return reply.code(400).send({
        error: 'phone_not_verified',
        message: 'Сначала подтвердите телефон через MAX',
      });
    }

    const id = await createPost(db(), {
      houseKey: rows[0].houseKey,
      ukId: rows[0].ukId,
      authorId: user.id,
      type: 'resident',
      category: 'market',
      title,
      body: text,
      contact: body?.contact?.trim(),
      sharePhone,
    });

    return reply.code(201).send({ status: 'ok', id });
  });

  /**
   * Фотография объявления: карточка товара у соседей, обложка объявления
   * дома. Одна на объявление — повторная загрузка заменяет прежнюю.
   *
   * Права те же, что на публикацию: свой пост правит автор, объявления
   * дома — председатель этого дома. Отдельного правила не заводим.
   */
  app.post('/api/posts/:id/photo', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };
    if (!await canEditPost(db(), user.id, id)) {
      return reply.code(403).send({
        error: 'no_access',
        message: 'Фотографию можно приложить только к своему объявлению',
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
      // Сработал лимит плагина: файл больше, чем мы готовы принять
      return reply.code(413).send({ error: 'too_large', message: PHOTO_MESSAGES.too_large });
    }

    const saved = await savePostPhoto(db(), { postId: id, bytes, userId: user.id });
    if (!saved.ok) {
      return reply.code(PHOTO_CODES[saved.reason])
        .send({ error: saved.reason, message: PHOTO_MESSAGES[saved.reason] });
    }

    return reply.send({ status: 'ok' });
  });

  /**
   * Отметить объявление прочитанным.
   *
   * Ставится на ОТКРЫТИИ карточки, а не на показе строки списка: человек,
   * пролиставший ленту, ничего не прочитал, и объявлять за него обратное
   * значит соврать ровно там, где он и полагается на приложение.
   */
  app.post('/api/posts/:id/read', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };

    const [row] = await db()
      .select({ houseKey: post.houseKey })
      .from(post)
      .where(eq(post.id, id))
      .limit(1);

    const keys = await houseKeysFor(db(), user.id);
    if (!row || !keys.includes(row.houseKey)) {
      return reply.code(403).send({ error: 'no_access', message: 'Объявление недоступно' });
    }

    await markPostRead(db(), user.id, id);
    return reply.send({ status: 'ok' });
  });

  /** Снять фотографию. Само объявление при этом остаётся. */
  app.delete('/api/posts/:id/photo', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };
    if (!await canEditPost(db(), user.id, id)) {
      return reply.code(403).send({ error: 'no_access', message: 'Это не ваше объявление' });
    }

    await removePostPhoto(db(), id);
    return reply.send({ status: 'ok' });
  });

  /**
   * Отдать фотографию.
   *
   * Публичной ссылки у неё нет: каждый запрос проверяет, видно ли человеку
   * само объявление. Лента дома и доска соседей — уровень 1, то есть
   * только после подтверждения председателем.
   */
  app.get('/api/posts/:id/photo', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };

    const [row] = await db()
      .select({ houseKey: post.houseKey })
      .from(post)
      .where(eq(post.id, id))
      .limit(1);

    const keys = await houseKeysFor(db(), user.id);
    if (!row || !keys.includes(row.houseKey)) {
      return reply.code(403).send({ error: 'no_access', message: 'Объявление недоступно' });
    }

    const file = await readPostPhoto(db(), id);
    if (!file) {
      return reply.code(404).send({ error: 'not_found', message: 'Фотографии нет' });
    }

    return reply.header('content-type', file.mime).send(file.bytes);
  });

  app.get('/api/polls', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    return reply.send({ polls: await listPolls(db(), user.id) });
  });

  app.get('/api/polls/:id', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };
    const found = await getPoll(db(), user.id, id);
    if (!found) return reply.code(404).send({ error: 'not_found', message: 'Опрос не найден' });
    return reply.send(found);
  });

  app.post('/api/polls/:id/vote', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };
    const body = request.body as { optionId?: string };
    if (!body?.optionId) {
      return reply.code(400).send({ error: 'no_option', message: 'Выберите вариант' });
    }

    const result = await vote(db(), user.id, id, body.optionId);
    if (!result.ok) {
      const messages: Record<string, string> = {
        not_found: 'Опрос не найден',
        closed: 'Опрос уже завершён',
        bad_option: 'Такого варианта нет',
      };
      const codes: Record<string, number> = { not_found: 404, closed: 409, bad_option: 400 };
      return reply.code(codes[result.reason]).send({
        error: result.reason,
        message: messages[result.reason],
      });
    }

    // Отдаём результаты сразу: проголосовавший имеет право их видеть
    return reply.send(await getPoll(db(), user.id, id));
  });

  /**
   * Житель просит подключить дом, за которым никто не стоит.
   *
   * Это выход из замкнутого круга: председателя назначает УК, а УК нет.
   * Разорвать его изнутри нечем, поэтому заявка уходит оператору.
   */
  app.post('/api/house/claim', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const body = request.body as { propertyId?: string; note?: string };
    const propertyId = (body?.propertyId ?? '').trim();
    if (!propertyId) {
      reply.code(400).send({ error: 'bad_input', message: 'Не указана квартира' });
      return;
    }

    const [row] = await db()
      .select({ houseKey: property.houseKey })
      .from(property)
      .where(eq(property.id, propertyId))
      .limit(1);
    if (!row) {
      reply.code(404).send({ error: 'not_found', message: 'Такого адреса нет' });
      return;
    }

    const res = await openHouseClaim(db(), {
      houseKey: row.houseKey,
      userId: user.id,
      note: body?.note,
    });
    if (!res.ok) {
      reply.code(403).send({ error: res.reason, message: 'Это не ваш дом' });
      return;
    }

    reply.send({ ok: true, created: res.created });
  });
}
