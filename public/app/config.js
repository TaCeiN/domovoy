/**
 * Название приложения — в одном месте.
 *
 * «Домовой»: короткое русское слово, которое пожилой человек читает
 * и понимает мгновенно, и смысл ровно тот — тот, кто следит за домом.
 * Дом и посёлок стоят подзаголовком: приложение одно, домов у него
 * со временем будет много.
 */
export const APP_NAME = 'Домовой';

/**
 * Адрес бэкенда.
 *
 * Правило перевёрнутое и это намеренно: свой origin используем ТОЛЬКО там,
 * где точно знаем, что рядом есть API, — на машине разработчика и на самом
 * домене бэкенда. Во всех остальных случаях идём на удалённый адрес.
 *
 * Обратное правило («если github.io — то удалённый») уже подводило: любой
 * другой хост — предпросмотр, зеркало, свой домен на Pages — молча стучался
 * в несуществующий свой API, и это выглядело как поломка приложения, а не
 * как промах конфигурации.
 *
 * Здесь же лежит единственная строка, которую надо править при переезде
 * бэкенда на другой адрес.
 */
const REMOTE_API = 'https://domovoy.devcore.com.ru';

/** Хосты, которые раздают и статику, и API из одного процесса. */
const SELF_HOSTED = ['localhost', '127.0.0.1', '::1', 'domovoy.devcore.com.ru'];

export const API_BASE = typeof location === 'undefined'
  || SELF_HOSTED.includes(location.hostname)
  ? ''
  : REMOTE_API;

/**
 * Хранилище токена сессии.
 *
 * ПОЧЕМУ НЕ КУКА. Когда фронт на github.io, а API на другом домене, кука
 * становится сторонней: ей нужен SameSite=None, а вебвью на iOS такие куки
 * режет борьбой с трекингом. Вход начинает работать через раз, и отладить
 * это почти невозможно.
 *
 * Токен в заголовке Authorization обходит всю кухню с куками целиком:
 * одинаково работает в браузере, в вебвью и на любом домене.
 */
const TOKEN_KEY = 'domovoy-token';

export const tokenStore = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      // Приватный режим блокирует хранилище — останемся на куке
    }
  },
  clear() {
    this.set(null);
  },
};

/**
 * Человек вышел сам — не втаскивать его обратно.
 *
 * ЗАЧЕМ. Внутри MAX приложение входит само: личность подтверждает
 * мессенджер, и при открытии мини-аппа вызывается `/api/auth/max`.
 * Но тогда кнопка «Выйти» переставала что-либо значить — следующий
 * запуск (а иногда и просто обновление) заводил новую сессию и возвращал
 * человека внутрь. Выход выглядел сломанным.
 *
 * Флаг снимается, когда человек сам нажимает «Войти через MAX».
 */
const MAX_OFF_KEY = 'domovoy-max-off';

export const maxAutoLogin = {
  suppressed() {
    try {
      return localStorage.getItem(MAX_OFF_KEY) === '1';
    } catch {
      return false;
    }
  },
  suppress() {
    try { localStorage.setItem(MAX_OFF_KEY, '1'); } catch { /* приватный режим */ }
  },
  allow() {
    try { localStorage.removeItem(MAX_OFF_KEY); } catch { /* приватный режим */ }
  },
};

/**
 * Какая собственность открыта «сейчас».
 *
 * ЗАЧЕМ. Выбор жил только в памяти вкладки: при каждом запуске приложение
 * ставило первый объект списка. Человек с двумя квартирами переключался
 * на вторую, закрывал мини-апп, возвращался — и снова видел первую.
 *
 * Ключ включает человека: на общем устройстве два аккаунта не должны
 * подсказывать друг другу, какие у них квартиры.
 */
const ACTIVE_PROPERTY_KEY = 'domovoy-active-property';

export const activePropertyStore = {
  get(userId) {
    if (!userId) return null;
    try {
      return localStorage.getItem(`${ACTIVE_PROPERTY_KEY}:${userId}`);
    } catch {
      return null;
    }
  },
  set(userId, propertyId) {
    if (!userId) return;
    try {
      if (propertyId) localStorage.setItem(`${ACTIVE_PROPERTY_KEY}:${userId}`, propertyId);
      else localStorage.removeItem(`${ACTIVE_PROPERTY_KEY}:${userId}`);
    } catch {
      // Приватный режим блокирует хранилище — останемся на первом объекте
    }
  },
};
