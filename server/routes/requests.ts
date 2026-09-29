import type { FastifyInstance } from 'fastify';
import {
  createRequest, listForUser, getForUser, rateRequest, addResidentComment, disputeDone, DISPUTE_DAYS,
} from '../../lib/requests/service.ts';
import { slaHoursFor } from '../../lib/requests/sla.ts';
import { parseOptionalDateOrUndefined } from '../../lib/dates.ts';
import {
  saveAttachment, listAttachments, readAttachment,
  ATTACH_CODES, ATTACH_MESSAGES, MAX_FILE_BYTES,
} from '../../lib/requests/attachments.ts';
import { addresseeForProperty } from '../../lib/requests/addressee.ts';
import { db, requireUser } from '../context.ts';
import { readLimit } from '../../lib/lists.ts';
import { markDraftUsed } from '../../lib/bot/drafts.ts';

/** Заявки со стороны жителя. */
export async function requestRoutes(app: FastifyInstance) {
  app.get('/api/requests', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    /**
     * Список — по ОДНОЙ квартире, той, что открыта в приложении.
     *
     * Обращение принадлежит квартире: у человека с двумя адресами общий
     * список смешивал протечку в одной с домофоном в другой, и понять,
     * к чему относится заявка, было нельзя. Без параметра отдаём всё,
     * что человеку доступно, — так работает старый фронт на Pages.
     */
    const query = request.query as { propertyId?: string };
    const propertyId = typeof query?.propertyId === 'string' ? query.propertyId : undefined;

    const all = await listForUser(db(), user.id, propertyId);
    const open = (s: string) => s !== 'done' && s !== 'rejected';

    /**
     * Режется только архив.
     *
     * Активных у человека единицы, и «Показать ещё» на трёх строках —
     * лишняя кнопка там, где и так видно всё. Архив за год дорастает
     * до шести десятков строк, и он же — то место, где человек ищет
     * прошлогоднюю жалобу.
     */
    const archive = all.filter((r) => !open(r.status));
    const limit = readLimit((request.query as { limit?: string })?.limit);

    return reply.send({
      active: all.filter((r) => open(r.status)).map(publicShape),
      archive: archive.slice(0, limit).map(publicShape),
      archiveTotal: archive.length,
    });
  });

  app.get('/api/requests/:id', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };
    const found = await getForUser(db(), user.id, id);
    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Заявка не найдена' });
    }

    /**
     * Кто на самом деле стоит за этой заявкой — вместе с его телефоном.
     *
     * Раньше карточка рисовала блок «Позвонить диспетчеру» с литералом
     * «+7 (495) 123-45-67 · будни 8:00–20:00»: выдуманный номер
     * и выдуманный график в приложении, чьё правило — «данные только
     * настоящие». Настоящий телефон лежит в реестре и приезжает сюда,
     * а когда его нет, блока на экране не будет вовсе.
     */
    const who = await addresseeForProperty(db(), found.propertyId);

    return reply.send({
      ...publicShape(found),
      addressee: who.kind === 'org'
        ? { kind: 'org', name: who.name, phone: who.phone, hasCabinet: who.hasCabinet }
        : who.kind === 'chairman'
          ? { kind: 'chairman', name: who.name, phone: null, hasCabinet: false }
          : { kind: 'none', name: null, phone: null, hasCabinet: false },
      events: found.events,
      photos: found.photos,
      rating: found.rating,
    });
  });

  app.post('/api/requests', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    /**
     * `photoUrls` от клиента НЕ принимаем.
     *
     * Загрузки файлов в проекте ещё нет, а поле уже принималось без всякой
     * проверки и складывалось в request_photo — то есть житель мог подсунуть
     * диспетчеру ссылку на чужой сервер, и она отрисовывалась в кабинете
     * как <img src>. Это трекер открытия заявки, а не фотография протечки.
     * Поле вернётся, когда появится своё хранилище и будут приходить
     * идентификаторы, а не произвольные адреса.
     */
    const body = request.body as {
      propertyId?: string; category?: string; description?: string;
      kind?: 'complaint' | 'master';
      slotStart?: string; slotEnd?: string;
      /** Черновик бота MAX, по которому заполнена форма: гасим, чтобы не заполнять второй раз */
      draftId?: string;
    };

    if (!body?.propertyId) {
      return reply.code(400).send({ error: 'no_property', message: 'Не выбран объект' });
    }

    const description = (body.description ?? '').trim();
    const category = body.category ?? 'Другое';

    const slotStart = parseOptionalDateOrUndefined(body.slotStart);
    const slotEnd = parseOptionalDateOrUndefined(body.slotEnd);
    if (!slotStart.ok || !slotEnd.ok) {
      return reply.code(400).send({
        error: 'bad_date',
        message: 'Не удалось разобрать удобное время. Выберите его заново',
      });
    }

    const result = await createRequest(db(), {
      userId: user.id,
      userName: user.fullName,
      propertyId: body.propertyId,
      kind: body.kind ?? 'complaint',
      category,
      // Заголовок собираем из описания: отдельное поле пользователи всё равно
      // заполняют так же, а лишний ввод отпугивает
      title: description.split(/[.\n]/)[0] || category,
      description,
      masterSlotStart: slotStart.date,
      masterSlotEnd: slotEnd.date,
    });

    if (!result.ok) {
      const messages: Record<string, string> = {
        no_access: 'Нет доступа к этому объекту',
        empty_description: 'Опишите проблему подробнее — хотя бы пару слов',
      };
      const codes: Record<string, number> = {
        no_access: 403, empty_description: 400,
      };
      return reply.code(codes[result.reason] ?? 400).send({
        error: result.reason,
        message: messages[result.reason],
      });
    }

    // Только свой черновик: чужой id markDraftUsed молча пропускает
    if (typeof body.draftId === 'string') await markDraftUsed(db(), user.id, body.draftId);

    return reply.code(201).send({
      status: 'ok',
      id: result.id,
      number: String(result.number).padStart(5, '0'),
      slaHours: slaHoursFor(category),
    });
  });

  /**
   * Ответ жителя по заявке.
   *
   * Закрывает тупик статуса «нужны уточнения»: до этого диспетчер мог
   * задать вопрос, а житель — только позвонить в УК.
   */
  app.post('/api/requests/:id/comment', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };
    const body = request.body as { text?: string };

    const result = await addResidentComment(db(), {
      userId: user.id,
      userName: user.fullName,
      requestId: id,
      text: body?.text ?? '',
    });

    if (!result.ok) {
      const messages: Record<string, string> = {
        empty: 'Напишите, что уточнить — пустое сообщение диспетчеру не поможет',
        not_found: 'Заявка не найдена',
        closed: 'Заявка закрыта. Если проблема вернулась — заведите новую, срок пойдёт заново',
      };
      const codes: Record<string, number> = { empty: 400, not_found: 404, closed: 409 };
      return reply.code(codes[result.reason]).send({
        error: result.reason,
        message: messages[result.reason],
      });
    }

    return reply.code(201).send({
      status: result.status,
      reopened: result.reopened,
    });
  });

  /**
   * «Проблема не решена» — вернуть выполненную заявку в работу.
   * Подробности — у `disputeDone` в lib/requests/service.ts.
   */
  app.post('/api/requests/:id/dispute', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };
    const body = request.body as { text?: string };

    const result = await disputeDone(db(), {
      userId: user.id,
      userName: user.fullName,
      requestId: id,
      text: body?.text ?? '',
    });

    if (!result.ok) {
      const messages: Record<string, string> = {
        empty: 'Напишите, что не так — без этого диспетчер не поймёт, что доделать',
        not_found: 'Заявка не найдена',
        not_done: 'Вернуть в работу можно только выполненную заявку',
        too_late: `Прошло больше ${DISPUTE_DAYS} дней — заведите новую заявку`,
      };
      const codes: Record<string, number> = { empty: 400, not_found: 404, not_done: 409, too_late: 409 };
      return reply.code(codes[result.reason]).send({ error: result.reason, message: messages[result.reason] });
    }

    return reply.send({ status: 'in_work' });
  });

  app.post('/api/requests/:id/rating', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };
    const body = request.body as { stars?: number; comment?: string };
    const stars = Number(body?.stars);

    const ok = await rateRequest(db(), user.id, id, stars, body?.comment);
    if (!ok) {
      return reply.code(400).send({
        error: 'cannot_rate',
        message: 'Оценить можно только выполненную заявку, оценка от 1 до 5',
      });
    }
    return reply.send({ status: 'ok' });
  });

  /**
   * Приложить файл к обращению.
   *
   * Прикладывать может только тот, кому обращение видно, — проверка та же,
   * что у чтения: `getForUser` возвращает `null`, если человек не из этой
   * квартиры или ещё не подтверждён и обращение не его.
   *
   * Тип определяем по содержимому файла, а не по имени и не по заголовку:
   * и то и другое приходит из того же запроса, что и сам файл.
   */
  app.post('/api/requests/:id/files', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id } = request.params as { id: string };
    const found = await getForUser(db(), user.id, id);
    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Обращение не найдено' });
    }

    const file = await request.file();
    if (!file) {
      return reply.code(400).send({
        error: 'no_file',
        message: 'Выберите фотографию или PDF',
      });
    }

    let bytes: Buffer;
    try {
      bytes = await file.toBuffer();
    } catch {
      // Сработал лимит плагина: файл больше, чем мы готовы принять
      return reply.code(413).send({
        error: 'too_large',
        message: ATTACH_MESSAGES.too_large,
      });
    }

    if (bytes.length > MAX_FILE_BYTES) {
      return reply.code(413).send({ error: 'too_large', message: ATTACH_MESSAGES.too_large });
    }

    const saved = await saveAttachment(db(), {
      requestId: id,
      bytes,
      originalName: file.filename,
      userId: user.id,
    });

    if (!saved.ok) {
      return reply.code(ATTACH_CODES[saved.reason]).send({
        error: saved.reason,
        message: ATTACH_MESSAGES[saved.reason],
      });
    }

    return reply.send({ status: 'ok', file: saved });
  });

  /**
   * Отдать файл.
   *
   * Публичных ссылок у вложений нет: путь на диске наружу не уходит,
   * а каждый запрос проверяет, видно ли человеку само обращение.
   */
  app.get('/api/requests/:id/files/:fileId', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { id, fileId } = request.params as { id: string; fileId: string };
    const found = await getForUser(db(), user.id, id);
    if (!found) {
      return reply.code(404).send({ error: 'not_found', message: 'Обращение не найдено' });
    }

    const file = await readAttachment(db(), id, fileId);
    if (!file) {
      return reply.code(404).send({ error: 'not_found', message: 'Файл не найден' });
    }

    return reply
      .header('Content-Type', file.mime)
      /**
       * `inline` с явным именем: фотографию человек хочет посмотреть, а не
       * скачать. `nosniff` обязателен — без него браузер может решить,
       * что это HTML, и выполнить его на нашем домене.
       */
      .header('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`)
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.bytes);
  });

}

/** Что отдаём наружу: без внутренних идентификаторов УК и автора. */
function publicShape(r: Awaited<ReturnType<typeof listForUser>>[number]) {
  return {
    id: r.id,
    number: String(r.number).padStart(5, '0'),
    kind: r.kind,
    category: r.category,
    title: r.title,
    description: r.description,
    status: r.status,
    statusLabel: r.statusLabel,
    closed: r.closed,
    // Ход за жителем — от этого зависит и подсказка в списке, и форма ответа
    awaitingResident: r.awaitingResident,
    sla: r.sla,
    slaLabel: r.slaLabel,
    /**
     * Есть ли у заявки срок вообще.
     *
     * Его нет, когда реагировать некому (см. createRequest). Без явного
     * признака экран печатал бы «Срок реакции · без срока» — строку,
     * которая выглядит поломкой, а не ответом.
     */
    hasDeadline: r.slaDueAt !== null,
    assigneeName: r.assigneeName,
    rejectReason: r.rejectReason,
    createdAt: r.createdAt,
    closedAt: r.closedAt,
    masterSlotStart: r.masterSlotStart,
    masterSlotEnd: r.masterSlotEnd,
  };
}
