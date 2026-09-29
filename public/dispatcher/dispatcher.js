import { confirmAction, displayAddress,
  esc, html, formatDate, formatDay, toast, withLoading, loadingState, errorState, emptyState,
  eventAuthor, eventRole,
} from '../app/ui.js';
import { slotText } from '../app/screens/requests.js';
import { chatTimeline } from '../app/chat.js';
import { handleDateAction } from '../app/datepicker.js';
import {
  postForm, readPostForm, postList, pollForm, readPollForm, pollList, ALL_HOUSES,
  showPickedPhoto, pickedPostPhoto, contactsEditor, pickContactKind, readContactForm,
} from '../app/house-admin.js';
import { renderNav, setSignedIn, searchBar, enterSearch, pageHead } from './nav.js';
import { API_BASE } from '../app/config.js';

/**
 * Кабинет диспетчера УК.
 *
 * Именно он продаётся управляющей компании: очередь заявок со сроками
 * и видимой просрочкой. Приложение жителя без этого кабинета — витрина,
 * в которой статусы никто не проставляет.
 *
 * ОТДЕЛЬНОЕ ХРАНИЛИЩЕ ТОКЕНА. Кабинет и приложение жителя живут на одном
 * домене, и один ключ в localStorage они бы затирали друг другу: вход
 * диспетчера выкидывал бы жителя, и наоборот. Ключи разные намеренно.
 */

const TOKEN_KEY = 'domovoy-dispatcher-token';

const tokenStore = {
  get() {
    try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
  },
  set(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* приватный режим */ }
  },
};

/** Названия услуг: у квартиры несколько счетов, и их надо различать */
const SERVICE_LABEL = {
  housing: 'ЖКУ',
  electricity: 'свет',
  gas: 'газ',
  water: 'вода',
  heat: 'отопление',
  waste: 'мусор',
  overhaul: 'капремонт',
  other: 'прочее',
};

const STATUS_LABEL = {
  new: 'новая',
  in_work: 'в работе',
  need_info: 'нужны уточнения',
  done: 'выполнено',
  rejected: 'отклонено',
};

/** Те же переходы, что и на сервере: кнопку недопустимого не показываем. */
const TRANSITIONS = {
  new: ['in_work', 'need_info', 'rejected'],
  in_work: ['need_info', 'done', 'rejected'],
  need_info: ['in_work', 'rejected'],
  done: [],
  rejected: [],
};

/* ─────────────── сеть ─────────────── */

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * Отправка файла с сессией кабинета.
 *
 * Тело — FormData, и `content-type` ставит браузер: указать его руками
 * нельзя, иначе потеряется граница multipart.
 */
async function upload(path, file) {
  const token = tokenStore.get();
  const body = new FormData();
  body.append('file', file, file.name);

  const response = await fetch(API_BASE + path, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  }).catch(() => {
    throw new ApiError('Нет связи с сервером. Проверьте подключение.', 0, null);
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new ApiError(parsed?.message ?? 'Не удалось приложить фотографию', response.status, parsed);
  }
  return parsed;
}

/** Файл с сессией кабинета — как адрес `blob:`, который понимают `<img>` и новая вкладка. */
async function fileUrl(path) {
  const token = tokenStore.get();
  const response = await fetch(API_BASE + path, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  }).catch(() => {
    throw new ApiError('Нет связи с сервером. Проверьте подключение.', 0, null);
  });
  if (!response.ok) throw new ApiError('Файл не открылся', response.status, null);
  return URL.createObjectURL(await response.blob());
}

/** Картинки вложений в открытой карточке: каждая своим запросом. */
function loadAttachments() {
  for (const img of main().querySelectorAll('img[data-src]')) {
    fileUrl(img.dataset.src)
      .then((url) => { img.src = url; })
      .catch(() => { img.alt = 'Фотография не загрузилась'; });
  }
}

async function request(method, path, payload) {
  const token = tokenStore.get();
  const response = await fetch(API_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    cache: 'no-store',
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }).catch(() => {
    throw new ApiError('Нет связи с сервером. Проверьте подключение.', 0, null);
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    if (response.status === 401) tokenStore.set(null);
    throw new ApiError(body?.message ?? 'Ошибка запроса', response.status, body);
  }
  if (body?.token) tokenStore.set(body.token);
  return body;
}

const api = {
  login: (login, password) => request('POST', '/api/dispatcher/login', { login, password }),
  logout: () => request('POST', '/api/dispatcher/logout', {}),
  me: () => request('GET', '/api/dispatcher/me'),
  requests: ({ status, flag, q, limit, sort, house } = {}) => {
    const params = new URLSearchParams();
    if (house) params.set('house', house);
    if (sort && sort !== 'deadline') params.set('sort', sort);
    if (status) params.set('status', status);
    if (flag) params.set('flag', flag);
    if (q) params.set('q', q);
    if (limit) params.set('limit', String(limit));
    const tail = params.toString();
    return request('GET', tail ? `/api/dispatcher/requests?${tail}` : '/api/dispatcher/requests');
  },
  request: (id) => request('GET', `/api/dispatcher/requests/${id}`),
  setStatus: (id, payload) => request('POST', `/api/dispatcher/requests/${id}/status`, payload),
  comment: (id, text) => request('POST', `/api/dispatcher/requests/${id}/comment`, { text }),

  accounts: () => request('GET', '/api/dispatcher/accounts'),
  houses: () => request('GET', '/api/dispatcher/houses'),
  addHouse: (address) => request('POST', '/api/dispatcher/houses', { address }),
  houseContacts: (key) => request('GET', `/api/dispatcher/houses/${encodeURIComponent(key)}/contacts`),
  saveHouseContact: (key, form) =>
    request('POST', `/api/dispatcher/houses/${encodeURIComponent(key)}/contacts`, form),
  removeHouseContact: (key, id) =>
    request('POST', `/api/dispatcher/houses/${encodeURIComponent(key)}/contacts/${encodeURIComponent(id)}/remove`),
  posts: (limit) => request(
    'GET',
    limit ? `/api/dispatcher/posts?limit=${encodeURIComponent(limit)}` : '/api/dispatcher/posts',
  ),
  createPost: (payload) => request('POST', '/api/dispatcher/posts', payload),
  attachPostPhoto: (id, file) => upload(`/api/dispatcher/posts/${id}/photo`, file),
  removePost: (id) => request('DELETE', `/api/dispatcher/posts/${id}`),
  polls: () => request('GET', '/api/dispatcher/polls'),
  createPoll: (payload) => request('POST', '/api/dispatcher/polls', payload),

  verifyAddress: (propertyId) =>
    request('POST', `/api/dispatcher/properties/${propertyId}/verify-address`, {}),
  chairmen: () => request('GET', '/api/dispatcher/chairmen'),
  addChairman: (payload) => request('POST', '/api/dispatcher/chairmen', payload),
  revokeChairman: (id) => request('POST', `/api/dispatcher/chairmen/${id}/revoke`, {}),
  chairmanCandidates: (houseKey) =>
    request('GET', `/api/dispatcher/chairman-candidates?houseKey=${encodeURIComponent(houseKey)}`),
  // Только чтение: подтверждает председатель, не УК
  claims: () => request('GET', '/api/dispatcher/claims'),
};

/* ─────────────── состояние ─────────────── */

/** Столько строк очереди добавляет одно нажатие «Показать ещё». */
const QUEUE_STEP = 50;

