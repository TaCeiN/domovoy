import { platform } from './platform.js';
import { API_BASE, tokenStore } from './config.js';

/**
 * Клиент API.
 *
 * Три вещи, которых не было в прототипе и без которых мобильное приложение
 * разваливается в первый же день:
 *   — сообщение об ошибке, понятное человеку, а не «Failed to fetch»;
 *   — таймаут: висящий запрос хуже упавшего;
 *   — различие «нет сети» и «сервер ответил ошибкой» — лечатся они по-разному.
 */

const TIMEOUT_MS = 12000;

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'unknown', body = null, offline = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
    this.offline = offline;
  }
}

/**
 * Молчаливое восстановление сессии внутри MAX.
 *
 * Сессия живёт 30 дней, и рано или поздно протухает у всех. При запуске
 * приложение и так входит заново по подписанным initData, а вот когда срок
 * вышел ПОСРЕДИ работы, человека выбрасывало на экран сканирования — хотя
 * подпись платформы приходит с каждым запросом и войти можно молча.
 *
 * Одна попытка на запрос: если и она не удалась, пусть решает экран входа.
 */
async function relogin() {
  if (!platform.initData) return false;
  try {
    const result = await request('POST', '/api/auth/max', {}, false);
    return result?.status === 'ok';
  } catch {
    return false;
  }
}

