import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  appUser, property, userProperty, uk, bill, account, managingOrg,
} from '../../db/schema.ts';
import {
  bindByReceipt, approveBinding, listHousehold, revokeBinding, type MaxIdentity,
} from '../../lib/auth/bind.ts';
import {
  createSession, destroySession, destroyAllSessionsForUser, resolveSession, SESSION_COOKIE,
} from '../../lib/auth/session.ts';
import { validateContact } from '../../lib/max/contact.ts';
import { formatKopecks } from '../../lib/qr/receipt.ts';
import { repairEncoding } from '../../lib/qr/encoding.ts';
import { statusOf } from '../../lib/bills/service.ts';
import {
  composeAddress, regionCodeFromInn, regionState, loadedRegions, findStreets, housesOnStreet,
} from '../../lib/address/registry.ts';
import { db, verifyMax, setSessionCookie, clearSessionCookie, requireUser, readSessionToken } from '../context.ts';
import { webLoginEnabled } from '../config.ts';
import { saveClaim, withdrawClaim, decidersForHouse } from '../../lib/auth/claims.ts';
import { houseState } from '../../lib/house/form.ts';
import { openClaimsOf } from '../../lib/house/claim.ts';
import { limited, LIMITS } from '../rate-limit.ts';
import type { MaxInitData } from '../../lib/max/init-data.ts';
import type { Database } from '../../db/client.ts';
import { broughtBy } from '../../lib/bills/bringers.ts';
import { isDemoEnabled } from '../../lib/demo/setting.ts';
import { DEMO_HOUSE_KEY } from '../../lib/demo/constants.ts';
import { avatarKind } from '../../lib/auth/avatar.ts';

/**
 * Что приложению нужно знать о доме, чтобы говорить правду на экране.
 *
 * `state` и `deciders` приходят уже посчитанными вызывающим кодом: обе они
 * сами дёргают `houseState`, и раньше эта функция считала его заново —
 * на объект недвижимости выходило до трёх одинаковых `houseState`
 * (по три запроса к базе каждый) за один вызов `/api/me`.
 */
async function houseSummary(
  database: Database,
  state: Awaited<ReturnType<typeof houseState>>,
  deciders: Awaited<ReturnType<typeof decidersForHouse>>,
) {
  let orgName: string | null = null;
  let orgPhone: string | null = null;
  if (state.orgId) {
    const [org] = await database
      .select({
        name: managingOrg.name,
        shortName: managingOrg.shortName,
        phone: managingOrg.phone,
      })
      .from(managingOrg)
      .where(eq(managingOrg.id, state.orgId))
      .limit(1);
    orgName = org ? (org.shortName ?? org.name) : null;
    orgPhone = org?.phone?.trim() || null;
  }
  return {
    form: state.form,
    hasChairman: state.hasChairman,
    orgName,
    /** Настоящий телефон из реестра. Пусто — значит строки на экране не будет */
    orgPhone,
    /**
     * Есть ли у организации кабинет, то есть человек, который заявку прочитает.
     *
     * `deciders.dispatcher` считает ровно это (см. decidersForHouse), но
     * называется так, что экран обращений его не использовал: там читали
     * только `orgName` и обещали «диспетчер увидит сразу» всем 14 213 домам,
     * у которых кабинета нет.
     */
    orgHasCabinet: deciders.dispatcher,
    canAskOperator: deciders.canAskOperator,
  };
}

/**
 * Вход.
 *
 * Внутри MAX: подписанные initData опознают человека, и если у него уже есть
 * привязанный лицевой счёт — квитанция не нужна вовсе, он просто входит.
 * Квитанцию просим только когда привязок ещё нет.
 *
 * В браузере: единственный способ войти — предъявить QR квитанции.
 */

function toIdentity(max: MaxInitData): MaxIdentity {
  return {
    maxUserId: max.user.id,
    firstName: max.user.first_name,
    lastName: max.user.last_name,
    username: max.user.username,
    photoUrl: max.user.photo_url,
    chatId: max.chat?.id ?? null,
  };
}

/**
 * Почему квитанция не принята — словами человека.
 *
 * Раньше здесь стоял тернарник на две ветки, и всё, кроме «это не платёжный
 * QR», объяснялось нехваткой лицевого счёта. Для строки из нативного сканера
 * MAX это неправда: счёт в ней есть, испорчена кодировка, — и человек искал
 * проблему не там, где она была.
 */
const INVALID_QR_MESSAGES: Record<string, string> = {
  not_a_payment_qr:
    'Это не платёжный QR-код. Отсканируйте код с квитанции ЖКУ.',
  mangled:
    'Код прочитался с испорченной кодировкой — так бывает со сканером '
    + 'мессенджера. Сфотографируйте квитанцию: с фотографии приложение '
    + 'разберёт код само.',
  unparsable_address:
    'Адрес в квитанции не удалось разобрать: не нашёлся номер дома. '
    + 'Сфотографируйте квитанцию — с фотографии код читается точнее.',
  missing_pers_acc:
    'В коде нет лицевого счёта плательщика — по такой квитанции '
    + 'квартиру не найти.',
  missing_required:
    'В коде не хватает данных: нужен получатель платежа и его ИНН.',
};

const INVALID_QR_FALLBACK =
  'В коде не хватает данных: нужен лицевой счёт и получатель платежа.';

