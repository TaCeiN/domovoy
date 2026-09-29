import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { appUser, house } from '../../db/schema.ts';
import { authenticate, db, requireUser } from '../context.ts';
import { limited, LIMITS } from '../rate-limit.ts';
import { findOrCreateMaxUser } from '../../lib/auth/session.ts';
import type { MaxInitData } from '../../lib/max/init-data.ts';
import { parseBbox } from '../../lib/pick/geo.ts';
import { mapHouses } from '../../lib/pick/houses.ts';
import { searchPick } from '../../lib/pick/search.ts';
import { pickCard } from '../../lib/pick/card.ts';
import { canReview, saveReview, validateReview } from '../../lib/pick/reviews.ts';
import { listFavorites, setFavorite } from '../../lib/pick/favorites.ts';
import { dismissPrompt, reviewPrompt } from '../../lib/pick/prompt.ts';
import { MOCK_KEY, mockActive, mockCard, mockDistricts, mockMap, mockPhoto, mockSearch } from '../../lib/pick/mock/query.ts';

/**
 * Подбор дома.
 *
 * КТО СМОТРИТ. Переезжающему квитанцию взять неоткуда, поэтому смотреть
 * можно и по подписи MAX без сессии. Сессию без квитанции НЕ заводим:
 * `/api/auth/max` по-прежнему отвечает `needs_receipt`, и модель доступа
 * жителя остаётся прежней. Наружу из этих маршрутов уходят только
 * реестровые данные дома, сводки выше порогов и отзывы без авторов.
 *
 * КТО ПИШЕТ ОТЗЫВ — только житель с сессией и уровнем `full` к дому.
 */

interface Viewer { userId: string | null; max: MaxInitData | null }

async function viewer(request: FastifyRequest, reply: FastifyReply): Promise<Viewer | null> {
  const auth = await authenticate(request);
  if (auth.user) return { userId: auth.user.id, max: auth.max };
  if (auth.max) {
    const [known] = await db().select({ id: appUser.id }).from(appUser)
      .where(eq(appUser.maxUserId, auth.max.user.id)).limit(1);
    return { userId: known?.id ?? null, max: auth.max };
  }
  reply.code(401).send({ error: 'unauthorized', message: 'Нужно войти' });
  return null;
}

/** «♥» от человека без квитанции: заводим его по подписи MAX, как при приглашении домочадца */
async function viewerUserId(v: Viewer): Promise<string | null> {
  if (v.userId) return v.userId;
  if (!v.max) return null;
  const user = await findOrCreateMaxUser(db(), {
    maxUserId: v.max.user.id,
    firstName: v.max.user.first_name,
    lastName: v.max.user.last_name,
    username: v.max.user.username,
    photoUrl: v.max.user.photo_url,
    chatId: v.max.chat?.id ?? null,
  });
  return user.id;
}

/** Ключ дома — 32 знака sha256 (`hashHouseKey`); другое сразу 404, без запроса в базу */
const HOUSE_KEY = /^[0-9a-f]{32}$/;

async function houseExists(houseKey: string): Promise<boolean> {
  if (!HOUSE_KEY.test(houseKey)) return false;
  const [row] = await db().select({ houseKey: house.houseKey }).from(house).where(eq(house.houseKey, houseKey)).limit(1);
  return Boolean(row);
}

const NOT_FOUND = { error: 'not_found', message: 'Этого дома нет в подборе' };