/** Порядок очереди — те же ключи, что в lib/requests/sort.ts */
const SORTS = [
  ['deadline', 'По сроку реакции'],
  ['newest', 'Сначала новые'],
  ['oldest', 'Сначала старые'],
];
const SORT_HINT = {
  deadline: 'сначала просроченные',
  newest: 'сначала созданные недавно',
  oldest: 'сначала созданные давно',
};

const state = {
  me: null,
  tab: 'requests',
  filter: null,
  /** Что назвали в трубку: номер, адрес или квартира */
  query: '',
  /** Порядок очереди: deadline — по сроку реакции, newest / oldest — по дате создания */
  sort: 'deadline',
  /** Выбранный дом очереди (houseKey) или null — все дома */
  house: null,
  queueShown: QUEUE_STEP,
  postsShown: QUEUE_STEP,
  postsTotal: 0,
  data: null,
  openId: null,
  open: null,
  posts: [],
  polls: [],
  chairmen: [],
  claims: [],
  claimsNeedChairman: [],
  accounts: null,

  /**
   * ДВА РАЗНЫХ ПОЛЯ, а не одно.
   *
   * Раньше оба назывались `houses`, и ключ в этом объекте был объявлен
   * дважды — второй затирал первый, поэтому при первом заходе
   * на «Объявления» или «Председатели» `loadHouses()` падал
   * на `null.length`. Сборщик предупреждал об этом всё время
   * («Duplicate key "houses"»), но предупреждение никто не читал.
   *
   * Даже без дубля они конфликтовали по смыслу: одно поле — плоский
   * список для выпадающих меню, другое — ответ `/api/dispatcher/houses`
   * целиком, со сводкой по организации. После захода на вкладку «Дома»
   * выпадающие списки получили бы объект вместо массива.
   */
  /** Плоский список `{houseKey, label}` для выпадающих меню */
  houseOptions: [],
  /** Ответ `/api/dispatcher/houses` целиком — для вкладки «Дома» */
  housesData: null,
  /** Открытый редактор телефонов дома: { houseKey, address, data } или null */
  contactsFor: null,
  /** Кого только что назначили председателем — для плашки над формой */
  appointed: null,
};

const main = () => document.querySelector('#dspMain');

/* ─────────────── экраны ─────────────── */


/**
 * Вложения к обращению глазами управляющей компании.
 *
 * ФАЙЛ ЗАБИРАЕТСЯ ЗАПРОСОМ С ТОКЕНОМ, а не ссылкой в `src`. Сессия
 * кабинета — токен в заголовке Authorization, `<img>` его не пошлёт,
 * а относительный `/api/...` на GitHub Pages уходил на сам github.io.
 * Картинки подгружает `loadAttachments` после отрисовки карточки,
 * документ открывается по кнопке.
 *
 * Возвращает, как рисовать одно вложение в пузыре переписки
 * (public/app/chat.js): у жителя адреса файлов другие.
 */
function dspFile(r) {
  const path = (f) => `/api/dispatcher/requests/${r.id}/files/${f.id}`;
  return (f) => (String(f.mime ?? '').startsWith('image/')
    ? `<button type="button" class="dsp-photo" data-action="open-file" data-path="${esc(path(f))}">`
      + `<img class="photo-ph" data-src="${esc(path(f))}" alt="${esc(f.name ?? 'Вложение')}"></button>`
    : `<button type="button" class="chat-file" data-action="open-file" data-path="${esc(path(f))}">`
      + `${esc(f.name ?? 'Документ')}</button>`);
}

function renderLogin(error) {
  return html`
    <div class="dsp-login">
      <h1>Вход для диспетчера</h1>
      <p>
        Это рабочее место управляющей компании. Жителям сюда не нужно —
        их приложение открывается по адресу сайта.
      </p>

      <div class="field-label">Логин</div>
      <input type="text" id="dspLogin" autocomplete="username" placeholder="dispatcher">

      <div class="field-label">Пароль</div>
      <input type="password" id="dspPass" autocomplete="current-password">

      <div class="field-error ${error ? 'show' : ''}" id="dspErr">${esc(error ?? '')}</div>

      <button class="btn-primary" data-action="do-login">Войти</button>
    </div>`;
}

const TABS = [
  { id: 'requests', label: 'Заявки', icon: 'wrench', tone: 'blue' },
  { id: 'claims', label: 'Ждут подтверждения', icon: 'inbox', tone: 'orange' },
  { id: 'posts', label: 'Объявления дома', icon: 'megaphone', tone: 'pink' },
  { id: 'polls', label: 'Опросы', icon: 'poll', tone: 'violet' },
  { id: 'chairmen', label: 'Председатели', icon: 'crown', tone: 'orange' },
  { id: 'accounts', label: 'Лицевые счета', icon: 'wallet', tone: 'teal' },
  { id: 'houses', label: 'Мои дома', icon: 'house', tone: 'green' },
];

/** Меню живёт в боковой панели; вызов оставлен там, где раньше рисовались вкладки */
function renderTabs() {
  const overdue = state.data?.counters?.overdue ?? 0;
  renderNav('#dspNav', TABS.map((t) => ({ ...t, count: t.id === 'requests' ? overdue : 0 })), state.tab, 'v');
  return '';
}

function renderQueue() {
  const { counters, requests } = state.data;

  const counter = (key, label, value, warn) => html`
    <button class="dsp-counter ${warn ? 'warn' : ''} ${state.filter === key ? 'on' : ''}"
            data-action="filter" data-v="${key ?? ''}" aria-pressed="${state.filter === key}">
      <div class="n">${value}</div>
      <div class="l">${esc(label)}</div>
    </button>`;

  const total = state.data.total ?? requests.length;

  return renderTabs() + html`
    <div class="dsp-page-head">
      <div>
        <h1>Заявки</h1>
        <p class="dsp-dim">Всего ${counters.total} · ${esc(SORT_HINT[state.sort])}</p>
      </div>
      <div class="dsp-page-search">
        ${searchBar({ id: 'dspQ', value: state.query, placeholder: 'Номер, адрес или квартира', action: 'search', reset: 'search-reset' })}
      </div>
    </div>

    <div class="dsp-sort" role="group" aria-label="Порядок заявок">
      ${(state.data.houses ?? []).length ? html`
        <select class="dsp-house-pick" data-action="house" aria-label="Дом">
          <option value="">Все дома · ${esc((state.data.houses ?? []).length)}</option>
          ${state.data.houses.map((h) => html`
            <option value="${esc(h.houseKey)}" ${state.house === h.houseKey ? 'selected' : ''}>
              ${esc(shortAddress({ ...h, flat: null }))} · ${h.open ? `открыто ${esc(h.open)}` : `всего ${esc(h.total)}`}
            </option>`).join('')}
        </select>` : ''}
      ${SORTS.map(([key, label]) => html`
        <button class="chip ${state.sort === key ? 'sel' : ''}" data-action="sort" data-v="${key}"
                aria-pressed="${state.sort === key}">${esc(label)}</button>`).join('')}
    </div>

    <div class="dsp-counters">
      ${counter(null, 'Все заявки', counters.total, false)}
      ${counter('new', 'Новые', counters.new, false)}
      ${counter('in_work', 'В работе', counters.in_work, false)}
      ${counter('need_info', 'Ждём жителя', counters.need_info, false)}
      ${counter('__awaiting', 'Житель ответил', counters.awaiting_uk, counters.awaiting_uk > 0)}
      ${counter('__overdue', 'Просрочено', counters.overdue, counters.overdue > 0)}
    </div>

    ${requests.length === 0
      ? html`<div class="dsp-empty">
          ${state.query
            ? `По запросу «${esc(state.query)}» ничего не нашлось.
               Номер, адрес или квартира — можно часть.`
            : 'В этой выборке заявок нет'}
        </div>`
      : html`
        <div class="dsp-queue">
          <div class="dsp-row head" aria-hidden="true">
            <span>№ · дата</span><span>Заявка</span><span>Адрес</span><span>Статус</span><span>Срок</span>
          </div>
          ${requests.map(queueRow).join('')}
        </div>
        ${total > requests.length ? html`
          <div class="dsp-more">
            <span class="dsp-dim">Показаны ${requests.length} из ${total}</span>
            <button class="dsp-mini" data-action="queue-more">Показать ещё</button>
          </div>` : ''}`}`;
}