export async function authRoutes(app: FastifyInstance) {
  /**
   * Что умеет этот запуск: клиент по этому ответу решает, что показывать.
   *
   * `devTools` включает ручной ввод строки QR — без него на компьютере
   * без камеры войти нечем. На проде выключается переменной, а не выкаткой.
   */
  app.get('/api/config', async () => ({
    /** Демо-дом на экране входа — включает оператор */
    demoEnabled: await isDemoEnabled(db()),
    devTools: webLoginEnabled(),
    /** Работает ли вход по квитанции вне MAX — от этого зависит весь экран входа */
    webLogin: webLoginEnabled(),
    maxEnabled: Boolean(process.env.MAX_BOT_TOKEN),
    botUsername: process.env.MAX_BOT_USERNAME ?? null,
  }));

  /** Вход из мини-приложения MAX по подписанным initData. */
  app.post('/api/auth/max', async (request, reply) => {
    const max = verifyMax(request);
    if (!max) {
      return reply.code(401).send({
        error: 'bad_init_data',
        message: 'Не удалось проверить подпись MAX',
      });
    }

    const existing = await db()
      .select()
      .from(appUser)
      .where(eq(appUser.maxUserId, max.user.id))
      .limit(1);

    if (!existing[0]) {
      // Человека ещё не знаем — нужна квитанция, чтобы понять, где он живёт
      return reply.send({
        status: 'needs_receipt',
        name: [max.user.last_name, max.user.first_name].filter(Boolean).join(' '),
        startParam: max.startParam,
      });
    }

    /**
     * Квитанция нужна тому, у кого объекта НЕТ ВОВСЕ, — а не тому, чья
     * заявка ещё не подтверждена.
     *
     * Раньше здесь стояло `status = 'active'`, и человек, отправивший
     * заявку, при следующем открытии мини-аппа снова попадал на экран
     * сканирования. Приложение при этом обещало ему «мы вас запомнили»:
     * обещание давала одна часть системы, а отвечала другая. С появлением
     * уровня 0 это стало прямой ложью — по ожидающему объекту уже открыты
     * свои квитанции, счётчики, аналитика и жалоба в УК, и не пускать
     * туда человека незачем.
     *
     * `revoked` в известные не входит: председатель отказал, и новый
     * заход начинается с новой квитанции.
     */
    const bindings = await db()
      .select({ id: userProperty.id })
      .from(userProperty)
      .where(and(
        eq(userProperty.userId, existing[0].id),
        inArray(userProperty.status, ['active', 'pending']),
      ));

    if (bindings.length === 0) {
      return reply.send({ status: 'needs_receipt', name: existing[0].fullName });
    }

    // chat_id мог появиться только сейчас — без него уведомление слать некуда
    if (max.chat?.id && existing[0].maxChatId !== max.chat.id) {
      await db().update(appUser).set({ maxChatId: max.chat.id })
        .where(eq(appUser.id, existing[0].id));
    }

    const { token, expiresAt } = await createSession(db(), existing[0].id, 'max');
    setSessionCookie(reply, token, expiresAt);
    // Токен в теле — для случая, когда фронт на другом домене и кука не дойдёт
    return reply.send({ status: 'ok', token, startParam: max.startParam });
  });

  /**
   * Вход по QR квитанции. Работает в обоих режимах: если пришли валидные
   * initData — личность подтверждена платформой, если нет — это веб-режим.
   */
  /**
   * Подсказка по улицам загруженного региона.
   *
   * Открыт без сессии намеренно: экран выбора адреса показывается ДО входа,
   * когда человек ещё никто. Персональных данных здесь нет — это публичный
   * справочник ФНС, тот же, что лежит на сайте налоговой.
   */
  app.get('/api/address/streets', async (request, reply) => {
    // Маршрут открыт без сессии — значит частоту ограничиваем обязательно
    if (limited(request, reply, 'streets', LIMITS.lookup)) return;

    const query = request.query as { region?: string; q?: string };
    const code = (query?.region ?? '').trim();
    const text = (query?.q ?? '').trim();

    if (!/^\d{2}$/.test(code)) {
      return reply.code(400).send({ error: 'bad_region', message: 'Не указан регион' });
    }

    const state = await regionState(db(), code);
    if (!state?.loaded) {
      return reply.code(409).send({
        error: 'region_not_loaded',
        message: `Справочник адресов региона ${code} пока не загружен в сервис`,
        available: await loadedRegions(db()),
      });
    }

    return reply.send({ streets: await findStreets(db(), code, text) });
  });

  /**
   * Дома выбранной улицы — житель выбирает свой из списка.
   *
   * Открыт без сессии по той же причине, что и поиск улиц: экран адреса
   * показывается до входа. Отдаются только адреса домов из госреестра —
   * ни жителей, ни квартир, ни организаций.
   */
  app.get('/api/address/houses', async (request, reply) => {
    if (limited(request, reply, 'houses', LIMITS.lookup)) return;

    const street = String((request.query as { street?: string })?.street ?? '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(street)) {
      return reply.code(400).send({ error: 'bad_street', message: 'Не указана улица' });
    }
    return reply.send({ houses: await housesOnStreet(db(), street.toLowerCase()) });
  });

  app.post('/api/auth/qr', async (request, reply) => {
    const body = request.body as {
      qr?: unknown; name?: unknown; intent?: unknown;
      /** Каким путём получена строка: max | camera | photo | manual. Только для логов. */
      source?: unknown;
      /** Платформа и версия клиента MAX. Только для логов. */
      client?: unknown;
      address?: {
        /** Дом, выбранный из списка домов улицы */
        houseKey?: unknown;
        streetCode?: unknown; house?: unknown;
        block?: unknown; building?: unknown; flat?: unknown;
      };
      /**
       * Человек сам сказал, что живёт в частном доме, а не в квартире.
       *
       * Приходит вместе с выбором адреса (когда в квитанции адреса нет) —
       * см. public/app/screens/login.js, действие submit-address. Решает
       * не этот флаг сам по себе, а canOwnPrivateHouse в lib/auth/private-house.ts:
       * слово человека там пятое условие из пяти, а не первое.
       */
      declaredPrivate?: unknown;
    } | undefined;
    const qrString = typeof body?.qr === 'string' ? body.qr : '';
    if (!qrString) {
      return reply.code(400).send({ error: 'no_qr', message: 'Не передан QR-код' });
    }

    /**
     * Частота: по адресу запроса и отдельно по самому лицевому счёту.
     *
     * Второй ключ важнее первого. Перебор номеров счетов идёт с одного
     * адреса, а вот перебор ОДНОГО счёта — например, чтобы завалить
     * председателя заявками на конкретную квартиру — может идти с разных.
     */
    if (limited(request, reply, 'qr', LIMITS.receipt)) return;

    const persAccKey = /persAcc=([^|]+)/i.exec(qrString)?.[1]?.trim();
    if (persAccKey && limited(request, reply, 'qr-acc', LIMITS.receiptAccount, persAccKey)) return;

    const max = verifyMax(request);

    /**
     * Вне MAX этот маршрут в бою закрыт.
     *
     * Строка платёжного QR приходит обычным запросом, и отличить снятую
     * камерой от набранной руками нельзя: подписи ГОСТ Р 56042-2014
     * не предусматривает. Значит без подписи платформы предъявлять нечего,
     * и «вход по квитанции» превращается в «вход по угаданному номеру
     * лицевого счёта». Проверено на живом стенде: придуманная строка
     * открывала чужую квартиру.
     */
    if (!max && !webLoginEnabled()) {
      return reply.code(403).send({
        error: 'web_login_disabled',
        message: 'Вход по квитанции работает внутри мессенджера MAX. '
          + 'Откройте приложение через бота — там личность подтверждает платформа.',
      });
    }

    /**
     * Тот же маршрут служит и входом, и добавлением второго адреса.
     * Разница — есть ли уже сессия: если есть, квитанцию привязываем
     * к вошедшему человеку, иначе по ней его и опознаём.
     */
    const current = await resolveSession(db(), readSessionToken(request));

    /**
     * Адрес, выбранный жителем в справочнике.
     *
     * Собираем строку на сервере, а не принимаем готовую: адрес обязан
     * выглядеть ровно так же, как печатают в квитанции, иначе houseKey
     * разойдётся и сосед со «слепой» квитанцией окажется в другом доме.
     */
    let addressRaw: string | undefined;
    const chosen = body?.address;

    if (chosen && (typeof chosen.houseKey === 'string' || typeof chosen.streetCode === 'string')) {
      // Пусто у частного дома — это нормальный адрес, а не ошибка ввода
      const flat = chosen.flat ? String(chosen.flat) : undefined;
      const composed = typeof chosen.houseKey === 'string'
        ? await composeAddress(db(), { houseKey: chosen.houseKey, flat })
        : await composeAddress(db(), {
            streetCode: String(chosen.streetCode),
            house: String(chosen.house ?? ''),
            block: chosen.block ? String(chosen.block) : undefined,
            building: chosen.building ? String(chosen.building) : undefined,
            flat,
          });

      if (!composed.ok) {
        const MESSAGE = {
          street_not_found: 'Улица не найдена в справочнике — выберите её из подсказки',
          house_not_found: 'Дом не найден — выберите его из списка ещё раз',
          bad_house: 'Укажите номер дома цифрами: «15», «15А», «4Б/1»',
        } as const;
        return reply.code(400).send({ error: composed.reason, message: MESSAGE[composed.reason] });
      }
      addressRaw = composed.addressRaw;
    }

    const result = await bindByReceipt(db(), {
      qrString,
      identity: max ? toIdentity(max) : undefined,
      existingUserId: current?.id,
      displayName: typeof body?.name === 'string' ? body.name : undefined,
      addressRaw,
      declaredPrivate: body?.declaredPrivate === true,
    });

    /**
     * Одна строка лога, ради которой затевалась половина этой работы.
     *
     * Вопрос «портит ли нативный сканер MAX кодировку win-1251» с 25 августа
     * стоял первым в списке задач и оставался без ответа, потому что ответить
     * на него было нечем. Теперь ответ приходит сам: `repaired: true` в бою
     * означает, что портит, а заголовок клиента говорит, на каком устройстве.
     *
     * Разбор здесь зовётся второй раз (первый — внутри bindByReceipt),
     * и это сознательно: тащить флаг ремонта сквозь весь результат привязки
     * ради лога значило бы менять её тип в четырёх местах. Функция чистая
     * и работает на строке в пару сотен байт.
     */
    const repairProbe = repairEncoding(qrString.trim());
    const scanLog = {
      source: typeof body?.source === 'string' ? body.source : 'unknown',
      /**
       * Тег клиента приходит в теле. Заголовок читается как запасной путь:
       * на Pages может ещё жить прежняя версия фронта, которая слала его
       * заголовком, и терять её телеметрию незачем.
       */
      client: (typeof body?.client === 'string' ? body.client : null)
        ?? request.headers['x-scan-platform'] ?? null,
      header: qrString.slice(0, 7),
      repaired: repairProbe.repaired,
    };

    if (result.status === 'invalid_qr') {
      /**
       * Причина уходит клиенту отдельным полем.
       *
       * Экран входа по ней решает, показать ли переход на фотографию:
       * при испорченной кодировке повторный скан тем же сканером даст
       * ровно тот же мусор, и предлагать его — издевательство.
       */
      request.log.warn(
        { scan: 'reject', reason: result.reason, ...scanLog },
        'квитанция не принята',
      );

      return reply.code(400).send({
        error: 'invalid_qr',
        reason: result.reason,
        message: INVALID_QR_MESSAGES[result.reason] ?? INVALID_QR_FALLBACK,
      });
    }

    request.log.info({ scan: 'accept', status: result.status, ...scanLog }, 'квитанция принята');

    /**
     * В квитанции нет адреса — спрашиваем его у жителя.
     *
     * Регион определяем по ИНН получателя: первые две цифры ИНН юрлица
     * это код субъекта. Если справочник этого субъекта ещё не загружен,
     * честно говорим об этом, а не показываем пустой поиск.
     */
    if (result.status === 'needs_address') {
      const code = regionCodeFromInn(result.payeeInn);
      const state = await regionState(db(), code);

      if (!state?.loaded) {
        return reply.code(409).send({
          error: 'region_not_loaded',
          status: 'region_not_loaded',
          regionCode: code,
          payeeName: result.payeeName,
          persAcc: result.persAcc,
          available: await loadedRegions(db()),
          message: code
            ? `В этой квитанции нет адреса, а справочник адресов вашего региона (код ${code}) `
              + 'пока не загружен в сервис. Мы не можем определить дом по одному лицевому счёту: '
              + 'такие данные есть только у вашей управляющей компании.'
            : 'В этой квитанции нет адреса, а определить регион по реквизитам получателя не удалось.',
        });
      }

      return reply.code(409).send({
        error: 'needs_address',
        status: 'needs_address',
        regionCode: state.code,
        regionName: state.name,
        payeeName: result.payeeName,
        persAcc: result.persAcc,
        message: 'В этой квитанции не напечатан адрес — укажите его сами, один раз.',
      });
    }

    /**
     * Заявка заведена. Ответ ОДИНАКОВ и для свободного счёта, и для занятого.
     *
     * Разные ответы на разные догадки — это оракул. Раньше маршрут отвечал
     * «этот счёт уже привязан», «не сходится с данными собственника»
     * или сразу пускал внутрь, и по ответам перебирались и номера счетов,
     * и фамилии собственников. Теперь снаружи видно только то, что заявка
     * принята, — независимо от того, что мы знаем о счёте.
     *
     * Сессию выдаём СРАЗУ, не дожидаясь решения: без неё человек не может
     * ни рассказать о себе, ни узнать, подтвердили ли его, а следующий
     * скан заводил бы ещё одного пользователя и ещё одну заявку. Активной
     * привязки у сессии нет, поэтому данные объекта — включая адрес —
     * закрыты полностью.
     */
    if (result.status === 'pending') {
      const pending = await createSession(db(), result.userId, max ? 'max' : 'web');
      setSessionCookie(reply, pending.token, pending.expiresAt);

      return reply.code(202).send({
        status: 'pending',
        token: pending.token,
        bindingId: result.bindingId,
        /** Заполнены ли данные о себе — от этого зависит следующий экран */
        claimComplete: result.claimComplete,
        hasChairman: result.hasChairman,
        /** Пусто, если у объекта нет квартиры — экран не должен её спрашивать */
        flat: result.flat,
        message: result.hasChairman
          ? 'Заявка принята. Доступ подтверждает председатель совета дома — '
            + 'расскажите о себе, чтобы он понял, кто вы.'
          : 'Заявка принята. Расскажите о себе — а доступ к соседям откроет '
            + 'председатель совета дома, когда управляющая компания его назначит.',
      });
    }

    const { token, expiresAt } = await createSession(
      db(), result.userId, max ? 'max' : 'web',
    );
    setSessionCookie(reply, token, expiresAt);

    return reply.send({
      status: 'ok',
      token,
      firstTime: result.firstTime,
      role: result.role,
      // Адрес мог прийти не из квитанции, а из справочника: показываем тот,
      // с которым объект в итоге сохранён, иначе экран успеха пустует
      address: result.receipt.payer.address ?? addressRaw ?? null,
      persAcc: result.receipt.payer.persAcc,
      uk: result.receipt.payee.name,
      period: result.receipt.period,
      sum: result.receipt.sumKopecks === null ? null : formatKopecks(result.receipt.sumKopecks),
    });
  });

  /**
   * Подтверждение телефона из requestContact(). Второй фактор:
   * initData доказывает владение аккаунтом, телефон — что аккаунт тот самый.
   */
  app.post('/api/auth/phone', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    if (!user.maxUserId) {
      return reply.code(400).send({
        error: 'not_max',
        message: 'Подтверждение телефона доступно только внутри MAX',
      });
    }

    const body = request.body as { phone?: string; authDate?: string; hash?: string };
    const token = process.env.MAX_BOT_TOKEN;
    if (!token) return reply.code(503).send({ error: 'max_disabled' });

    const result = validateContact(
      { phone: body?.phone ?? '', authDate: body?.authDate ?? '', hash: body?.hash ?? '' },
      { botToken: token, userId: user.maxUserId },
    );

    if (!result.ok) {
      return reply.code(400).send({
        error: 'bad_contact',
        reason: result.reason,
        message: 'Не удалось подтвердить номер телефона',
      });
    }

    await db().update(appUser)
      .set({ phone: result.phone, phoneVerifiedAt: new Date() })
      .where(eq(appUser.id, user.id));

    return reply.send({ status: 'ok', phone: result.phone });
  });

  /** Текущий пользователь и его объекты. */
  app.get('/api/me', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const rows = await db()
      .select({
        bindingId: userProperty.id,
        role: userProperty.role,
        status: userProperty.status,
        /** Нужны экрану ожидания: заполнена ли заявка и почему отказали */
        claimName: userProperty.claimName,
        claimFlat: userProperty.claimFlat,
        claimNote: userProperty.claimNote,
        rejectReason: userProperty.rejectReason,
        addressFromUser: userProperty.addressFromUser,
        propertyId: property.id,
        addressRaw: property.addressRaw,
        street: property.street,
        house: property.house,
        block: property.block,
        flat: property.flat,
        houseKey: property.houseKey,
        /**
         * Адрес выбран жителем, а не напечатан в квитанции.
         *
         * Интерфейс обязан это показывать: такой адрес никто не сверял,
         * и выдавать его за данные УК было бы тем же враньём, что
         * «оплачено» вместо «по вашим отметкам».
         */
        addressSource: property.addressSource,
        addressVerifiedAt: property.addressVerifiedAt,
        /**
         * Кто обслуживает дом — из реестра лицензий, а не из квитанции.
         * Пусто, если дома нет в загруженном реестре региона.
         */
        // Короткое имя генерируется при импорте, но подстрахуемся полным:
        // пустая строка «ваш дом обслуживает …» хуже длинного названия
        ukName: sql<string | null>`coalesce(${managingOrg.shortName}, ${managingOrg.name})`,
        ukFullName: managingOrg.name,
        ukPhone: managingOrg.phone,
      })
      .from(userProperty)
      .innerJoin(property, eq(userProperty.propertyId, property.id))
      .leftJoin(managingOrg, eq(property.managingOrgId, managingOrg.id))
      .where(eq(userProperty.userId, user.id))
      /**
       * Порядок обязателен.
       *
       * Фронт берёт `properties[0]` как «текущий адрес», а без сортировки
       * порядок задаёт Postgres по своему усмотрению. У жителя с двумя
       * квартирами после перезагрузки текущей оказывалась то одна, то
       * другая — а от неё зависит вся главная, показания, аналитика
       * и то, в чей дом уйдёт объявление.
       */
      .orderBy(userProperty.createdAt, userProperty.id);

    /**
     * В приложение уходят и подтверждённые объекты, и ожидающие.
     *
     * Раньше здесь оставались только `active`, и второй адрес человека
     * не попадал в приложение вовсе: фронт берёт текущий объект из этого
     * же списка. Получался разрыв с моделью доступа — сервер по уровню 0
     * разрешает свои квитанции, счётчики, аналитику и жалобу в УК
     * (`canSeeOwn` пропускает `pending`), а открыть объект было нечем.
     */
    const visible = rows.filter((r) => r.status === 'active' || r.status === 'pending');

    /**
     * Подтверждать домочадцев может только подтверждённый собственник,
     * поэтому `ownedIds` ниже считается по `active`, а не по видимым.
     */
    const active = visible.filter((r) => r.status === 'active');

    /**
     * Лицевые счета и деньги по квартире целиком.
     *
     * Показываем НЕ начисление за последний месяц, а всё, что житель
     * не отметил оплаченным. Сумма за месяц отвечала не на тот вопрос:
     * человек открывает приложение узнать, сколько должен, а видел,
     * сколько ему насчитали за один период — независимо от того, оплачен
     * он или нет. Отметил август, а июль пропустил — на главной всё
     * равно горел август, и про июль не говорилось ничего.
     *
     * Правило «что считать неоплаченным» берём из lib/bills/service.ts,
     * а не пишем здесь своё: это второе место в проекте, где складываются
     * деньги, и ровно такое раздвоение 31 августа дало «начисление
     * снизилось на 48%» в аналитике.
     */
    const now = new Date();
    const latest = await Promise.all(
      visible.map(async (r) => {
        /**
         * До подтверждения — только то, что человек принёс САМ.
         *
         * Та же граница, что в lib/bills/service.ts (moneyScope), и она
         * обязана стоять здесь тоже: главная берёт сумму отсюда, а не
         * из listBills. Аудит 11 сентября воспроизвёл на живом стенде,
         * как неподтверждённый житель видел на главной 17 070 ₽ вместо
         * своих 7 770 — сложились начисления трёх разных людей, попавших
         * в один объект из-за квитанции без номера квартиры.
         */
        const ownOnly = r.status !== 'active';

        const accounts = await db()
          .select({
            id: account.id,
            persAcc: account.persAcc,
            service: account.service,
            provider: uk.name,
          })
          .from(account)
          .innerJoin(uk, eq(account.ukId, uk.id))
          .where(ownOnly
            ? and(
                eq(account.propertyId, r.propertyId),
                inArray(
                  account.id,
                  db().select({ id: bill.accountId }).from(bill).where(and(
                    eq(bill.propertyId, r.propertyId),
                    broughtBy(user.id),
                  )),
                ),
              )
            : eq(account.propertyId, r.propertyId));

        // Порядок не нужен: складываем всё, а не берём первое
        const bills = await db()
          .select()
          .from(bill)
          .where(ownOnly
            ? and(eq(bill.propertyId, r.propertyId), broughtBy(user.id))
            : eq(bill.propertyId, r.propertyId));

        const statuses = bills.map((b) => statusOf(b, now));
        const unpaid = bills.filter((_, i) => statuses[i] !== 'paid');

        return {
          propertyId: r.propertyId,
          accounts,
          outstandingKopecks: unpaid.reduce((total, b) => total + b.sumKopecks, 0),
          /** Из скольких начислений сложилась сумма — иначе она выглядит странной */
          unpaidCount: unpaid.length,
          overdueCount: statuses.filter((s) => s === 'overdue').length,
          /**
           * Отличает «всё отмечено оплаченным» от «квитанций не приносили».
           * Ноль без этого признака читается как «долгов нет», хотя на деле
           * мы просто ничего не знаем.
           */
          hasBills: bills.length > 0,
        };
      }),
    );

    /**
     * Заявки на доступ, которые ждут МОЕГО решения.
     *
     * Это заявки чужих людей на объекты, которыми я владею, — а не мои
     * собственные ожидающие привязки. Их легко перепутать, потому что
     * лежат они в одной таблице, и тогда кнопка подтверждения не появится
     * никогда.
     *
     * Собственник по-прежнему может подтвердить домочадца: он живёт
     * в квартире и знает, кто ещё в ней живёт. Первичный доступ к самой
     * квартире это НЕ даёт — его открывает председатель или УК, и права
     * подтверждать первого жителя у собственника нет по построению:
     * пока никто не подтверждён, `ownedIds` пуст.
     */
    /**
     * По каким домам человек уже просил подключение.
     *
     * Один запрос на весь `/api/me`, а не на объект: домов у человека
     * единицы, а без этого экран не отличал «кнопку ещё не нажимали»
     * от «заявка подана и ждёт оператора» — и рисовал одно и то же.
     */
    const houseClaims = await openClaimsOf(db(), user.id);

    const ownedIds = active.filter((r) => r.role === 'owner').map((r) => r.propertyId);

    const incoming = ownedIds.length === 0 ? [] : await db()
      .select({
        bindingId: userProperty.id,
        requesterName: appUser.fullName,
        claimedName: userProperty.claimName,
        claimedNote: userProperty.claimNote,
        claimedFlat: userProperty.claimFlat,
        propertyId: property.id,
        addressRaw: property.addressRaw,
        flat: property.flat,
        requestedAt: userProperty.createdAt,
      })
      .from(userProperty)
      .innerJoin(appUser, eq(userProperty.userId, appUser.id))
      .innerJoin(property, eq(userProperty.propertyId, property.id))
      .where(and(
        eq(userProperty.status, 'pending'),
        inArray(userProperty.propertyId, ownedIds),
      ));

    /**
     * Мои заявки, которые ещё не решены.
     *
     * АДРЕСА ЗДЕСЬ НЕТ, и это главное. Раньше отдавались все колонки
     * объекта — `addressRaw`, `street`, `house`, `flat`, `houseKey`, —
     * то есть человек, знающий только ИНН получателя и номер лицевого
     * счёта, получал полный адрес чужой квартиры с номером, не дожидаясь
     * ничьего подтверждения. Связка «лицевой счёт → квартира» живёт
     * только в биллинге УК, и раздавать её мы права не имеем.
     *
     * Отдаём ровно то, что нужно экрану ожидания: что заявка есть,
     * кто её разберёт и почему отказали, если отказали.
     */
    const pendingMine = await Promise.all(
      rows
        .filter((r) => r.status === 'pending' || (r.status === 'revoked' && r.rejectReason))
        .map(async (r) => {
          // Одно вычисление состояния дома на объект — и в `deciders`,
          // и в `houseManagement`, вместо того чтобы каждое поле лезло
          // в базу по отдельности.
          const state = await houseState(db(), r.houseKey);
          const deciders = await decidersForHouse(db(), r.houseKey, state);

          return {
            bindingId: r.bindingId,
            propertyId: r.propertyId,
            status: r.status,
            rejectReason: r.rejectReason,
            // Квартиры может не быть вовсе — тогда заявка полна и без неё
            claimComplete: Boolean(r.claimName && (r.claimFlat || r.flat === '')),
            /**
             * Что человек рассказал о себе — его собственные слова.
             *
             * Нужны экрану отправленной заявки: он показывает, что именно
             * ушло председателю, и даёт это отозвать. Показывать человеку
             * его же заявку безопасно, чужих данных здесь нет.
             */
            claimName: r.claimName,
            claimFlat: r.claimFlat,
            claimNote: r.claimNote,
            deciders,
            /**
             * Отдельное поле, не `house`: тот уже занят номером дома в адресе.
             *
             * Гейт — тот же `addressFromUser`, что и у адресных полей ниже:
             * `houseManagement.orgName` — это название УК или ТСЖ, а у ТСЖ
             * обычно один-два дома на организацию, так что название почти
             * так же однозначно указывает на квартиру, как сам адрес.
             * Раздавать его тому, кто принёс только ИНН и номер счёта
             * (а не настоящий адрес), — та же утечка «счёт → квартира»,
             * от которой защищены соседние поля.
             */
            houseManagement: r.addressFromUser
              ? await houseSummary(db(), state, deciders)
              : null,
            houseClaimAt: houseClaims.get(r.houseKey) ?? null,
            /**
             * Адрес показываем, только если человек принёс его САМ —
             * в своей квитанции или выбрав улицу в справочнике.
             *
             * Адрес, который сервер поднял по номеру лицевого счёта, человеку
             * неизвестен: связка «счёт → квартира» живёт только в биллинге УК.
             * Раздавать её любому, кто угадал номер счёта, мы права не имеем —
             * это и была утечка, найденная аудитом.
             */
            addressRaw: r.addressFromUser ? r.addressRaw : null,
            street: r.addressFromUser ? r.street : null,
            house: r.addressFromUser ? r.house : null,
            flat: r.addressFromUser ? r.flat : null,
            ukName: r.addressFromUser ? r.ukName : null,
          };
        }),
    );

    /**
     * Аватар: фото из MAX, иначе мужской или женский Домовой по ФИО, иначе
     * инициалы (kind: null). Персонаж демо-дома — всегда Домовой: эксперт,
     * взявший роль в MAX, не должен видеть в профиле персонажа своё лицо.
     */
    const demoPersona = rows.some((r) => r.houseKey === DEMO_HOUSE_KEY);
    const photoUrl = demoPersona ? null : (user.maxPhotoUrl ?? null);

    return reply.send({
      user: {
        id: user.id,
        name: user.fullName,
        phoneVerified: user.phoneVerified,
        viaMax: user.maxUserId !== null,
        avatar: { photoUrl, kind: avatarKind(user.fullName) },
      },
      properties: await Promise.all(visible.map(async (r) => {
        const found = latest.find((l) => l.propertyId === r.propertyId);
        const pending = r.status === 'pending';

        /**
         * Адрес ожидающего объекта показываем, только если человек принёс
         * его сам — из печатной квитанции или выбрав улицу в справочнике.
         *
         * Адрес, поднятый нами по номеру лицевого счёта, человеку
         * неизвестен: связка «счёт → квартира» живёт только в биллинге УК.
         * Раздача её любому, кто угадал номер, — находка аудита.
         */
        const hideAddress = pending && !r.addressFromUser;

        // Одно вычисление состояния дома на объект — и в `deciders`,
        // и в `houseManagement`: раньше каждое поле лезло в базу отдельно,
        // и на одну квартиру выходило до трёх одинаковых `houseState`.
        const state = await houseState(db(), r.houseKey);
        const deciders = await decidersForHouse(db(), r.houseKey, state);

        return {
          ...r,
          /** Что открыто по объекту: считает сервер, фронт не выводит сам */
          accessLevel: pending ? 'self' : 'full',
          /** Кого ждём. У подтверждённого объекта ждать некого */
          deciders: pending ? deciders : null,
          /**
           * Отдельное поле, не `house`: тот уже занят номером дома в адресе.
           *
           * Гейт — тот же `hideAddress`, что у адресных полей ниже:
           * `houseManagement.orgName` называет УК или ТСЖ, а для ТСЖ это
           * почти то же самое, что назвать адрес — организаций на один-два
           * дома раскрывают квартиру так же, как «счёт → адрес».
           */
          houseManagement: hideAddress ? null : await houseSummary(db(), state, deciders),
          /** Когда подана заявка «Подключить дом». null — не подавали */
          houseClaimAt: houseClaims.get(r.houseKey) ?? null,
          addressRaw: hideAddress ? null : r.addressRaw,
          street: hideAddress ? null : r.street,
          house: hideAddress ? null : r.house,
          block: hideAddress ? null : r.block,
          flat: hideAddress ? null : r.flat,
          houseKey: hideAddress ? null : r.houseKey,
          /** Квартира демо-дома — главная ставит метку «Демо-дом» */
          demo: r.houseKey === DEMO_HOUSE_KEY,
          /**
           * Название, полное имя и телефон УК — тот же гейт, что у адреса.
           *
           * У ТСЖ и большинства УК на один-два дома название почти так же
           * однозначно указывает на квартиру, как сам адрес: организаций
           * мало, и телефон/название легко сопоставить с конкретным домом.
           * Раньше эти три поля приходили из `...r` выше без защиты —
           * `houseManagement` уже скрыт условием `hideAddress`, а его же
           * содержимое утекало отдельными полями рядом.
           */
          ukName: hideAddress ? null : r.ukName,
          ukFullName: hideAddress ? null : r.ukFullName,
          ukPhone: hideAddress ? null : r.ukPhone,
          accounts: found?.accounts ?? [],
          bill: found
            ? {
                propertyId: found.propertyId,
                outstandingKopecks: found.outstandingKopecks,
                unpaidCount: found.unpaidCount,
                overdueCount: found.overdueCount,
                hasBills: found.hasBills,
              }
            : null,
        };
      })),
      /** Ждут моего подтверждения — домочадцы на моих объектах */
      pendingRequests: incoming,
      /**
       * Мои заявки на доступ.
       *
       * Жалобу в УК по такой квартире подать МОЖНО — это ядро продукта,
       * и оно не ждёт ничьего одобрения. Поэтому `propertyId` здесь есть:
       * приложению он нужен, чтобы завести заявку.
       */
      myPendingAccess: pendingMine,
    });
  });

  /**
   * Рассказать о себе, пока заявка ждёт решения.
   *
   * Отдельный шаг, а не поле при сканировании: в MAX у половины аккаунтов
   * нет фамилии, а у части вместо имени ник. Председатель по такому имени
   * никого не узнает, и заявка зависает — либо, что хуже, подтверждается
   * вслепую. Поэтому ФИО и квартиру человек называет сам, а свободной
   * строкой может объяснить, кто он: «я из 27-й, сын Ивановых».
   */
  app.post('/api/properties/claims/:bindingId', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { bindingId } = request.params as { bindingId: string };
    const body = request.body as { name?: string; flat?: string; phone?: string; note?: string };

    const result = await saveClaim(db(), user.id, bindingId, {
      name: body?.name ?? '',
      flat: body?.flat ?? '',
      phone: body?.phone,
      note: body?.note,
    });

    if (!result.ok) {
      const codes = { not_found: 404, bad_input: 400, already_decided: 409 } as const;
      const messages = {
        not_found: 'Заявка не найдена',
        bad_input: 'Нужны фамилия с именем и номер квартиры',
        already_decided: 'По этой заявке уже принято решение',
      } as const;
      return reply.code(codes[result.reason]).send({
        error: result.reason,
        message: messages[result.reason],
      });
    }

    return reply.send({ status: 'ok' });
  });

  /**
   * Отозвать свою заявку.
   *
   * DELETE, а не смена статуса: человек передумал сообщать о себе, и его
   * ФИО с номером квартиры не должны остаться ни в очереди председателя,
   * ни в базе. Решения по заявке не было — хранить нечего.
   */
  app.delete('/api/properties/claims/:bindingId', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { bindingId } = request.params as { bindingId: string };
    const result = await withdrawClaim(db(), user.id, bindingId);

    if (!result.ok) {
      const codes = { not_found: 404, already_decided: 409 } as const;
      const messages = {
        not_found: 'Заявка не найдена',
        already_decided: 'По этой заявке уже принято решение — отозвать её нельзя',
      } as const;
      return reply.code(codes[result.reason]).send({
        error: result.reason,
        message: messages[result.reason],
      });
    }

    return reply.send({ status: 'ok' });
  });

  /** Заявки на доступ к моим объектам — их подтверждает собственник. */
  app.post('/api/properties/:bindingId/approve', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { bindingId } = request.params as { bindingId: string };
    const ok = await approveBinding(db(), user.id, bindingId);

    if (!ok) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Подтвердить доступ может только собственник объекта',
      });
    }
    return reply.send({ status: 'ok' });
  });

  /** Кто ещё пользуется этим адресом. */
  app.get('/api/properties/:propertyId/household', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { propertyId } = request.params as { propertyId: string };
    const data = await listHousehold(db(), user.id, propertyId);
    if (!data) {
      return reply.code(403).send({ error: 'no_access', message: 'Нет доступа к объекту' });
    }
    return reply.send(data);
  });

  /** Отзыв доступа домочадца. */
  app.post('/api/properties/:bindingId/revoke', async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return;

    const { bindingId } = request.params as { bindingId: string };
    const result = await revokeBinding(db(), user.id, bindingId);

    if (!result.ok) {
      return reply.code(403).send({
        error: 'forbidden',
        message: 'Отозвать доступ может только собственник, и только у домочадца',
      });
    }

    /**
     * Сессии гасим сразу же. Иначе отозванный доступ продолжает работать
     * до истечения токена — тридцать суток, — и отзыв остаётся жестом
     * в интерфейсе, а не действием.
     */
    await destroyAllSessionsForUser(db(), result.revokedUserId);
    return reply.send({ status: 'ok' });
  });

  /**
   * Выход закрывает ВСЕ сессии человека, а не одну текущую.
   *
   * Внутри MAX сессия заводится при каждом открытии мини-аппа
   * (`/api/auth/max`), и за неделю их набирается десяток. Выход, который
   * убивал только предъявленный токен, оставлял остальные живыми:
   * человек нажимал «Выйти», а пропуск продолжал действовать. Для явного
   * действия это неверно — «выйти» значит выйти отовсюду.
   */
  app.post('/api/auth/logout', async (request, reply) => {
    const token = readSessionToken(request);
    const user = await resolveSession(db(), token);
    if (user) await destroyAllSessionsForUser(db(), user.id);
    else await destroySession(db(), token);
    clearSessionCookie(reply);
    return reply.send({ status: 'ok' });
  });
}