export async function pickRoutes(app: FastifyInstance) {
  app.get('/api/pick/search', async (request, reply) => {
    const who = await viewer(request, reply);
    if (!who) return;
    if (limited(request, reply, 'pick-search', LIMITS.lookup)) return;
    const q = String((request.query as { q?: string })?.q ?? '').slice(0, 100);
    // Заглушка ЖК (docs/mock-complexes.md): пока она загружена, ищем по ЖК
    if (await mockActive(db())) return reply.send(await mockSearch(db(), q));
    return reply.send(await searchPick(db(), q));
  });

  app.get('/api/pick/houses', async (request, reply) => {
    const who = await viewer(request, reply);
    if (!who) return;
    if (limited(request, reply, 'pick-map', LIMITS.lookup)) return;

    const query = request.query as { bbox?: string; zoom?: string };
    const box = parseBbox(query?.bbox);
    const zoom = Number(query?.zoom);
    if (!box || !Number.isInteger(zoom) || zoom < 0 || zoom > 20) {
      return reply.code(400).send({ error: 'bad_bbox', message: 'Не удалось понять границы карты' });
    }
    if (await mockActive(db())) return reply.send(await mockMap(db(), box));
    return reply.send(await mapHouses(db(), box, zoom));
  });

  /**
   * Фото ЖК заглушки. Открыто без входа: картинку грузит `<img>`/CSS-фон,
   * а заголовка initData MAX у них нет. Это рендер застройщика, а не файл
   * жителя. Кэш на сутки — меняется только новой загрузкой `mock:load`.
   */
  app.get('/api/pick/mock-photo/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const photo = await mockPhoto(db(), slug);
    if (!photo) return reply.code(404).send({ error: 'not_found', message: 'Фото нет' });
    return reply.header('content-type', photo.mime).header('cache-control', 'public, max-age=86400').send(photo.bytes);
  });

  // Районы для отдалённой карты — только у заглушки ЖК (docs/mock-complexes.md)
  app.get('/api/pick/districts', async (request, reply) => {
    const who = await viewer(request, reply);
    if (!who) return;
    if (limited(request, reply, 'pick-map', LIMITS.lookup)) return;
    return reply.send(await mockDistricts(db()));
  });

  app.get('/api/pick/house/:houseKey', async (request, reply) => {
    const who = await viewer(request, reply);
    if (!who) return;
    const { houseKey } = request.params as { houseKey: string };
    const card = MOCK_KEY.test(houseKey)
      ? await mockCard(db(), houseKey)
      : HOUSE_KEY.test(houseKey) ? await pickCard(db(), houseKey, who.userId) : null;
    if (!card) return reply.code(404).send(NOT_FOUND);
    return reply.send(card);
  });

  app.post('/api/pick/house/:houseKey/review', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const { houseKey } = request.params as { houseKey: string };
    if (!(await houseExists(houseKey))) return reply.code(404).send(NOT_FOUND);

    if (!(await canReview(db(), user.id, houseKey))) {
      return reply.code(403).send({
        error: 'not_resident',
        message: 'Отзыв пишут только подтверждённые жители этого дома',
      });
    }
    const checked = validateReview(request.body);
    if (!checked.ok) return reply.code(400).send({ error: 'bad_review', message: checked.message });

    await saveReview(db(), user.id, houseKey, checked.value);
    return reply.send({ ok: true });
  });

  app.get('/api/pick/favorites', async (request, reply) => {
    const who = await viewer(request, reply);
    if (!who) return;
    return reply.send({ houses: who.userId ? await listFavorites(db(), who.userId) : [] });
  });

  for (const method of ['POST', 'DELETE'] as const) {
    app.route({
      method,
      url: '/api/pick/favorites/:houseKey',
      handler: async (request, reply) => {
        const who = await viewer(request, reply);
        if (!who) return;
        const { houseKey } = request.params as { houseKey: string };
        if (!(await houseExists(houseKey))) return reply.code(404).send(NOT_FOUND);
        const userId = await viewerUserId(who);
        if (!userId) return reply.code(401).send({ error: 'unauthorized', message: 'Нужно войти' });
        await setFavorite(db(), userId, houseKey, method === 'POST');
        return reply.send({ ok: true });
      },
    });
  }

  app.get('/api/pick/prompt', async (request, reply) => {
    const auth = await authenticate(request);
    if (!auth.user && !auth.max) return reply.code(401).send({ error: 'unauthorized', message: 'Нужно войти' });
    // Гость из MAX отзыв писать не может — и просить его не о чем
    return reply.send({ prompt: auth.user ? await reviewPrompt(db(), auth.user.id) : null });
  });

  app.post('/api/pick/prompt/:houseKey/dismiss', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;
    const { houseKey } = request.params as { houseKey: string };
    if (!(await houseExists(houseKey))) return reply.code(404).send(NOT_FOUND);
    await dismissPrompt(db(), user.id, houseKey);
    return reply.send({ ok: true });
  });
}
