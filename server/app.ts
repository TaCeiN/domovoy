import Fastify from 'fastify';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { authRoutes } from './routes/auth.ts';
import { requestRoutes } from './routes/requests.ts';
import { dispatcherRoutes } from './routes/dispatcher.ts';
import { adminRoutes } from './routes/admin.ts';
import { chairmanRoutes } from './routes/chairman.ts';
import { houseRoutes } from './routes/house.ts';
import { meterRoutes } from './routes/meters.ts';
import { propertyRoutes } from './routes/properties.ts';
import { pickRoutes } from './routes/pick.ts';
import { botRoutes } from './routes/bot.ts';
import { assistantRoutes } from './routes/assistant.ts';
import { docsRoutes } from './routes/docs.ts';
import { demoRoutes } from './routes/demo.ts';
import { describeConnection, getDb } from '../db/client.ts';
import { startSessionCleanup } from '../lib/auth/session.ts';
import { startReviewInvites } from '../lib/pick/prompt.ts';
import { isProduction, webLoginEnabled, signingSecret } from './config.ts';

/**
 * Один процесс: статика фронта плюс API.
 *
 * Намеренно без serverless-обвязки — так приложение поднимается локально
 * одной командой и разворачивается одним контейнером на любом сервере.
 * Зависимости от конкретного облака нет ни в одном месте.
 */

const PUBLIC_DIR = join(process.cwd(), 'public');