function queueRow(r) {
  const overdue = r.sla === 'overdue';

  /**
   * Последняя реплика прямо в очереди.
   *
   * Без неё ответ жителя на уточнение виден только внутри карточки, то есть
   * фактически не виден: диспетчер не открывает подряд все заявки, а строка
   * очереди выглядит так же, как вчера.
   */
  const last = r.lastMessage;
  const sub = last
    ? `${eventRole(last.actor)}: ${last.text}`
    : `${r.category} · ${r.authorName ?? 'житель'}`;

  return html`
    <button class="dsp-row ${overdue ? 'overdue' : ''} ${r.awaitingUk ? 'answered' : ''}"
            data-action="open" data-id="${esc(r.id)}">
      <span class="num">
        № ${esc(r.number)}
        <!--
          Дата подачи рядом с номером: очередь отсортирована по времени,
          а времени в строке не было. «Просрочено на 22 дня» отвечает
          на вопрос про срок, но не на вопрос «когда это к нам пришло»,
          и в архиве за год отличить прошлогоднюю заявку от вчерашней
          было нельзя вовсе.
        -->
        <span class="dsp-when">${esc(formatDay(r.createdAt))}</span>
      </span>
      <span>
        <span class="ttl">
          ${r.awaitingUk ? '<span class="dsp-flag">ответ жителя</span>' : ''}${esc(r.title)}
        </span>
        <span class="cat">${esc(sub)}</span>
      </span>
      <span class="addr">${esc(shortAddress(r))}</span>
      <span class="pill ${statusTone(r.status)}">${esc(STATUS_LABEL[r.status] ?? r.statusLabel)}</span>
      <span class="dsp-sla ${esc(r.sla)}">${esc(r.slaLabel)}</span>
    </button>`;
}

function renderDetail(r) {
  const allowed = r.allowed ?? TRANSITIONS[r.status] ?? [];

  return html`
    <button class="dsp-back" data-action="back">← К очереди</button>

    <div class="dsp-card dsp-req-head">
      <div>
        <div class="dsp-dim">Заявка № ${esc(r.number)} · ${esc(r.category)} · ${esc(formatDate(r.createdAt))}</div>
        <h1>${esc(r.title)}</h1>
        <div class="dsp-dim">${esc(displayAddress(r.address ?? '—'))}${r.flat && !/кв\.?\s/i.test(r.address ?? '') ? `, кв. ${esc(r.flat)}` : ''}</div>
      </div>
      <div class="dsp-req-state">
        <span class="pill ${statusTone(r.status)}">${esc(STATUS_LABEL[r.status] ?? r.statusLabel)}</span>
        <span class="dsp-sla ${esc(r.sla)}">${esc(r.slaLabel)}</span>
      </div>
    </div>

    ${r.awaitingUk ? `
      <div class="dsp-banner">
        ${(r.events ?? []).some((e) => /проблема не решена/.test(e.text ?? ''))
          ? 'Житель вернул заявку: проблема не решена. Что осталось — ниже, в переписке.'
          : 'Житель написал — ход за УК. Сообщение ниже, в переписке.'}
      </div>` : ''}
    ${r.awaitingResident && !r.awaitingUk ? `
      <div class="dsp-banner wait">
        Ждём ответа жителя на заданный вопрос. Срок реакции при этом идёт.
      </div>` : ''}

    <div class="dsp-detail">
      <div>
        <!--
          Переписка — чатом, как у жителя (public/app/chat.js): УК справа,
          житель слева, статусы по центру. Описание и вложения жителя —
          его первым сообщением.
        -->
        <div class="dsp-card dsp-chat">
          <h2>Переписка с жителем</h2>
          ${chatTimeline(r, 'dispatcher', { file: dspFile(r) })}
          ${allowed.length === 0 ? '' : html`
            <div class="chat-input">
              <textarea id="dspReply" rows="1" placeholder="Сообщение жителю — статус не меняется"></textarea>
              <button class="chat-send" data-action="send-dsp-comment" data-id="${esc(r.id)}" aria-label="Отправить">
                <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h13M13 6l6 6-6 6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
            </div>
            <div class="field-error" id="dspReplyErr"></div>`}
        </div>
      </div>

      <div class="dsp-aside">
        ${statusCard(r, allowed)}

        <div class="dsp-card">
          <h2>Житель и сроки</h2>
          <dl class="dsp-kv">
            <dt>Житель</dt><dd>${esc(r.authorName ?? '—')}</dd>
            <dt>Телефон</dt>
            <dd>${r.authorPhone
              ? `${esc(r.authorPhone)}${r.authorPhoneVerified ? '' : ' · не подтверждён'}`
              : 'не указан'}</dd>
            <dt>Категория</dt><dd>${esc(r.category)}</dd>
            <dt>Поступила</dt><dd>${esc(formatDate(r.createdAt))}</dd>
            <dt>Срок реакции</dt>
            <dd class="dsp-sla ${esc(r.sla)}">${esc(r.slaLabel)}</dd>
            ${r.masterSlotStart
              ? `<dt>Удобное время</dt><dd>${esc(slotText(r))}</dd>` : ''}
            ${r.assigneeName ? `<dt>Исполнитель</dt><dd>${esc(r.assigneeName)}</dd>` : ''}
            ${r.rejectReason ? `<dt>Причина отказа</dt><dd>${esc(r.rejectReason)}</dd>` : ''}
            ${r.rating ? `<dt>Оценка жителя</dt><dd>${esc(r.rating.stars)} из 5</dd>` : ''}
          </dl>
          ${r.notifiable ? '' : `
            <div class="dt-p" style="font-size:13px;color:var(--tx-2)">
              Житель заходил из браузера, а не из MAX: сообщение от бота ему
              не уйдёт — статус он увидит, только открыв приложение.
            </div>`}
        </div>
      </div>
    </div>`;
}

/**
 * Кто и когда закрыл заявку — прямо в карточке статуса.
 *
 * Раньше это читалось только по плашке «выполнено»: кто закрыл и с каким
 * итогом, приходилось искать в переписке.
 */
function closedLine(r) {
  const closing = [...(r.events ?? [])].reverse().find((e) => e.type === 'status');
  const who = closing ? eventAuthor(closing) : 'управляющая компания';
  const when = r.closedAt ?? closing?.createdAt;
  const verb = r.status === 'rejected' ? 'Отклонена' : 'Закрыта';
  return html`
    <div class="dt-p" style="margin:0 0 8px;font-size:14px">
      ${verb}${when ? html` ${esc(formatDate(when))}` : ''} · ${esc(who)}${
        r.status === 'rejected' && r.rejectReason ? html`<br>Причина: ${esc(r.rejectReason)}` : ''}
    </div>`;
}

