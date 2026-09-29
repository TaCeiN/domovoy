import { api } from '../api.js';
import { platform } from '../platform.js';
import { avatarSrc,
  esc, html, money, formatDate, errorState, emptyState, toast, withLoading, plural,
} from '../ui.js';
import { readTheme, applyTheme } from '../theme.js';
import { activePropertyStore } from '../config.js';
import { shortAddress, propertyTitle, waitingText, waitingHint } from './home.js';
import { telHref } from './requests.js';
import { wipNote } from '../wip.js';

/**
 * Профиль, адреса, доступ к адресу, оплата и аварийные службы.
 *
 * Экран профиля — единственное место, где человек видит, что приложение
 * про него знает и кто ещё видит его начисления. Поэтому список жильцов
 * адреса и кнопка отзыва доступа живут здесь, а не спрятаны в настройках.
 */

/* ─────────────── профиль ─────────────── */

export function renderProfile(state) {
  const { me } = state;
  const user = me?.user;
  const theme = readTheme();

  return html`
    <div class="profile-head">
      <!-- Инициалы под картинкой: не загрузилось фото из MAX — видны они -->
      <div class="profile-avatar">
        ${esc(initials(user?.name))}
        ${avatarSrc(user?.avatar) ? html`<img src="${esc(avatarSrc(user.avatar))}" alt="" onerror="this.remove()">` : ''}
      </div>
      <div class="profile-name">${esc(user?.name ?? 'Житель')}</div>
      <div class="profile-sub">
        ${state.currentProperty
          // Активная собственность, а не первая в списке: под именем должно
          // стоять то же, что стоит в шапке главной
          ? esc(propertyTitle(state.currentProperty))
          : 'Адрес не привязан'}
      </div>
    </div>

    <div class="field-label">Оформление</div>
    <div class="segmented" id="themeSeg">
      ${[['system', 'Как в MAX'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([v, label]) => html`
        <button class="${theme === v ? 'on' : ''}" data-action="set-theme" data-v="${v}">
          ${esc(label)}
        </button>`).join('')}
    </div>

    <div class="field-label">Моя недвижимость</div>
    <div class="list">
      ${me.properties.map((p) => html`
        <button class="row tappable" data-action="properties">
          <span class="sq"><svg viewBox="0 0 20 20" fill="none"><path d="M3 8.5L10 3L17 8.5V16.5H3V8.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></span>
          <div class="content">
            <div class="t">${esc(propertyTitle(p))}</div>
            <div class="d">${esc(accountsLine(p))}</div>
          </div>
          ${statusPill(p)}
        </button>`).join('')}
    </div>
    <button class="btn-primary secondary" data-action="properties">Вся недвижимость</button>

    <div class="field-label">Доступ и данные</div>
    <div class="list">
      ${row('tutorial', 'Как пользоваться приложением', 'Короткое обучение — одна минута')}
      ${state.chairman?.isChairman
        ? row('council', 'Совет дома',
            esc(state.chairman.houses[0]?.houseLabel ?? 'Подтверждение жильцов, объявления, опросы'))
        : ''}
      ${row('access', 'Кто видит мой адрес', 'Домочадцы и запросы доступа')}
      ${row('notify-settings', 'Уведомления', notificationsHint())}
      ${row('privacy', 'Персональные данные', 'Что мы храним и как это удалить')}
    </div>

    <div class="profile-sub" style="margin-top:20px;text-align:center">
      ${user?.viaMax ? 'Вход через MAX' : 'Вход по QR квитанции'}
      ${user?.phoneVerified ? ' · телефон подтверждён' : ''}
    </div>

    <button class="link-btn" data-action="logout">Выйти</button>`;
}

function row(action, title, hint) {
  return html`
    <button class="row tappable" data-action="${esc(action)}">
      <div class="content">
        <div class="t">${esc(title)}</div>
        <div class="d">${esc(hint)}</div>
      </div>
      <span class="chev"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    </button>`;
}

/**
 * Отдать приглашение человеку.
 *
 * Кладём в буфер и код, и ссылку: ссылка открывает мини-приложение сразу
 * и работает у тех, кто в MAX, а код можно продиктовать голосом — для
 * пожилого человека это часто единственный рабочий путь.
 */
async function shareInvite(state, code) {
  if (!code) return;

  const bot = state.config?.botUsername;
  const link = bot ? `https://max.ru/${bot}?startapp=${code}` : null;
  const text = link
    ? `Код для входа в приложение дома: ${code}
${link}`
    : `Код для входа в приложение дома: ${code}`;

  try {
    await navigator.clipboard.writeText(text);
    toast('Код и ссылка скопированы');
  } catch {
    // Буфер закрыт политикой браузера — код всё равно виден на экране
    toast(`Код: ${code}`);
  }
}

function notificationsHint() {
  // Вкладка ведёт в НАСТРОЙКИ доставки, а не в список событий: список
  // открывается колокольчиком на главной, и дублировать его незачем
  return platform.inMax
    ? 'Что присылать сообщением от бота'
    : 'Что присылать ботом — сработает, когда откроете приложение в MAX';
}

function initials(name) {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const [surname, first] = parts;
  return ((first?.[0] ?? '') + (surname?.[0] ?? '')).toUpperCase() || '?';
}

/* ─────────────── адреса ─────────────── */

