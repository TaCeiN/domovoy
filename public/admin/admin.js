import { askText, confirmAction, displayAddress,
  esc, html, formatDate, toast, withLoading, loadingState, errorState, emptyState, eventAuthor,
} from '../app/ui.js';
import { dateField, handleDateAction } from '../app/datepicker.js';
import { contactsEditor, pickContactKind, readContactForm } from '../app/house-admin.js';
import { API_BASE } from '../app/config.js';
import { telHref } from '../app/screens/requests.js';
import { renderNav, setSignedIn, searchBar, enterSearch, pageHead } from '../dispatcher/nav.js';
import { eventsSection, eventsState, handleEventsAction, unseenTotal } from './events.js';
import {
  coverageSection, coverageState, handleCoverageAction, mountCoverage, bindCoverageSearch,
  LEVEL_LABEL, LEVEL_COLOR,
} from './coverage.js';

/**
 * Кабинет оператора сервиса.
 *
 * ЗАЧЕМ ОН. Дом без управляющей компании некому подключить изнутри:
 * председателя назначает УК, а её нет. Разрывает круг человек снаружи.
 * До этого кабинета он работал командами из консоли.
 *
 * ОТДЕЛЬНОЕ ХРАНИЛИЩЕ ТОКЕНА. Кабинеты и приложение жителя живут на одном
 * домене, и один ключ в localStorage они бы затирали друг другу: вход
 * оператора выкидывал бы диспетчера, а тот — жителя. Ключи разные
 * намеренно — эта грабля в проекте уже описана.
 */

const TOKEN_KEY = 'domovoy-admin-token';

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

/* ─────────────── сеть ─────────────── */

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
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
  login: (login, password) => request('POST', '/api/admin/login', { login, password }),
  logout: () => request('POST', '/api/admin/logout', {}),
  me: () => request('GET', '/api/admin/me'),
  demo: () => request('GET', '/api/admin/demo'),
  demoSet: (enabled) => request('POST', '/api/admin/demo', { enabled }),
  demoReset: () => request('POST', '/api/admin/demo/reset', {}),
  demoRelease: (key) => request('POST', `/api/admin/demo/roles/${encodeURIComponent(key)}/release`, {}),
  audit: ({ page, from, to, action } = {}) => {
    const params = new URLSearchParams({ page: String(page ?? 1) });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    if (action) params.set('action', action);
    return request('GET', `/api/admin/audit?${params}`);
  },

  houses: (q) => request('GET', `/api/admin/houses?q=${encodeURIComponent(q)}`),
  house: (key) => request('GET', `/api/admin/houses/${encodeURIComponent(key)}`),
  houseRequest: (key, id) =>
    request('GET', `/api/admin/houses/${encodeURIComponent(key)}/requests/${encodeURIComponent(id)}`),
  hideReview: (id, reason) => request('POST', `/api/admin/reviews/${encodeURIComponent(id)}/hide`, { reason }),
  setForm: (key, form) =>
    request('POST', `/api/admin/houses/${encodeURIComponent(key)}/form`, { form }),
  saveHouseContact: (key, form) =>
    request('POST', `/api/admin/houses/${encodeURIComponent(key)}/contacts`, form),
  removeHouseContact: (key, id) =>
    request('POST', `/api/admin/houses/${encodeURIComponent(key)}/contacts/${encodeURIComponent(id)}/remove`),
  connectOrg: (key, inn, form) =>
    request('POST', `/api/admin/houses/${encodeURIComponent(key)}/org`, { inn, form }),
  makeChairman: (key, userId) =>
    request('POST', `/api/admin/houses/${encodeURIComponent(key)}/chairman`, { userId }),
  revokeChairman: (id) => request('POST', `/api/admin/chairmen/${id}/revoke`, {}),

  claims: () => request('GET', '/api/admin/house-claims'),
  decideClaim: (id, status, reason) =>
    request('POST', `/api/admin/house-claims/${id}/decide`, { status, reason }),

  users: (q) => request('GET', `/api/admin/users?q=${encodeURIComponent(q)}`),
  user: (id) => request('GET', `/api/admin/users/${id}`),
  revokeBinding: (id, reason) =>
    request('POST', `/api/admin/bindings/${id}/revoke`, { reason }),

  orgs: (q) => request('GET', `/api/admin/orgs?q=${encodeURIComponent(q)}`),
  orgDispatcher: (id, login) =>
    request('POST', `/api/admin/orgs/${id}/dispatcher`, login ? { login } : {}),

  events: ({ kind, unseenOnly } = {}) => {
    const params = new URLSearchParams();
    if (kind) params.set('kind', kind);
    if (unseenOnly) params.set('unseen', '1');
    return request('GET', `/api/admin/events?${params}`);
  },
  eventsSeen: (items) => request('POST', '/api/admin/events/seen', { items }),

  coverageRegions: () => request('GET', '/api/admin/coverage/regions'),
  coveragePlaces: (region) => request('GET', `/api/admin/coverage/places?region=${encodeURIComponent(region)}`),
  coverageStreets: (region, place) =>
    request('GET', `/api/admin/coverage/streets?region=${encodeURIComponent(region)}&place=${encodeURIComponent(place)}`),
  coveragePoints: (region, bbox) =>
    request('GET', `/api/admin/coverage/points?region=${encodeURIComponent(region)}&bbox=${bbox.join(',')}`),

  tables: () => request('GET', '/api/admin/tables'),
  table: (name, page, q) => request(
    'GET',
    `/api/admin/tables/${encodeURIComponent(name)}?page=${page}&q=${encodeURIComponent(q ?? '')}`,
  ),
};

/** Формы управления домом: значение и человеческое название. */
const FORMS = [
  ['uk', 'управляющая компания'],
  ['tsj', 'ТСЖ'],
  ['zhsk', 'ЖСК'],
  ['direct', 'непосредственное управление'],
  ['none', 'управления нет'],
  ['private', 'частный дом'],
  ['unknown', 'неизвестно'],
];

/* ─────────────── состояние ─────────────── */

const state = {
  me: null,
  /** События — первый раздел: оператор заходит узнать, что без него не разберут */
  tab: 'events',
  /** Новых событий — для счётчика на вкладке */
  unseen: 0,
  /** Результат поиска домов: null — ещё не искали, [] — не нашлось */
  houses: null,
  houseQuery: '',
  /** Ключ открытого дома: карточка вместо списка */
  openHouse: null,
  /** Открытое обращение этого дома: карточка обращения вместо карточки дома */
  openRequest: null,
  users: null,
  userQuery: '',
  openUser: null,
  orgs: null,
  orgQuery: '',
  /**
   * Логин и пароль только что заведённого кабинета УК. Пароль виден
   * один раз — в базе только хеш, — поэтому держим его до ухода
   * из раздела, а не показываем в alert(), откуда его не скопировать.
   */
  freshCabinet: null,
  tableName: null,
  tablePage: 1,
  tableQuery: '',
  /** Журнал: страница и границы периода — записи живут дольше одного экрана */
  auditPage: 1,
  auditFrom: '',
  auditTo: '',
  auditAction: '',
};

