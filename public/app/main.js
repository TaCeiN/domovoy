import { api, ApiError } from './api.js';
import { platform } from './platform.js';
import { parseStartParam } from './deeplink.js';
import { mountAssistantButton, openAssistant, closeAssistant } from './assistant.js';
import { activePropertyStore, APP_NAME } from './config.js';
import {
  $, setHtml, toast, skeletonState, errorState, emptyState, formatDate, esc, html, withLoading,
  confirmAction, moreLine, keepScroll, openSheet, closeSheet, dismissSheet,
} from './ui.js';
import { initRouter, reset, go, back, refresh, swap, current, depth, setBackHook } from './router.js';
import { initSwipeBack } from './swipe-back.js';
import { startScreen, revealLate } from './transitions.js';
import { maxAutoLogin } from './config.js';
import { renderLogin, bindLogin, tryMaxLogin } from './screens/login.js';
import {
  renderHome, homeSkeleton, shortAddress, greetingFor, pendingSheetMarkup,
} from './screens/home.js';
import {
  renderRequests, renderRequestDetail, mountRequestDetail, closePhotoViewer, renderComplaintForm, renderSuccess,
  handleRequestAction,
} from './screens/requests.js';
import { renderMeters, renderAnalytics, handleMeterAction } from './screens/meters.js';
import { handleDateAction } from './datepicker.js';
import {
  renderFeed, renderPost, renderPostForm, renderPolls, renderPoll, handleHouseAction,
} from './screens/house.js';
import {
  renderProfile, renderProperties, renderAccess, renderPayment, renderPaymentHistory, renderEmergency,
  renderPrivacy, renderNotifySettings, handleProfileAction,
} from './screens/profile.js';
import {
  renderCouncil, renderCouncilHouse, renderCouncilRequests, renderCouncilRequestDetail,
  renderCouncilContacts, handleCouncilAction,
} from './screens/council.js';
import {
  renderCouncilPosts, renderCouncilPostForm, handleCouncilPostsAction,
} from './screens/council-posts.js';
import {
  renderCouncilPolls, renderCouncilPollForm, handleCouncilPollsAction,
} from './screens/council-polls.js';
import { readTheme, applyTheme } from './theme.js';
import { handlePayAction, initPayReturn } from './pay.js';
import { handleTutorialAction, maybeShowTutorial, openTutorial } from './tutorial.js';
import { renderMaster, handleMasterAction, stepBackMaster } from './screens/master.js';
import {
  renderPick, mountPick, renderPickHouse, renderPickReview, renderPickFavorites, renderPickList, handlePickAction,
} from './screens/pick.js';

/**
 * Оболочка приложения: загрузка, экраны, тема.
 *
 * Экран входа отделён от остального: пока адрес не подтверждён, нижняя
 * навигация не показывается — иначе онбординг обходится тапом по вкладке.
 */

const state = {
  config: null,
  me: null,
  currentProperty: null,
  cleanup: null,
};

const TITLES = {
  login: [APP_NAME, false],
  home: [APP_NAME, true],
  requests: ['Мои обращения', false],
  request: ['Обращение', false],
  complaint: ['Новое обращение', false],
  master: ['Мастер в квартиру', false],
  pick: ['Подбор дома', false],
  'pick-house': ['Дом', false],
  'pick-review': ['Отзыв о доме', false],
  'pick-favorites': ['Мои дома', false],
  'pick-list': ['Дома на карте', false],
  'request-success': ['Готово', false],
  feed: ['Объявления дома', false],
  market: ['Соседи предлагают', false],
  post: ['Объявление', false],
  'new-post': ['Новое объявление', false],
  polls: ['Опросы дома', false],
  poll: ['Опрос', false],
  meters: ['Показания счётчиков', false],
  analytics: ['Аналитика потребления', false],
  payment: ['Оплата ЖКУ', false],
  'payment-history': ['История начислений', false],
  access: ['Доступ к адресу', false],
  properties: ['Моя недвижимость', false],
  'add-property': ['Добавить недвижимость', false],
  'add-receipt': ['Добавить квитанцию', false],
  emergency: ['Аварийные службы', false],
  privacy: ['Персональные данные', false],
  'notify-settings': ['Уведомления', false],
  profile: ['Профиль', false],
  council: ['Совет дома', false],
  'council-house': ['Квартиры дома', false],
  'council-requests': ['Обращения дома', false],
  'council-request': ['Обращение', false],
  'council-posts': ['Объявления совета', false],
  'council-post-new': ['Новое объявление', false],
  'council-polls': ['Опросы дома', false],
  'council-poll-new': ['Новый опрос', false],
  'council-contacts': ['Телефоны дома', false],
};

/* ─────────────── высота под клавиатуру ─────────────── */

/**
 * Насколько должна просесть видимая высота, чтобы считать это клавиатурой.
 *
 * Гоняться за фокусом поля нельзя: на компьютере клавиатура не вылезает,
 * и навигация пропадала бы от простого щелчка по полю. А высота меняется
 * и без клавиатуры — сворачивается адресная строка браузера, появляются
 * панели мессенджера. Настоящая клавиатура на телефоне забирает
 * 250–350px, так что спутать эти величины порогом в 120px нельзя.
 *
 * Ошибаться этот порог должен в сторону «навигация осталась»: лишняя
 * полоска внизу — мелкое неудобство, исчезнувшая на ровном месте
 * навигация — потерянный человек.
 */
const KEYBOARD_MIN_PX = 120;

/**
 * Подкрутить прокрутку так, чтобы поле оказалось примерно посередине
 * видимой полосы.
 *
 * Прокручивается .page: у неё overflow-y:auto, а у .app прокрутки нет
 * вовсе (overflow:hidden). Экраны входа рисуются прямо в #pages, но
 * тоже своей разметкой с классом .page — так что closest находит её
 * везде. Если вдруг не нашёл, молча ничего не делаем: сдвигать наугад
 * хуже, чем оставить как есть.
 */