async function request(method, path, payload, allowRelogin = true) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const headers = { 'Content-Type': 'application/json' };

  // Фрагмент URL на сервер не уходит — передаём подписанные параметры сами
  const initData = platform.initData;
  if (initData) headers['X-Max-Init-Data'] = initData;

  // Токен вместо куки: фронт и API живут на разных доменах
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;

  let response;
  try {
    response = await fetch(API_BASE + path, {
      method,
      headers,
      credentials: 'same-origin',
      /**
       * Без явного запрета браузер кэширует GET эвристически — даже когда
       * сервер не просил. Человек видит начисление за прошлый месяц или
       * статус заявки, который давно изменился, и это выглядит настоящим.
       * Заголовок на сервере такой кэш не лечит: браузер до сервера
       * просто не доходит.
       */
      cache: 'no-store',
      signal: controller.signal,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  } catch (error) {
    clearTimeout(timer);
    const aborted = error?.name === 'AbortError';

    /**
     * «Интернета нет» и «наш сервер не отвечает» — разные беды, и лечатся
     * они по-разному. Фронт лежит на GitHub Pages, а API на отдельной
     * машине: если страница открылась, интернет у человека точно есть,
     * и совет «проверьте интернет» отправляет чинить исправное.
     *
     * navigator.onLine врёт в одну сторону: false означает «сети точно нет»,
     * true — лишь «интерфейс поднят». Поэтому доверяем только false.
     */
    const offline = navigator.onLine === false;

    const message = offline
      ? 'Нет интернета. Приложение продолжит работу, когда связь вернётся.'
      : aborted
        ? 'Сервер приложения не отвечает. Скорее всего, он сейчас недоступен — попробуйте через минуту.'
        : 'Не удаётся связаться с сервером приложения. С вашим интернетом всё в порядке — недоступен наш сервер.';

    throw new ApiError(message, {
      offline: true,
      code: offline ? 'offline' : aborted ? 'timeout' : 'server_unreachable',
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!response.ok) {
    // Протухшая сессия не должна оставлять мёртвый токен в хранилище
    if (response.status === 401) {
      tokenStore.clear();

      // В MAX личность подтверждена подписью — входим заново и повторяем
      if (allowRelogin && path !== '/api/auth/max' && await relogin()) {
        return request(method, path, payload, false);
      }
    }
    throw new ApiError(
      body?.message ?? 'Что-то пошло не так. Попробуйте ещё раз.',
      { status: response.status, code: body?.error ?? 'http_error', body },
    );
  }

  // Сервер отдаёт токен в теле — сохраняем его для последующих запросов
  if (body && typeof body.token === 'string') tokenStore.set(body.token);

  return body;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, payload) => request('POST', path, payload ?? {}),

  /* Подбор дома: отвечает и гостю из MAX без квитанции — по подписи initData */
  pickSearch: (q) => request('GET', `/api/pick/search?q=${encodeURIComponent(q)}`),
  pickHouses: (bbox, zoom) => request('GET', `/api/pick/houses?bbox=${bbox}&zoom=${zoom}`),
  pickDistricts: () => request('GET', '/api/pick/districts'),
  pickHouse: (key) => request('GET', `/api/pick/house/${encodeURIComponent(key)}`),
  pickReview: (key, review) => request('POST', `/api/pick/house/${encodeURIComponent(key)}/review`, review),
  pickFavorites: () => request('GET', '/api/pick/favorites'),
  pickFavorite: (key, on) => (on
    ? request('POST', `/api/pick/favorites/${encodeURIComponent(key)}`, {})
    : request('DELETE', `/api/pick/favorites/${encodeURIComponent(key)}`)),
  pickPrompt: () => request('GET', '/api/pick/prompt'),
  pickDismiss: (key) => request('POST', `/api/pick/prompt/${encodeURIComponent(key)}/dismiss`, {}),

  /** Черновик жалобы от бота MAX: кнопка «Подтвердить заявку» несёт его id */
  botDraft: (id) => request('GET', `/api/bot/drafts/${encodeURIComponent(id)}`),
  /** Домовой: вопрос по текущей квартире, ответ — те же реплики, что у бота MAX */
  assistant: (text, propertyId) => request('POST', '/api/assistant', { text, propertyId: propertyId ?? undefined }),

  config: () => request('GET', '/api/config'),
  me: () => request('GET', '/api/me'),
  logout: async () => {
    try {
      return await request('POST', '/api/auth/logout', {});
    } finally {
      tokenStore.clear();
    }
  },

  loginMax: () => request('POST', '/api/auth/max', {}),
  /**
   * Вход по квитанции.
   *
   * Тег клиента идёт в ТЕЛЕ, а не заголовком, хотя нужен он только логам.
   * Нестандартный заголовок превращает каждый межсайтовый запрос
   * в предполётный OPTIONS плюс сам запрос, а забытая строка в списке
   * `allowedHeaders` на сервере обрывает связь целиком — и приложение
   * показывает «сервер недоступен» при живом сервере. Один раз уже стоило
   * рабочего дня. В теле запроса этой цены нет.
   */
  /**
   * `extra` может нести `address` (адрес из справочника, если в квитанции
   * его не было) и `declaredPrivate` (человек сам сказал, что это частный
   * дом, — оба поля собирает public/app/screens/login.js на экране выбора
   * адреса). Оба уходят как есть, без разбора здесь: решение по ним
   * принимает сервер, а не клиент.
   */
  /** Демо-дом на экране входа: роли и вход в роль (подпись MAX — по желанию) */
  demoRoles: () => request('GET', '/api/demo/roles'),
  demoTake: (key, opts = {}) => request('POST', `/api/demo/roles/${encodeURIComponent(key)}/take`, opts),
  loginQr: (qr, extra) => request('POST', '/api/auth/qr', {
    qr,
    client: platform.clientTag ?? undefined,
    ...(extra ?? {}),
  }),
  /**
   * Рассказать о себе по заявке.
   *
   * Отдельный шаг после квитанции: доступ открывает председатель дома,
   * и ему нужно понять, кто просит. Имени из MAX для этого не хватает —
   * у половины аккаунтов там нет фамилии.
   */
  sendClaim: (bindingId, payload) =>
    request('POST', `/api/properties/claims/${bindingId}`, payload),
  /**
   * Отозвать свою заявку.
   *
   * DELETE, потому что на сервере это настоящее удаление строки: человек
   * передумал сообщать о себе, и его ФИО с номером квартиры не должны
   * остаться ни в очереди председателя, ни в базе.
   */
  withdrawClaim: (bindingId) =>
    request('DELETE', `/api/properties/claims/${bindingId}`),
  /** Подсказка улиц загруженного региона: адрес выбирается, а не пишется */
  streets: (region, q) =>
    request('GET', `/api/address/streets?region=${encodeURIComponent(region)}&q=${encodeURIComponent(q)}`),
  /** Дома выбранной улицы: номер выбирается из списка, а не набирается */
  houses: (street) => request('GET', `/api/address/houses?street=${encodeURIComponent(street)}`),
  verifyPhone: (contact) => request('POST', '/api/auth/phone', contact),
  approveAccess: (bindingId) => request('POST', `/api/properties/${bindingId}/approve`, {}),
  revokeAccess: (bindingId) => request('POST', `/api/properties/${bindingId}/revoke`, {}),
  household: (propertyId) => request('GET', `/api/properties/${propertyId}/household`),

  /**
   * Приглашение жильца.
   *
   * Квитанция на квартиру одна и лежит у собственника — домочадцу нечего
   * сканировать. Собственник зовёт его кодом, и доступ открывается сразу:
   * за приглашённого поручился тот, кто знает, кто у него живёт.
   */
  createInvite: (propertyId) =>
    request('POST', `/api/properties/${propertyId}/invites`, {}),
  invites: (propertyId) => request('GET', `/api/properties/${propertyId}/invites`),
  revokeInvite: (inviteId) => request('DELETE', `/api/invites/${inviteId}`),
  redeemInvite: (code) => request('POST', '/api/invites/redeem', { code }),

  /**
   * Обращения ОДНОЙ квартиры — той, что открыта в приложении.
   * Без адреса сервер отдаёт всё доступное; так ведёт себя старый фронт.
   */
  requests: (propertyId, limit) => request(
    'GET',
    '/api/requests'
    + (propertyId ? `?propertyId=${encodeURIComponent(propertyId)}` : '?')
    + (limit ? `&limit=${encodeURIComponent(limit)}` : ''),
  ),
  request: (id) => request('GET', `/api/requests/${id}`),
  createRequest: (payload) => request('POST', '/api/requests', payload),
  rateRequest: (id, stars, comment) =>
    request('POST', `/api/requests/${id}/rating`, { stars, comment }),
  commentRequest: (id, text) => request('POST', `/api/requests/${id}/comment`, { text }),
  /** «Проблема не решена» — вернуть выполненную заявку в работу */
  disputeRequest: (id, text) => request('POST', `/api/requests/${id}/dispute`, { text }),

  /**
   * Приложить файл к обращению.
   *
   * Идёт мимо `request()`: там тело всегда JSON, а файл уходит формой.
   * Заголовки те же — токен сессии и подпись MAX, иначе межсайтовый
   * запрос не опознает человека.
   */
  /** Скачать вложение с сессией: публичных ссылок у файлов нет */
  fetchFile: async (path) => {
    const headers = {};
    const initData = platform.initData;
    if (initData) headers['X-Max-Init-Data'] = initData;
    const token = tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(API_BASE + path, { headers, credentials: 'same-origin' });
    if (!response.ok) {
      throw new ApiError('Не удалось открыть файл', {
        status: response.status, code: 'file_error',
      });
    }
    return response.blob();
  },

  /**
   * Отправка файла с сессией.
   *
   * Заголовки те же, что у обычных запросов, но тело — FormData, и
   * `content-type` ставит браузер: указать его руками нельзя, иначе
   * потеряется граница multipart.
   */
  uploadFile: async (path, file, failure) => {
    const body = new FormData();
    body.append('file', file, file.name);

    const headers = {};
    const initData = platform.initData;
    if (initData) headers['X-Max-Init-Data'] = initData;
    const token = tokenStore.get();
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(API_BASE + path, {
      method: 'POST', headers, credentials: 'same-origin', body,
    });

    const text = await response.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new ApiError(parsed?.message ?? failure, {
        status: response.status, code: parsed?.error ?? 'http_error', body: parsed,
      });
    }
    return parsed;
  },

  attachFile: (requestId, file) => api.uploadFile(
    `/api/requests/${requestId}/files`, file, 'Не удалось приложить файл',
  ),

  /** Объявление прочитано: отметка ставится на открытии карточки */
  markPostRead: (postId) => request('POST', `/api/posts/${postId}/read`),

  attachPostPhoto: (postId, file) => api.uploadFile(
    `/api/posts/${postId}/photo`, file, 'Не удалось приложить фотографию',
  ),

  /**
   * scope: 'house' — объявления дома (УК и председатель),
   *        'market' — доска соседей. Без scope приходит всё: так главный
   *        экран одним запросом получает и баннер аварии, и остальное.
   */
  feed: (scope, limit) => request(
    'GET',
    '/api/feed?'
    + (scope ? `scope=${encodeURIComponent(scope)}` : '')
    + (limit ? `&limit=${encodeURIComponent(limit)}` : ''),
  ),
  createPost: (payload) => request('POST', '/api/feed', payload),

  polls: () => request('GET', '/api/polls'),
  poll: (id) => request('GET', `/api/polls/${id}`),
  vote: (id, optionId) => request('POST', `/api/polls/${id}/vote`, { optionId }),

  meters: (propertyId) => request('GET', `/api/properties/${propertyId}/meters`),
  /**
   * Завести счётчик.
   *
   * До этого маршрута приборы учёта в системе не появлялись никак:
   * вставка в таблицу жила только в тестах, и раздел «Показания»
   * был пуст у каждого жителя.
   */
  addMeter: (propertyId, payload) =>
    request('POST', `/api/properties/${propertyId}/meters`, payload),

  /**
   * Квитанция, отнесённая к своему объекту.
   *
   * Отдельный маршрут, а не вход по квитанции: человек уже вошёл и уже
   * сказал, к какой квартире относит счёт, — адрес спрашивать не нужно.
   */
  attachReceipt: (propertyId, qr, extra) =>
    request('POST', `/api/properties/${propertyId}/receipts`, {
      qr,
      client: platform.clientTag ?? undefined,
      ...(extra ?? {}),
    }),
  notifications: (limit) => request(
    'GET',
    limit ? `/api/notifications?limit=${encodeURIComponent(limit)}` : '/api/notifications',
  ),
  /** Настройки доставки: что присылать ботом, а что оставить только в списке */
  notifySettings: () => request('GET', '/api/notifications/settings'),
  saveNotifySettings: (payload) => request('POST', '/api/notifications/settings', payload),

  /**
   * Совет дома. Отдельного входа нет: это та же сессия жителя,
   * а права выводятся из роли председателя.
   */
  chairmanMe: () => request('GET', '/api/chairman/me'),
  /**
   * houseKey — у председателя нескольких домов: без него сервер берёт
   * первое председательство, и второй дом был недостижим.
   */
  chairmanHouse: (houseKey) =>
    request('GET', `/api/chairman/house?houseKey=${encodeURIComponent(houseKey ?? '')}`),
  chairmanContacts: (houseKey) =>
    request('GET', `/api/chairman/contacts?houseKey=${encodeURIComponent(houseKey)}`),
  saveChairmanContact: (houseKey, form) =>
    request('POST', '/api/chairman/contacts', { houseKey, ...form }),
  removeChairmanContact: (houseKey, id) =>
    request('POST', `/api/chairman/contacts/${encodeURIComponent(id)}/remove`, { houseKey }),
  /** Телефоны дома для экрана аварийных служб */
  houseContacts: (propertyId) =>
    request('GET', `/api/properties/${encodeURIComponent(propertyId)}/house-contacts`),
  chairmanClaims: (houseKey) =>
    request('GET', `/api/chairman/claims?houseKey=${encodeURIComponent(houseKey ?? '')}`),
  decideClaim: (id, role, houseKey) =>
    request('POST', `/api/chairman/claims/${id}/approve`, { role, houseKey }),
  rejectClaim: (id, reason, houseKey) =>
    request('POST', `/api/chairman/claims/${id}/reject`, { reason, houseKey }),

  /**
   * Объявления и опросы совета дома.
   *
   * houseKey передаём всегда, хотя сервер и умеет обойтись без него:
   * без ключа он берёт ПЕРВОЕ председательство человека, и у того,
   * кто ведёт совет в двух домах, объявление молча уйдёт не туда.
   */
  chairmanPosts: (houseKey, limit) => request(
    'GET',
    `/api/chairman/posts?houseKey=${encodeURIComponent(houseKey)}`
    + (limit ? `&limit=${encodeURIComponent(limit)}` : ''),
  ),
  chairmanCreatePost: (payload) => request('POST', '/api/chairman/posts', payload),
  chairmanRemovePost: (id, houseKey) =>
    request('DELETE', `/api/chairman/posts/${id}?houseKey=${encodeURIComponent(houseKey)}`),
  chairmanPolls: (houseKey) =>
    request('GET', `/api/chairman/polls?houseKey=${encodeURIComponent(houseKey)}`),
  chairmanCreatePoll: (payload) => request('POST', '/api/chairman/polls', payload),

  /** Обращения дома в УК — читает и председатель, только не меняет статус. */
  chairmanRequests: (houseKey, { tab, q, limit } = {}) => {
    const params = new URLSearchParams({ houseKey });
    if (tab) params.set('tab', tab);
    if (q) params.set('q', q);
    if (limit) params.set('limit', String(limit));
    return request('GET', `/api/chairman/requests?${params}`);
  },
  chairmanRequest: (id, houseKey) =>
    request('GET', `/api/chairman/requests/${id}?houseKey=${encodeURIComponent(houseKey)}`),
  chairmanCommentRequest: (id, text, houseKey) =>
    request('POST', `/api/chairman/requests/${id}/comment`, { text, houseKey }),
  readNotifications: (id) => request('POST', '/api/notifications/read', id ? { id } : {}),
  submitReading: (meterId, value, confirmed) =>
    request('POST', `/api/meters/${meterId}/readings`, { value, confirmed }),
  analytics: (propertyId) => request('GET', `/api/properties/${propertyId}/analytics`),

  bills: (propertyId) => request('GET', `/api/properties/${propertyId}/bills`),
  markPaid: (billId, paid) => request('POST', `/api/bills/${billId}/paid`, { paid }),
};