/** Панель смены статуса — первой в правой колонке: ради неё карточку и открывают */
function statusCard(r, allowed) {
  return html`
        <div class="dsp-card">
          <h2>Статус — ${esc(STATUS_LABEL[r.status] ?? r.statusLabel)}</h2>

          ${allowed.length === 0 ? html`
            ${closedLine(r)}
            <div class="dt-p" style="margin-top:0;font-size:14px;color:var(--tx-2)">
              Переоткрыть заявку нельзя — если проблема
              вернулась, житель заводит новую, и срок реакции считается заново.
            </div>` : html`
            <div class="field-label" style="margin-top:0">Сообщение жителю</div>
            <textarea id="dspComment"
              placeholder="Что сделано, что уточнить или почему отказ. Житель прочитает это в заявке"></textarea>
            <div class="dsp-hint">
              Для «Запросить уточнения» и «Отклонить» текст обязателен:
              без него житель не поймёт, чего от него ждут, и позвонит в УК.
            </div>

            <div class="field-label">Исполнитель</div>
            <input type="text" id="dspAssignee" placeholder="Например: Петров И., сантехник"
                   value="${esc(r.assigneeName ?? '')}">

            <div class="dsp-actions" style="margin-top:16px">
              ${allowed.map((to) => html`
                <button class="dsp-act ${to === 'done' ? 'primary' : ''} ${to === 'rejected' ? 'danger' : ''}"
                        data-action="set-status" data-id="${esc(r.id)}" data-to="${esc(to)}">
                  ${esc(actionLabel(to))}
                </button>`).join('')}
            </div>

            <div class="dt-p" style="font-size:13px;color:var(--tx-2)">
              Житель увидит новый статус сразу, а если приложение открыто
              в MAX — получит сообщение от бота.
            </div>`}
        </div>`;
}

/**
 * Объявления дома со стороны УК.
 *
 * Раньше эндпоинты были, а кнопки не было вовсе: опубликовать отключение
 * можно было только curl-ом, то есть на практике никак.
 */
function renderPosts() {
  return renderTabs() + pageHead('Объявления дома', 'Отключения, собрания и новости — жители увидят их на главном экране')
    + postForm({ houses: state.houseOptions })
    + postList(state.posts, state.postsTotal, 'posts-more');
}

function renderPolls() {
  return renderTabs() + pageHead('Опросы', 'Вопрос жителям дома с вариантами ответа')
    + pollForm({ houses: state.houseOptions }) + pollList(state.polls);
}

/**
 * Председатели домов.
 *
 * Право подтверждает УК: в жизни председателя выбирает собрание, а учётку
 * заводит компания по протоколу. Пароль генерируется на сервере и виден
 * ровно один раз — в базе только хеш, и диспетчер не должен иметь
 * возможности войти под председателем.
 */
function renderChairmen() {
  const appointed = state.appointed;

  return renderTabs() + pageHead('Председатели', 'Председатель — житель дома: подтверждает соседей, ведёт объявления и опросы') + html`
    ${appointed ? html`
      <div class="dsp-banner">
        Председателем дома назначен «${esc(appointed.name)}».
        Раздел «Совет дома» появился у него в приложении — передавать
        ничего не нужно, отдельного входа и пароля больше нет.
      </div>` : ''}

    <div class="dsp-card">
      <h2>Назначить председателя</h2>
      <div class="dsp-hint" style="margin-top:0">
        Председателем становится ЖИТЕЛЬ дома: он подтверждает соседей,
        ведёт объявления и опросы, видит сводку по квартирам. Обращения
        дома он читает и может в них написать, но статус меняет только УК.
      </div>

      <div class="field-label">Дом</div>
      <select id="chHouse" class="dsp-select" data-action="ch-house">
        ${state.houseOptions.map((h) => `<option value="${esc(h.houseKey)}">${esc(displayAddress(h.label))}</option>`).join('')}
      </select>

      <div class="field-label">Кто из жителей</div>
      ${(state.chairmanCandidates ?? []).length === 0
        ? html`<div class="dsp-hint">
            По этому дому ещё никто не предъявил квитанцию. Председателя
            можно назначить, только когда в приложении появится хотя бы
            один житель этого дома.
          </div>`
        : html`<select id="chUser" class="dsp-select">
            ${state.chairmanCandidates.map((c) => `<option value="${esc(c.userId)}">${
              esc(`${c.claimedName || c.name}${c.flat ? `, кв. ${c.flat}` : ''}`
                // Одинаковые ФИО различаются входом и датой (аудит 26.09)
                + ` · ${c.viaMax ? 'MAX' : 'браузер'}${c.phoneVerified ? ', телефон подтверждён' : ''}`
                + `, с ${formatDay(c.since)}`
                + (c.status === 'active' ? '' : ' — не подтверждён'))
            }</option>`).join('')}
          </select>
          <div class="dsp-hint">
            Неподтверждённого жителя назначайте, только если знаете его лично:
            строку квитанции можно ввести руками, а председатель открывает
            соседям доступ к дому.
          </div>`}

      <div class="dsp-actions" style="margin-top:16px">
        <button class="dsp-act primary" data-action="ch-add">Назначить</button>
      </div>
    </div>

    ${state.chairmen.length === 0
      ? '<div class="dsp-empty">Председателей пока нет</div>'
      : html`
        <div class="dsp-card">
          <h2>Председатели домов</h2>
          <div class="ha-list">
            ${state.chairmen.map((c) => html`
              <div class="ha-row ${c.active ? '' : 'off'}">
                <div>
                  <div class="ha-t">${esc(c.name)}${c.flat ? `, кв. ${esc(c.flat)}` : ''}</div>
                  <div class="ha-d">
                    ${c.viaMax ? 'входит через MAX' : 'входит из браузера'}
                    ${c.phone ? ` · ${esc(c.phone)}` : ''}
                    · назначен ${esc(formatDate(c.createdAt))}
                    ${c.revokedAt ? ` · снят ${esc(formatDate(c.revokedAt))}` : ''}
                  </div>
                </div>
                <div class="ha-state">
                  ${c.active ? '<span class="pill ok">действует</span>' : '<span class="pill">снят</span>'}
                </div>
                ${c.active ? html`
                  <span style="display:flex;gap:8px">
                    <button class="dsp-act danger" data-action="ch-revoke" data-id="${esc(c.id)}">
                      Снять
                    </button>
                  </span>` : '<span></span>'}
              </div>`).join('')}
          </div>
        </div>`}`;
}

/**
 * Дома организации из реестра лицензий ГИС ЖКХ.
 *
 * Список существует до первого жителя: связка «дом → управляющая компания»
 * берётся из реестра, а не из квитанции. В квитанции указан получатель
 * платежа — энергосбыт, газовики или расчётный центр, — и управляющей
 * организацией он не является.
 */