const main = () => document.querySelector('#admMain');

/* ─────────────── экраны ─────────────── */

function renderLogin(error) {
  return html`
    <div class="dsp-login">
      <h1>Вход для оператора</h1>
      <p>
        Это рабочее место оператора сервиса. Ни жителям, ни управляющим
        компаниям сюда не нужно — у них свои адреса.
      </p>

      <div class="field-label">Логин</div>
      <input type="text" id="admLogin" autocomplete="username" placeholder="operator">

      <div class="field-label">Пароль</div>
      <input type="password" id="admPass" autocomplete="current-password">

      <div class="field-error ${error ? 'show' : ''}" id="admErr">${esc(error ?? '')}</div>

      <button class="btn-primary" data-action="do-login">Войти</button>
    </div>`;
}

const TABS = [
  { id: 'events', label: 'События', icon: 'bell', tone: 'red' },
  { id: 'coverage', label: 'Покрытие', icon: 'map', tone: 'green' },
  { id: 'houses', label: 'Дома', icon: 'house', tone: 'blue' },
  { id: 'claims', label: 'Заявки на подключение', icon: 'inbox', tone: 'orange' },
  { id: 'users', label: 'Жители', icon: 'people', tone: 'violet' },
  { id: 'orgs', label: 'Организации', icon: 'org', tone: 'teal' },
  { id: 'tables', label: 'База', icon: 'db', tone: 'gray' },
  { id: 'audit', label: 'Журнал', icon: 'log', tone: 'pink' },
  { id: 'demo', label: 'Демо-дом', icon: 'play', tone: 'violet' },
];

/** Заголовки разделов; у «Событий» и «Покрытия» свои — с переключателями справа */
const PAGE_HEAD = {
  houses: ['Дома', 'Поиск по адресу — среди домов реестра и адресов из квитанций жителей'],
  claims: ['Заявки на подключение', 'Жители просят подключить дом, за которым никто не стоит'],
  users: ['Жители', 'Поиск человека по фамилии или телефону'],
  orgs: ['Организации', 'Управляющие компании, ТСЖ и ЖСК из реестра и их кабинеты'],
  tables: ['База', 'Таблицы базы — только чтение'],
  audit: ['Журнал', 'Каждое действие оператора, меняющее данные'],
  demo: ['Демо-дом', 'Выдуманный дом для экспертов: роли на экране входа приложения'],
};

function sectionHead() {
  const head = PAGE_HEAD[state.tab];
  // В карточке дома или жителя заголовок — сам адрес или имя
  if (!head || (state.tab === 'houses' && state.openHouse) || (state.tab === 'users' && state.openUser)) return '';
  return pageHead(...head);
}

/** Меню живёт в боковой панели; вызов оставлен там, где раньше рисовались вкладки */
function tabsBar() {
  renderNav('#admNav', TABS.map((t) => ({ ...t, count: t.id === 'events' ? state.unseen : 0 })), state.tab, 'tab');
  return '';
}

/**
 * Сколько совпадений показано, а сколько их всего.
 *
 * Поиск отдаёт полсотни строк и молчал об остальных: оператор видел
 * список и считал, что видит всё. Для дома, записанного в базе двумя
 * способами, это прямой путь к неверному решению — не нашёл и завёл
 * второй. Кнопки «показать ещё» здесь нет намеренно: правильный ответ
 * на «слишком много совпадений» — сузить запрос, а не листать.
 */
function searchTail(found) {
  if (!found || found.total <= found.rows.length) return '';
  return html`
    <p class="dsp-dim">
      Показаны первые ${found.rows.length} из ${found.total} — уточните запрос
    </p>`;
}

/* ─────────────── дома ─────────────── */

/**
 * Вход в раздел — поиск, а не список.
 *
 * У оператора нет точки отсчёта: диспетчер видит дома своей организации,
 * председатель — свой, а оператор ищет дом, о котором ещё ничего
 * не известно. Показывать ему «все дома» бессмысленно — в наборе
 * одной области их больше миллиона.
 */