/**
 * Строка «метка — значение» в списке.
 *
 * Функция вызывалась на экране начислений, но не существовала: экран падал
 * с «infoRow is not defined» и показывал «Не удалось загрузить» вместо
 * реквизитов. Ошибка была не видна в тестах, потому что верстку они
 * не исполняют.
 */
function infoRow(label, value) {
  if (value === null || value === undefined || value === '') return '';
  return html`
    <div class="row">
      <div class="content">
        <div class="d">${esc(label)}</div>
        <div class="t" style="margin-top:2px">${esc(value)}</div>
      </div>
    </div>`;
}

/** Человеческие названия услуг: коды наружу не показываем. */
const SERVICE_LABEL = {
  housing: 'ЖКУ',
  electricity: 'Электроэнергия',
  gas: 'Газ',
  water: 'Вода',
  heat: 'Отопление',
  waste: 'Вывоз мусора',
  overhaul: 'Капремонт',
  other: 'Прочее',
};

/**
 * Подпись под адресом.
 *
 * У квартиры несколько лицевых счетов, и раньше каждый был отдельным
 * «адресом» в списке: одна квартира выглядела как четыре. Теперь адрес
 * один, а под ним перечислены услуги.
 */
function accountsLine(p) {
  const accounts = p.accounts ?? [];
  if (accounts.length === 0) return p.ukName ?? '';

  const names = accounts.map((a) => SERVICE_LABEL[a.service] ?? 'Прочее');
  return names.length <= 3
    ? names.join(' · ')
    : `${names.slice(0, 2).join(' · ')} и ещё ${names.length - 2}`;
}

/**
 * Пометка статуса. Ожидающий объект называется своим словом: он уже
 * в списке, и без пометки человек решит, что доступ уже открыт.
 */
function statusPill(p) {
  if (p.status === 'pending') return '<span class="pill new">ожидает</span>';
  return html`<span class="pill ${p.role === 'owner' ? 'ok' : ''}">
    ${p.role === 'owner' ? 'собственник' : 'жилец'}
  </span>`;
}

export function renderProperties(state) {
  const { me } = state;
  const currentId = state.currentProperty?.propertyId;

  /**
   * Ожидающие объекты стоят в общем списке, поэтому отдельным блоком
   * показываем только ОТКЛОНЁННЫЕ заявки: они из `properties` уходят,
   * а причина отказа человеку нужна — иначе непонятно, что делать.
   */
  const rejected = (me.myPendingAccess ?? []).filter((p) => p.status === 'revoked');

  return html`
    <div class="list">
      ${me.properties.map((p) => html`
        <button class="row tappable" data-action="pick-property" data-id="${esc(p.propertyId)}">
            <span class="sq ${p.propertyId === currentId ? 'new' : ''}">
              ${p.propertyId === currentId
                ? '<svg viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5L8.2 14.2L15.5 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'
                : '<svg viewBox="0 0 20 20" fill="none"><path d="M3 8.5L10 3L17 8.5V16.5H3V8.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>'}
            </span>
            <div class="content">
              <div class="t">${esc(propertyTitle(p))}</div>
              <div class="d">
                ${esc(accountsLine(p))}
                <!-- То же число, что на главной: две суммы про одну
                     квартиру человек не простит, и правой сочтёт бóльшую -->
                ${p.bill?.hasBills
                  ? ` · ${esc(money(p.bill.outstandingKopecks))}`
                  : ''}
              </div>
              ${p.status === 'pending' ? html`
                <div class="d" style="color:var(--amber-deep)">
                  ${esc(waitingHint(p))}
                </div>` : ''}
              ${p.addressSource === 'resident' ? `
                <div class="d" style="color:var(--amber-deep)">
                  Адрес указали вы — управляющая компания ещё не сверила его
                  с лицевым счётом
                </div>` : ''}
            </div>
          ${statusPill(p)}
        </button>`).join('')}
    </div>

    ${rejected.length ? html`
      <div class="field-label">Отклонённые заявки</div>
      <div class="list">
        ${rejected.map((p) => html`
          <div class="row">
            <div class="content">
              <div class="t">Заявка отклонена</div>
              <div class="d">${esc(p.rejectReason ?? 'Причина не указана')}</div>
            </div>
            <span class="pill">отказ</span>
          </div>`).join('')}
      </div>` : ''}

    ${state.currentProperty ? html`
      <button class="btn-primary" data-action="add-receipt-active">
        Добавить квитанцию
      </button>
      <div class="dt-p" style="color:var(--tx-2);font-size:13px">
        Квитанция добавится к выбранной квартире — ${esc(propertyTitle(state.currentProperty))}.
        Свет, газ и вывоз мусора приходят отдельными квитанциями, адрес
        спрашивать не будем.
      </div>` : ''}

    <button class="btn-primary secondary" data-action="add-property">
      Добавить недвижимость
    </button>

    <div class="dt-p" style="color:var(--tx-2);font-size:13px">
      «Добавить недвижимость» — это новый адрес, для него понадобится
      квитанция по нему.
    </div>`;
}


/* ─────────────── настройки уведомлений ─────────────── */

/**
 * Что присылать ботом.
 *
 * Вкладка в профиле не дублирует колокольчик на главной: там события,
 * здесь — доставка. Сверху три готовых набора карточками (раньше —
 * четыре кнопки в одну строку, «Только важное» переносилось, а «Свой»
 * уезжал за край экрана), под ними переключатели по видам. Тронул
 * переключатель — набор сам становится «своим», и карточка «Свой набор»
 * появляется только тогда: выбирать её руками нечего.
 */
