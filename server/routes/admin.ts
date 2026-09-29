import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { admin } from '../../db/schema.ts';
import { verifyPasswordOrBurnTime } from '../../lib/auth/password.ts';
import {
  createAdminSession, resolveAdminSession, destroySession, type SessionAdmin,
} from '../../lib/auth/session.ts';
import { db, setSessionCookie, clearSessionCookie, readSessionToken } from '../context.ts';
import { limited, LIMITS } from '../rate-limit.ts';
import { listActions, recordAction } from '../../lib/admin/audit.ts';
import { searchHouses, houseCard } from '../../lib/admin/houses.ts';
import { getForHouse, startClockForOrg } from '../../lib/requests/service.ts';
import {
  setHouseForm, HOUSE_FORMS, FORM_LABEL, type HouseForm,
} from '../../lib/house/form.ts';
import { createChairman, revokeChairman } from '../../lib/house/chairman.ts';
import { findOrg, fetchHouses, type GisHouse } from '../../lib/address/gis.ts';
import { upsertOrgAndHouses } from '../../lib/dataset/org.ts';
import { chairman, dispatcher, managingOrg } from '../../db/schema.ts';
import { openHouseClaims, decideHouseClaim } from '../../lib/house/claim.ts';
import { searchUsers, userCard, searchOrgs } from '../../lib/admin/people.ts';
import { adminRevokeBinding } from '../../lib/admin/revoke.ts';
import { hashPassword, generatePassword } from '../../lib/auth/password.ts';
import { newId } from '../../lib/ids.ts';
import { listTables, readTable } from '../../lib/admin/tables.ts';
import { operatorEvents, markEventsSeen, EVENT_KINDS, EVENT_LABEL, type EventKind } from '../../lib/admin/events.ts';
import { coverageSnapshot } from '../../lib/coverage/snapshot.ts';
import { loadedRegions } from '../../lib/address/registry.ts';
import { isNull as isNullCol } from 'drizzle-orm';
import { hideReview } from '../../lib/pick/reviews.ts';
import {
  contactTitle, saveContact, findContact, removeContact, readContactBody,
} from '../../lib/house/contacts.ts';
import { listRoles, releaseRole } from '../../lib/demo/roles.ts';
import { seedDemo } from '../../lib/demo/seed.ts';
import { isDemoEnabled, setDemoEnabled } from '../../lib/demo/setting.ts';

/**
 * Кабинет оператора сервиса.
 *
 * ЗАЧЕМ ОН ЕСТЬ. Дом без управляющей компании некому подключить изнутри:
 * председателя назначает УК, а её нет. Разрывает круг человек снаружи —
 * оператор. До этого кабинета он работал командами из консоли.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ:
 *
 *   удаления обращения — ядро продукта в том, что у жителя остаётся
 *   доказательство, которое никто не сотрёт, включая оператора;
 *
 *   смены статуса обращения — это работа диспетчера. Закрытая чужой
 *   рукой жалоба выглядит для жителя так же, как решённая.
 *
 * Оба правила закреплены тестами, а не намерением.
 */

/**
 * Право оператора проверяется на КАЖДОМ запросе, а не при входе.
 *
 * Выключенная учётка обязана терять доступ той же секундой: у оператора
 * он ко всем домам сразу, и двенадцать часов до истечения сессии — это
 * не «почти сразу».
 */
async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionAdmin | null> {
  const found = await resolveAdminSession(db(), readSessionToken(request));
  if (!found) {
    reply.code(401).send({ error: 'unauthorized', message: 'Войдите в кабинет' });
    return null;
  }
  return found;
}