function centerInView(field, viewHeight) {
  const page = field.closest('.page');
  if (!page) return;

  const box = field.getBoundingClientRect();
  // Насколько центр поля отстоит от центра видимой полосы — на столько
  // и прокручиваем. Координаты обеих величин экранные, поэтому вычитаются
  // напрямую, без пересчёта относительно страницы.
  page.scrollTop += (box.top + box.height / 2) - viewHeight / 2;
}

function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;

  /** Поле, которое ждёт подкрутки в центр: см. focusin ниже */
  let pendingFocus = null;

  const fit = () => {
    document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);

    const up = window.innerHeight - vv.height > KEYBOARD_MIN_PX;
    document.querySelector('.app')?.classList.toggle('typing', up);

    /**
     * Поле в середину видимой полосы — РОВНО ОДИН РАЗ на фокус.
     *
     * Движок сам подкручивает поле в видимую зону и делает это по-своему
     * на каждой платформе: чаще всего утыкает под верхнюю кромку.
     * Подкручивать на каждое изменение размера нельзя — человек пишет
     * объявление в несколько строк, и экран, прыгающий на каждой букве,
     * хуже, чем поле не по центру.
     */
    if (up && pendingFocus) {
      centerInView(pendingFocus, vv.height);
      pendingFocus = null;
    }
  };

  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);

  /**
   * Запоминаем поле, но не двигаем ничего сейчас: клавиатура ещё
   * не выехала, и видимая высота пока прежняя. Двигать будем, когда
   * придёт resize с открытой клавиатурой.
   */
  document.addEventListener('focusin', (event) => {
    const field = event.target.closest?.('input, textarea');
    if (field) pendingFocus = field;
  });

  /** Ушёл фокус — забыли: иначе подкрутим уже неактуальное поле */
  document.addEventListener('focusout', () => { pendingFocus = null; });

  fit();
}

/* ─────────────── отрисовка экранов ─────────────── */

/**
 * Экран рисуется под заставкой — первый после запуска.
 *
 * Переход здесь не нужен и не виден: предыдущего экрана под заставкой
 * нет, а сама она гаснет плавно. Каскад в `new`, наоборот, остаётся —
 * он и есть первое движение после заставки.
 */
function underSplash() {
  const splash = $('#splash');
  return Boolean(splash && !splash.hidden && !splash.classList.contains('gone'));
}

/** Выполнить, когда заставка погаснет (или сразу, если её нет) */
function afterSplash(fn) {
  if (!underSplash()) { fn(); return; }
  setTimeout(() => afterSplash(fn), 200);
}

/** Какой заготовкой ждёт данные экран; остальные — списком */
const SKELETON_OF = { home: 'home', request: 'detail', post: 'detail', payment: 'detail' };