const NOTIFY_PRESETS = [
  {
    mode: 'all', title: 'Всё', grad: 'blue',
    text: 'Обращения, аварии, начисления и напоминания',
    icon: '<path d="M6 10a6 6 0 1 1 12 0c0 4.5 2 6 2 6H4s2-1.5 2-6Z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M10 19.5a2 2 0 0 0 4 0" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  },
  {
    mode: 'important', title: 'Только важное', grad: 'orange',
    text: 'Мои обращения, доступ к квартире, аварии в доме',
    icon: '<path d="M12 4 21 19.5H3L12 4Z" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="M12 10v4" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="12" cy="16.8" r="1.1" fill="currentColor"/>',
  },
  {
    mode: 'off', title: 'Не присылать', grad: 'grey',
    text: 'Бот молчит, всё остаётся в колокольчике на главной',
    icon: '<path d="M8.5 5.2A6 6 0 0 1 18 10c0 2.4.6 4 1.1 4.9M16 16H4s2-1.5 2-6c0-.7.1-1.3.3-1.9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M10 19.5a2 2 0 0 0 4 0M4 4l16 16" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/>',
  },
  {
    mode: 'custom', title: 'Свой набор', grad: 'purple',
    text: '',
    icon: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/><circle cx="15" cy="7" r="2.2" stroke="currentColor" stroke-width="1.9"/><circle cx="9" cy="17" r="2.2" stroke="currentColor" stroke-width="1.9"/>',
  },
];

function customText(kinds) {
  const on = Object.values(kinds).filter(Boolean).length;
  return `Включено ${on} из ${Object.keys(kinds).length} — ниже`;
}

export async function renderNotifySettings() {
  let data;
  try {
    data = await api.notifySettings();
  } catch (error) {
    return errorState(error, 'reload');
  }

  return html`
    <div class="field-label" style="margin-top:0">Что присылать ботом</div>
    <div class="list notify-presets" id="notifyPresets">
      ${NOTIFY_PRESETS.map((p) => html`
        <button class="row tappable notify-preset${data.mode === p.mode ? ' on' : ''}"
                data-action="notify-mode" data-v="${esc(p.mode)}"
                ${p.mode === 'custom' && data.mode !== 'custom' ? 'hidden' : ''}>
          <span class="np-ic np-${p.grad}"><svg width="22" height="22" viewBox="0 0 24 24" fill="none">${p.icon}</svg></span>
          <div class="content">
            <div class="t">${esc(p.title)}</div>
            <div class="d">${esc(p.mode === 'custom' ? customText(data.kinds) : p.text)}</div>
          </div>
          <span class="np-radio"></span>
        </button>`).join('')}
    </div>

    <div class="notify-note">
      ${platform.inMax
        ? 'Сообщения приходят от бота в MAX, даже когда приложение закрыто.'
        : 'В браузере сообщения не приходят — бот пишет только в MAX. Настройка сохранится и заработает там.'}
    </div>

    <div class="field-label">Подробно</div>
    <div class="list" id="notifyKinds">
      ${data.available.map((k) => html`
        <button class="row tappable" data-action="notify-kind" data-k="${esc(k.kind)}"
                data-on="${data.kinds[k.kind] ? '1' : '0'}" aria-pressed="${data.kinds[k.kind] ? 'true' : 'false'}">
          <div class="content">
            <div class="t">${esc(k.label)}</div>
            <div class="d">${esc(k.hint)}</div>
          </div>
          <span class="toggle${data.kinds[k.kind] ? ' on' : ''}"><span class="knob"></span></span>
        </button>`).join('')}
    </div>

    <div class="dt-p" style="color:var(--tx-2);font-size:13px">
      Выключенное уведомление всё равно появится в колокольчике на главной —
      молчит только бот.
    </div>`;
}

/**
 * Показать сохранённые настройки на месте, без перерисовки экрана:
 * переключатели переезжают с анимацией, а не подменяются мгновенно.
 */
function applyNotify(saved) {
  document.querySelectorAll('#notifyPresets .notify-preset').forEach((card) => {
    const mode = card.dataset.v;
    card.classList.toggle('on', mode === saved.mode);
    if (mode === 'custom') {
      card.hidden = saved.mode !== 'custom';
      card.querySelector('.d').textContent = customText(saved.kinds);
    }
  });
  document.querySelectorAll('#notifyKinds [data-k]').forEach((row) => {
    const on = !!saved.kinds[row.dataset.k];
    row.dataset.on = on ? '1' : '0';
    row.setAttribute('aria-pressed', String(on));
    row.querySelector('.toggle').classList.toggle('on', on);
  });
}

/* ─────────────── доступ к адресу ─────────────── */

export async function renderAccess(state) {
  const property = state.currentProperty;
  if (!property) return emptyState('Адрес не привязан', 'Отсканируйте квитанцию');

  /**
   * Состав жильцов — данные ДРУГИХ людей, это уровень 1. Пока доступ
   * не подтверждён, показывать нечего, и сказать об этом надо словами.
   */
  if (property.status === 'pending') {
    return html`
      <div class="dt-card" style="margin-top:0">
        <div class="meter-name">Раздел откроется после подтверждения</div>
        <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
          ${waitingText(property)}
        </div>
      </div>`;
  }

  let data;
  try {
    data = await api.household(property.propertyId);
  } catch (error) {
    return errorState(error, 'access');
  }

  // Запросы доступа приходят на все объекты сразу — на этом экране
  // показываем только те, что относятся к открытому адресу
  const pending = (state.me.pendingRequests ?? [])
    .filter((p) => p.propertyId === property.propertyId);

  /**
   * Приглашения показываем только собственнику: звать жильцов может он,
   * и список кодов — его инструмент, а не общая информация о квартире.
   */
  const canInvite = property.role === 'owner' && property.status === 'active';
  const invites = canInvite
    ? await api.invites(property.propertyId).then((r) => r.invites).catch(() => [])
    : [];

  return html`
    <div class="dt-meta" style="margin-top:0">${esc(shortAddress(property))}</div>

    ${canInvite ? html`
      <div class="field-label">Пригласить жильца</div>
      <div class="dt-p" style="font-size:13px;color:var(--tx-2);margin-top:0">
        Квитанция на квартиру одна, и сканировать её домочадцу незачем.
        Пришлите код — человек войдёт по нему и сразу получит доступ
        к квартире. Код действует двое суток и срабатывает один раз.
      </div>

      ${invites.length ? html`
        <div class="list">
          ${invites.map((i) => html`
            <div class="row">
              <div class="content">
                <div class="t" style="letter-spacing:.18em;font-size:19px">${esc(i.code)}</div>
                <div class="d">Действует до ${esc(formatDate(i.expiresAt))}</div>
                <!-- Кнопки строкой под кодом: в строке с ним срок сжимался
                     в колонку, а «Скопировать» на деле отправляла (аудит 26.09) -->
                <div class="chips" style="margin-top:10px">
                  <span class="chip sel" data-action="copy-invite" data-code="${esc(i.code)}">
                    ${platform.inMax ? 'Отправить в MAX' : 'Отправить'}
                  </span>
                  <span class="chip" data-action="revoke-invite" data-id="${esc(i.id)}">Отозвать</span>
                </div>
              </div>
            </div>`).join('')}
        </div>` : ''}

      <button class="btn-primary secondary" data-action="create-invite">
        ${invites.length ? 'Ещё одно приглашение' : 'Пригласить жильца'}
      </button>` : ''}

    ${pending.length ? html`
      <div class="field-label">Просят доступ</div>
      <div class="list">
        ${pending.map((p) => html`
          <div class="row">
            <span class="sq new"><svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7.5" r="3.2" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 17C4.5 13.8 7 12.4 10 12.4C13 12.4 15.5 13.8 15.5 17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></span>
            <div class="content">
              <div class="t">${esc(p.claimedName || p.requesterName)}</div>
              <div class="d">
                ${p.claimedNote
                  ? esc(p.claimedNote)
                  : 'Отсканировал квитанцию этого адреса'}
              </div>
            </div>
            <button class="pay-quickbtn tappable" style="background:var(--accent);color:#fff"
                    data-action="approve" data-id="${esc(p.bindingId)}">Разрешить</button>
            <button class="pay-quickbtn tappable" style="background:var(--fade);color:var(--negative)"
                    data-action="reject" data-id="${esc(p.bindingId)}">Отклонить</button>
          </div>`).join('')}
      </div>` : ''}

    <div class="field-label">Сейчас имеют доступ</div>
    <div class="list">
      ${data.members.map((m) => html`
        <div class="row">
          <span class="sq ${m.role === 'owner' ? 'ok' : ''}">
            <svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="7.5" r="3.2" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 17C4.5 13.8 7 12.4 10 12.4C13 12.4 15.5 13.8 15.5 17" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </span>
          <div class="content">
            <div class="t">${esc(m.name)}${m.isMe ? ' — это вы' : ''}</div>
            <div class="d">
              ${m.role === 'owner' ? 'Собственник' : 'Жилец'}
              ${m.status === 'invited' ? ' · ждёт подтверждения' : ''}
              ${m.since ? ` · с ${esc(formatDate(m.since))}` : ''}
            </div>
          </div>
          ${data.canManage && !m.isMe && m.role !== 'owner' ? html`
            <button class="pay-quickbtn tappable" style="background:var(--fade);color:var(--negative)"
                    data-action="revoke" data-id="${esc(m.bindingId)}">Отозвать</button>` : ''}
        </div>`).join('')}
    </div>

    <div class="dt-p" style="color:var(--tx-2);font-size:13px">
      ${data.canManage
        ? 'Отзыв доступа действует сразу: вход с его устройства перестанет работать.'
        : ''}
    </div>`;
}

/* ─────────────── начисления ─────────────── */

/**
 * Экран начислений.
 *
 * Ключевая честность: приложение НЕ знает, прошёл ли платёж. В платёжном
 * QR такой информации нет, доступа к биллингу УК и к ГИС ЖКХ у нас тоже
 * нет. Поэтому статус подписан «отмечено вами», а расчётная сумма нигде
 * не названа задолженностью перед управляющей компанией.
 */
export async function renderPayment(state) {
  const property = state.currentProperty;
  if (!property) return emptyState('Адрес не привязан', 'Отсканируйте квитанцию');

  let data;
  try {
    data = await api.bills(property.propertyId);
  } catch (error) {
    return errorState(error, 'payment');
  }

  const nothingOwed = data.outstandingKopecks === 0;
  const unpaid = data.bills.filter((b) => b.status !== 'paid');
  const countToShow = Math.max(3, unpaid.length);
  const previewLimit = Math.min(5, countToShow);
  const recentBills = data.bills.slice(0, previewLimit);
  const hasMoreBills = data.bills.length > recentBills.length;

  return html`
    <div class="dt-card">
      <div class="pay-label">
        ${nothingOwed
          // Приложение долгов не знает — только отметки человека
          ? (data.bills.length ? 'По вашим отметкам всё оплачено' : 'Квитанций пока нет')
          : 'Не отмечено оплаченным'}
      </div>
      <div class="pay-amt" style="${data.overdueCount ? 'color:var(--negative)' : ''}">
        ${esc(data.outstanding)}
      </div>
      <div class="pay-card-bottom">
        <span class="pay-due">
          ${data.overdueCount
            ? `${data.overdueCount} ${plural(data.overdueCount, 'период', 'периода', 'периодов')} с истёкшим сроком`
            : `по всем счетам квартиры: ${esc((property.accounts ?? []).length)}`}
        </span>
      </div>
    </div>

    <div style="font-size:12px;color:var(--tx-3);line-height:1.35;margin-top:8px;padding:0 2px">
      ${esc(data.disclaimer)}
    </div>

    <div class="field-label">${data.outstandingKopecks > 0 ? 'Квитанции к оплате' : 'История начислений'}</div>
    ${data.bills.length === 0
      ? emptyState('Начислений нет', 'Отсканируйте квитанцию — она попадёт в историю')
      : html`
        <div class="list">${recentBills.map(billRow).join('')}</div>
        ${hasMoreBills ? html`
          <button class="btn-primary secondary" style="margin-top:10px" data-action="payment-history">
            Вся история начислений (${data.bills.length}) →
          </button>` : ''}`}

    <div class="field-label" id="payAccounts" style="display:flex;justify-content:space-between;align-items:center">
      <span>Лицевые счета этой квартиры</span>
      <button class="tappable" style="background:none;border:none;padding:0;font-size:13px;font-weight:600;color:var(--accent);cursor:pointer" data-action="add-receipt-active">+ Добавить</button>
    </div>
    <div class="list">
      ${(property.accounts ?? []).length
        ? property.accounts.map((a) => html`
            <div class="row">
              <div class="content">
                <div class="t">${esc(SERVICE_LABEL[a.service] ?? 'Прочее')}</div>
                <div class="d">${esc(a.provider ?? '')} · счёт ${esc(a.persAcc)}</div>
              </div>
            </div>`).join('')
        : infoRow('Лицевые счета', 'нет')}
    </div>

    <div class="field-label">Об объекте</div>
    <div class="list">
      ${infoRow('Обслуживает дом', property.ukName
        ?? 'дома нет в реестре управляющих организаций')}
      ${property.ukPhone ? infoRow('Телефон УК', property.ukPhone) : ''}
      ${infoRow('Адрес', property.addressRaw)}
      ${property.addressSource === 'resident'
        ? infoRow('Источник адреса', 'указан вами, ждёт сверки с УК')
        : property.addressSource === 'uk'
          ? infoRow('Источник адреса', 'подтверждён управляющей компанией')
          : ''}
    </div>

    <div class="dt-card" style="margin-top:16px">
      <div class="meter-name">Оплатить можно по тому же QR</div>
      <div class="dt-p" style="color:var(--tx-2);font-size:14px;margin-top:8px">
        Наведите камеру банковского приложения на код с квитанции — реквизиты
        подставятся сами. Приём платежей внутри приложения требует договора
        с банком и регистрации в ГИС ЖКХ, это следующий шаг после пилота с УК.
      </div>
    </div>`;
}

export async function renderPaymentHistory(state) {
  const property = state.currentProperty;
  if (!property) return emptyState('Адрес не привязан', 'Отсканируйте квитанцию');

  let data;
  try {
    data = await api.bills(property.propertyId);
  } catch (error) {
    return errorState(error, 'payment-history');
  }

  return html`
    <div style="font-size:12px;color:var(--tx-3);line-height:1.35;margin-bottom:12px;padding:0 2px">
      ${esc(data.disclaimer)}
    </div>

    <div class="field-label">Все начисления (${data.bills.length})</div>
    ${data.bills.length === 0
      ? emptyState('Начислений нет', 'Отсканируйте квитанцию — она попадёт в историю')
      : html`<div class="list">${data.bills.map(billRow).join('')}</div>`}

    <div class="dt-card" style="margin-top:16px">
      <div class="meter-name">Оплатить можно по тому же QR</div>
      <div class="dt-p" style="color:var(--tx-2);font-size:14px;margin-top:8px">
        Наведите камеру банковского приложения на код с квитанции — реквизиты
        подставятся сами. Приём платежей внутри приложения требует договора
        с банком и регистрации в ГИС ЖКХ, это следующий шаг после пилота с УК.
      </div>
    </div>`;
}

function billRow(b) {
  const tone = b.status === 'paid' ? 'ok' : b.status === 'overdue' ? 'bad' : '';
  const paid = b.status === 'paid';

  return html`
    <div class="row">
      <span class="sq ${tone}">
        ${paid
          ? '<svg viewBox="0 0 20 20" fill="none"><path d="M4.5 10.5L8.2 14.2L15.5 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          : '<svg viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="7.2" stroke="currentColor" stroke-width="1.6"/><path d="M10 6V10.4M10 13.6V13.7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>'}
      </span>
      <div class="content">
        <div class="t">
          ${esc(b.serviceLabel ?? '')} · ${esc(b.sum)}
        </div>
        <div class="d">
          ${esc(capitaliseFirst(b.periodLabel))} · ${esc(b.statusLabel)}${paid && b.paidAt ? ` · ${esc(formatDate(b.paidAt))}` : ''}
        </div>
        <div class="d">${esc(b.provider ?? '')}</div>
      </div>
      <!--
        «Оплатить» ведёт в банк (pay.js), а отметка ставится после возврата
        вопросом «Оплата прошла?». Галочки «Оплатил» здесь больше нет —
        снять ошибочную отметку можно.
      -->
      ${paid ? html`
        <button class="pay-quickbtn tappable"
                data-action="mark-paid" data-id="${esc(b.id)}" data-paid="0">Снять</button>` : html`
        <button class="pay-quickbtn tappable" style="background:var(--accent);color:#fff"
                data-action="pay-bill" data-id="${esc(b.id)}" data-sum="${esc(b.sum)}"
                data-sum-kopecks="${esc(b.sumKopecks)}" data-provider="${esc(b.provider ?? '')}"
                data-service-label="${esc(b.serviceLabel ?? '')}" data-period-label="${esc(b.periodLabel ?? '')}"
                data-has-qr="${b.hasQr ? 'true' : 'false'}">Оплатить</button>`}
    </div>`;
}

function capitaliseFirst(value) {
  return String(value).charAt(0).toUpperCase() + String(value).slice(1);
}

/* ─────────────── аварийные службы ─────────────── */

/**
 * Аварийные службы.
 *
 * САМЫЙ ОПАСНЫЙ ЭКРАН ПРИЛОЖЕНИЯ, и до 11 сентября он не работал дважды.
 *
 * Первое: все три строки были кнопками с действием «позвонить», а обработчик
 * показывал тост «Звоним: 112» и НЕ НАБИРАЛ НОМЕР. Человек с запахом газа
 * нажимал «112», читал надпись и ждал соединения, которого не будет.
 * Теперь это `<a href="tel:">` — набор делает система, наш код в этом
 * не участвует вовсе и сломать его больше нечем.
 *
 * Второе: строка «Аварийная служба УК · +7 495 000-00-00» — выдуманный
 * номер в приложении, чьё правило «данные — только настоящие». Теперь
 * телефон берётся из реестра (`ukPhone` активной квартиры), а когда его
 * там нет — строки нет. На аварийном экране пустая строка безопаснее
 * выдуманной: по выдуманной звонят.
 *
 * 112 и 101–104 — настоящие федеральные номера, они остаются всегда.
 * С мобильного 101–104 набираются напрямую, как и 112 (с 27.09 — все пять:
 * раньше были только 112 и 104).
 */
const EMERGENCY_FEDERAL = [
  {
    type: 'sos',
    title: 'Единая служба спасения',
    hint: 'Пожар, залив, угроза жизни',
    phone: '112',
    btnLabel: '112',
  },
  {
    type: 'fire',
    title: 'Пожарная охрана',
    hint: 'Пожар, дым, задымление подъезда',
    phone: '101',
    btnLabel: '101',
  },
  {
    type: 'police',
    title: 'Полиция',
    hint: 'Кража, драка, посторонние в подъезде',
    phone: '102',
    btnLabel: '102',
  },
  {
    type: 'ambulance',
    title: 'Скорая помощь',
    hint: 'Человеку плохо, травма',
    phone: '103',
    btnLabel: '103',
  },
  {
    type: 'gas',
    title: 'Аварийная газовая служба',
    hint: 'Запах газа, утечка',
    phone: '104',
    btnLabel: '104',
  },
];

function emergencyIcon(type) {
  if (type === 'sos') {
    return html`
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M12 8v4M12 16h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>`;
  }
  if (type === 'fire') {
    return html`
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 21c-3.9 0-7-2.8-7-6.5 0-3.2 2.2-5.4 3.6-7.3.4 1.6 1.3 2.8 2.4 3.3C11 7 12.5 4.5 14.5 3c-.3 2.7.9 4.3 2.2 5.9C18 10.5 19 12.3 19 14.5 19 18.2 15.9 21 12 21z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>`;
  }
  if (type === 'police') {
    return html`
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6l7-3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M12 8.5l1.1 2.2 2.4.3-1.8 1.7.5 2.4L12 14l-2.2 1.1.5-2.4-1.8-1.7 2.4-.3L12 8.5z" fill="currentColor"/>
      </svg>`;
  }
  if (type === 'ambulance') {
    return html`
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M9.5 4h5v5.5H20v5h-5.5V20h-5v-5.5H4v-5h5.5V4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
      </svg>`;
  }
  if (type === 'gas') {
    return html`
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M12 3C12 3 7 8.5 7 13.5C7 16.5 9.2 19 12 19C14.8 19 17 16.5 17 13.5C17 8.5 12 3 12 3Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        <path d="M12 10.5C12 10.5 10.2 12.5 10.2 14C10.2 15.1 11 16 12 16C13 16 13.8 15.1 13.8 14C13.8 12.5 12 10.5 12 10.5Z" fill="currentColor"/>
      </svg>`;
  }
  return html`
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 10.5L12 3L21 10.5V20C21 20.6 20.6 21 20 21H4C3.4 21 3 20.6 3 20V10.5Z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M9 21V12H15V21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
}

function emergencyCard(e) {
  return html`
    <a class="emergency-card tappable" href="tel:${esc(telHref(e.phone))}">
      <span class="emergency-card-icon ${esc(e.type)}">
        ${emergencyIcon(e.type)}
      </span>
      <div class="emergency-card-body">
        <div class="emergency-card-title">${esc(e.title)}</div>
        <div class="emergency-card-sub">${esc(e.hint)}</div>
      </div>
      <span class="emergency-call-btn ${esc(e.type)}">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M3.6 1.8A1.8 1.8 0 0 1 6.2 1.3L7.7 3.3a1.8 1.8 0 0 1-.3 2.3l-.8.7c.6 1.3 1.7 2.4 3 3l.7-.8a1.8 1.8 0 0 1 2.3-.3l2 1.5a1.8 1.8 0 0 1 .5 2.6c-.6.8-1.5 1.3-2.5 1.4-4.8.4-8.8-3.6-8.4-8.4.1-1 .6-1.9 1.4-2.5Z"/>
        </svg>
        <span>${esc(e.btnLabel || e.phone)}</span>
      </span>
    </a>`;
}

/** Кто вписал номера — житель должен знать, что это не реестр. */
const CONTACT_SOURCE = {
  chairman: 'председатель совета дома',
  dispatcher: 'управляющая компания',
  operator: 'оператор сервиса',
};

export async function renderEmergency(state) {
  const property = state.currentProperty;

  /**
   * Телефон управляющей организации — только настоящий, из реестра.
   * Названия «Аварийная служба УК» не пишем: в реестре лежит общий
   * телефон организации, а не её аварийной службы, и обещать
   * круглосуточность мы не можем.
   */
  const org = property?.ukPhone
    ? [{
        type: 'uk',
        title: property.ukName || 'Управляющая организация',
        hint: property.ukName ? `Телефон из реестра · ${property.ukPhone}` : property.ukPhone,
        phone: property.ukPhone,
        btnLabel: 'Позвонить',
      }]
    : [];

  /**
   * Телефоны дома — их вписали председатель, УК или оператор.
   *
   * Ошибка загрузки НЕ роняет экран: 112 и 104 обязаны показаться
   * всегда, даже без связи с нашим сервером. Нет номеров — нет блока.
   */
  const houseContacts = property
    ? (await api.houseContacts(property.propertyId).catch(() => ({ contacts: [] }))).contacts
    : [];
  const house = houseContacts.map((c) => ({
    type: 'uk',
    title: c.title,
    hint: c.note ? `${c.phone} · ${c.note}` : c.phone,
    phone: c.phone,
    btnLabel: 'Позвонить',
  }));
  const sources = [...new Set(houseContacts.map((c) => CONTACT_SOURCE[c.updatedByRole]).filter(Boolean))];

  // Председатель этого дома видит на пустом месте, куда вписать номера
  const isChairmanHere = Boolean(property?.houseKey)
    && (state.chairman?.houses ?? []).some((h) => h.houseKey === property.houseKey);

  return html`
    <div class="dt-p" style="margin-top:2px">
      Если есть угроза жизни, залив соседей или запах газа — звоните,
      а заявку в приложении оформите потом.
    </div>

    <div class="emergency-cards" style="margin-top:14px">
      ${[...EMERGENCY_FEDERAL, ...org].map(emergencyCard).join('')}
    </div>

    ${org.length === 0 ? html`
      <div class="dt-p" style="font-size:13px;color:var(--tx-2);margin-top:12px">
        Телефона вашей управляющей организации у нас нет — его не оказалось
        в реестре. Он напечатан на квитанции.
      </div>` : ''}

    ${house.length ? html`
      <div class="field-label">Телефоны дома</div>
      <div class="emergency-cards">
        ${house.map(emergencyCard).join('')}
      </div>
      <div class="emergency-source">
        Номера добавил${sources.length > 1 ? 'и' : ''} ${esc(sources.join(' и '))}.
      </div>` : isChairmanHere ? html`
      <div class="list" style="margin-top:14px">
        <button class="wrow tappable" data-action="council-contacts">
          <div class="content">
            <div class="t">Добавьте телефоны дома</div>
            <div class="d">Лифтёрская служба, диспетчерская, домофон — жители увидят их здесь</div>
          </div>
          <span class="chev">
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </span>
        </button>
      </div>` : ''}

    <button class="btn-primary" data-action="complaint" style="margin-top:20px">
      Оформить аварийную заявку
    </button>`;
}

/* ─────────────── персональные данные ─────────────── */

export function renderPrivacy() {
  return html`
    <div class="dt-title">Что мы храним</div>
    <div class="dt-p">
      Из квитанции: ваше ФИО, адрес, лицевой счёт, сумму начисления и период.
      Из приложения: текст заявок, показания счётчиков и оценки работы.
      Если вход через MAX — идентификатор аккаунта и имя.
    </div>

    <div class="field-label">Кто это видит</div>
    <div class="dt-p" style="margin-top:0">
      <b>Вы и подтверждённые жильцы вашей квартиры</b> — начисления, показания
      и обращения квартиры. До подтверждения каждый видит только то, что
      принёс и написал сам.
    </div>
    <div class="dt-p">
      <b>Диспетчер управляющей компании</b> — ваши обращения и адрес: иначе
      он не пришлёт мастера.
    </div>
    <div class="dt-p">
      <b>Председатель совета дома</b> — вашу заявку на доступ (имя, квартиру
      и то, что вы о себе написали) и обращения дома.
    </div>
    <div class="dt-p">
      <b>Соседи</b> — только объявления, которые вы разместили сами, и имя
      под ними. Телефон — если вы сами решили его показать.
    </div>
    <div class="dt-p">
      <b>Оператор сервиса</b> разбирает спорные случаи; каждое его действие,
      меняющее данные, записывается в журнал.
    </div>

    <div class="field-label">Как удалить</div>
    ${wipNote('dataDelete')}
    <div class="dt-p" style="margin-top:0">
      Уже сейчас можно отозвать заявку на доступ — она удаляется вместе
      с именем, квартирой и тем, что вы о себе написали. Собственник может
      отозвать доступ жильца в «Кто видит мой адрес».
    </div>`;
}

/* ─────────────── действия ─────────────── */

export async function handleProfileAction(action, target, ctx) {
  switch (action) {
    case 'set-theme': {
      applyTheme(target.dataset.v);
      target.parentElement.querySelectorAll('button')
        .forEach((b) => b.classList.toggle('on', b === target));
      return true;
    }

    case 'pick-property': {
      const id = target.dataset.id;
      const found = ctx.state.me.properties.find((p) => p.propertyId === id);
      if (found) {
        ctx.state.currentProperty = found;
        // Выбор переживает перезапуск: иначе человек возвращается к первой
        activePropertyStore.set(ctx.state.me.user?.id, id);
        platform.haptic('light');
      }
      await ctx.reset('home');
      return true;
    }

    case 'add-receipt-active': {
      // Квитанция всегда уходит в ту квартиру, что открыта сейчас
      const current = ctx.state.currentProperty;
      if (!current) return true;
      await ctx.show('add-receipt', { id: current.propertyId });
      return true;
    }

    case 'add-property':
      await ctx.show('add-property');
      return true;

    case 'notify-mode': {
      if (target.dataset.v === 'custom' || target.classList.contains('on')) return true;
      const list = target.closest('.list');
      list.classList.add('busy');
      try {
        applyNotify(await api.saveNotifySettings({ mode: target.dataset.v }));
        platform.haptic('light');
      } catch (error) {
        toast(error.message);
      } finally {
        list.classList.remove('busy');
      }
      return true;
    }

    case 'notify-kind': {
      // Режим пересчитает сервер: он же решает, стал ли набор «своим».
      // Переключатель щёлкает сразу, не дожидаясь ответа; ошибка вернёт его
      const kind = target.dataset.k;
      const next = target.dataset.on !== '1';
      const toggle = target.querySelector('.toggle');
      toggle.classList.toggle('on', next);
      target.dataset.on = next ? '1' : '0';
      platform.haptic('light');
      try {
        applyNotify(await api.saveNotifySettings({ kinds: { [kind]: next } }));
      } catch (error) {
        toggle.classList.toggle('on', !next);
        target.dataset.on = next ? '0' : '1';
        toast(error.message);
      }
      return true;
    }

    case 'create-invite': {
      const property = ctx.state.currentProperty;
      if (!property) return true;
      await withLoading(target, async () => {
        try {
          const made = await api.createInvite(property.propertyId);
          platform.haptic('medium');
          await shareInvite(ctx.state, made.code);
          await ctx.refresh();
        } catch (error) {
          toast(error.message);
        }
      });
      return true;
    }

    case 'copy-invite':
      await shareInvite(ctx.state, target.dataset.code);
      return true;

    case 'revoke-invite':
      await withLoading(target, async () => {
        try {
          await api.revokeInvite(target.dataset.id);
          toast('Приглашение отозвано');
          await ctx.refresh();
        } catch (error) {
          toast(error.message);
        }
      });
      return true;

    case 'revoke': {
      await withLoading(target, async () => {
        try {
          await api.revokeAccess(target.dataset.id);
          platform.haptic('medium');
          toast('Доступ отозван');
          await ctx.refresh();
        } catch (error) {
          toast(error.message);
        }
      });
      return true;
    }

    case 'mark-paid': {
      await withLoading(target, async () => {
        try {
          await api.markPaid(target.dataset.id, target.dataset.paid === '1');
          platform.haptic('light');
          /**
           * Профиль перечитываем обязательно, а не только этот экран.
           *
           * С 2 сентября сумма на главной и в переключателе квартир —
           * это «всё, что не отмечено оплаченным», то есть она зависит
           * от отметки, которую человек ставит прямо здесь. Раньше там
           * стояло начисление за месяц, на отметки не реагировавшее,
           * и одного ctx.refresh() хватало. Теперь без refreshMe человек
           * отмечает оплату, возвращается на главную и видит старую сумму.
           */
          await ctx.refreshMe();
          await ctx.refresh();
        } catch (error) {
          toast(error.message);
        }
      });
      return true;
    }

    case 'privacy':
      await ctx.show('privacy');
      return true;

    default:
      return false;
  }
}

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];

function periodName(period) {
  const [, month] = String(period).split('-');
  return MONTHS[Number(month) - 1] ?? period;
}