export async function adminRoutes(app: FastifyInstance) {
  app.post('/api/admin/login', async (request, reply) => {
    const body = request.body as { login?: string; password?: string };
    const login = (body?.login ?? '').trim();

    if (limited(request, reply, 'admin-login', LIMITS.login)) return;

    const rows = await db()
      .select()
      .from(admin)
      .where(and(eq(admin.login, login), isNull(admin.disabledAt)))
      .limit(1);

    /**
     * Одинаковый ответ И одинаковое время на неверный логин и неверный
     * пароль: иначе перебором выясняется, какие логины существуют,
     * а логин оператора — половина ключа от всей системы.
     */
    const ok = await verifyPasswordOrBurnTime(body?.password ?? '', rows[0]?.passwordHash);
    if (!ok || !rows[0]) {
      return reply.code(401).send({
        error: 'bad_credentials',
        message: 'Неверный логин или пароль',
      });
    }

    const { token, expiresAt } = await createAdminSession(db(), rows[0].id);
    setSessionCookie(reply, token, expiresAt);
    return reply.send({ status: 'ok', token, name: rows[0].name });
  });

  app.post('/api/admin/logout', async (request, reply) => {
    await destroySession(db(), readSessionToken(request));
    clearSessionCookie(reply);
    return reply.send({ status: 'ok' });
  });

  app.get('/api/admin/me', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    return reply.send({ id: me.id, login: me.login, name: me.name });
  });

  /**
   * Журнал страницами, а не последними двумя сотнями.
   *
   * Разбор спора приходит через полгода, и до правки записи старше
   * двухсотой были недостижимы из кабинета вообще. Параметры приводит
   * сам `listActions`: мусор из адресной строки означает «фильтра нет».
   */
  app.get('/api/admin/audit', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const query = request.query as {
      page?: string; from?: string; to?: string; action?: string;
    };
    return reply.send(await listActions(db(), {
      page: Number(query?.page),
      from: query?.from,
      to: query?.to,
      action: query?.action,
    }));
  });

  /* ─────────────── дома ─────────────── */

  app.get('/api/admin/houses', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const q = ((request.query as { q?: string })?.q ?? '').trim();
    if (q.length < 2) {
      return reply.send([]);
    }
    return reply.send(await searchHouses(db(), q));
  });

  app.get('/api/admin/houses/:houseKey', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { houseKey } = request.params as { houseKey: string };
    return reply.send(await houseCard(db(), houseKey));
  });

  /**
   * Обращение дома целиком — текст, переписка, вложения списком.
   *
   * ТОЛЬКО ЧТЕНИЕ. Оператор разбирает дом, и строки «Течёт крыша» в
   * карточке ему мало. Менять статус или удалять обращение он не может:
   * у жителя должно остаться доказательство, которое никто не сотрёт.
   * Ключ дома в адресе — та же проверка, что у председателя: обращение
   * чужого дома через этот дом не откроется.
   */
  app.get('/api/admin/houses/:houseKey/requests/:id', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { houseKey, id } = request.params as { houseKey: string; id: string };
    const found = await getForHouse(db(), houseKey, id);
    if (!found) return reply.code(404).send({ error: 'not_found', message: 'Обращение не найдено' });
    return reply.send(found);
  });

  app.post('/api/admin/houses/:houseKey/form', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { houseKey } = request.params as { houseKey: string };
    const form = (request.body as { form?: string })?.form as HouseForm;

    if (!HOUSE_FORMS.includes(form)) {
      return reply.code(400).send({
        error: 'bad_form',
        message: `Неизвестная форма. Допустимо: ${HOUSE_FORMS.join(', ')}`,
      });
    }

    await setHouseForm(db(), houseKey, { form, source: 'operator', setBy: me.name });
    await recordAction(db(), {
      adminId: me.id,
      action: 'house.form',
      targetKind: 'house',
      targetId: houseKey,
      summary: `Форма управления: ${FORM_LABEL[form]}`,
      payload: { form },
    });

    return reply.send({ ok: true });
  });

  /** Телефоны дома. Каждое изменение — в журнал, как любое действие оператора. */
  app.post('/api/admin/houses/:houseKey/contacts', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { houseKey } = request.params as { houseKey: string };
    const body = readContactBody(request.body);
    const result = await saveContact(db(), { houseKey, ...body, role: 'operator', by: me.id });
    if (!result.ok) return reply.code(400).send({ error: result.reason, message: result.message });

    await recordAction(db(), {
      adminId: me.id,
      action: 'house.contact.save',
      targetKind: 'house',
      targetId: houseKey,
      summary: `Телефон дома: ${contactTitle(body.kind, body.label.trim())} — ${body.phone.trim()}`,
      payload: { contactId: result.id, ...body },
    });
    return reply.code(201).send({ status: 'ok', id: result.id });
  });

  app.post('/api/admin/houses/:houseKey/contacts/:id/remove', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { houseKey, id } = request.params as { houseKey: string; id: string };
    const found = await findContact(db(), id);
    if (!found || found.houseKey !== houseKey) {
      return reply.code(404).send({ error: 'not_found', message: 'Такого номера в доме нет' });
    }
    await removeContact(db(), id);

    await recordAction(db(), {
      adminId: me.id,
      action: 'house.contact.remove',
      targetKind: 'house',
      targetId: houseKey,
      summary: `Удалён телефон дома: ${contactTitle(found.kind, found.label)} — ${found.phone}`,
      payload: { contactId: id, kind: found.kind, phone: found.phone },
    });
    return reply.send({ ok: true });
  });

  /**
   * Скрыть отзыв о доме: клевета, персональные данные соседа.
   *
   * Удаления нет — только скрытие с причиной, и каждое пишется в журнал.
   * Обращений в УК это не касается: их оператор не скрывает и не удаляет.
   */
  app.post('/api/admin/reviews/:id/hide', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const reason = String((request.body as { reason?: unknown })?.reason ?? '').trim();
    if (reason.length < 3) {
      return reply.code(400).send({ error: 'no_reason', message: 'Укажите причину — её увидит автор отзыва' });
    }

    const hidden = await hideReview(db(), id, me.id, reason);
    if (!hidden) return reply.code(404).send({ error: 'not_found', message: 'Отзыва нет или он уже скрыт' });

    await recordAction(db(), {
      adminId: me.id,
      action: 'review.hide',
      targetKind: 'house',
      targetId: hidden.houseKey,
      summary: `Скрыт отзыв о доме: ${reason}`,
      payload: { reviewId: id, reason },
    });
    return reply.send({ ok: true });
  });

  /**
   * Точечный импорт организации из ГИС ЖКХ по ИНН.
   *
   * Это ИМПОРТ, а не ручной ввод: организация и её дома тянутся теми же
   * функциями, что и полный прогон по региону, и ключ дома считается тем
   * же нормализатором. Иначе дом лёг бы в базу под своим написанием,
   * а житель со своей квитанцией его не нашёл бы — и выглядело бы это
   * как «импорт молча не сработал».
   */
  app.post('/api/admin/houses/:houseKey/org', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { houseKey } = request.params as { houseKey: string };
    const body = request.body as { inn?: string; form?: string };
    const inn = (body?.inn ?? '').trim();
    const form = (body?.form ?? 'tsj') as HouseForm;

    if (!/^\d{10}$|^\d{12}$/.test(inn)) {
      return reply.code(400).send({ error: 'bad_inn', message: 'ИНН — 10 или 12 цифр' });
    }
    if (!HOUSE_FORMS.includes(form)) {
      return reply.code(400).send({ error: 'bad_form', message: 'Неизвестная форма' });
    }

    const found = await findOrg(inn);
    if (!found) {
      return reply.code(404).send({
        error: 'org_not_found',
        message: `Организации с ИНН ${inn} нет в справочнике ГИС ЖКХ`,
      });
    }

    const houses: GisHouse[] = [];
    for (let page = 1; ; page += 1) {
      const chunk = await fetchHouses(found.guid, page);
      houses.push(...chunk.items);
      if (houses.length >= chunk.total || chunk.items.length === 0) break;
    }

    const { orgId } = await upsertOrgAndHouses(db(), inn, found, houses);
    await setHouseForm(db(), houseKey, { form, orgId, source: 'operator', setBy: me.name });

    await recordAction(db(), {
      adminId: me.id,
      action: 'house.org',
      targetKind: 'house',
      targetId: houseKey,
      summary: `Подключена организация ${found.shortName ?? found.name ?? inn}`
        + ` (${FORM_LABEL[form]}), домов в ГИС ЖКХ: ${houses.length}`,
      payload: { inn, form, houses: houses.length },
    });

    return reply.send({ ok: true, orgId, houses: houses.length });
  });

  app.post('/api/admin/houses/:houseKey/chairman', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { houseKey } = request.params as { houseKey: string };
    const userId = ((request.body as { userId?: string })?.userId ?? '').trim();
    if (!userId) {
      return reply.code(400).send({ error: 'bad_input', message: 'Не выбран житель' });
    }

    const res = await createChairman(db(), {
      houseKey, userId, by: { kind: 'operator', who: me.name },
    });

    if (!res.ok) {
      const message = {
        foreign_house: 'Дом не принадлежит назначающему',
        not_a_resident: 'Этот человек не житель дома',
        already_exists: 'У дома уже есть действующий председатель',
      }[res.reason];
      return reply.code(409).send({ error: res.reason, message });
    }

    await recordAction(db(), {
      adminId: me.id,
      action: 'chairman.create',
      targetKind: 'house',
      targetId: houseKey,
      summary: `Назначен председатель: ${res.name}`,
      payload: { userId, chairmanId: res.id },
    });

    return reply.send({ ok: true, id: res.id, name: res.name });
  });

  app.post('/api/admin/chairmen/:id/revoke', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };

    // Читаем ДО снятия: после него строка помечена, и для журнала нужны
    // дом и имя — а брать их из снятой записи значит зависеть от того,
    // что снятие не чистит поля
    const [found] = await db()
      .select({ houseKey: chairman.houseKey, name: chairman.name })
      .from(chairman)
      .where(and(eq(chairman.id, id), isNullCol(chairman.revokedAt)))
      .limit(1);

    const ok = found
      && await revokeChairman(db(), { kind: 'operator', who: me.name }, id);

    if (!ok || !found) {
      return reply.code(404).send({
        error: 'not_found',
        message: 'Действующего председателя с таким номером нет',
      });
    }

    await recordAction(db(), {
      adminId: me.id,
      action: 'chairman.revoke',
      targetKind: 'house',
      targetId: found.houseKey,
      summary: `Снят председатель: ${found.name}`,
      payload: { chairmanId: id },
    });

    return reply.send({ ok: true });
  });

  /* ─────────────── события ─────────────── */

  /**
   * События, которые без оператора никто не разберёт: заявки «Подключить
   * дом», жалобы без адресата, жители из домов вне реестра и без организации.
   * Рассылок нет — оператор смотрит этот раздел сам.
   */
  app.get('/api/admin/events', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const query = request.query as { kind?: string; unseen?: string };
    const kind = EVENT_KINDS.includes(query.kind as EventKind) ? query.kind as EventKind : undefined;
    const result = await operatorEvents(db(), { kind, unseenOnly: query.unseen === '1' });
    return reply.send({ ...result, kinds: EVENT_KINDS.map((k) => ({ kind: k, label: EVENT_LABEL[k] })) });
  });

  app.post('/api/admin/events/seen', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const body = request.body as { items?: { kind?: string; refId?: string }[] };
    const items = (Array.isArray(body?.items) ? body.items : [])
      .filter((item): item is { kind: EventKind; refId: string } =>
        EVENT_KINDS.includes(item?.kind as EventKind) && typeof item?.refId === 'string' && item.refId.length <= 64)
      .slice(0, 500);
    if (items.length === 0) {
      return reply.code(400).send({ error: 'no_items', message: 'Нечего отмечать' });
    }

    const marked = await markEventsSeen(db(), me.id, items);
    if (marked > 0) {
      await recordAction(db(), {
        adminId: me.id,
        action: 'events.seen',
        targetKind: 'operator_event',
        targetId: items.length === 1 ? `${items[0].kind}:${items[0].refId}` : 'many',
        summary: marked === 1 ? `Просмотрено событие «${EVENT_LABEL[items[0].kind]}»` : `Просмотрено событий: ${marked}`,
        payload: { items },
      });
    }
    return reply.send({ ok: true, marked });
  });

  /* ─────────────── покрытие ─────────────── */

  /**
   * Покрытие домов: с какими домами у нас достаточно данных, чтобы
   * прийти и договориться. Два режима — сводка по населённым пунктам
   * и улицам и точки домов видимой части карты.
   */
  app.get('/api/admin/coverage/regions', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    return reply.send({ regions: await loadedRegions(db()) });
  });

  const regionOf = (value: unknown) => (typeof value === 'string' && /^\d{2}$/.test(value) ? value : null);

  app.get('/api/admin/coverage/places', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    const region = regionOf((request.query as { region?: string }).region);
    if (!region) return reply.code(400).send({ error: 'bad_region', message: 'Не указан регион' });

    const snapshot = await coverageSnapshot(db(), region);
    return reply.send({ builtAt: snapshot.builtAt, totals: snapshot.totals, places: snapshot.places });
  });

  app.get('/api/admin/coverage/streets', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    const query = request.query as { region?: string; place?: string };
    const region = regionOf(query.region);
    if (!region || !query.place) return reply.code(400).send({ error: 'bad_query', message: 'Нужны регион и пункт' });

    const snapshot = await coverageSnapshot(db(), region);
    return reply.send({ streets: snapshot.streets.get(query.place) ?? [] });
  });

  app.get('/api/admin/coverage/points', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    const query = request.query as { region?: string; bbox?: string };
    const region = regionOf(query.region);
    const [south, west, north, east] = String(query.bbox ?? '').split(',').map(Number);
    if (!region || ![south, west, north, east].every(Number.isFinite)) {
      return reply.code(400).send({ error: 'bad_query', message: 'Нужны регион и границы карты' });
    }

    const snapshot = await coverageSnapshot(db(), region);
    // Предел: столько точек браузер рисует без рывков, дальше — приблизить карту
    return reply.send(snapshot.points({ south, west, north, east }, 20_000));
  });

  /* ─────────────── заявки на подключение дома ─────────────── */

  app.get('/api/admin/house-claims', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    return reply.send(await openHouseClaims(db()));
  });

  app.post('/api/admin/house-claims/:id/decide', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const body = request.body as { status?: string; reason?: string };
    const status = body?.status;
    if (status !== 'done' && status !== 'rejected') {
      return reply.code(400).send({
        error: 'bad_status', message: 'Решение — «done» или «rejected»',
      });
    }

    /**
     * Причина отказа едет жителю уведомлением.
     *
     * Без неё отказ был невидим полностью: человек продолжал нажимать
     * «Подключить дом» и заводить новые заявки, ни разу не узнав о решении.
     */
    const ok = await decideHouseClaim(db(), id, status, me.name, body?.reason);
    if (!ok) {
      return reply.code(409).send({
        error: 'already_decided',
        message: 'Заявка уже решена или её нет',
      });
    }

    await recordAction(db(), {
      adminId: me.id,
      action: 'house_claim.decide',
      targetKind: 'house_claim',
      targetId: id,
      summary: status === 'done' ? 'Заявка на подключение дома решена' : 'Заявка отклонена',
      payload: { status },
    });

    return reply.send({ ok: true });
  });

  /* ─────────────── жители ─────────────── */

  app.get('/api/admin/users', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const q = ((request.query as { q?: string })?.q ?? '').trim();
    if (q.length < 2) return reply.send([]);
    return reply.send(await searchUsers(db(), q));
  });

  app.get('/api/admin/users/:id', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const card = await userCard(db(), id);
    if (!card) {
      return reply.code(404).send({ error: 'not_found', message: 'Такого человека нет' });
    }
    return reply.send(card);
  });

  app.post('/api/admin/bindings/:id/revoke', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const reason = ((request.body as { reason?: string })?.reason ?? '').trim();

    const res = await adminRevokeBinding(db(), { bindingId: id, reason });
    if (!res.ok) {
      const status = res.reason === 'not_found' ? 404 : 400;
      const message = {
        not_found: 'Такой привязки нет',
        no_reason: 'Нужна причина — житель увидит её у себя на экране',
        already_revoked: 'Доступ уже закрыт',
      }[res.reason];
      return reply.code(status).send({ error: res.reason, message });
    }

    await recordAction(db(), {
      adminId: me.id,
      action: 'binding.revoke',
      targetKind: 'user_property',
      targetId: id,
      summary: res.wasOwner
        ? `Закрыт доступ собственнику, квартира осталась без владельца. Причина: ${reason}`
        : `Закрыт доступ жильцу. Причина: ${reason}`,
      payload: { userId: res.userId, wasOwner: res.wasOwner, reason },
    });

    return reply.send({ ok: true, wasOwner: res.wasOwner });
  });

  /* ─────────────── организации и кабинеты УК ─────────────── */

  app.get('/api/admin/orgs', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const q = ((request.query as { q?: string })?.q ?? '').trim();
    if (q.length < 2) return reply.send([]);
    return reply.send(await searchOrgs(db(), q));
  });

  /**
   * Кабинет УК: завести или сбросить пароль.
   *
   * Пароль возвращается ОДИН раз и в журнал не пишется: журнал читают
   * позже и не только тем, кто действие совершил.
   */
  app.post('/api/admin/orgs/:id/dispatcher', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { id } = request.params as { id: string };
    const login = ((request.body as { login?: string })?.login ?? '').trim();

    const [org] = await db()
      .select({ id: managingOrg.id, name: managingOrg.name, shortName: managingOrg.shortName })
      .from(managingOrg)
      .where(eq(managingOrg.id, id))
      .limit(1);
    if (!org) {
      return reply.code(404).send({ error: 'not_found', message: 'Такой организации нет' });
    }

    const [existing] = await db()
      .select({ id: dispatcher.id, login: dispatcher.login })
      .from(dispatcher)
      .where(eq(dispatcher.orgId, id))
      .limit(1);

    const password = generatePassword();
    const passwordHash = await hashPassword(password);
    const orgName = org.shortName ?? org.name;

    if (existing) {
      await db().update(dispatcher).set({ passwordHash })
        .where(eq(dispatcher.id, existing.id));
      await recordAction(db(), {
        adminId: me.id,
        action: 'dispatcher.reset',
        targetKind: 'managing_org',
        targetId: id,
        summary: `Сброшен пароль кабинета «${orgName}», логин ${existing.login}`,
        payload: { login: existing.login },
      });
      return reply.send({ ok: true, login: existing.login, password });
    }

    if (!login) {
      return reply.code(400).send({
        error: 'bad_input', message: 'Нужен логин для нового кабинета',
      });
    }

    const [taken] = await db()
      .select({ id: dispatcher.id })
      .from(dispatcher)
      .where(eq(dispatcher.login, login))
      .limit(1);
    if (taken) {
      return reply.code(409).send({ error: 'login_taken', message: 'Логин уже занят' });
    }

    await db().insert(dispatcher).values({
      id: newId('dsp'), orgId: id, login, passwordHash, name: `Диспетчер ${orgName}`,
    });
    // Заявки, поданные до кабинета, получают срок с этой минуты
    await startClockForOrg(db(), id);

    await recordAction(db(), {
      adminId: me.id,
      action: 'dispatcher.create',
      targetKind: 'managing_org',
      targetId: id,
      summary: `Заведён кабинет «${orgName}», логин ${login}`,
      payload: { login },
    });

    return reply.send({ ok: true, login, password });
  });

  /* ─────────────── демо-дом ─────────────── */

  /**
   * Демо-дом для экспертов: включить на экране входа, сбросить, освободить
   * роль.
   * Каждое действие — в журнал, как всё, что оператор меняет.
   */
  app.get('/api/admin/demo', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    const roles = await listRoles(db(), -1);
    return reply.send({ enabled: await isDemoEnabled(db()), seeded: roles.length > 0, roles });
  });

  app.post('/api/admin/demo', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    const enabled = (request.body as { enabled?: boolean })?.enabled === true;
    await setDemoEnabled(db(), enabled);
    await recordAction(db(), {
      adminId: me.id, action: enabled ? 'demo.enable' : 'demo.disable',
      targetKind: 'demo', targetId: 'demo',
      summary: enabled ? 'Демо-дом показан на экране входа' : 'Демо-дом убран с экрана входа',
    });
    return reply.send({ enabled });
  });

  app.post('/api/admin/demo/reset', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    const creds = await seedDemo(db());
    await recordAction(db(), {
      adminId: me.id, action: 'demo.reset', targetKind: 'demo', targetId: 'demo',
      summary: 'Демо-дом заведён заново, держатели ролей отвязаны',
    });
    return reply.send(creds);
  });

  app.post('/api/admin/demo/roles/:key/release', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    const { key } = request.params as { key: string };
    if (!await releaseRole(db(), key)) {
      return reply.code(404).send({ error: 'not_found', message: 'Такой роли нет' });
    }
    await recordAction(db(), {
      adminId: me.id, action: 'demo.release', targetKind: 'demo_role', targetId: key,
      summary: `Роль демо-дома «${key}» освобождена`,
    });
    return reply.send({ ok: true });
  });

  /* ─────────────── база: только чтение ─────────────── */

  app.get('/api/admin/tables', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;
    return reply.send(await listTables(db()));
  });

  /**
   * Одна таблица страницами.
   *
   * Ни одного маршрута правки рядом нет и не планируется: правка ячейки
   * мимо правил ломает инварианты тихо — два действующих председателя,
   * житель без дома, обращение без автора. Менять данные можно только
   * действиями, которые знают правила.
   */
  app.get('/api/admin/tables/:name', async (request, reply) => {
    const me = await requireAdmin(request, reply);
    if (!me) return;

    const { name } = request.params as { name: string };
    const query = request.query as { page?: string; q?: string };

    try {
      return reply.send(await readTable(db(), name, {
        page: Number(query?.page ?? 1) || 1,
        q: query?.q ?? '',
      }));
    } catch {
      return reply.code(404).send({ error: 'unknown_table', message: 'Такой таблицы нет' });
    }
  });
}