async function renderScreen(name, params = {}, nav = { kind: 'none', scroll: 0 }) {
  const firstLaunch = underSplash();
  const kind = firstLaunch ? 'none' : nav.kind;
  // Шторка принадлежит экрану, с которого её открыли: любой переход её закрывает,
  // включая нативную кнопку «Назад» MAX, которая зовёт back() в обход кликов
  closeSheet();
  state.cleanup?.();
  state.cleanup = null;

  const [title] = TITLES[name] ?? ['', false];
  const screenTitle = params.title ?? title;

  // Гость из MAX без квитанции ходит только в подборе дома: вкладки вели бы в пустоту
  $('.app')?.classList.toggle('onboarding', name === 'login' || !state.me);

  /**
   * Шапка — одна строка: «Назад» и название раздела рядом.
   *
   * Кнопка — только когда есть куда возвращаться; внутри MAX её роль
   * играет нативная кнопка мессенджера, и в шапке остаётся одно название.
   * Без названия: главная (сверху стоит адрес) и экран входа.
   *
   * Шапка лежит поверх страниц (см. .app-header в styles.css). Страница
   * с шапкой получает .with-header — отступ под неё — сразу, а сама шапка
   * меняется в момент старта перехода (applyHeader в onShow). Иначе она
   * появлялась над ещё видимой главной и дёргала её.
   */
  const headerTitle = name === 'home' || name === 'login' ? '' : screenTitle;
  const withHeader = (depth() > 1 && !platform.inMax) || Boolean(headerTitle);
  const applyHeader = () => {
    const header = document.querySelector('.app-header');
    const titleEl = document.querySelector('#hdTitle');
    if (titleEl) titleEl.textContent = headerTitle;
    header?.classList.toggle('off', !withHeader);
  };

  syncTabs(name);
  // Домовёнок — только на главной: на других экранах кнопка закрывала бы их кнопки
  $('.app')?.classList.toggle('on-home', name === 'home' && Boolean(state.me));
  closeAssistant();

  const pages = $('#pages');

  /**
   * Вход и добавление адреса — один и тот же экран сканера, отличаются
   * только подписями и тем, что после добавления мы уже вошли.
   *
   * Рисуем его прямо в контейнер страниц, а не внутрь #screen: у .page
   * абсолютное позиционирование, и вложенная страница получила бы вторую
   * полосу прокрутки и двойные поля.
   */
  if (name === 'login' || name === 'add-property' || name === 'add-receipt') {
    const adding = name === 'add-property';

    /**
     * Квитанция к известной квартире: адрес спрашивать не нужно, и уходит
     * она другим маршрутом — там уже есть сессия и выбранный объект.
     */
    const attachTo = name === 'add-receipt' ? params.id : null;
    const attached = attachTo
      ? state.me?.properties.find((p) => p.propertyId === attachTo)
      : null;

    /**
     * Экран входа приносит собственный `.page` в разметке. Разбираем её
     * во фрагмент и отдаём корневой `.page` модулю переходов — те же
     * правила, что у остальных экранов. bindLogin по-прежнему слушает
     * #pages: уходящий экран `inert`, а его слушатель снимается
     * в начале следующей отрисовки (state.cleanup).
     */
    const template = document.createElement('template');
    template.innerHTML = renderLogin({
      ...state,
      ...params,
      addingAddress: adding,
      attachTo,
      attachLabel: attached ? shortAddress(attached) : '',
    }).trim();
    const loginScreen = startScreen(pages, { kind, element: template.content.firstElementChild, onShow: applyHeader });
    loginScreen.page.classList.toggle('with-header', withHeader);
    state.cleanup = bindLogin(pages, {
      attachTo,
      /**
       * Молча — во всех трёх случаях.
       *
       * Заставка принадлежит запуску приложения и входу в него, а не
       * действию внутри сеанса. Здесь человек уже внутри: он добавил
       * квитанцию к своей квартире, и четыре секунды анимации читаются
       * как «приложение перезапустилось, я что-то сломал».
       */
      onSuccess: () => boot({ silent: true }),
      /**
       * Обновить свои данные, не уходя с экрана: после отправки или отзыва
       * заявки список объектов на сервере уже другой, и профиль не должен
       * показывать вчерашний.
       */
      refreshMe: async () => { state.me = await api.me(); },
      rerender: () => renderScreen(name, params),
    });
    // Разметка синхронная — ждать нечего
    loginScreen.show();
    return;
  }

  // Сначала каркас, потом данные: пустой экран во время загрузки
  // выглядит как зависание
  /**
   * Новый экран — невидимым рядом со старым, см. app/transitions.js.
   * Строка «Загружаем…» станет видна, только если данные не придут
   * за WAIT_MS.
   */
  const screen = startScreen(pages, { kind, onShow: applyHeader });
  screen.page.classList.toggle('with-header', withHeader);
  const host = screen.page;
  host.innerHTML = skeletonState(SKELETON_OF[name] ?? 'list');

  /**
   * Первая настоящая разметка — сигнал к переходу: экран въезжает сразу
   * с данными, одним движением. Заглушка (`skeleton`) сигналом не
   * считается. Если экран уже въехал заглушкой — данные опоздали дольше
   * WAIT_MS, — содержимое проявляется на месте.
   */
  const put = (content, { skeleton = false } = {}) => {
    // Экран, с которого уже ушли: его ответ на новый экран не попадает
    if (screen.stale) return;
    const late = screen.shown;

    setHtml(host, content);

    if (!skeleton) {
      // До перехода: иначе экран въедет сверху и прыгнет вниз на глазах
      if (nav.scroll) host.scrollTop = nav.scroll;
      if (!late) screen.show();
      // refresh анимации не получает ни в каком виде — см. спеку
      else if (kind !== 'none') revealLate(host);
    }
  };

  try {
    /**
     * Раздел «Дом» не существует для частного дома.
     *
     * Прямой переход сюда возможен только в обход вкладки (например
     * старая закладка или уведомление): вкладка уже скрыта в `syncTabs`.
     * Показывать раздел пустым нельзя — «дома» как сообщества у частного
     * дома нет по определению, — поэтому просто возвращаемся на главную.
     */
    if (HOUSE_SECTION_SCREENS.has(name)
      && state.currentProperty?.houseManagement?.form === 'private') {
      await reset('home');
      return;
    }

    switch (name) {
      case 'home':
        put(homeSkeleton(), { skeleton: true });
        put(await renderHome(state));
        // Обучение — после заставки, иначе оно откроется поверх неё
        afterSplash(() => { if (!screen.stale) maybeShowTutorial(state); });
        break;
      case 'requests':
        put(await renderRequests(state));
        break;
      case 'council':
        put(await renderCouncil(state));
        break;
      case 'council-house':
        put(await renderCouncilHouse(state));
        break;
      case 'council-requests':
        put(await renderCouncilRequests(state));
        break;
      case 'council-request':
        put(await renderCouncilRequestDetail(params.id, state));
        break;
      case 'council-posts':
        put(await renderCouncilPosts(state));
        break;
      case 'council-post-new':
        put(renderCouncilPostForm());
        // Не терять набранный текст, если мини-апп случайно свернули
        platform.guardClosing(true);
        state.cleanup = () => platform.guardClosing(false);
        break;
      case 'council-polls':
        put(await renderCouncilPolls(state));
        break;
      case 'council-poll-new':
        put(renderCouncilPollForm());
        platform.guardClosing(true);
        state.cleanup = () => platform.guardClosing(false);
        break;
      case 'council-contacts':
        put(await renderCouncilContacts(state));
        break;
      case 'request':
        put(await renderRequestDetail(params.id));
        mountRequestDetail(host);
        state.cleanup = closePhotoViewer;
        break;
      case 'master':
        put(renderMaster(state));
        setBackHook(() => stepBackMaster({ state }));
        state.cleanup = () => setBackHook(null);
        break;
      case 'pick':
        put(renderPick());
        state.cleanup = await mountPick(host, state);
        break;
      case 'pick-house':
        put(await renderPickHouse(state, params));
        break;
      case 'pick-review':
        put(await renderPickReview(state, params));
        platform.guardClosing(true);
        state.cleanup = () => platform.guardClosing(false);
        break;
      case 'pick-favorites':
        put(await renderPickFavorites());
        break;
      case 'pick-list':
        put(await renderPickList());
        break;
      case 'complaint':
        put(renderComplaintForm(state, 'complaint', {
          category: params?.category, text: params?.text, draftId: params?.draftId,
        }));
        // Не терять заполненную форму при случайном закрытии мини-аппа
        platform.guardClosing(true);
        state.cleanup = () => platform.guardClosing(false);
        break;
      case 'request-success':
        put(renderSuccess(params));
        break;

      case 'meters':
        put(await renderMeters(state));
        break;
      case 'analytics':
        put(await renderAnalytics(state));
        break;

      case 'feed':
        put(await renderFeed(state));
        break;
      case 'market':
        put(await renderFeed(state, { category: 'market' }));
        break;
      case 'post':
        put(await renderPost(state, params));
        break;
      case 'new-post':
        put(renderPostForm());
        platform.guardClosing(true);
        state.cleanup = () => platform.guardClosing(false);
        break;
      case 'polls':
        put(await renderPolls(state));
        break;
      case 'poll':
        put(await renderPoll(state, params));
        break;

      case 'profile':
        put(renderProfile(state));
        break;
      case 'properties':
        put(renderProperties(state));
        break;
      case 'access':
        put(await renderAccess(state));
        break;
      case 'payment':
        put(await renderPayment(state));
        // Из бота «мои лицевые счета» — сразу к разделу счетов
        if (params.focus === 'accounts') host.querySelector('#payAccounts')?.scrollIntoView({ block: 'start' });
        break;
      case 'payment-history':
        put(await renderPaymentHistory(state));
        break;
      case 'emergency':
        put(await renderEmergency(state));
        break;
      case 'privacy':
        put(renderPrivacy());
        break;

      case 'notifications':
        put(await notificationsScreen());
        break;
      case 'notify-settings':
        put(await renderNotifySettings());
        break;

      default:
        put(`<div class="state">
          <div class="state-title">Раздел в разработке</div>
          <div class="state-text">Скоро появится</div>
        </div>`);
    }
  } catch (error) {
    /**
     * Протухшая сессия — не ошибка загрузки, а повод войти заново.
     * Показывать «Не удалось загрузить» в этом случае значит запереть
     * человека в тупике: кнопка «Повторить» даст тот же 401.
     */
    if (error instanceof ApiError && error.status === 401) {
      state.me = null;
      state.currentProperty = null;
      await reset('login', { name: platform.unsafeName });
      return;
    }
    if (screen.stale) return;
    setHtml(host, errorState(error, 'reload'));
    screen.show();
  }
}

