import type { FastifyInstance } from 'fastify';
import {
  listMeters, submitReading, windowState, currentPeriod, addMeter, meterKinds,
} from '../../lib/meters/service.ts';
import { consumptionAnalytics } from '../../lib/analytics/service.ts';
import { listBills, markPaid, billQr, rawQrOf } from '../../lib/bills/service.ts';
import { signPayQr, verifyPayQr, receiptQrPng } from '../../lib/bills/pay-qr.ts';
import { signingSecret } from '../config.ts';
import { parseOptionalDate } from '../../lib/dates.ts';
import {
  listNotifications, countNotifications, unreadCount, markRead,
  NOTIFICATIONS_PAGE, NOTIFICATIONS_MAX,
} from '../../lib/notify/index.ts';
import { getSettings, saveSettings, NOTIFY_KINDS } from '../../lib/notify/prefs.ts';
import { db, requireUser } from '../context.ts';

/** Счётчики и аналитика потребления. */
export async function meterRoutes(app: FastifyInstance) {
  app.get('/api/properties/:propertyId/meters', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { propertyId } = request.params as { propertyId: string };
    const meters = await listMeters(db(), user.id, propertyId);
    if (!meters) {
      return reply.code(403).send({ error: 'no_access', message: 'Нет доступа к объекту' });
    }

    return reply.send({
      period: currentPeriod(),
      window: windowState(),
      meters,
      /** Что можно завести: список видов нужен форме добавления */
      kinds: meterKinds(),
    });
  });

  /**
   * Завести счётчик.
   *
   * До этого маршрута счётчик в системе не мог появиться никак: вставка
   * в таблицу существовала только в тестах. Раздел «Показания» был пуст
   * у всех и всегда, а вместе с ним не работала половина аналитики.
   */
  app.post('/api/properties/:propertyId/meters', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { propertyId } = request.params as { propertyId: string };
    const body = request.body as { kind?: string; place?: string };

    const result = await addMeter(db(), {
      userId: user.id,
      propertyId,
      kind: body?.kind ?? '',
      place: typeof body?.place === 'string' ? body.place : null,
    });

    if (!result.ok) {
      const codes = { no_access: 403, bad_kind: 400, duplicate: 409, needs_place: 409 } as const;
      const messages = {
        no_access: 'Нет доступа к объекту',
        bad_kind: 'Выберите вид счётчика',
        duplicate: 'Такой счётчик в этом месте уже есть',
        needs_place: 'Такой счётчик уже есть — подпишите, где стоит новый: кухня, ванная',
      } as const;
      return reply.code(codes[result.reason]).send({
        error: result.reason,
        message: messages[result.reason],
      });
    }

    return reply.code(201).send({ status: 'ok', meterId: result.meterId });
  });

  app.post('/api/meters/:meterId/readings', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { meterId } = request.params as { meterId: string };
    const body = request.body as { value?: string; confirmed?: boolean; photoUrl?: string };

    if (body?.value === undefined || body.value === '') {
      return reply.code(400).send({ error: 'no_value', message: 'Введите показания' });
    }

    const result = await submitReading(db(), {
      userId: user.id,
      meterId,
      value: String(body.value),
      confirmed: body.confirmed === true,
      photoUrl: body.photoUrl,
    });

    if (!result.ok) {
      const code = result.reason === 'no_access' ? 403
        : result.reason === 'not_a_number' ? 400 : 409;
      return reply.code(code).send({
        error: result.reason,
        message: result.message,
        previous: result.previous,
        // Для опечатки: исправленное значение — интерфейс предлагает его кнопкой
        suggested: result.suggested,
        ratio: result.ratio,
        // Подозрительный скачок можно подтвердить и отправить повторно
        confirmable: result.reason === 'needs_confirmation',
      });
    }

    return reply.code(201).send({
      status: 'ok',
      consumption: result.consumption,
      /** Первое показание: расхода ещё нет, «Расход 0» — неправда */
      first: result.first,
      warnings: result.warnings,
    });
  });

  /** История начислений и расчётная задолженность. */
  app.get('/api/properties/:propertyId/bills', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { propertyId } = request.params as { propertyId: string };
    const data = await listBills(db(), user.id, propertyId);
    if (!data) {
      return reply.code(403).send({ error: 'no_access', message: 'Нет доступа к объекту' });
    }
    return reply.send(data);
  });

  /**
   * Ссылка на картинку QR квитанции — для «Сохранить и открыть банк».
   *
   * Сама картинка отдаётся без сессии (нативное скачивание MAX её не
   * передаёт), поэтому ссылка подписана под начисление и живёт 15 минут.
   */
  app.post('/api/bills/:billId/pay-qr', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { billId } = request.params as { billId: string };
    const result = await billQr(db(), user.id, billId);
    if (!result.ok) {
      const codes = { not_found: 404, no_access: 403, no_qr: 404 } as const;
      const messages = {
        not_found: 'Начисление не найдено',
        no_access: 'QR этой квитанции доступен только тому, кто её добавил',
        no_qr: 'У этого начисления нет QR-кода квитанции',
      } as const;
      return reply.code(codes[result.reason]).send({ error: result.reason, message: messages[result.reason] });
    }

    const token = signPayQr(billId, signingSecret());
    return reply.send({
      url: `/api/bills/${encodeURIComponent(billId)}/qr.png?t=${token}`,
      fileName: result.fileName,
    });
  });

  app.get('/api/bills/:billId/qr.png', async (request, reply) => {
    const { billId } = request.params as { billId: string };
    const { t } = request.query as { t?: string };
    if (!verifyPayQr(billId, t ?? '', signingSecret())) {
      return reply.code(403).send({ error: 'bad_link', message: 'Ссылка устарела — откройте оплату заново' });
    }
    const raw = await rawQrOf(db(), billId);
    if (!raw) return reply.code(404).send({ error: 'not_found', message: 'QR не найден' });

    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'private, no-store')
      .header('content-disposition', `inline; filename="kvitanciya.png"`)
      .send(receiptQrPng(raw));
  });

  /**
   * Отметка об оплате.
   *
   * Ставит её житель: прошёл платёж или нет, приложение не знает —
   * в квитанции этого нет, а доступа к биллингу УК у нас тоже нет.
   */
  app.post('/api/bills/:billId/paid', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { billId } = request.params as { billId: string };
    const body = request.body as { paid?: boolean; kopecks?: number };

    const result = await markPaid(db(), user.id, billId, {
      paid: body?.paid !== false,
      kopecks: typeof body?.kopecks === 'number' ? body.kopecks : undefined,
    });

    if (!result.ok) {
      const codes = { not_found: 404, no_access: 403, bad_amount: 400 } as const;
      const messages = {
        not_found: 'Начисление не найдено',
        no_access: 'Нет доступа к объекту',
        bad_amount: 'Сумма должна быть больше нуля',
      } as const;
      return reply.code(codes[result.reason]).send({
        error: result.reason,
        message: messages[result.reason],
      });
    }

    return reply.send({ status: 'ok', billStatus: result.status });
  });

  /* ─────────────── уведомления ─────────────── */

  /**
   * Что человеку присылали.
   *
   * Уведомления писались в базу с самого начала, но прочитать их было
   * негде: маршрута не существовало, колонка `read` не использовалась.
   * Для жителя из браузера это значило, что смену статуса заявки
   * и аварийное отключение он не узнавал вообще никак — сообщения бота
   * доходят только внутри MAX.
   */
  /**
   * Настройки уведомлений.
   *
   * Отдельно от списка: вкладка в профиле управляет доставкой, а колокольчик
   * на главной показывает сами события. Раньше оба пункта вели на один
   * экран, и настройки было негде держать.
   */
  app.get('/api/notifications/settings', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    return reply.send({
      ...(await getSettings(db(), user.id)),
      /** Описания видов приходят с сервера: тексты не должны разъезжаться */
      available: NOTIFY_KINDS,
    });
  });

  /**
   * Сохранение — POST, а не PUT: список методов в CORS перечислен явно,
   * и молча добавленный PUT обрывал бы запрос с фронта на Pages ещё
   * на предполётном OPTIONS. Один раз это уже стоило рабочего дня.
   */
  app.post('/api/notifications/settings', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const body = request.body as { mode?: unknown; kinds?: unknown };
    const saved = await saveSettings(db(), user.id, body ?? {});
    return reply.send({ status: 'ok', ...saved });
  });

  app.get('/api/notifications', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    /**
     * `limit` приходит от кнопки «Показать ещё»: экран просит следующие
     * полсотни, а не страницу. Страницы здесь были бы хуже — телефон,
     * палец и пожилой человек, для которого «Вперёд» означает
     * «потерял место в списке».
     */
    const asked = Number((request.query as { limit?: string })?.limit);
    const limit = Number.isFinite(asked)
      ? Math.min(NOTIFICATIONS_MAX, Math.max(1, Math.floor(asked)))
      : NOTIFICATIONS_PAGE;

    return reply.send({
      unread: await unreadCount(db(), user.id),
      total: await countNotifications(db(), user.id),
      notifications: await listNotifications(db(), user.id, limit),
    });
  });

  app.post('/api/notifications/read', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const body = request.body as { id?: string };
    await markRead(db(), user.id, body?.id ?? null);
    return reply.send({ status: 'ok' });
  });

  app.get('/api/properties/:propertyId/analytics', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { propertyId } = request.params as { propertyId: string };
    const data = await consumptionAnalytics(db(), user.id, propertyId);
    if (!data) {
      return reply.code(403).send({ error: 'no_access', message: 'Нет доступа к объекту' });
    }
    return reply.send(data);
  });
}