export function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      /**
       * Читаемые логи — по явному флагу, а не «во всём кроме продакшена».
       * pino-pretty лежит в devDependencies, и на любом хостинге, который
       * ставит только прод-зависимости, приложение упало бы при старте.
       */
      transport: process.env.PRETTY_LOGS === '1' ? {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      } : undefined,
    },
    // За обратным прокси нужен настоящий адрес клиента, а не адрес прокси
    trustProxy: true,
  });

  /**
   * Пустое тело при Content-Type: application/json — обычное дело:
   * часть запросов вроде /api/auth/max несут данные только в заголовке.
   * Стандартный парсер Fastify на это отвечает 400, что выглядит как
   * поломка сервера, хотя запрос корректный.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body, done) => {
      const raw = typeof body === 'string' ? body.trim() : '';
      if (!raw) return done(null, {});
      try {
        done(null, JSON.parse(raw));
      } catch {
        done(Object.assign(new Error('Некорректный JSON'), { statusCode: 400 }), undefined);
      }
    },
  );

  /**
   * CORS. На бою фронт и API на одном адресе, и CORS не участвует; он
   * нужен для чужих origin из ALLOWED_ORIGINS и для localhost.
   *
   * Разрешённые origin перечисляются явно, а не через «*»: со звёздочкой
   * браузер не пропустит запрос с учётными данными, и любой сайт сможет
   * дёргать наш API от имени пользователя.
   */
  const allowed = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean);

  /**
   * Вложения к обращениям приходят обычной формой.
   *
   * Лимит стоит и здесь, и в самом сохранении: браузер не должен успеть
   * залить в память двадцать мегабайт до того, как мы скажем «нельзя».
   */
  app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4 },
  });

  app.register(cors, {
    origin(origin, done) {
      // Запросы без origin — это curl, вебвью и same-origin: пропускаем
      if (!origin) return done(null, true);
      if (allowed.includes(origin)) return done(null, true);
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return done(null, true);
      done(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    /**
     * ВСЕ заголовки, которые шлёт фронт, обязаны быть здесь.
     *
     * Забытый заголовок ломает не одну функцию, а связь целиком: браузер
     * не пропускает предполётный OPTIONS и отменяет сам запрос, `fetch`
     * падает с TypeError, и приложение честно сообщает «сервер недоступен»
     * при живом сервере. Проверяется тестом в hardening.test.ts.
     */
    allowedHeaders: [
      'Content-Type', 'Authorization', 'X-Max-Init-Data', 'X-Scan-Platform',
    ],
  });

  /**
   * Секрет куки. В бою — только из окружения.
   *
   * Значение по умолчанию было литералом в исходниках. Подписанные куки
   * сейчас не используются, поэтому вреда не было, но как только кто-нибудь
   * начнёт их применять — например, для CSRF-токена, — забытая переменная
   * даст секрет, известный всем, кто видел код. Лучше не подняться,
   * чем подняться с заглушкой.
   */
  const cookieSecret = process.env.COOKIE_SECRET;
  if (isProduction() && !cookieSecret) {
    throw new Error('COOKIE_SECRET не задан. В продакшене заглушка недопустима.');
  }
  app.register(cookie, { secret: signingSecret() });

  /**
   * Статику отдаём только если она рядом.
   *
   * Папки public рядом с сервером может не оказаться, если API
   * запускают отдельно от фронта. Fastify-static падает при регистрации, если корень
   * не существует, и уронил бы всё приложение целиком.
   */
  const servesStatic = existsSync(PUBLIC_DIR);
  if (servesStatic) {
    app.register(fastifyStatic, {
      root: PUBLIC_DIR,
      index: ['index.html'],
      /**
       * В разработке браузер обязан спрашивать сервер о каждом файле.
       * Иначе ES-модули залипают в дисковом кэше, и правки просто не
       * доезжают: страница продолжает крутить вчерашний код, а выглядит
       * это как загадочные баги в данных.
       *
       * «no-cache» не запрещает кэш — он требует ревалидации, и сервер
       * отвечает дешёвым 304, если файл не менялся.
       */
      /**
       * И в бою тоже ревалидация, а не час жизни в кэше.
       *
       * Час означает, что после выкладки житель до часа видит старый код
       * поверх нового API: разъехавшаяся пара «фронт-бэкенд» выглядит как
       * баги в данных, а не как устаревший файл. Ревалидация стоит одного
       * условного запроса с ответом 304 — заметно дешевле такой путаницы.
       */
      cacheControl: isProduction(),
      maxAge: 0,
      /**
       * `/dispatcher` уводит на `/dispatcher/` редиректом 301.
       *
       * Без этого адрес без слэша отдавал ту же страницу, но с ДРУГОЙ
       * базой для относительных путей: `./dispatcher.js` разрешался
       * в `/dispatcher.js`, которого нет. Человек получал шапку «Кабинет
       * диспетчера» из разметки и пустоту вместо формы входа — скрипт,
       * который её строит, не загружался. Выглядит как сломанный кабинет,
       * а причина в потерянном слэше.
       */
      redirect: true,
    });
  }

  /**
   * Ответы API не кэшируются.
   *
   * Без этого браузер спокойно отдаёт сохранённый ответ на GET, и человек
   * видит начисление за прошлый месяц или статус заявки, который давно
   * изменился. Для приложения, показывающего деньги и сроки, это хуже
   * ошибки: ошибку видно, а устаревшие данные выглядят настоящими.
   */
  const isDev = !isProduction();

  app.addHook('onSend', async (request, reply, payload) => {
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store, must-revalidate');
      reply.header('Pragma', 'no-cache');
    } else if (isDev) {
      /**
       * В разработке браузер обязан спрашивать сервер о каждом файле.
       * Иначе ES-модули залипают в дисковом кэше, страница крутит вчерашний
       * код, а выглядит это как загадочные баги в данных — я на это уже
       * потратил полчаса.
       *
       * «no-cache» не запрещает кэш, а требует ревалидации: сервер отвечает
       * дешёвым 304, если файл не менялся.
       */
      reply.header('Cache-Control', 'no-cache');
    }
    return payload;
  });

  app.register(authRoutes);
  app.register(requestRoutes);
  app.register(dispatcherRoutes);
  app.register(adminRoutes);
  app.register(chairmanRoutes);
  app.register(houseRoutes);
  app.register(meterRoutes);
  app.register(propertyRoutes);
  app.register(pickRoutes);
  app.register(botRoutes);
  app.register(assistantRoutes);
  app.register(docsRoutes);
  app.register(demoRoutes);

  /**
   * Живость. Наружу — только «ok».
   *
   * Раньше отдавались драйвер, хост и имя базы плюс признак включённых
   * dev-инструментов, без всякой авторизации. Для проверки живости этого
   * не нужно, а рассказывать анонимному запросу про устройство стенда
   * незачем. Подробности остаются в разработке и на петле — там, где
   * их читает `npm run prod:health`.
   */
  app.get('/api/health', async () => {
    if (isProduction()) return { status: 'ok' };
    return {
      status: 'ok',
      db: describeConnection(),
      maxEnabled: Boolean(process.env.MAX_BOT_TOKEN),
      devTools: webLoginEnabled(),
    };
  });

  /**
   * Единый формат ошибок: клиенту всегда приходит JSON, а не HTML-страница.
   *
   * Но текст подменяем ТОЛЬКО у 5xx. Раньше подменялся любой: собственный
   * парсер тела формировал «Некорректный JSON» со статусом 400, а человек
   * читал «Что-то пошло не так» — и то же самое видел при слишком большом
   * теле (413). Фронт показывает `body.message` как есть, поэтому осмысленная
   * причина обязана доезжать. Внутреннюю ошибку по-прежнему не раскрываем:
   * в ней бывают имена таблиц и куски запроса.
   */
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    const status = error.statusCode ?? 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'необработанная ошибка');
      return reply.code(status).send({
        error: 'internal',
        message: 'Что-то пошло не так. Попробуйте ещё раз.',
      });
    }

    request.log.warn({ err: error, url: request.url }, 'запрос отклонён');
    return reply.code(status).send({
      error: error.code ?? 'bad_request',
      message: error.message || 'Запрос не принят',
    });
  });

  // Неизвестный /api/* — это ошибка, всё остальное отдаём фронту (SPA-навигация)
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/') || !servesStatic) {
      return reply.code(404).send({ error: 'not_found', message: 'Метод не найден' });
    }
    return reply.sendFile('index.html');
  });

  return app;
}

export async function start() {
  const app = buildApp();
  const port = Number(process.env.PORT ?? 3000);

  try {
    await app.listen({ port, host: '0.0.0.0' });
    app.log.info(`база: ${describeConnection()}`);

    /**
     * Уборка протухших сессий.
     * Там же — одно письмо бота с просьбой об отзыве о доме (lib/pick/prompt.ts).
     *
     * Запускается только в долгоживущем процессе, а не в buildApp:
     * в serverless-адаптере и в тестах приложение поднимается на один
     * вызов, и таймер там не нужен.
     */
    startSessionCleanup(getDb());
    startReviewInvites(getDb());
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}