function housesSection(found, q) {
  const rows = found?.rows ?? null;

  return html`
    <div class="dsp-card">
      ${searchBar({ id: 'admHouseQ', value: q, placeholder: 'Адрес или его часть, например: Ленина 85', action: 'find-houses' })}
      ${rows === null ? html`
        <p class="dsp-dim">
          Начните с адреса — можно часть: «Ленина 85», «Батайск Мира».
          Список всех домов здесь не показывается: в наборе области их больше миллиона,
          включая частные.
        </p>` : ''}
    </div>

    ${rows === null ? '' : rows.length === 0
      ? emptyState('Ничего не нашлось', 'Проверьте написание адреса')
      : html`
        <div class="dsp-card">
          <div class="dsp-table-wrap">
          <table class="dsp-table">
            <thead><tr><th>Адрес</th><th>Управление</th><th>Жители</th><th></th></tr></thead>
            <tbody>
              ${rows.map((r) => html`
                <tr>
                  <td>${esc(displayAddress(r.address))}</td>
                  <td>
                    ${esc(r.orgName ?? r.formLabel)}
                    ${r.hasChairman ? '<div class="dsp-dim">председатель есть</div>' : ''}
                    ${r.openClaims ? `<div class="dsp-dim">заявок: ${r.openClaims}</div>` : ''}
                  </td>
                  <td>${r.residents}</td>
                  <td>
                    <button class="dsp-mini" data-action="open-house"
                            data-key="${esc(r.houseKey)}">Открыть</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
          </div>
          ${searchTail(found)}
        </div>`}`;
}

function houseCardSection(h) {
  const cov = h.coverage ?? { level: 'address', isPrivate: false };
  const reg = h.registry;
  const org = reg?.org;
  const yesNo = (v) => (v === true ? 'да' : v === false ? 'нет' : '—');

  return html`
    <button class="dsp-back" data-action="back-houses">← К поиску</button>

    <div class="dsp-card dsp-house-head">
      <div class="dsp-house-title">
        <h2>${esc(displayAddress(h.address))}</h2>
        <div class="dsp-dim" title="Ключ дома">${esc(h.houseKey)}</div>
      </div>
      <div class="dsp-house-level">
        ${cov.isPrivate
          ? '<span class="dsp-level" style="--c:#8b5cf6">частный дом</span>'
          : html`<span class="dsp-level" style="--c:${LEVEL_COLOR[cov.level]}">${esc(LEVEL_LABEL[cov.level])}</span>`}
        <p class="dsp-dim">${esc(nextStep(cov))}</p>
      </div>
    </div>

    <div class="dsp-detail">
      <div>
        <div class="dsp-card">
          <h2>Жители · ${h.residents.length}</h2>
          ${h.residents.length === 0
            ? '<p class="dsp-dim">В доме пока никого нет</p>'
            : html`
            <div class="dsp-table-wrap">
            <table class="dsp-table">
              <thead><tr><th>Кто</th><th>Квартира</th><th>Статус</th><th><span class="sr-only">Действия</span></th></tr></thead>
              <tbody>
                ${h.residents.map((r) => html`
                  <tr>
                    <td>${esc(r.name)}<div class="dsp-dim">${r.viaMax ? 'через MAX' : 'браузер'}</div></td>
                    <td>${esc(r.flat || '—')}</td>
                    <td>${esc(statusLabel(r.status))}${r.role === 'owner' ? ' · собственник' : ''}</td>
                    <td class="dsp-row-actions">
                      ${h.chairman || r.status === 'revoked' || r.status === 'rejected' ? '' : html`
                        <button class="dsp-mini" data-action="make-chairman"
                                data-key="${esc(h.houseKey)}" data-id="${esc(r.userId)}">
                          Назначить председателем
                        </button>`}
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
            </div>`}
        </div>

        <div class="dsp-card">
          <h2>Отзывы о доме · ${h.reviews.length}</h2>
          ${h.reviews.length === 0
            ? '<p class="dsp-dim">Отзывов нет</p>'
            : h.reviews.map((r) => html`
              <div class="dsp-review">
                <div><b>★ ${esc(r.overall.toFixed(1))}</b>
                  <span class="dsp-dim">${esc(new Date(r.updatedAt).toLocaleDateString('ru-RU'))}</span></div>
                ${r.pros ? html`<p>Нравится: ${esc(r.pros)}</p>` : ''}
                ${r.cons ? html`<p>Не нравится: ${esc(r.cons)}</p>` : ''}
                ${r.hiddenAt
                  ? html`<p class="dsp-dim">Скрыт: ${esc(r.hiddenReason ?? '')}</p>`
                  : html`<button class="dsp-mini danger" data-action="hide-review" data-id="${esc(r.id)}">Скрыть</button>`}
              </div>`).join('')}
        </div>

        <div class="dsp-card">
          <h2>Обращения · ${h.requests.length}</h2>
          <p class="dsp-dim">
            Только чтение. Обращение нельзя ни удалить, ни закрыть: у жителя
            должно остаться доказательство, которое никто не сотрёт.
          </p>
          ${h.requests.length === 0
            ? '<p class="dsp-dim">Обращений нет</p>'
            : html`
            <div class="dsp-table-wrap">
            <table class="dsp-table">
              <thead><tr><th>Когда</th><th>Что</th><th>Статус</th><th><span class="sr-only">Действия</span></th></tr></thead>
              <tbody>
                ${h.requests.map((r) => html`
                  <tr>
                    <td class="dsp-muted-cell dsp-nowrap">${esc(formatDate(r.createdAt))}</td>
                    <td>${esc(r.title)}<div class="dsp-dim">${esc(r.category)}</div></td>
                    <td>${esc(r.statusLabel ?? r.status)}</td>
                    <td><button class="dsp-mini" data-action="open-request" data-id="${esc(r.id)}">Открыть</button></td>
                  </tr>`).join('')}
              </tbody>
            </table>
            </div>`}
        </div>
      </div>

      <aside>
        <div class="dsp-card">
          <h2>Управление</h2>
          <div class="dsp-field">
            <span>Форма управления</span>
            <select class="dsp-select" data-action="set-form" data-key="${esc(h.houseKey)}">
              ${FORMS.map(([value, label]) => html`
                <option value="${esc(value)}" ${h.form === value ? 'selected' : ''}>
                  ${esc(label)}
                </option>`).join('')}
            </select>
          </div>
          ${h.orgName ? html`<p class="dsp-dim">Организация: ${esc(h.orgName)}</p>` : ''}
          ${h.setBy ? html`<p class="dsp-dim">Проставил: ${esc(h.setBy)}</p>` : ''}

          <div class="dsp-field dsp-gap">
            <span>Подключить организацию по ИНН</span>
            <!--
              Кто эта организация — выбирает оператор. Раньше кабинет всегда
              слал «ТСЖ», и лицензированная УК или ЖСК помечались товариществом.
            -->
            <select id="admOrgForm" class="dsp-select">
              ${ORG_FORMS.map(([value, label]) => html`
                <option value="${esc(value)}" ${(ORG_FORMS.some(([v]) => v === h.form) ? h.form : 'uk') === value ? 'selected' : ''}>
                  ${esc(label)}
                </option>`).join('')}
            </select>
            <div class="dsp-inline">
              <input type="text" id="admOrgInn" placeholder="10 или 12 цифр" inputmode="numeric">
              <button class="dsp-act primary" data-action="connect-org"
                      data-key="${esc(h.houseKey)}">Подключить</button>
            </div>
          </div>
        </div>

        <div class="dsp-card">
          <h2>Председатель</h2>
          ${h.chairman ? html`
            <p>${esc(h.chairman.name)}${h.chairman.flat ? `, кв. ${esc(h.chairman.flat)}` : ''}</p>
            <button class="dsp-mini danger" data-action="revoke-chairman"
                    data-id="${esc(h.chairman.id)}">Снять с должности</button>`
            : html`
            <p class="dsp-dim">
              Председателя нет — подтверждать жителей некому. Назначьте его
              из списка жителей слева.
            </p>`}
        </div>

        <div class="dsp-card">
          <h2>Телефоны дома</h2>
          <p class="dsp-dim">Жители видят их на экране «Аварийные службы». Каждое изменение — в журнал.</p>
          ${contactsEditor({ kinds: h.contactKinds, contacts: h.contacts, look: 'cabinet', houseKey: h.houseKey })}
        </div>

        <div class="dsp-card">
          <h2>Реестр</h2>
          ${!reg ? html`
            <p class="dsp-dim">
              Дома нет в наборе данных региона: адрес пришёл из квитанции жителя.
              Проверьте, правильно ли житель указал дом.
            </p>` : html`
            <dl class="dsp-kv">
              <dt>Форма по реестру</dt><dd>${esc(FORM_LABELS[reg.form] ?? 'нет в реестре фонда')}</dd>
              <dt>Многоквартирный</dt><dd>${yesNo(reg.garMkd)}${reg.garFlats ? ` · квартир в ГАР ${reg.garFlats}` : ''}</dd>
              <dt>Кадастровый №</dt><dd>${esc(reg.cadastralNumber ?? '—')}</dd>
              <dt>На карте</dt><dd>${reg.lat !== null ? 'есть точка' : 'координат нет'}</dd>
            </dl>
            ${org ? html`
              <div class="dsp-org">
                <div class="dsp-org-name">${esc(org.name)}</div>
                <div class="dsp-dim">ИНН ${esc(org.inn)}${org.licenseNumber ? ` · лицензия ${esc(org.licenseNumber)}` : ''}</div>
                <div class="dsp-contacts">
                  ${org.phone ? html`<a href="tel:${esc(telHref(org.phone))}">${esc(org.phone)}</a>` : ''}
                  ${org.email ? html`<a href="mailto:${esc(org.email)}">${esc(org.email)}</a>` : ''}
                  ${org.site ? html`<span>${esc(org.site)}</span>` : ''}
                  ${!org.phone && !org.email && !org.site ? '<span class="dsp-dim">контактов нет</span>' : ''}
                </div>
                <div class="dsp-dim">${org.hasCabinet ? 'Кабинет УК заведён' : 'Кабинета УК нет'}</div>
              </div>` : '<p class="dsp-dim">Организация в реестре не указана</p>'}`}
        </div>
      </aside>
    </div>`;
}

/**
 * Обращение дома глазами оператора — только чтение.
 *
 * Ни статуса, ни удаления: у жителя должно остаться доказательство,
 * которое никто не сотрёт. Вложения — списком: сами файлы открывают
 * те, кто по обращению работает, — УК и председатель.
 */
function requestSection(r) {
  return html`
    <button class="dsp-back" data-action="back-house">← К дому</button>

    <div class="dsp-card">
      <div class="dsp-dim">Обращение № ${esc(String(r.number).padStart(5, '0'))} · ${esc(r.category)} · ${esc(formatDate(r.createdAt))}</div>
      <h2>${esc(r.title)}</h2>
      <p class="dsp-dim">
        ${esc(r.statusLabel ?? r.status)}${r.slaLabel ? ` · ${esc(r.slaLabel)}` : ''}
        · ${esc(r.authorName ?? 'житель')}${r.flat ? `, кв. ${esc(r.flat)}` : ''}
      </p>
      <p>${esc(r.description)}</p>
      ${(r.photos ?? []).length
        ? html`<p class="dsp-dim">Вложения: ${esc(r.photos.map((f) => f.name ?? 'файл').join(', '))}</p>`
        : ''}
    </div>

    <div class="dsp-card">
      <h2>Переписка · ${(r.events ?? []).length}</h2>
      ${(r.events ?? []).length === 0
        ? '<p class="dsp-dim">Переписки нет</p>'
        : html`
        <div class="timeline">
          ${r.events.map((e) => html`
            <div class="tl-row">
              <div class="tl-dot-col"><div class="tl-dot"></div><div class="tl-line"></div></div>
              <div class="tl-body">
                <div class="tl-who">${esc(eventAuthor(e))}</div>
                <div class="tl-t">${esc(e.text)}</div>
                <div class="tl-time">${esc(formatDate(e.at))}</div>
              </div>
            </div>`).join('')}
        </div>`}
    </div>`;
}

const FORM_LABELS = Object.fromEntries(FORMS);

/** Формы, при которых за домом стоит организация с ИНН */
const ORG_FORMS = FORMS.filter(([value]) => ['uk', 'tsj', 'zhsk'].includes(value));

/** Что сделать оператору, чтобы дом поднялся на следующий уровень покрытия */
function nextStep(cov) {
  if (cov.isPrivate) return 'Договариваться не с кем: жалобы жителей разбирает оператор.';
  return {
    address: 'Неизвестно, многоквартирный ли дом и кто им управляет. Проставьте форму управления.',
    kind: 'Нет организации с контактом. Подключите организацию по ИНН или назначьте председателя.',
    contact: 'Есть с кем договориться. Подключённым дом станет, когда у УК появится кабинет или у дома — председатель.',
    agreed: 'Дом подключён: есть председатель или кабинет УК.',
  }[cov.level];
}

function statusLabel(status) {
  return {
    active: 'подтверждён', pending: 'ждёт подтверждения', revoked: 'доступ закрыт', rejected: 'отказано',
  }[status]
    ?? status;
}

/* ─────────────── заявки на подключение ─────────────── */

function claimsSection(rows) {
  if (!rows.length) {
    return emptyState('Очередь пуста', 'Здесь появятся дома, которые просят подключить');
  }

  return html`
    <div class="dsp-card">
      <p class="dsp-dim">
        Житель просит подключить дом, за которым никто не стоит. Решить —
        значит разобраться с домом: проставить форму, подключить организацию
        или назначить председателя.
      </p>
      <div class="dsp-table-wrap">
      <table class="dsp-table">
        <thead><tr><th>Когда</th><th>Адрес</th><th>Кто просит</th><th><span class="sr-only">Действия</span></th></tr></thead>
        <tbody>
          ${rows.map((r) => html`
            <tr>
              <td class="dsp-muted-cell dsp-nowrap">${esc(formatDate(r.createdAt))}</td>
              <td class="dsp-addr-cell">${esc(displayAddress(r.address))}</td>
              <td>${esc(r.userName)}${r.note ? html`<div class="dsp-dim">«${esc(r.note)}»</div>` : ''}</td>
              <td class="dsp-row-actions">
                <button class="dsp-mini" data-action="open-house"
                        data-key="${esc(r.houseKey)}">Дом</button>
                <button class="dsp-mini" data-action="decide-claim"
                        data-id="${esc(r.id)}" data-status="done">Решено</button>
                <button class="dsp-mini danger" data-action="decide-claim"
                        data-id="${esc(r.id)}" data-status="rejected">Отклонить</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
      </div>
    </div>`;
}

/* ─────────────── жители ─────────────── */

function usersSection(found, q) {
  const rows = found?.rows ?? null;

  return html`
    <div class="dsp-card">
      ${searchBar({ id: 'admUserQ', value: q, placeholder: 'Фамилия или телефон, например: Петров', action: 'find-users' })}
      ${rows === null ? html`
        <p class="dsp-dim">
          Найдите человека по фамилии или телефону — например «Петров»
          или «903». В карточке видно его квартиры и можно закрыть доступ.
        </p>` : ''}
    </div>

    ${rows === null ? '' : rows.length === 0
      ? emptyState('Никого не нашлось', 'Проверьте написание')
      : html`
        <div class="dsp-card">
          <div class="dsp-table-wrap">
          <table class="dsp-table">
            <thead><tr><th>Кто</th><th>Телефон</th><th>Адресов</th><th></th></tr></thead>
            <tbody>
              ${rows.map((r) => html`
                <tr>
                  <td>${esc(r.name)}<div class="dsp-dim">${r.viaMax ? 'через MAX' : 'браузер'}</div></td>
                  <td>${esc(r.phone ?? '—')}</td>
                  <td>${r.properties}</td>
                  <td><button class="dsp-mini" data-action="open-user"
                              data-id="${esc(r.id)}">Открыть</button></td>
                </tr>`).join('')}
            </tbody>
          </table>
          </div>
          ${searchTail(found)}
        </div>`}`;
}

function userCardSection(u) {
  return html`
    <div class="dsp-card">
      <button class="dsp-mini" data-action="back-users">← К поиску</button>
      <h2>${esc(u.name)}</h2>
      <p class="dsp-dim">
        ${u.viaMax ? 'через MAX' : 'браузер'}
        ${u.phone ? ` · ${esc(u.phone)}${u.phoneVerified ? ' (подтверждён)' : ''}` : ''}
      </p>
    </div>

    <div class="dsp-card">
      <h2>Адреса · ${u.bindings.length}</h2>
      ${u.bindings.length === 0
        ? '<p class="dsp-dim">Ни одного адреса</p>'
        : html`
        <table class="dsp-table">
          <thead><tr><th>Адрес</th><th>Роль</th><th>Статус</th><th></th></tr></thead>
          <tbody>
            ${u.bindings.map((b) => html`
              <tr>
                <td>${esc(displayAddress(b.address))}${b.flat ? `, кв. ${esc(b.flat)}` : ''}</td>
                <td>${b.role === 'owner' ? 'собственник' : 'жилец'}</td>
                <td>
                  ${esc(statusLabel(b.status))}
                  ${b.rejectReason ? html`<div class="dsp-dim">${esc(b.rejectReason)}</div>` : ''}
                </td>
                <td>
                  ${b.status === 'revoked' ? '' : html`
                    <button class="dsp-mini danger" data-action="revoke-binding"
                            data-id="${esc(b.bindingId)}" data-owner="${b.role === 'owner'}">
                      Закрыть доступ
                    </button>`}
                </td>
              </tr>`).join('')}
          </tbody>
        </table>`}
    </div>`;
}

/* ─────────────── организации ─────────────── */

function orgsSection(found, q) {
  const rows = found?.rows ?? null;
  const fresh = state.freshCabinet;

  return html`
    ${fresh ? html`
      <div class="dsp-card">
        <h2>Кабинет УК · ${esc(fresh.orgName)}</h2>
        <dl class="dsp-kv">
          <dt>Логин</dt><dd><code>${esc(fresh.login)}</code></dd>
          <dt>Пароль</dt><dd><code>${esc(fresh.password)}</code></dd>
        </dl>
        <p class="dsp-dim">
          Пароль показан один раз: в базе только хеш. Передайте его управляющей
          компании сейчас — потом останется только сбросить.
        </p>
        <div class="dsp-actions">
          <button class="dsp-act primary" data-action="copy-cabinet">Скопировать логин и пароль</button>
          <button class="dsp-act" data-action="hide-cabinet">Готово, скрыть</button>
        </div>
      </div>` : ''}

    <div class="dsp-card">
      ${searchBar({ id: 'admOrgQ', value: q, placeholder: 'Название или ИНН, например: Трианон', action: 'find-orgs' })}
    </div>

    ${rows === null ? '' : rows.length === 0
      ? emptyState('Ничего не нашлось', 'Организация появляется в базе после импорта реестра')
      : html`
        <div class="dsp-card">
          <div class="dsp-table-wrap">
          <table class="dsp-table">
            <thead><tr><th>Организация</th><th>Домов</th><th>Кабинет</th><th></th></tr></thead>
            <tbody>
              ${rows.map((r) => html`
                <tr>
                  <td>
                    ${esc(r.name)}
                    <div class="dsp-dim">
                      ИНН ${esc(r.inn)}${r.licenseNumber ? ` · лицензия ${esc(r.licenseNumber)}` : ' · без лицензии'}
                    </div>
                  </td>
                  <td>${r.houses}</td>
                  <td>${esc(r.dispatcherLogin ?? '—')}</td>
                  <td>
                    <button class="dsp-mini" data-action="org-dispatcher" data-name="${esc(r.name)}"
                            data-id="${esc(r.id)}" data-login="${esc(r.dispatcherLogin ?? '')}">
                      ${r.dispatcherLogin ? 'Сбросить пароль' : 'Завести кабинет'}
                    </button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
          </div>
          ${searchTail(found)}
        </div>`}`;
}

/* ─────────────── база ─────────────── */

function tablesSection(list, page) {
  return html`
    <div class="dsp-card">
      <p class="dsp-dim">
        Только чтение. Менять данные можно действиями в разделах выше — они
        знают правила, а правка ячейки ломает их тихо. Хеши паролей
        и токены сессий здесь не показываются никогда.
      </p>
      <div class="dsp-chips">
        ${list.map((t) => html`
          <button class="dsp-chip ${state.tableName === t.name ? 'on' : ''}"
                  data-action="open-table" data-name="${esc(t.name)}">
            ${esc(t.name)} · ${t.rows}
          </button>`).join('')}
      </div>
    </div>

    ${!page ? '' : html`
      <div class="dsp-card">
        <h2>${esc(page.name)} · ${page.total}</h2>
        ${searchBar({ id: 'admTableQ', value: state.tableQuery, placeholder: 'Поиск по текстовым колонкам', action: 'search-table' })}

        <div style="overflow-x:auto">
          <table class="dsp-table">
            <thead><tr>${page.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
            <tbody>
              ${page.rows.map((row) => html`
                <tr>${page.columns.map((c) => `<td>${esc(cellText(row[c]))}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </div>

        <div class="dsp-dim">
          Страница ${page.page} из ${Math.max(1, Math.ceil(page.total / page.pageSize))}
        </div>
        <button class="dsp-mini" data-action="table-page" data-page="${page.page - 1}"
                ${page.page <= 1 ? 'disabled' : ''}>Назад</button>
        <button class="dsp-mini" data-action="table-page" data-page="${page.page + 1}"
                ${page.page * page.pageSize >= page.total ? 'disabled' : ''}>Вперёд</button>
      </div>`}`;
}

function cellText(value) {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/* ─────────────── журнал ─────────────── */

/**
 * Журнал страницами, а не последними двумя сотнями.
 *
 * Он заведён ради разбора спора через полгода, и записи старше потолка
 * были недостижимы из кабинета вообще — то есть к нужному сроку журнал
 * оказывался пустым. Приём тот же, что в разделе «База»: страница,
 * общее число, кнопки по краям.
 */
/**
 * Действия в выпадающем списке.
 *
 * Подпись берётся человеческая, но два разных действия могут совпасть
 * в ней слово в слово — назначение и снятие председателя описываются
 * одной строкой. Тогда рядом дописывается машинное имя: два одинаковых
 * пункта в списке хуже одного технического слова.
 */
function auditActionOptions(actions) {
  const twice = (label) => actions.filter((a) => a.label === label).length > 1;

  return actions.map((a) => html`
    <option value="${esc(a.action)}" ${state.auditAction === a.action ? 'selected' : ''}>
      ${esc(a.label)}${twice(a.label) ? ` (${esc(a.action)})` : ''}
    </option>`).join('');
}

function auditSection(page) {
  const pages = Math.max(1, Math.ceil(page.total / page.pageSize));
  const filtered = Boolean(state.auditFrom || state.auditTo || state.auditAction);

  return html`
    <div class="dsp-card">
      <p class="dsp-dim">
        Каждое действие оператора, меняющее данные. Записи не удаляются
        и переживают выключение учётки.
      </p>

      <div class="dsp-filterbar">
        <div class="dsp-field">
          <span>Записи с</span>
          ${dateField({ id: 'admAuditFrom', value: state.auditFrom, placeholder: 'С самого начала' })}
        </div>
        <div class="dsp-field">
          <span>по</span>
          ${dateField({ id: 'admAuditTo', value: state.auditTo, placeholder: 'По сегодня' })}
        </div>
        <label class="dsp-field wide">
          <span>Действие</span>
          <select id="admAuditAction" class="dsp-select" data-action="audit-action">
            <option value="">любое</option>
            ${auditActionOptions(page.actions ?? [])}
          </select>
        </label>
        <div class="dsp-filterbar-actions">
          <button class="dsp-act primary" data-action="audit-filter">Показать</button>
          ${filtered
            ? '<button class="dsp-act" data-action="audit-reset">Сбросить</button>'
            : ''}
        </div>
      </div>
    </div>

    ${page.rows.length === 0
      ? emptyState(
          filtered ? 'За этот период записей нет' : 'Журнал пуст',
          filtered
            ? 'Возьмите период шире или снимите его совсем'
            : 'Здесь появится каждое действие оператора',
        )
      : html`
        <div class="dsp-card">
          <div class="dsp-table-wrap">
          <table class="dsp-table">
            <thead><tr><th>Когда</th><th>Кто</th><th>Что</th><th>Над чем</th></tr></thead>
            <tbody>
              <!--
                «Что» говорит по-русски, «Над чем» показывает адрес.
                Раньше в первой колонке стояли две строки сразу — русская
                и машинная, — а во второй хэш дома на половину ширины
                таблицы. Машинное имя теперь живёт в фильтре, ключ дома —
                в подсказке при наведении.
              -->
              ${page.rows.map((r) => html`
                <tr>
                  <td class="dsp-muted-cell dsp-nowrap">${esc(formatDate(r.createdAt))}</td>
                  <td>${esc(r.adminName)}</td>
                  <td>${esc(r.summary)}</td>
                  <td title="${esc(r.targetId)}">${esc(r.targetLabel ?? r.targetId)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
          </div>

          <div class="dsp-pager">
            <span class="dsp-dim">Страница ${page.page} из ${pages} · всего ${page.total}</span>
            <button class="dsp-mini" data-action="audit-page" data-page="${page.page - 1}"
                    ${page.page <= 1 ? 'disabled' : ''}>Назад</button>
            <button class="dsp-mini" data-action="audit-page" data-page="${page.page + 1}"
                    ${page.page * page.pageSize >= page.total ? 'disabled' : ''}>Вперёд</button>
          </div>
        </div>`}`;
}

/* ─────────────── отрисовка ─────────────── */

async function renderTab() {
  if (state.tab === 'events') {
    const data = await api.events({ kind: eventsState.kind, unseenOnly: eventsState.unseenOnly });
    state.unseen = unseenTotal(data.unseen);
    return eventsSection(data);
  }

  if (state.tab === 'coverage') {
    const { regions } = await api.coverageRegions();
    if (!coverageState.region && regions[0]) coverageState.region = regions[0].code;
    if (!regions.length) return coverageSection([], null, null);
    const [data, streets] = await Promise.all([
      api.coveragePlaces(coverageState.region),
      coverageState.place ? api.coverageStreets(coverageState.region, coverageState.place).then((r) => r.streets) : null,
    ]);
    return coverageSection(regions, data, streets);
  }

  if (state.tab === 'audit') {
    return auditSection(await api.audit({
      page: state.auditPage,
      from: state.auditFrom,
      to: state.auditTo,
      action: state.auditAction,
    }));
  }

  if (state.tab === 'houses') {
    if (state.openHouse && state.openRequest) {
      return requestSection(await api.houseRequest(state.openHouse, state.openRequest));
    }
    if (state.openHouse) return houseCardSection(await api.house(state.openHouse));
    return housesSection(state.houses, state.houseQuery);
  }

  if (state.tab === 'claims') return claimsSection(await api.claims());

  if (state.tab === 'demo') return demoSection(await api.demo());

  if (state.tab === 'users') {
    if (state.openUser) return userCardSection(await api.user(state.openUser));
    return usersSection(state.users, state.userQuery);
  }

  if (state.tab === 'orgs') return orgsSection(state.orgs, state.orgQuery);

  if (state.tab === 'tables') {
    const list = await api.tables();
    const page = state.tableName
      ? await api.table(state.tableName, state.tablePage, state.tableQuery)
      : null;
    return tablesSection(list, page);
  }

  return emptyState('Раздел в работе', 'Скоро здесь появится содержимое');
}

async function render() {
  if (!state.me) {
    main().innerHTML = renderLogin(null);
    setSignedIn(null);
    return;
  }

  setSignedIn(state.me.name);

  main().innerHTML = tabsBar() + loadingState('Загружаем…');
  try {
    const body = await renderTab();
    // Вкладки рисуются после раздела: счётчик новых событий знает только он
    main().innerHTML = tabsBar() + sectionHead() + body;
    if (state.tab === 'coverage') {
      bindCoverageSearch();
      await mountCoverage({
        api,
        render,
        openHouse: (key) => { state.tab = 'houses'; state.openHouse = key; render(); },
      });
    }
  } catch (error) {
    main().innerHTML = tabsBar() + errorState(error, 'admin');
  }
}

/* ─────────────── демо-дом ─────────────── */

/**
 * Демо-дом для экспертов.
 * Включить на экране входа, завести заново, освободить роль. Пароль
 * кабинета демо-УК показывается один раз — после сброса.
 */
function demoSection(data) {
  const fresh = state.demoCreds;
  return html`
    ${fresh ? html`
      <div class="dsp-card">
        <h2>Кабинет демо-УК</h2>
        <dl class="dsp-kv">
          <dt>Логин</dt><dd><code>${esc(fresh.ukLogin)}</code></dd>
          <dt>Пароль</dt><dd><code>${esc(fresh.ukPassword)}</code></dd>
        </dl>
        <p class="dsp-dim">Пароль показан один раз — запишите его на служебный слайд.</p>
      </div>` : ''}

    <div class="dsp-card">
      <h2>На экране входа</h2>
      <p class="dsp-dim">
        ${data.enabled
          ? 'Показан: каждый, кто открыл приложение без квитанции, видит роли демо-дома.'
          : 'Скрыт: экран входа как обычно, дом и данные на месте.'}
      </p>
      <div class="dsp-actions">
        ${data.seeded ? html`
          <button class="dsp-act ${data.enabled ? '' : 'primary'}" data-action="demo-toggle"
                  data-on="${data.enabled ? '0' : '1'}">${data.enabled ? 'Скрыть' : 'Показать'}</button>` : ''}
        <button class="dsp-act ${data.seeded ? '' : 'primary'}" data-action="demo-reset">
          ${data.seeded ? 'Сбросить демо-дом' : 'Завести демо-дом'}
        </button>
      </div>
      <p class="dsp-dim">Сброс заводит дом заново: заявки, лента и деньги — как в начале, держатели ролей отвязаны.</p>
    </div>

    ${data.seeded ? html`
      <div class="dsp-card">
        <h2>Роли</h2>
        <div class="ha-list">
          ${data.roles.map((r) => html`
            <div class="ha-row">
              <div>
                <div class="ha-t">${esc(r.title)}</div>
                <div class="ha-d">${esc(r.subtitle)}</div>
              </div>
              <div class="ha-state">${r.holderName
                ? html`<span class="pill new">${esc(r.holderName)} · с ${esc(formatDate(r.heldSince))}</span>`
                : '<span class="dsp-dim">свободна</span>'}</div>
              ${r.holderName
                ? html`<button class="dsp-act" data-action="demo-release" data-key="${esc(r.key)}">Освободить</button>`
                : '<span></span>'}
            </div>`).join('')}
        </div>
      </div>` : ''}`;
}

/* ─────────────── действия ─────────────── */

async function handleAction(action, target) {
  // Календарь общий на весь проект: сам рисует шторку и пишет значение в поле
  if (await handleDateAction(action, target)) return;
  if (await handleEventsAction(action, target, { api, render })) return;
  if (await handleCoverageAction(action, target, { render })) return;

  switch (action) {
    case 'do-login': {
      const login = document.querySelector('#admLogin')?.value.trim() ?? '';
      const password = document.querySelector('#admPass')?.value ?? '';
      if (!login || !password) {
        main().innerHTML = renderLogin('Введите логин и пароль');
        return;
      }
      await withLoading(target, async () => {
        try {
          await api.login(login, password);
          state.me = await api.me();
          await render();
        } catch (error) {
          main().innerHTML = renderLogin(error.message);
        }
      });
      break;
    }

    case 'logout': {
      await api.logout().catch(() => {});
      tokenStore.set(null);
      state.me = null;
      await render();
      break;
    }

    case 'tab': {
      state.tab = target.dataset.tab;
      state.openHouse = null;
      state.openRequest = null;
      state.freshCabinet = null;
      await render();
      break;
    }

    case 'find-houses': {
      const q = document.querySelector('#admHouseQ')?.value.trim() ?? '';
      if (q.length < 2) { toast('Введите хотя бы две буквы'); return; }
      await withLoading(target, async () => {
        try {
          state.houseQuery = q;
          state.houses = await api.houses(q);
          state.openHouse = null;
          await render();
        } catch (error) {
          toast(error.message);
        }
      });
      break;
    }

    case 'open-house': {
      state.tab = 'houses';
      state.openHouse = target.dataset.key;
      state.openRequest = null;
      await render();
      break;
    }

    case 'open-request': {
      state.openRequest = target.dataset.id;
      await render();
      window.scrollTo({ top: 0 });
      break;
    }

    case 'back-house': {
      state.openRequest = null;
      await render();
      break;
    }

    case 'back-houses': {
      state.openHouse = null;
      state.openRequest = null;
      await render();
      break;
    }

    /**
     * Ошибки здесь и ниже показываются, а не теряются: без try/catch
     * отказ сервера исчезал молча, а список продолжал показывать форму,
     * которая не сохранилась. Перерисовка после ошибки возвращает
     * в список то, что на самом деле лежит в базе.
     */
    case 'set-form': {
      try {
        await api.setForm(target.dataset.key, target.value);
        toast('Форма управления изменена');
      } catch (error) {
        toast(error.message);
      }
      await render();
      break;
    }

    case 'hc-kind':
      pickContactKind(target);
      break;

    case 'hc-save': {
      await withLoading(target, async () => {
        try {
          await api.saveHouseContact(target.dataset.key, readContactForm());
          toast('Номер сохранён');
          await render();
        } catch (error) {
          toast(error.message);
        }
      });
      break;
    }

    case 'hc-remove': {
      if (!await confirmAction({ title: 'Удалить номер?', text: 'Жители перестанут его видеть.', confirmLabel: 'Удалить', danger: true })) return;
      try {
        await api.removeHouseContact(target.dataset.key, target.dataset.id);
        toast('Номер удалён');
        await render();
      } catch (error) {
        toast(error.message);
      }
      break;
    }

    case 'connect-org': {
      const inn = document.querySelector('#admOrgInn')?.value.trim() ?? '';
      if (!inn) { toast('Введите ИНН организации'); return; }
      await withLoading(target, async () => {
        try {
          const form = document.querySelector('#admOrgForm')?.value ?? 'uk';
          const res = await api.connectOrg(target.dataset.key, inn, form);
          toast(`Организация подключена, домов: ${res.houses}`);
          await render();
        } catch (error) {
          toast(error.message);
        }
      });
      break;
    }

    case 'make-chairman': {
      await withLoading(target, async () => {
        try {
          const res = await api.makeChairman(target.dataset.key, target.dataset.id);
          toast(`Председатель назначен: ${res.name}`);
          await render();
        } catch (error) {
          toast(error.message);
        }
      });
      break;
    }

    /**
     * Скрыть отзыв о доме. Удаления нет: причину увидит автор,
     * действие ляжет в журнал.
     */
    case 'hide-review': {
      const reason = await askText({
        title: 'Почему скрываете отзыв?', text: 'Причину увидит автор.',
        confirmLabel: 'Скрыть', danger: true,
      });
      if (!reason) return;
      try {
        await api.hideReview(target.dataset.id, reason.trim());
        toast('Отзыв скрыт');
        await render();
      } catch (error) {
        toast(error.message);
      }
      break;
    }

    case 'demo-toggle': {
      try {
        await api.demoSet(target.dataset.on === '1');
        toast(target.dataset.on === '1' ? 'Демо-дом показан на экране входа' : 'Демо-дом скрыт');
        await render();
      } catch (error) { toast(error.message); }
      return;
    }

    case 'demo-reset': {
      if (!await confirmAction({
        title: 'Завести демо-дом заново?',
        text: 'Всё, что эксперты успели сделать, сотрётся, держатели ролей отвяжутся. Пароль кабинета демо-УК сменится.',
        confirmLabel: 'Сбросить', danger: true,
      })) return;
      await withLoading(target, async () => {
        try {
          state.demoCreds = await api.demoReset();
          toast('Демо-дом заведён заново');
          await render();
        } catch (error) { toast(error.message); }
      });
      return;
    }

    case 'demo-release': {
      if (!await confirmAction({
        title: 'Освободить роль?',
        text: 'Эксперт, который её держит, при следующем открытии увидит «Вашу роль передали».',
        confirmLabel: 'Освободить',
      })) return;
      try {
        await api.demoRelease(target.dataset.key);
        await render();
      } catch (error) { toast(error.message); }
      return;
    }

    case 'revoke-chairman': {
      if (!await confirmAction({ title: 'Снять председателя?', text: 'Подтверждать жителей станет некому.', confirmLabel: 'Снять', danger: true })) return;
      try {
        await api.revokeChairman(target.dataset.id);
        toast('Председатель снят');
        await render();
      } catch (error) {
        toast(error.message);
      }
      break;
    }

    /**
     * Отказ — с причиной: житель прочитает её в уведомлении. Без неё
     * он получал «Причина не указана» и подавал заявку снова.
     */
    case 'decide-claim': {
      const status = target.dataset.status;
      let reason;
      if (status === 'rejected') {
        reason = await askText({
          title: 'Почему отказ?', text: 'Житель прочитает это в уведомлении.',
          confirmLabel: 'Отказать', danger: true,
        });
        if (!reason) return;
      }
      try {
        await api.decideClaim(target.dataset.id, status, reason?.trim());
        toast(status === 'done' ? 'Заявка решена' : 'Заявка отклонена');
        await render();
      } catch (error) {
        toast(error.message);
      }
      break;
    }

    case 'find-users': {
      const q = document.querySelector('#admUserQ')?.value.trim() ?? '';
      if (q.length < 2) { toast('Введите хотя бы две буквы'); return; }
      await withLoading(target, async () => {
        try {
          state.userQuery = q;
          state.users = await api.users(q);
          state.openUser = null;
          await render();
        } catch (error) {
          toast(error.message);
        }
      });
      break;
    }

    case 'open-user': {
      state.tab = 'users';
      state.openUser = target.dataset.id;
      await render();
      break;
    }

    case 'back-users': {
      state.openUser = null;
      await render();
      break;
    }

    case 'revoke-binding': {
      /**
       * Причина обязательна: житель увидит её у себя на экране,
       * а «доступ закрыт, причина не указана» — то же молчание,
       * от которого продукт уходит.
       */
      const owner = target.dataset.owner === 'true';
      const warning = owner
        ? 'Это собственник: квартира останется без владельца, и приглашать домочадцев станет некому.'
        : '';
      const reason = await askText({
        title: 'Закрыть доступ?', text: warning, placeholder: 'Причина закрытия доступа',
        confirmLabel: 'Закрыть доступ', danger: true,
      });
      if (!reason) return;

      try {
        const res = await api.revokeBinding(target.dataset.id, reason);
        toast(res.wasOwner ? 'Доступ закрыт. Квартира без владельца' : 'Доступ закрыт');
        await render();
      } catch (error) {
        toast(error.message);
      }
      break;
    }

    case 'find-orgs': {
      const q = document.querySelector('#admOrgQ')?.value.trim() ?? '';
      if (q.length < 2) { toast('Введите хотя бы две буквы'); return; }
      await withLoading(target, async () => {
        try {
          state.orgQuery = q;
          state.orgs = await api.orgs(q);
          await render();
        } catch (error) {
          toast(error.message);
        }
      });
      break;
    }

    case 'org-dispatcher': {
      const existing = target.dataset.login;
      const login = existing || await askText({
        title: 'Логин для кабинета управляющей компании',
        placeholder: 'Например: uk-trianon', confirmLabel: 'Завести кабинет',
      });
      if (!login) return;
      if (existing && !await confirmAction({ title: `Сбросить пароль кабинета ${existing}?`, text: 'Старый пароль перестанет работать сразу.', confirmLabel: 'Сбросить' })) return;

      try {
        const res = await api.orgDispatcher(target.dataset.id, existing ? '' : login);
        state.freshCabinet = { login: res.login, password: res.password, orgName: target.dataset.name ?? '' };
        await render();
        window.scrollTo({ top: 0 });
      } catch (error) {
        toast(error.message);
      }
      break;
    }

    case 'copy-cabinet': {
      const c = state.freshCabinet;
      if (!c) return;
      try {
        await navigator.clipboard.writeText(
          `Кабинет УК: ${location.origin}/dispatcher/\nЛогин: ${c.login}\nПароль: ${c.password}`,
        );
        toast('Скопировано');
      } catch {
        toast('Браузер не дал скопировать — выделите логин и пароль вручную');
      }
      break;
    }

    case 'hide-cabinet':
      state.freshCabinet = null;
      await render();
      break;

    case 'open-table': {
      state.tableName = target.dataset.name;
      state.tablePage = 1;
      state.tableQuery = '';
      await render();
      break;
    }

    case 'search-table': {
      state.tableQuery = document.querySelector('#admTableQ')?.value.trim() ?? '';
      state.tablePage = 1;
      await render();
      break;
    }

    case 'table-page': {
      state.tablePage = Math.max(1, Number(target.dataset.page) || 1);
      await render();
      break;
    }

    case 'audit-page': {
      state.auditPage = Math.max(1, Number(target.dataset.page) || 1);
      await render();
      break;
    }

    case 'audit-action':
      // Выбор в списке ничего не грузит сам: грузит кнопка «Показать»
      return;

    case 'audit-filter': {
      state.auditFrom = document.querySelector('#admAuditFrom')?.value ?? '';
      state.auditTo = document.querySelector('#admAuditTo')?.value ?? '';
      state.auditAction = document.querySelector('#admAuditAction')?.value ?? '';
      // Период сменился — прежний номер страницы к нему отношения не имеет
      state.auditPage = 1;
      await render();
      break;
    }

    case 'audit-reset': {
      state.auditFrom = '';
      state.auditTo = '';
      state.auditAction = '';
      state.auditPage = 1;
      await render();
      break;
    }

    case 'retry': {
      await render();
      break;
    }

    default:
      toast('Действие не поддерживается');
  }
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  handleAction(target.dataset.action, target);
});

/**
 * Выпадающие списки шлют `change`, а не `click`. Без этого слушателя
 * смена формы управления не срабатывала бы вовсе — та же грабля уже
 * описана в кабинете УК.
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
  if (button && document.querySelector('#admPass')) handleAction('do-login', button);
});

async function boot() {
  if (tokenStore.get()) {
    state.me = await api.me().catch(() => null);
  }
  await render();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