/**
 * Перечитать председательство.
 *
 * ЗАЧЕМ ОТДЕЛЬНОЙ ФУНКЦИЕЙ. Раньше эта строка стояла единственный раз —
 * внутри `boot()`. Значит роль, полученная во время сеанса, до человека
 * не доходила вовсе. Проверено на живом стенде 11 сентября: оператор
 * назначает председателя, сервер отвечает `isChairman: true`, а экран
 * продолжает показывать «ожидает» и «у дома нет председателя», пока
 * мини-апп не закроют и не откроют заново. В MAX с его кэшем это
 * означало до десяти минут неопределённости в самый важный момент
 * подключения дома.
 *
 * Ошибку глотаем: раздел «Совет дома» — дополнение, и упавший запрос
 * не должен мешать приложению жителя работать как обычно.
 */
async function refreshChairman() {
  state.chairman = await api.chairmanMe().catch(() => ({ isChairman: false, houses: [] }));
}

function syncTabs(name) {
  const tabFor = {
    home: 'home',
    requests: 'requests', request: 'requests', complaint: 'requests',
    master: 'requests', 'request-success': 'requests',
    pick: 'home', 'pick-house': 'home', 'pick-review': 'home', 'pick-favorites': 'home', 'pick-list': 'home',
    feed: 'feed', market: 'feed', post: 'feed', 'new-post': 'feed',
    polls: 'feed', poll: 'feed',
    profile: 'profile', properties: 'profile', access: 'profile',
    privacy: 'profile', 'add-property': 'profile', 'notify-settings': 'profile',
    'add-receipt': 'profile',
  };
  const active = tabFor[name];
  document.querySelectorAll('.apptab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.tab === active);
  });

  /**
   * У частного дома «дома» как сообщества не существует.
   *
   * Вкладка вела бы на раздел, которого нет по определению — соседей,
   * ленты и опросов у одного дома без общего имущества не бывает.
   * Прячем вкладку целиком, а не показываем её пустой.
   */
  const feedTab = document.querySelector('.apptab[data-tab="feed"]');
  if (feedTab) feedTab.hidden = state.currentProperty?.houseManagement?.form === 'private';
}

/** Экраны раздела «Дом»: недоступны частному дому — см. syncTabs выше. */
const HOUSE_SECTION_SCREENS = new Set(['feed', 'market', 'post', 'new-post', 'polls', 'poll']);

/* ─────────────── действия ─────────────── */

const NAVIGATE = {
  home: 'home', requests: 'requests', complaint: 'complaint', master: 'master',
  feed: 'feed', profile: 'profile', meters: 'meters', analytics: 'analytics',
  polls: 'polls', market: 'market', payment: 'payment', 'payment-history': 'payment-history', access: 'access',
  emergency: 'emergency', properties: 'properties', notifications: 'notifications',
  'notify-settings': 'notify-settings',
  council: 'council',
  pick: 'pick',
};