function renderHouses() {
  const data = state.housesData;
  const org = data.organization;

  return renderTabs() + pageHead(
    'Мои дома',
    org ? `${org.name} · ИНН ${org.inn}${org.licenseNumber ? ` · лицензия ${org.licenseNumber}` : ''}` : 'Дома, которые реестр числит за вашей организацией',
  ) + html`

    <div class="dsp-counters">
      <div class="dsp-counter"><div class="n">${data.total}</div><div class="l">Домов в реестре</div></div>
      <div class="dsp-counter"><div class="n">${data.withResidents}</div><div class="l">Есть жители в приложении</div></div>
      ${org && org.houseCountByLicense !== data.total ? html`
        <div class="dsp-counter warn">
          <div class="n">${esc(org.houseCountByLicense)}</div>
          <div class="l">По данным лицензии</div>
        </div>` : ''}
    </div>

    ${state.contactsFor ? html`
      <div class="dsp-card">
        <h2>Телефоны дома · ${esc(displayAddress(state.contactsFor.address))}</h2>
        <div class="dsp-hint" style="margin-top:0">
          Жители увидят эти номера на экране «Аварийные службы» с пометкой,
          что их добавила управляющая компания.
        </div>
        ${contactsEditor({
          kinds: state.contactsFor.data.kinds,
          contacts: state.contactsFor.data.contacts,
          look: 'cabinet',
          houseKey: state.contactsFor.houseKey,
        })}
        <div class="dsp-actions" style="margin-top:12px">
          <button class="dsp-act" data-action="close-contacts">Закрыть</button>
        </div>
      </div>` : ''}

    <div class="dsp-card">
      <h2>Добавить дом вручную</h2>
      <div class="dsp-hint" style="margin-top:0">
        Реестры узнают о смене управляющей компании с опозданием в недели.
        Если вашего дома в списке нет — добавьте его сами, жители сразу
        попадут к вам.
      </div>

      <div class="field-label">Полный адрес дома</div>
      <input type="text" id="dspHouseAddress"
             placeholder="344038, Ростовская обл, г Ростов-на-Дону, пр-кт Ленина, д. 85/3">

      <div class="dsp-actions" style="margin-top:16px">
        <button class="dsp-act primary" data-action="add-house">Добавить дом</button>
      </div>
    </div>

    ${data.houses.length === 0
      ? html`<div class="dsp-empty">
          За вашей организацией в реестре домов нет. Добавьте дом вручную —
          жители этого дома сразу попадут к вам.
        </div>`
      : html`
        <div class="dsp-card">
          <h2>Жилищный фонд · ${data.houses.length}</h2>
          ${filterField('houses', 'Улица или номер дома')}
          <div class="dsp-table-wrap" data-filter-scope="houses">
          <table class="dsp-table">
            <thead><tr><th>Адрес</th><th>Квартир</th><th>Оценка жителей</th><th>Жители в приложении</th><th>Телефоны</th></tr></thead>
            <tbody>
              ${data.houses.map((h) => html`
                <tr data-filter-row>
                  <td class="dsp-addr-cell">${esc(displayAddress(h.address))}</td>
                  <td class="dsp-muted-cell">${h.flatCount ? esc(h.flatCount) : '—'}</td>
                  <td class="dsp-muted-cell">${h.reviews
                    ? `★ ${esc(h.rating.toFixed(1))} · ${esc(h.reviews)}`
                    : '—'}</td>
                  <td>${h.linkedProperties
                    ? `<span class="pill ok">${esc(h.linkedProperties)}</span>`
                    : '<span class="dsp-dim">никто не пришёл</span>'}</td>
                  <td><button class="dsp-mini" data-action="open-contacts"
                              data-key="${esc(h.houseKey)}" data-address="${esc(displayAddress(h.address))}">Телефоны</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
          </div>
        </div>`}`;
}

/**
 * Лицевые счета дома.
 *
 * Отдельный смысл этого экрана — адреса, которые житель указал сам.
 * Так бывает, когда расчётный центр печатает QR без адреса: по одному
 * лицевому счёту дом не определить ни по одной открытой базе, поэтому
 * житель выбирает его из справочника, а сверить с биллингом может только УК.
 */
function renderAccounts() {
  const data = state.accounts;
  const unverified = data.accounts.filter((a) => a.addressSource === 'resident');

  const row = (a) => html`
    <div class="ha-row" data-filter-row>
      <div>
        <div class="ha-t">${esc(displayAddress(a.address || 'адрес не указан'))}</div>
        <div class="ha-d">
          ${a.accounts.length
            // Лицевых счетов у квартиры несколько: ЖКУ, свет, газ, мусор.
            // Диспетчеру нужен весь список, а не первый попавшийся номер
            ? esc(a.accounts.map((x) => `${SERVICE_LABEL[x.service] ?? 'прочее'} ${x.persAcc}`).join(' · '))
            : 'лицевых счетов нет'}
        </div>
        <div class="ha-d">
          ${a.residents.length
            ? esc(a.residents.map((r) => r.name).join(', '))
            : 'никто не зарегистрирован'}
        </div>
      </div>
      <div class="ha-state">
        ${a.addressSource === 'resident'
          ? '<span class="pill">указан жителем</span>'
          : a.addressSource === 'uk'
            ? '<span class="pill ok">сверен</span>'
            : '<span class="pill ok">из квитанции</span>'}
      </div>
      ${a.addressSource === 'resident'
        ? html`<button class="dsp-act primary" data-action="verify-address"
                       data-id="${esc(a.propertyId)}">Подтвердить адрес</button>`
        : '<span></span>'}
    </div>`;

  return renderTabs() + pageHead('Лицевые счета', 'Квартиры жителей, их лицевые счета и сверка адресов') + html`
    ${unverified.length ? html`
      <div class="dsp-banner">
        Адресов, указанных жителями и не сверенных с лицевым счётом:
        ${unverified.length}. Так бывает, когда в квитанции нет адреса —
        сверьте по своему биллингу и подтвердите.
      </div>` : ''}

    <div class="dsp-counters">
      <div class="dsp-counter"><div class="n">${data.total}</div><div class="l">Квартир и домов</div></div>
      <div class="dsp-counter"><div class="n">${data.registered}</div><div class="l">Есть житель в приложении</div></div>
      <div class="dsp-counter ${unverified.length ? 'warn' : ''}">
        <div class="n">${unverified.length}</div><div class="l">Ждут сверки адреса</div>
      </div>
    </div>

    <div class="dsp-card">
      <h2>Объекты и их лицевые счета</h2>
      ${filterField('accounts', 'Адрес, квартира, лицевой счёт или фамилия')}
      <div class="ha-list" data-filter-scope="accounts">${data.accounts.map(row).join('')}</div>
    </div>`;
}

/**
 * Поиск по уже загруженному списку — без запроса к серверу.
 *
 * У крупной УК сотни домов и квартир, а «Мои дома» и «Лицевые счета»
 * приходят целиком: листать их глазами в поисках одного адреса нельзя.
 * Строки с `data-filter-row` внутри `data-filter-scope` прячутся,
 * если в их тексте нет набранного.
 */
function filterField(scope, placeholder) {
  return html`
    <input type="search" class="dsp-filter" data-filter-for="${esc(scope)}"
           placeholder="${esc(placeholder)}" autocomplete="off">`;
}

function applyFilter(input) {
  const scope = main().querySelector(`[data-filter-scope="${input.dataset.filterFor}"]`);
  if (!scope) return;
  const words = input.value.toLowerCase().replaceAll('ё', 'е').split(/\s+/).filter(Boolean);
  for (const row of scope.querySelectorAll('[data-filter-row]')) {
    const text = row.textContent.toLowerCase().replaceAll('ё', 'е');
    row.hidden = !words.every((w) => text.includes(w));
  }
}

function actionLabel(to) {
  return {
    in_work: 'Взять в работу',
    need_info: 'Запросить уточнения',
    done: 'Выполнено',
    rejected: 'Отклонить',
  }[to] ?? STATUS_LABEL[to];
}

function statusTone(status) {
  if (status === 'done') return 'ok';
  if (status === 'new') return 'new';
  if (status === 'rejected') return 'bad';
  return '';
}

/**
 * Адрес для очереди: улица, дом, квартира.
 *
 * Собирается из РАЗОБРАННЫХ полей, а не нарезкой исходной строки. Резать
 * её здесь пришлось бы теми же правилами, что в normalize.ts, вместе со
 * всеми ловушками — в том числе с тем, что  в JS не срабатывает на
 * кириллице, и «г Ростов-на-Дону» так не отфильтруешь.
 *
 * Если разбор не удался, честно показываем исходную строку целиком:
 * неполный адрес хуже длинного — по нему не найти квартиру.
 */
function shortAddress(r) {
  if (!r.street) return r.address ?? '';

  const house = [r.house, r.block ? `к${r.block}` : null].filter(Boolean).join('');
  const flat = r.flat ? `кв. ${r.flat}` : '';
  return [[capitalise(r.street), house].filter(Boolean).join(' '), flat]
    .filter(Boolean)
    .join(', ');
}

function capitalise(value) {
  return String(value).replace(/(^|[\s-])([а-яёa-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/* ─────────────── загрузка ─────────────── */

async function loadQueue() {
  main().innerHTML = loadingState('Загружаем очередь…');
  try {
    /**
     * «Просрочено» и «Житель ответил» — признаки, а не статусы, и теперь
     * их отбирает сервер. Раньше это делал кабинет у себя, но с потолком
     * выдачи просроченные заявки могут целиком оказаться за пределами
     * первых пятидесяти строк.
     */
    const flag = state.filter === '__overdue' ? 'overdue'
      : state.filter === '__awaiting' ? 'awaiting' : undefined;

    state.data = await api.requests({
      status: flag ? undefined : state.filter ?? undefined,
      flag,
      q: state.query || undefined,
      limit: state.queueShown,
      sort: state.sort,
      house: state.house ?? undefined,
    });
    main().innerHTML = renderQueue();
  } catch (error) {
    if (error.status === 401) return showLogin('Сессия истекла, войдите заново');
    main().innerHTML = errorState(error, 'reload');
  }
}

/**
 * Карточка тянется с сервера, а не берётся из строки очереди.
 *
 * В строке нет ни переписки, ни контакта жителя: пока карточка рисовалась
 * из неё, диспетчер не видел ни собственного вопроса, ни ответа на него.
 */
/**
 * Дома УК одним списком — для объявлений, опросов и председателей.
 *
 * Берём из «Моих домов», а не из лицевых счетов. Раньше список собирался
 * по квартирам жителей, и в дом, где в приложении ещё никого нет, нельзя
 * было опубликовать даже объявление об отключении воды.
 *
 * Дома с жителями — наверху: председателя и опрос без жителей не завести.
 */
async function loadHouses() {
  if (state.houseOptions.length) return;
  state.housesData ??= await api.houses();
  state.houseOptions = [...state.housesData.houses]
    .sort((a, b) => Number(Boolean(b.linkedProperties)) - Number(Boolean(a.linkedProperties))
      || String(a.address).localeCompare(String(b.address), 'ru'))
    .map((h) => ({
      houseKey: h.houseKey,
      label: h.linkedProperties ? h.address : `${h.address} — жителей в приложении нет`,
    }));
}

/**
 * Кто в домах организации ждёт подтверждения — ТОЛЬКО ПРОСМОТР.
 *
 * ПОДТВЕРЖДАТЬ УК НЕ МОЖЕТ, и кнопок здесь нет ни одной. Диспетчер
 * заходит в кабинет хорошо если раз в месяц; сделай его звеном
 * ежедневного потока — и жители застрянут в очереди навсегда.
 * Подтверждает председатель совета дома: он живёт в этом доме
 * и знает соседей в лицо.
 *
 * Смысл этого списка ровно один: увидеть, что в доме копятся заявки,
 * а председателя нет, — и назначить его на соседней вкладке.
 */
function renderClaims() {
  const rows = state.claims ?? [];
  const needChairman = state.claimsNeedChairman ?? [];

  return renderTabs() + pageHead('Ждут подтверждения', 'Жители, которые отсканировали квитанцию и ждут, пока председатель подтвердит доступ') + html`
    ${needChairman.length ? html`
      <div class="dsp-banner">
        В ${needChairman.length}
        ${needChairman.length === 1 ? 'доме' : 'домах'} люди ждут, а председателя нет —
        подтвердить их некому. Назначьте председателя на вкладке «Председатели»:
        ${esc(needChairman.map((h) => `${displayAddress(h.address)} (${h.waiting})`).join('; '))}
      </div>` : ''}

    <div class="dsp-card">
      <h2>Кто ждёт подтверждения в ваших домах</h2>
      <div class="dt-p" style="margin-top:0;font-size:14px;color:var(--tx-2)">
        Подтверждает жителей <b>председатель совета дома</b> — он живёт
        в доме и знает соседей в лицо. Здесь список только для сведения:
        если люди копятся, а председателя нет, его нужно назначить.
      </div>

      ${rows.length === 0
        ? emptyState('Никто не ждёт', 'Здесь появятся жильцы, отсканировавшие квитанцию')
        : `<div class="ha-list">${rows.map(claimRow).join('')}</div>`}
    </div>`;
}

function claimRow(c) {
  const mismatch = c.claimedFlat && c.flat && c.claimedFlat !== c.flat;

  return html`
    <div class="ha-row ${c.complete ? '' : 'off'}">
      <div class="ha-main">
        <div class="ha-title">${esc(c.claimedName || c.accountName)}</div>
        <div class="ha-sub">${esc(displayAddress(c.address))}</div>
        <div class="ha-sub">
          Называет квартиру ${esc(c.claimedFlat || '—')}
          ${mismatch ? ` · в квитанции ${esc(c.flat)} — расхождение` : ''}
          ${c.claimedPhone ? ` · ${esc(c.claimedPhone)}` : ''}
        </div>
        ${c.note ? html`<div class="ha-sub">${esc(c.note)}</div>` : ''}
        <div class="ha-state">
          ${c.viaMax ? 'Вход через MAX' : 'Вход из браузера'}
          ${c.phoneVerified ? ' · телефон подтверждён' : ''}
          · ${esc(formatDate(c.requestedAt))}
        </div>
      </div>

      ${c.complete
        ? '<span class="pill">ждёт председателя</span>'
        : '<span class="pill">ждём данных о себе</span>'}
    </div>`;
}

async function loadSection() {
  main().innerHTML = loadingState('Загружаем…');
  try {
    if (state.tab === 'claims') {
      const data = await api.claims();
      state.claims = data.claims;
      state.claimsNeedChairman = data.needChairman ?? [];
      main().innerHTML = renderClaims();
      return;
    }
    if (state.tab === 'posts') {
      await loadHouses();
      const loaded = await api.posts(state.postsShown);
      state.posts = loaded.posts;
      state.postsTotal = loaded.total ?? loaded.posts.length;
      main().innerHTML = renderPosts();
      return;
    }
    if (state.tab === 'polls') {
      await loadHouses();
      state.polls = (await api.polls()).polls;
      main().innerHTML = renderPolls();
      return;
    }
    if (state.tab === 'houses') {
      state.housesData = await api.houses();
      main().innerHTML = renderHouses();
      return;
    }
    if (state.tab === 'accounts') {
      state.accounts = await api.accounts();
      main().innerHTML = renderAccounts();
      return;
    }
    if (state.tab === 'chairmen') {
      await loadHouses();
      state.chairmen = (await api.chairmen()).chairmen;
      const first = state.houseOptions[0]?.houseKey;
      state.chairmanCandidates = first
        ? (await api.chairmanCandidates(first).catch(() => ({ candidates: [] }))).candidates
        : [];
      main().innerHTML = renderChairmen();
      return;
    }
    return loadQueue();
  } catch (error) {
    if (error.status === 401) return showLogin('Сессия истекла, войдите заново');
    main().innerHTML = errorState(error, 'reload');
  }
}

async function openRequest(id) {
  state.openId = id;
  main().innerHTML = loadingState('Открываем заявку…');
  try {
    state.open = await api.request(id);
    main().innerHTML = renderDetail(state.open);
    loadAttachments();
  } catch (error) {
    if (error.status === 401) return showLogin('Сессия истекла, войдите заново');
    state.openId = null;
    main().innerHTML = errorState(error, 'reload');
  }
}

function showLogin(error) {
  state.me = null;
  setSignedIn(null);
  main().innerHTML = renderLogin(error);
}

async function boot() {
  if (!tokenStore.get()) return showLogin(null);

  try {
    state.me = await api.me();
  } catch {
    return showLogin(null);
  }

  setSignedIn(state.me.name);
  await loadQueue();
}

/* ─────────────── действия ─────────────── */

async function handleAction(action, target) {
  // Календарь общий с приложением жителя: одно окно выбора даты на все кабинеты
  if (await handleDateAction(action, target)) return;

  switch (action) {
    case 'do-login': {
      const login = document.querySelector('#dspLogin')?.value.trim() ?? '';
      const password = document.querySelector('#dspPass')?.value ?? '';
      await withLoading(target, async () => {
        try {
          await api.login(login, password);
          await boot();
        } catch (error) {
          const box = document.querySelector('#dspErr');
          if (box) {
            box.textContent = error.message;
            box.classList.add('show');
          }
        }
      });
      return;
    }

    case 'logout':
      await api.logout().catch(() => {});
      tokenStore.set(null);
      return showLogin(null);

    case 'filter':
      state.filter = target.dataset.v || null;
      state.openId = null;
      // Другая выборка — счёт показанного начинается заново
      state.queueShown = QUEUE_STEP;
      return loadQueue();

    case 'search':
      state.query = document.querySelector('#dspQ')?.value.trim() ?? '';
      state.queueShown = QUEUE_STEP;
      return loadQueue();

    case 'house': {
      // Клик по списку тоже приходит сюда — перезагружаем только на смену дома
      const house = target.value || null;
      if (house === state.house) return;
      state.house = house;
      state.queueShown = QUEUE_STEP;
      return loadQueue();
    }

    case 'sort':
      state.sort = target.dataset.v || 'deadline';
      state.queueShown = QUEUE_STEP;
      return loadQueue();

    case 'search-reset':
      state.query = '';
      state.queueShown = QUEUE_STEP;
      return loadQueue();

    case 'posts-more': {
      const keep = window.scrollY;
      state.postsShown += QUEUE_STEP;
      await loadSection();
      window.scrollTo({ top: keep });
      return;
    }

    case 'queue-more': {
      // Очередь читается сверху вниз, поэтому место прокрутки бережём
      const keep = window.scrollY;
      state.queueShown += QUEUE_STEP;
      await loadQueue();
      window.scrollTo({ top: keep });
      return;
    }

    case 'open':
      return openRequest(target.dataset.id);

    case 'open-file': {
      // Вкладку открываем сразу, в ответ на нажатие: после await браузер
      // счёл бы её всплывающим окном и заблокировал
      const tab = window.open('', '_blank');
      try {
        const url = await fileUrl(target.dataset.path);
        if (tab) tab.location.href = url;
        else window.location.href = url;
      } catch (error) {
        tab?.close();
        toast(error.message);
      }
      return;
    }

    case 'back':
      state.openId = null;
      state.open = null;
      return loadQueue();

    case 'reload':
      if (state.openId) return openRequest(state.openId);
      return loadSection();

    /**
     * Переключение вкладки.
     *
     * Сбрасываем открытую карточку и разовые сообщения: иначе вернувшись
     * в «Заявки», диспетчер видит карточку, из которой уже ушёл.
     */
    case 'tab': {
      state.tab = target.dataset.v;
      state.openId = null;
      state.open = null;
      state.appointed = null;
      state.contactsFor = null;
      await loadSection();
      return;
    }

    /* ─────────────── телефоны дома ─────────────── */

    case 'open-contacts': {
      const houseKey = target.dataset.key;
      try {
        state.contactsFor = {
          houseKey, address: target.dataset.address, data: await api.houseContacts(houseKey),
        };
        main().innerHTML = renderHouses();
        window.scrollTo({ top: 0 });
      } catch (error) {
        toast(error.message);
      }
      return;
    }

    case 'close-contacts':
      state.contactsFor = null;
      main().innerHTML = renderHouses();
      return;

    case 'hc-kind':
      pickContactKind(target);
      return;

    case 'hc-save': {
      const key = target.dataset.key;
      await withLoading(target, async () => {
        try {
          await api.saveHouseContact(key, readContactForm());
          toast('Номер сохранён');
          state.contactsFor.data = await api.houseContacts(key);
          main().innerHTML = renderHouses();
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    case 'hc-remove': {
      if (!await confirmAction({ title: 'Удалить номер?', text: 'Жители перестанут его видеть.', confirmLabel: 'Удалить', danger: true })) return;
      const key = target.dataset.key;
      try {
        await api.removeHouseContact(key, target.dataset.id);
        toast('Номер удалён');
        state.contactsFor.data = await api.houseContacts(key);
        main().innerHTML = renderHouses();
      } catch (error) {
        toast(error.message);
      }
      return;
    }

    /* ─────────────── объявления и опросы ─────────────── */

    /** Выбор типа объявления: обычные «чипы», выделение одно на группу. */
    case 'ha-kind': {
      const group = target.parentElement;
      group?.querySelectorAll('.chip').forEach((chip) => chip.classList.remove('sel'));
      target.classList.add('sel');

      // Подсказка меняется вместе с типом: у аварии она про рассылку
      const hint = document.querySelector('#haKindHint');
      if (hint) hint.textContent = target.dataset.hint ?? '';
      return;
    }

    case 'ha-photo':
      showPickedPhoto(target);
      return;

    case 'ha-publish': {
      const payload = readPostForm();
      if (!payload) {
        toast('Заполните заголовок и текст');
        return;
      }
      if (!payload.houseKey) {
        toast('Выберите дом');
        return;
      }

      /** Во все дома — одно и то же объявление в каждый, фотография — к первому */
      if (payload.houseKey === ALL_HOUSES) {
        const keys = (state.houseOptions ?? []).map((h) => h.houseKey);
        await withLoading(target, async () => {
          let done = 0;
          let notified = 0;
          const failed = [];
          for (const houseKey of keys) {
            try {
              const result = await api.createPost({ ...payload, houseKey });
              done += 1;
              notified += result?.notified ?? 0;
            } catch (error) {
              failed.push(error.message);
            }
          }
          toast(failed.length
            ? `Опубликовано в ${done} из ${keys.length} домов: ${failed[0]}`
            : notified
              ? `Опубликовано в ${done} домах, уведомление ушло ${notified} жильцам`
              : `Опубликовано в ${done} домах`);
          await loadSection();
        });
        return;
      }

      await withLoading(target, async () => {
        try {
          const result = await api.createPost(payload);

          /**
           * Фотография идёт вторым запросом. Не дошла — объявление всё
           * равно опубликовано: терять написанный текст из-за картинки
           * нельзя, но и молчать о ней тоже.
           */
          const photo = pickedPostPhoto();
          let photoFailed = '';
          if (photo && result?.id) {
            try {
              await api.attachPostPhoto(result.id, photo);
            } catch (error) {
              photoFailed = error.message;
            }
          }

          toast(photoFailed
            ? `Опубликовано, но фотография не приложилась: ${photoFailed}`
            : result.notified
              ? `Опубликовано, уведомление ушло ${result.notified} жильцам`
              : 'Опубликовано');
          await loadSection();
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    /**
     * Снятие объявления. Мягкое: строка остаётся в базе.
     * Жёсткое удаление лишает дом истории — «а было ли вообще объявление
     * про отключение?» станет неразрешимым спором между УК и жителями.
     */
    case 'ha-remove': {
      if (!await confirmAction({ title: 'Снять объявление?', text: 'Жители перестанут его видеть.', confirmLabel: 'Снять', danger: true })) return;
      await withLoading(target, async () => {
        try {
          await api.removePost(target.dataset.id);
          toast('Объявление снято');
          await loadSection();
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    case 'hp-create': {
      const payload = readPollForm();
      if (!payload) {
        toast('Нужен заголовок и хотя бы два варианта, каждый с новой строки');
        return;
      }

      const houseKey = document.querySelector('#hpHouse')?.value;
      if (!houseKey) {
        toast('Выберите дом');
        return;
      }

      await withLoading(target, async () => {
        try {
          await api.createPoll({ ...payload, houseKey });
          toast('Опрос создан');
          await loadSection();
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    /* ─────────────── дома и адреса ─────────────── */

    /**
     * УК добавляет свой дом руками.
     *
     * Реестр ГИС ЖКХ отдаёт дома не всех организаций, а смена управляющей
     * компании доходит до него неделями. Без ручного ввода жители таких
     * домов остаются без УК, хотя компания уже работает в сервисе.
     */
    case 'add-house': {
      const field = document.querySelector('#dspHouseAddress');
      const address = field?.value.trim() ?? '';
      if (address.length < 10) {
        toast('Нужен полный адрес с номером дома');
        field?.focus();
        return;
      }

      await withLoading(target, async () => {
        try {
          const result = await api.addHouse(address);
          toast(result.alreadyMine ? 'Этот дом уже ваш' : 'Дом добавлен');
          if (field) field.value = '';
          // Список домов для выпадающих меню устарел — пересоберём
          state.houseOptions = [];
          state.housesData = null;
          await loadSection();
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    /**
     * УК подтверждает адрес, который житель выбрал сам.
     *
     * Появляется, когда в квитанции адреса нет: расчётные центры печатают
     * QR без него. Сверить с лицевым счётом может только УК — у неё биллинг.
     */
    case 'verify-address': {
      await withLoading(target, async () => {
        try {
          await api.verifyAddress(target.dataset.id);
          toast('Адрес сверен');
          await loadSection();
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    case 'ch-house': {
      state.chairmanCandidates =
        (await api.chairmanCandidates(target.value).catch(() => ({ candidates: [] }))).candidates;
      main().innerHTML = renderChairmen();
      return;
    }

    case 'ch-add': {
      const houseKey = document.querySelector('#chHouse')?.value;
      const userId = document.querySelector('#chUser')?.value;

      if (!userId) {
        toast('Выберите жителя дома');
        return;
      }

      await withLoading(target, async () => {
        try {
          const result = await api.addChairman({ houseKey, userId });
          /**
           * Пароля больше нет и передавать нечего: раздел «Совет дома»
           * появляется у человека в его же приложении.
           */
          state.appointed = { name: result.name };
          await loadSection();
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    case 'ch-revoke': {
      await withLoading(target, async () => {
        try {
          await api.revokeChairman(target.dataset.id);
          state.appointed = null;
          // Гасить нечего: права проверяются на каждом запросе
          toast('Председатель снят, права закрыты');
          await loadSection();
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    case 'set-status': {
      const to = target.dataset.to;
      const comment = document.querySelector('#dspComment')?.value.trim() ?? '';
      const assigneeName = document.querySelector('#dspAssignee')?.value.trim() ?? '';

      /**
       * Причина отклонения обязательна — так же, как на сервере.
       * Житель должен понимать, почему его заявку закрыли: «отклонено»
       * без объяснения гарантированно приводит к звонку в УК, то есть
       * ровно к тому, от чего приложение должно избавлять.
       */
      if (to === 'rejected' && !comment) {
        toast('Укажите причину отклонения — житель должен понимать, почему');
        document.querySelector('#dspComment')?.focus();
        return;
      }

      /**
       * «Нужны уточнения» без вопроса — тупик: житель видит, что от него
       * чего-то ждут, но не знает чего. До этой проверки заявка так и
       * зависала, а человек всё равно звонил в УК.
       */
      if (to === 'need_info' && !comment) {
        toast('Напишите, что уточнить — житель увидит ваш вопрос в заявке');
        document.querySelector('#dspComment')?.focus();
        return;
      }

      /**
       * Закрытую заявку не переоткрыть — ни УК, ни житель. Промах мимо
       * «Взять в работу» по соседней «Отклонить» закрывал её навсегда.
       */
      if ((to === 'done' || to === 'rejected')
        && !await confirmAction(to === 'done'
          ? {
            title: 'Отметить заявку выполненной?',
            text: 'Сами вы её не переоткроете. Если работа не сделана, житель сможет вернуть её в работу.',
            confirmLabel: 'Выполнено',
          }
          : {
            title: 'Отклонить заявку?',
            text: 'Переоткрыть её будет нельзя, житель увидит причину.',
            confirmLabel: 'Отклонить', danger: true,
          })) return;

      await withLoading(target, async () => {
        try {
          await api.setStatus(target.dataset.id, {
            status: to,
            comment: comment || undefined,
            assigneeName: assigneeName || undefined,
            rejectReason: to === 'rejected' ? comment : undefined,
          });
          toast(`Статус: ${STATUS_LABEL[to]}`);
          // Остаёмся в карточке: диспетчер обычно ведёт заявку дальше,
          // а не возвращается в очередь после каждого действия
          await openRequest(target.dataset.id);
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    /** Строка ввода в чате: написать жителю, не трогая статус */
    case 'send-dsp-comment': {
      const field = document.querySelector('#dspReply');
      const err = document.querySelector('#dspReplyErr');
      const text = field?.value.trim() ?? '';
      if (text.length < 2) {
        if (err) {
          err.textContent = 'Напишите сообщение жителю';
          err.classList.add('show');
        }
        field?.focus();
        return;
      }
      err?.classList.remove('show');
      await withLoading(target, async () => {
        try {
          await api.comment(target.dataset.id, text);
          toast('Сообщение отправлено');
          await openRequest(target.dataset.id);
        } catch (error) {
          toast(error.message);
        }
      });
      return;
    }

    default:
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  handleAction(target.dataset.action, target);
});

document.addEventListener('input', (event) => {
  if (event.target.matches?.('[data-filter-for]')) applyFilter(event.target);
});

/**
 * Смена значения в списке — тоже действие.
 *
 * Клик по `<select>` не даёт нового значения: оно появляется только
 * в событии change. Без этого выбор дома в форме председателя не подгружал
 * бы его жителей.
 */
document.addEventListener('change', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target || target.tagName !== 'SELECT') return;
  handleAction(target.dataset.action, target);
});

// Enter в поле пароля — обычное ожидание от формы входа
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  if (enterSearch(event, handleAction)) return;
  const button = document.querySelector('[data-action="do-login"]');
  if (button && document.querySelector('#dspPass')) handleAction('do-login', button);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