async function handleAction(action, target) {
  /**
   * back здесь не роскошь: экран-форма закрывается ВОЗВРАТОМ на список,
   * а не reset-ом. reset стирает стек навигации целиком, и кнопка «Назад»
   * в шапке пропадает — человек остаётся на списке без выхода в раздел.
   */
  const ctx = {
    state, show: (n, p) => go(n, p), go, reset, refresh, back,
    /**
     * Перечитать свой профиль: список объектов и статусы могли измениться.
     *
     * Вместе с профилем ОБЯЗАТЕЛЬНО переставляем `currentProperty`: это
     * объект из прежнего ответа `/api/me`, и без перестановки он остаётся
     * старым. Главная и переключатель квартир читают именно его, поэтому
     * человек, отметивший оплату, возвращался на главную и видел прежнюю
     * сумму — данные пришли, а экран смотрел в старую копию.
     *
     * Если квартира из ответа пропала (доступ отозвали, заявку отклонили),
     * оставляем `null`: указывать в никуда хуже, чем не указывать.
     */
    refreshMe: async () => {
      state.me = await api.me();
      const id = state.currentProperty?.propertyId;
      state.currentProperty = state.me.properties.find((p) => p.propertyId === id) ?? null;
      await refreshChairman();
    },
  };

  // Календарь общий для всех экранов, поэтому стоит первым в цепочке
  if (await handleDateAction(action, target)) return;
  if (handleTutorialAction(action)) return;
  if (await handleRequestAction(action, target, ctx)) return;
  if (await handleCouncilAction(action, target, ctx)) return;
  if (await handleCouncilPostsAction(action, target, ctx)) return;
  if (await handleCouncilPollsAction(action, target, ctx)) return;
  if (await handleMeterAction(action, target, ctx)) return;
  if (await handleHouseAction(action, target, ctx)) return;
  if (await handleProfileAction(action, target, ctx)) return;
  if (await handlePayAction(action, target, ctx)) return;
  if (await handleMasterAction(action, target, ctx)) return;
  if (await handlePickAction(action, target, ctx)) return;

  switch (action) {
    case 'back':
      return back();

    // Профиль → «Как пользоваться приложением»: обучение в любой момент
    case 'tutorial':
      openTutorial(state);
      return;

    case 'reload':
      return boot();

    /**
     * Следующие полсотни уведомлений вместо страницы: см. notificationsTail.
     *
     * Место прокрутки возвращаем руками: экран перерисовывается целиком,
     * и без этого человек, нажавший кнопку внизу списка, оказывается
     * в его начале — то есть теряет ровно то место, ради которого
     * и нажимал.
     */
    case 'notif-more':
      notificationsShown += NOTIFICATIONS_STEP;
      return keepScroll(refresh);

    /** Возврат после собственного выхода: снимаем запрет и входим заново */
    case 'max-login':
      maxAutoLogin.allow();
      return boot();

    case 'request':
      return go('request', { id: target.dataset.id });

    case 'assistant-open':
      return openAssistant({
        propertyId: state.currentProperty?.propertyId ?? null,
        navigate: (payload) => openTarget(parseStartParam(payload)),
      });

    case 'request-success':
      return reset('requests');

    case 'logout': {
      const sure = await confirmAction({
        title: 'Выйти из приложения?',
        text: 'Данные останутся на месте. Чтобы вернуться, понадобится '
          + 'квитанция или вход через MAX.',
        confirmLabel: 'Выйти',
        danger: true,
      });
      if (!sure) return;

      /**
       * Внутри MAX запрещаем автовход до следующего явного согласия:
       * иначе следующий запуск заведёт новую сессию и вернёт человека
       * внутрь, будто кнопка «Выйти» ничего не делает.
       */
      maxAutoLogin.suppress();
      await api.logout().catch(() => {});
      state.me = null;
      state.currentProperty = null;
      return reset('login');
    }

    case 'approve':
      try {
        await api.approveAccess(target.dataset.id);
        platform.haptic('medium');
        toast('Доступ выдан');
        state.me = await api.me();
        await refresh();
      } catch (error) {
        toast(error.message);
      }
      return;

    /**
     * Отказ по запросу доступа.
     *
     * Тот же эндпоинт, что и отзыв доступа: заявка помечается отозванной
     * и уходит из списка. Без этой кнопки чужой человек, сфотографировавший
     * квитанцию, висел в запросах вечно — разрешить было можно, отказать
     * нечем.
     */
    case 'reject':
      try {
        await api.revokeAccess(target.dataset.id);
        platform.haptic('medium');
        toast('Запрос отклонён');
        state.me = await api.me();
        await refresh();
      } catch (error) {
        toast(error.message);
      }
      return;

    /**
     * Просьба подключить дом, за которым никто не стоит.
     *
     * Идентификатор квартиры берём из кнопки, а не из `state.currentProperty`:
     * кнопка появляется и на экране ожидания, где текущего объекта ещё нет
     * вовсе, — только заявка, к которой она относится.
     */
    case 'ask-operator': {
      const propertyId = target.dataset.id || state.currentProperty?.propertyId;
      await withLoading(target, async () => {
        try {
          const res = await api.post('/api/house/claim', { propertyId });
          toast(res?.created
            ? 'Заявка принята — мы подключим ваш дом'
            : 'Заявка уже принята, ждём');
          /**
           * Именно `refreshMe`, а не голое `state.me = await api.me()`.
           *
           * Присваивание профиля НЕ переставляет `currentProperty`, а экран
           * рисуется из него — и поданная заявка не появлялась на месте
           * кнопки: тост исчезал, а блок оставался прежним. Ровно об этой
           * ловушке предупреждает комментарий у `refreshMe` выше, и здесь
           * на неё наступили.
           */
          await ctx.refreshMe();
          /**
           * На экране ожидания после квитанции — не `refresh`.
           *
           * Он заново рисует экран входа с нуля, и карточка заявки
           * пропадала: человек, только что нажавший «Подключить дом»,
           * оказывался перед «Сфотографируйте квитанцию», будто ничего
           * не отправил. Экран входа сам перерисует свою карточку.
           */
          const screen = current();
          if (screen && ENTRY_SCREENS.has(screen.name)) {
            document.dispatchEvent(new CustomEvent('house-claimed'));
          } else {
            await refresh();
          }
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    /**
     * Шторка «ожидает»: объяснение, «Проверить», код приглашения.
     * Открывается нажатием на пометку в шапке главной, см. pendingSheetMarkup.
     */
    case 'pending-sheet':
      if (state.currentProperty?.status === 'pending') {
        openSheet(pendingSheetMarkup(state.currentProperty), 'Заявка на доступ');
      }
      return;

    case 'sheet-close':
      dismissSheet();
      return;

    /** Проверка, подтвердил ли собственник доступ. Сессия уже своя. */
    case 'check-access':
      try {
        state.me = await api.me();
        /**
         * Председательство перечитываем ТОЖЕ.
         *
         * Человек жмёт «Проверить» ровно в тот момент, когда его дом
         * подключают, — а подключение дома чаще всего и означает, что
         * председателем назначили его самого. Пока здесь читался только
         * профиль, роль до него не доходила: сервер отвечал
         * `isChairman: true`, а раздела в приложении не появлялось
         * до полного перезапуска мини-аппа.
         */
        await refreshChairman();

        /**
         * Подтверждение — это ACTIVE. Ожидающий объект приходит в список
         * сразу, поэтому проверка на длину списка отвечала бы «пустили»
         * ещё до решения председателя.
         */
        const approved = state.me.properties.find((p) => p.status === 'active');
        if (approved) {
          platform.haptic('medium');
          state.currentProperty = approved;
          activePropertyStore.set(state.me.user?.id, approved.propertyId);
          toast(state.chairman?.isChairman
            ? 'Доступ открыт. Вас назначили председателем совета дома'
            : 'Доступ к дому открыт');
          return reset('home');
        }
        /**
         * Ответ пишем в шторку, если «Проверить» нажали в ней: тост
         * живёт в .app с z-index 50, а шторка — 81, и под её фоном
         * тоста было бы не видно.
         */
        const status = document.querySelector('#pendingStatus');
        if (status) {
          status.textContent = 'Пока не подтвердили — загляните позже.';
          status.classList.add('show');
        } else {
          toast('Председатель пока не подтвердил доступ');
        }
      } catch (error) {
        toast(error.message);
      }
      return;

    /**
     * Вход по коду приглашения.
     *
     * Отдельно от квитанции: здесь человека впускает не платёжка,
     * а поручительство собственника. Ошибки называем словами — «код
     * не найден», «срок истёк», «им уже воспользовались»: человек должен
     * понимать, просить ли новый код или искать опечатку.
     */
    case 'redeem-invite': {
      const field = document.querySelector('#inviteCode');
      const box = document.querySelector('#inviteErr');
      const code = (field?.value ?? '').trim();

      if (code.length < 4) {
        if (box) {
          box.textContent = 'Введите код из приглашения';
          box.classList.add('show');
        }
        return;
      }
      box?.classList.remove('show');

      await withLoading(target, async () => {
        try {
          await api.redeemInvite(code);
          platform.haptic('medium');
          toast('Квартира добавлена');
          // Молча: человек в середине сеанса, заставка здесь читается
          // как перезапуск — см. onSuccess у экрана квитанции
          await boot({ silent: true });
        } catch (error) {
          if (box) {
            box.textContent = error.message;
            box.classList.add('show');
          }
        }
      });
      return;
    }

    /** Квитанция с главной уходит в открытую сейчас квартиру */
    case 'add-receipt-home': {
      if (!state.currentProperty) return;
      return go('add-receipt', { id: state.currentProperty.propertyId });
    }

    default:
      if (NAVIGATE[action]) {
        /**
         * `data-swap` — соседний вид того же места (доски ленты), а не шаг
         * вглубь. Растворение и без записи в стек «назад», см. swap в router.js.
         */
        return target.dataset.swap ? swap(NAVIGATE[action]) : go(NAVIGATE[action]);
      }
  }
}

/* ─────────────── запуск ─────────────── */

/**
 * Заставка при открытии — три режима.
 *
 * Раньше она держалась минимум 4 секунды при КАЖДОМ запуске, включая
 * открытие кнопкой бота («Ваша заявка выполнена» → четыре секунды
 * анимации до статуса) и выход из аккаунта (аудит 26 сентября).
 *
 *   none  — открыли из бота или по ссылке (`start_param`): человек пришёл
 *           за конкретным экраном, заставка ему только мешает;
 *   full  — первый запуск за день: сжатая анимация на 1,2 секунды
 *           (класс `brief`) — дом, волна, приветствие;
 *   quick — повторный запуск в тот же день: логотип и имя на полсекунды.
 *
 * Минимум по-прежнему есть: оборванная на середине анимация читается
 * как сбой отрисовки. Но он равен длине самой анимации, а не 4 секундам.
 * Если данные не пришли, заставка переходит в ожидание — класс `waiting`
 * убирает лишнее движение и оставляет дыхание иконки.
 */
const SPLASH_FULL_MS = 1200;
const SPLASH_QUICK_MS = 500;
/** День, когда полная заставка уже была: в этот день — короткая */
const SPLASH_DAY_KEY = 'domovoy-splash-day';
/** Ссылку-приглашение принимаем один раз за запуск: код одноразовый */
let inviteFromLinkTried = false;
let splashShownAt = 0;
let splashMinMs = SPLASH_FULL_MS;
let splashWaitTimer = 0;

function splashMode() {
  if (platform.startParam) return 'none';
  const today = new Date().toDateString();
  try {
    if (localStorage.getItem(SPLASH_DAY_KEY) === today) return 'quick';
    localStorage.setItem(SPLASH_DAY_KEY, today);
  } catch {
    // Приватный режим: без памяти о дне — короткая, чтобы не мучить каждый раз
    return 'quick';
  }
  return 'full';
}

function showSplash() {
  const splash = $('#splash');
  if (!splash) return;

  const mode = splashMode();
  if (mode === 'none') {
    splash.hidden = true;
    return;
  }

  splash.hidden = false;
  splash.classList.remove('gone', 'waiting', 'brief', 'flash');
  splash.classList.add(mode === 'full' ? 'brief' : 'flash');
  splashMinMs = mode === 'full' ? SPLASH_FULL_MS : SPLASH_QUICK_MS;
  splashShownAt = Date.now();

  clearTimeout(splashWaitTimer);
  splashWaitTimer = setTimeout(() => {
    if (!splash.hidden) splash.classList.add('waiting');
  }, splashMinMs);
}

function splashGreeting(name) {
  const node = $('#splashGreet');
  if (!node) return;
  const firstName = String(name ?? '').trim().split(/\s+/)[1] ?? name;
  node.textContent = firstName ? `${greetingFor(new Date())}, ${firstName}` : '';
  // Появляется, когда стало известно имя, и больше не гаснет
  node.classList.toggle('in', Boolean(node.textContent));
}

async function hideSplash() {
  const splash = $('#splash');
  if (!splash || splash.hidden) return;

  const left = splashMinMs - (Date.now() - splashShownAt);
  if (left > 0) await new Promise((done) => setTimeout(done, left));

  clearTimeout(splashWaitTimer);
  splash.classList.add('gone');
  // Метка для замера: сколько человек смотрел на заставку от начала загрузки
  performance.mark?.('splash-gone');
  // Прячем после анимации, иначе прозрачный слой перехватывает нажатия
  setTimeout(() => { splash.hidden = true; splash.classList.remove('waiting'); }, 340);
}

/**
 * Экраны, с которых после успеха уходят обязательно.
 *
 * Все три — формы входа во что-то: сама сессия, новый адрес, квитанция
 * к известной квартире. Перерисовать такую форму поверх успеха значит
 * показать человеку ровно то, что он только что заполнил, — и он
 * заполняет второй раз. Раньше от этого спасала заставка: она приходила
 * вместе с полной перезагрузкой и уводила на главную, но платой были
 * четыре секунды анимации посреди сеанса.
 */
const ENTRY_SCREENS = new Set(['login', 'add-property', 'add-receipt']);

async function bootInner({ silent = false } = {}) {
  const pages = $('#pages');
  if (!silent) {
    showSplash();
    setHtml(pages, `<div class="page active">${skeletonState('home')}</div>`);
  }

  try {
    state.config = await api.config();
  } catch (error) {
    setHtml(pages, `<div class="page active">${errorState(error, 'reload')}</div>`);
    return;
  }

  // Внутри MAX человек с привязанным счётом входит без квитанции —
  // но не тогда, когда он только что вышел сам
  if (platform.inMax && !state.me && !maxAutoLogin.suppressed()) {
    const status = await tryMaxLogin();
    if (status === 'needs_receipt') return loginOrSharedHouse();
  }

  try {
    state.me = await api.me();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return loginOrSharedHouse();
    setHtml(pages, `<div class="page active">${errorState(error, 'reload')}</div>`);
    return;
  }

  /**
   * Активная собственность переживает перезапуск.
   *
   * Проверяем, что объект ещё в списке: доступ могли отозвать, а заявку
   * отклонить, и тогда сохранённый выбор указывает в никуда.
   */
  splashGreeting(state.me.user?.name);

  /**
   * Приглашение, открытое ссылкой.
   *
   * Собственник присылает `max.ru/<бот>?startapp=<код>`; мессенджер отдаёт
   * этот код нам в `start_param`. Человек уже нажал на ссылку — спрашивать
   * его ещё раз незачем, принимаем сразу. Одна попытка за запуск: код
   * одноразовый, и повторные вызовы отвечали бы «им уже воспользовались»
   * на собственное же приглашение.
   */
  if (!inviteFromLinkTried) {
    inviteFromLinkTried = true;
    const linkCode = (platform.startParam ?? '').trim();
    if (/^[A-Za-z0-9]{5,12}$/.test(linkCode)) {
      try {
        await api.redeemInvite(linkCode);
        state.me = await api.me();
        toast('Квартира добавлена — вас пригласил собственник');
      } catch (error) {
        // Код мог протухнуть или уже сработать: человеку это надо сказать,
        // но приложение обязано открыться в любом случае
        toast(error.message);
      }
    }
  }

  const savedId = activePropertyStore.get(state.me.user?.id);
  state.currentProperty = state.me.properties.find((p) => p.propertyId === savedId)
    // Без сохранённого выбора открываем подтверждённую квартиру: на ней
    // работает всё, а ожидающая — половина разделов с объяснением
    ?? state.me.properties.find((p) => p.status === 'active')
    ?? state.me.properties[0]
    ?? null;

  /**
   * Председательство грузим вместе с профилем.
   *
   * Ошибку глотаем: раздел «Совет дома» — дополнение, и если запрос
   * не прошёл, приложение жителя обязано открыться как обычно.
   */
  await refreshChairman();

  /**
   * Название управляющей организации живёт на самой главной, под адресом:
   * шапки там больше нет. Оно приходит из реестра и может отсутствовать —
   * тогда строки просто не будет, подставлять «УК» вместо настоящего
   * названия значит соврать о том, кто обслуживает дом.
   */

  /**
   * Тихая перезагрузка нужна там, где данные обновились, а экран менять
   * не надо — например после выдачи доступа домочадцу. Но с экрана входа
   * уходить обязательно: иначе успешный вход перерисовывает форму входа,
   * и человек остаётся на ней с уже работающей сессией.
   */
  const screen = current();
  if (silent && screen && !ENTRY_SCREENS.has(screen.name)) return refresh();
  await reset('home');
  return openFromLink();
}

/**
 * Экран по кнопке бота MAX — один раз за запуск.
 *
 * Под целевым экраном лежит главная: «Назад» ведёт домой, а не закрывает
 * приложение. Человек без квитанции сюда не доходит — сначала вход,
 * после него `bootInner` вызывается снова, и ссылка отрабатывает тогда.
 *
 * Черновик жалобы не открылся (протух, уже отправлен) — всё равно форма
 * жалобы, пустая: человек пришёл жаловаться, и жалоба не ждёт бота.
 */
let deepLinkTried = false;

/**
 * Без квитанции — экран входа, но ссылку на дом из «Поделиться» открываем
 * сразу поверх него: подбор дома гостю доступен и без входа (pick.ts),
 * а человек пришёл посмотреть присланный ЖК, а не сканировать квитанцию.
 * «Назад» с карточки — на вход.
 */
async function loginOrSharedHouse() {
  await reset('login', { name: platform.unsafeName });
  // Гость подбора — только из MAX (подпись initData); в браузере без сессии сервер ответит 401
  const target = parseStartParam(platform.startParam);
  if (!platform.inMax || target?.kind !== 'pick' || deepLinkTried) return;
  deepLinkTried = true;
  return go('pick-house', { key: target.key });
}

async function openFromLink() {
  if (deepLinkTried) return;
  deepLinkTried = true;
  return openTarget(parseStartParam(platform.startParam));
}

/**
 * Перейти по адресу из кнопки бота — из MAX (параметр запуска) или из
 * шторки Домовёнка (тот же payload). Правила одни, см. deeplink.js.
 */
async function openTarget(target) {
  if (!target) return;

  if (target.kind === 'screen') return go(target.name, target.params ?? {});
  if (target.kind === 'pick') return go('pick-house', { key: target.key });
  if (target.kind === 'request') return go('request', { id: target.id });

  let draft;
  try {
    draft = await api.botDraft(target.id);
  } catch (error) {
    toast(error.message);
    return go('complaint');
  }
  // Черновик — по квартире, о которой писал житель: у кого их две,
  // жалоба не должна уйти не на тот адрес
  const own = state.me.properties.find((p) => p.propertyId === draft.propertyId);
  if (own) {
    state.currentProperty = own;
    activePropertyStore.set(state.me.user?.id, own.propertyId);
  }
  return go('complaint', { category: draft.category, text: draft.text, draftId: target.id });
}

/**
 * Загрузка приложения. Заставка снимается в любом исходе — включая отказ
 * сервера и протухшую сессию: оставить её на экране значило бы показать
 * человеку вечный логотип вместо объяснения.
 */
export async function boot(options = {}) {
  try {
    return await bootInner(options);
  } finally {
    await hideSplash();
  }
}

/**
 * Уведомления.
 *
 * ЧТО ЗДЕСЬ ИЗМЕНИЛОСЬ. Раньше экран был заглушкой: «в браузере
 * уведомлений не будет». При этом уведомления писались в базу с самого
 * начала — просто прочитать их было негде, маршрута не существовало.
 * Для жителя из браузера это значило, что смену статуса заявки, вопрос
 * диспетчера и аварийное отключение он не узнавал никак.
 *
 * Сообщения от бота остаются главным каналом: они приходят, даже когда
 * приложение закрыто. Но список должен быть и здесь — иначе половина
 * событий продукта существует только в базе.
 */
/** Столько уведомлений добавляет одно нажатие «Показать ещё». */
const NOTIFICATIONS_STEP = 50;

/**
 * Сколько уведомлений показано сейчас.
 *
 * Живёт в модуле, а не рядом с разметкой: экран перерисовывается целиком,
 * и состояние внутри него не пережило бы ни одной перерисовки. Раскрытый
 * список остаётся раскрытым до конца сеанса — человек, дошедший до мая,
 * не должен возвращаться туда заново после каждого ухода с экрана.
 */
let notificationsShown = NOTIFICATIONS_STEP;

async function notificationsScreen() {
  const inMax = platform.inMax;

  let data;
  try {
    data = await api.notifications(notificationsShown);
  } catch (error) {
    return errorState(error, 'reload');
  }

  const channel = html`
    <div class="dt-p" style="color:var(--tx-2);font-size:13px">
      ${inMax
        ? 'Эти же события приходят сообщением от бота — даже когда приложение закрыто.'
        : `В браузере сообщения не приходят: этот канал работает только внутри MAX.
           Здесь события копятся и ждут, пока вы зайдёте.`}
    </div>`;

  if (data.notifications.length === 0) {
    return emptyState(
      'Пока ничего не было',
      'Здесь появятся смены статуса заявок, вопросы диспетчера и объявления об авариях',
    ) + channel;
  }

  // Открыли список — значит прочитали: держать счётчик непрочитанного
  // после того, как человек всё увидел, значит врать ему
  api.readNotifications().catch(() => {});

  return html`
    <div class="list">
      ${data.notifications.map((n) => html`
        <div class="row">
          <span class="sq ${n.read ? '' : 'new'}">
            <svg viewBox="0 0 20 20" fill="none"><path d="M5 8.5C5 6 6.9 4 10 4C13.1 4 15 6 15 8.5C15 11.3 16.5 12.5 16.5 12.5H3.5C3.5 12.5 5 11.3 5 8.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>
          </span>
          <div class="content">
            <div class="t">${esc(n.title)}</div>
            <div class="d">${esc(n.body)}</div>
            <div class="d" style="font-size:12px">
              ${esc(formatDate(n.at))}${n.delivered ? ' · доставлено в чат' : ''}
            </div>
          </div>
        </div>`).join('')}
    </div>
    ${moreLine({
      shown: data.notifications.length,
      total: data.total ?? data.notifications.length,
      action: 'notif-more',
    })}
    ${channel}`;
}



function start() {
  applyTheme(readTheme());
  trackViewport();
  // Прокрутка длинных списков не должна сворачивать мини-апп
  platform.lockVerticalSwipes();
  initRouter(renderScreen);
  initSwipeBack();

  matchMedia('(prefers-color-scheme: light)')
    .addEventListener('change', () => applyTheme(readTheme()));

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    /**
     * Уходящий экран — `inert` с начала смены (app/transitions.js).
     * Нажатие пальцем по нему браузер и так не пропускает, но вебвью без
     * поддержки inert и программный click() дошли бы до обработчика
     * и положили бы экран в стек второй раз.
     */
    if (target.closest('[inert]')) return;
    handleAction(target.dataset.action, target);
  });

  /**
   * Поля выбора файла кликов не шлют.
   *
   * По кнопке-`label` человек попадает в системный диалог, а приложение
   * узнаёт о выборе только событием `change`. Без этой строки список
   * приложенных файлов не обновлялся, и кнопка выглядела сломанной,
   * хотя файл на сервер уходил.
   */
  document.addEventListener('change', (event) => {
    const target = event.target.closest?.('[data-action]');
    if (!target || target.tagName !== 'INPUT') return;
    handleAction(target.dataset.action, target);
  });

  document.querySelectorAll('.apptab').forEach((tab) => {
    tab.addEventListener('click', () => reset(tab.dataset.tab));
  });

  // Вернулся из приложения банка — спросить, прошла ли оплата
  initPayReturn();

  mountAssistantButton();

  /**
   * Внутри MAX верхний вырез экрана уже занят шапкой мессенджера.
   *
   * Android-клиент MAX всё равно отдаёт в env(safe-area-inset-*)
   * высоту строки состояния и панели кнопок: шапка раздела съезжала вниз,
   * а под вкладками стояла пустая полоса. Сентябрь 2026.
   */
  document.documentElement.classList.toggle('in-max', platform.inMax);

  boot();
}

/**
 * Модули выполняются с отложенной загрузкой, и обычно DOMContentLoaded
 * ждёт их. Но если граф модулей вычислился позже — при восстановлении
 * страницы из кэша, при динамическом импорте — событие уже прошло,
 * обработчик не сработает, и приложение молча не запустится:
 * файлы загружены, а API не вызывается ни разу.
 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
