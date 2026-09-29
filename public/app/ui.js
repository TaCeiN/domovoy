/**
 * Мелкие помощники отрисовки.
 *
 * Отдельного внимания заслуживают состояния загрузки, ошибки и пустоты:
 * в исходном прототипе их не было ни одного, а в мобильной сети они
 * встречаются в первый же день использования.
 */

const NBSP = ' ';

/**
 * Экранирование: данные приходят от людей, в том числе от соседей.
 *
 * Апостроф тоже: сейчас все атрибуты в шаблонах написаны в двойных
 * кавычках, поэтому без него обходилось, — но это правило держалось
 * на дисциплине, а не на функции. Один атрибут в одинарных кавычках,
 * и экранирование перестаёт работать молча.
 */
export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const html = (strings, ...values) =>
  strings.reduce((out, part, i) => out + part + (i < values.length ? values[i] : ''), '');

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function setHtml(target, markup) {
  const node = typeof target === 'string' ? $(target) : target;
  if (node) node.innerHTML = markup;
  return node;
}

/**
 * Рубли из копеек. Группировку разрядов делаем сами, а не через
 * toLocaleString: результат не должен зависеть от сборки ICU в браузере.
 */
export function money(kopecks) {
  if (kopecks === null || kopecks === undefined) return '—';
  const sign = kopecks < 0 ? '-' : '';
  const abs = Math.abs(kopecks);
  const rubles = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${rubles},${rest}${NBSP}₽`;
}

export function plural(n, one, few, many) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * День без времени: «23.08» в этом году, «23.08.2025» в прошлых.
 *
 * ГОД ПИШЕТСЯ ТОЛЬКО ТАМ, ГДЕ ОН ЧТО-ТО ЗНАЧИТ. Дата без года работает
 * ровно один год, а потом начинает обманывать молча: в журнале, в архиве
 * обращений и в ленте объявлений «15.08» перестаёт отвечать на вопрос
 * «когда». Писать год всегда — лишний шум в списке за текущий месяц,
 * поэтому правило одно на весь проект: свой год не пишем, чужой пишем.
 */
export function formatDay(value) {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
  return d.getFullYear() === new Date().getFullYear() ? day : `${day}.${d.getFullYear()}`;
}

export function formatDate(value) {
  if (!value) return '';
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${formatDay(value)}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Хвост списка: сколько показано из скольких и кнопка «Показать ещё».
 *
 * Список, обрезанный молча, человек принимает за полный — и решает, что
 * прошлогодняя жалоба пропала. Кнопка, а не страницы: это телефон,
 * и «Вперёд» здесь означает «потерял место в списке».
 *
 * Ничего не рисует, когда показано всё: строка «Показаны 12 из 12» —
 * это шум, на который человек однажды перестанет смотреть вовсе.
 */
export function moreLine({ shown, total, action }) {
  if (!total || total <= shown) return '';
  return `
    <div class="dt-p" style="color:var(--tx-2);font-size:13px">
      Показаны ${shown} из ${total}
    </div>
    <button class="btn-primary secondary" data-action="${esc(action)}">Показать ещё</button>`;
}

/**
 * Перерисовать экран, не теряя места прокрутки.
 *
 * Экраны перерисовываются целиком, и без этого человек, нажавший
 * «Показать ещё» внизу списка, оказывается в его начале — то есть
 * теряет ровно то место, ради которого нажимал.
 */
export async function keepScroll(run) {
  const keep = document.querySelector('#screen')?.scrollTop ?? 0;
  await run();
  const screen = document.querySelector('#screen');
  if (screen) screen.scrollTop = keep;
}

/**
 * Кто написал реплику в переписке по обращению.
 *
 * Общий помощник для трёх читателей одной переписки — жителя, диспетчера
 * и совета дома. Раньше каждый экран считал подпись сам, и когда в
 * переписке появилась третья роль (председатель), кабинет УК не знал
 * о ней и подписывал его слова «Житель», а два места, которые всё же
 * знали, называли его по-разному. Роли мало: на адресе может быть
 * несколько жильцов, и «житель» без имени не отвечает на вопрос
 * «это писал я или мой домочадец».
 */
export function eventAuthor(e) {
  const role = eventRole(e.actor);
  if (e.actor === 'system' || !e.actorName) return role;
  return `${role} · ${e.actorName}`;
}

/**
 * Только роль, без имени — для однострочных превью в списках.
 *
 * Отдельно от `eventAuthor`, но на тех же словах: пока строка очереди
 * считала роль сама («житель или УК»), ответ председателя подписывался
 * в ней как «УК», а в карточке — правильно. Одна и та же реплика
 * называлась по-разному на соседних экранах.
 */
export function eventRole(actor) {
  if (actor === 'system') return 'Система';
  if (actor === 'dispatcher') return 'Диспетчер';
  if (actor === 'chairman') return 'Председатель совета дома';
  return 'Житель';
}

/**
 * Картинка аватара: фото из MAX, иначе мужской или женский Домовой по ФИО
 * (сервер решает, см. lib/auth/avatar.ts), иначе null — остаются инициалы.
 */
export function avatarSrc(avatar) {
  if (avatar?.photoUrl) return avatar.photoUrl;
  return avatar?.kind ? `icons/avatars/${avatar.kind}.webp` : null;
}

/* ─────────────── состояния экрана ─────────────── */

export function loadingState(text = 'Загружаем…') {
  return html`
    <div class="state">
      <div class="state-spinner"></div>
      <div class="state-text">${esc(text)}</div>
    </div>`;
}

/**
 * Заготовка экрана: серые полосы по форме будущего содержимого.
 *
 * Спиннер с «Загружаем…» на медленном интернете выглядел как зависание,
 * а заготовка — как экран, который вот-вот наполнится (27.09.2026).
 * Пульсирует только прозрачность: анимируем лишь transform и opacity,
 * остальное на слабых телефонах дёргается. Кабинеты УК и оператора остаются на спиннере.
 *
 *   home   — главная: адрес, плашка, сумма к оплате, строки, плитки;
 *   list   — список: заголовок, переключатели, строки;
 *   detail — карточка: заголовок, текст, блоки.
 */
export function skeletonState(kind = 'list', label = 'Загружаем…') {
  const bar = (w, h = 14, extra = '') => `<div class="sk" style="width:${w};height:${h}px${extra}"></div>`;
  const row = `<div class="sk-row"><div class="sk sk-ic"></div><div class="sk-lines">${bar('70%', 15)}${bar('45%', 12)}</div></div>`;
  const body = {
    home: `
      ${bar('62%', 22)}${bar('38%', 14, ';margin-top:8px')}
      <div class="sk sk-card" style="height:72px;margin-top:18px"></div>
      <div class="sk sk-card" style="height:150px"></div>
      <div class="sk sk-card" style="height:64px"></div>
      ${bar('40%', 18, ';margin:22px 0 12px')}
      <div class="sk-list">${row}${row}</div>
      <div class="sk-grid">${'<div class="sk sk-card" style="height:96px;margin:0"></div>'.repeat(4)}</div>`,
    list: `
      <div class="sk-chips">${bar('112px', 36, ';border-radius:10px')}${bar('84px', 36, ';border-radius:10px')}</div>
      <div class="sk-list">${row.repeat(5)}</div>`,
    detail: `
      ${bar('70%', 22)}${bar('35%', 13, ';margin-top:8px')}
      <div class="sk sk-card" style="height:44px;margin-top:18px"></div>
      <div class="sk sk-card" style="height:96px"></div>
      <div class="sk sk-card" style="height:180px"></div>`,
  }[kind] ?? '';
  return html`
    <div class="sk-screen" aria-busy="true">
      <span class="visually-hidden">${esc(label)}</span>
      ${body}
    </div>`;
}

/**
 * Ошибка обязана говорить, что произошло и что делать.
 * «Что-то пошло не так» без кнопки — тупик для пользователя.
 */
export function errorState(error, retryAction) {
  const offline = error?.offline;
  // Заголовок должен совпадать с диагнозом: «Нет связи» поверх текста
  // «с вашим интернетом всё в порядке» противоречит сам себе
  const title = error?.code === 'offline' ? 'Нет интернета'
    : error?.code === 'timeout' || error?.code === 'server_unreachable' ? 'Сервер недоступен'
    : 'Не удалось загрузить';
  return html`
    <div class="state">
      <div class="state-icon ${offline ? 'warn' : 'bad'}">
        ${offline
          ? '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3C7 3 3 6 1 9M12 3c5 0 9 3 11 6M12 9c-2.5 0-4.5 1.2-6 3m6-3c2.5 0 4.5 1.2 6 3M12 18v.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
          : '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/><path d="M12 7v6M12 16.5v.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'}
      </div>
      <div class="state-title">${esc(title)}</div>
      <div class="state-text">${esc(error?.message ?? 'Попробуйте ещё раз')}</div>
      ${retryAction ? `<button class="btn-primary" style="max-width:220px" data-action="${esc(retryAction)}">Повторить</button>` : ''}
    </div>`;
}

function emptyStateIcon(type) {
  switch (type) {
    case 'requests':
      return html`
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M19.5 7.5V18.5C19.5 19.6 18.6 20.5 17.5 20.5H6.5C5.4 20.5 4.5 19.6 4.5 18.5V5.5C4.5 4.4 5.4 3.5 6.5 3.5H15.5L19.5 7.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M15 3.5V8H19.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M8.5 12H15.5M8.5 15.5H13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>`;
    case 'meters':
      return html`
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/>
          <path d="M12 7.5V12L15 15" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
          <path d="M8 3.5L9.5 2M16 3.5L14.5 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>`;
    case 'posts':
      return html`
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M18 8C18 8 16 7 14 7H8L5 10H3V14H5L8 17H14C16 17 18 16 18 16V8Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M18 11C19.5 11 20.5 11.5 21 12M18 8.5C20.5 8.5 22 9.5 22.5 10M18 13.5C20.5 13.5 22 12.5 22.5 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
        </svg>`;
    case 'market':
      return html`
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3.5 7.5L12 3.5L20.5 7.5L12 11.5L3.5 7.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M3.5 7.5V16.5L12 20.5V11.5M20.5 7.5V16.5L12 20.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        </svg>`;
    case 'archive':
      return html`
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.8"/>
          <path d="M8 12L11 15L16 9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
    case 'house':
    case 'peace':
      return html`
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M3 10.5L12 3.5L21 10.5V19.5C21 20.1 20.5 20.5 20 20.5H4C3.5 20.5 3 20.1 3 19.5V10.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
          <path d="M9 20.5V12.5H15V20.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
        </svg>`;
    default:
      return html`
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="4" y="4" width="16" height="16" rx="3" stroke="currentColor" stroke-width="1.8"/>
          <path d="M8 12h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>`;
  }
}

export function emptyState(title, text, action, iconType = 'default') {
  const iconCls = iconType || 'default';
  return html`
    <div class="empty-card">
      <div class="empty-card-icon ${esc(iconCls)}">
        ${emptyStateIcon(iconCls)}
      </div>
      <div class="empty-card-title">${esc(title)}</div>
      ${text ? html`<div class="empty-card-text">${esc(text)}</div>` : ''}
      ${action ? html`<button class="btn-primary" style="margin-top:14px;max-width:240px" data-action="${esc(action.action)}">${esc(action.label)}</button>` : ''}
    </div>`;
}

/* ─────────────── тост ─────────────── */

let toastTimer = null;

export function toast(message) {
  let node = $('#toast');
  if (!node) {
    node = document.createElement('div');
    node.id = 'toast';
    node.className = 'toast';
    document.querySelector('.app')?.appendChild(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

/* ─────────────── кнопка с индикатором ─────────────── */

export async function withLoading(button, task) {
  if (!button) return task();
  button.classList.add('loading');
  button.disabled = true;
  try {
    return await task();
  } finally {
    button.classList.remove('loading');
    button.disabled = false;
  }
}

/* ─────────────── подтверждение действия ─────────────── */

/**
 * Спросить перед необратимым действием.
 *
 * НЕ `window.confirm`: системное окно выглядит по-разному везде,
 * а в вебвью мессенджера ещё и появляется с задержкой и без наших
 * шрифтов — человек успевает решить, что приложение сломалось.
 *
 * Опасное действие стоит СЛЕВА и красным, отказ — справа и обычной
 * кнопкой: палец сам тянется к правому краю, и промах должен приводить
 * к «оставить как есть», а не к выходу из приложения.
 */
export function confirmAction({ title, text = '', confirmLabel = 'Продолжить', danger = false }) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'confirm-host';
    host.innerHTML = html`
      <div class="confirm-backdrop"></div>
      <div class="confirm-box" role="dialog" aria-modal="true">
        <div class="confirm-title">${esc(title)}</div>
        ${text ? html`<div class="confirm-text">${esc(text)}</div>` : ''}
        <div class="confirm-row">
          <button type="button" class="confirm-yes ${danger ? 'danger' : ''}">${esc(confirmLabel)}</button>
          <button type="button" class="confirm-no">Отмена</button>
        </div>
      </div>`;

    const done = (answer) => {
      host.remove();
      document.body.classList.remove('dp-locked');
      resolve(answer);
    };

    host.querySelector('.confirm-yes').addEventListener('click', () => done(true));
    host.querySelector('.confirm-no').addEventListener('click', () => done(false));
    host.querySelector('.confirm-backdrop').addEventListener('click', () => done(false));

    document.body.appendChild(host);
    document.body.classList.add('dp-locked');
    host.querySelector('.confirm-no').focus();
  });
}

/**
 * Спросить короткий текст — причину отказа и подобное.
 *
 * НЕ `window.prompt`: в веб-версии MAX мини-приложение живёт во фрейме,
 * и системное окно там может не появиться вовсе — кнопка «Отказать»
 * молча ничего не делала бы. Окно то же, что у `confirmAction`.
 *
 * Возвращает введённый текст без пробелов по краям или `null`, если
 * человек передумал. Кнопка неактивна, пока текст короче `minLength`.
 */
export function askText({
  title, text = '', placeholder = '', confirmLabel = 'Готово', danger = false, minLength = 3,
}) {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    host.className = 'confirm-host';
    host.innerHTML = html`
      <div class="confirm-backdrop"></div>
      <div class="confirm-box" role="dialog" aria-modal="true">
        <div class="confirm-title">${esc(title)}</div>
        ${text ? html`<div class="confirm-text">${esc(text)}</div>` : ''}
        <textarea class="confirm-input" placeholder="${esc(placeholder)}"></textarea>
        <div class="confirm-row">
          <button type="button" class="confirm-yes ${danger ? 'danger' : ''}" disabled>${esc(confirmLabel)}</button>
          <button type="button" class="confirm-no">Отмена</button>
        </div>
      </div>`;

    const field = host.querySelector('.confirm-input');
    const yes = host.querySelector('.confirm-yes');
    const done = (answer) => {
      host.remove();
      document.body.classList.remove('dp-locked');
      resolve(answer);
    };

    field.addEventListener('input', () => { yes.disabled = field.value.trim().length < minLength; });
    yes.addEventListener('click', () => done(field.value.trim()));
    host.querySelector('.confirm-no').addEventListener('click', () => done(null));
    host.querySelector('.confirm-backdrop').addEventListener('click', () => done(null));

    document.body.appendChild(host);
    document.body.classList.add('dp-locked');
    field.focus();
  });
}

/* ─────────────── шторка ─────────────── */

/**
 * Шторка снизу с произвольным содержимым.
 *
 * Классы берём у шторки выбора даты — dp-backdrop и dp-sheet. Они уже
 * оформлены в обеих версиях дизайна, в new вместе с ручкой-хватом,
 * и вторая шторка со своими стилями разошлась бы с первой при первой
 * же правке.
 *
 * Кнопки внутри работают через общее делегирование кликов на document
 * (main.js), поэтому шторка живёт в body, вне контейнера экранов.
 * Закрывается фоном, кнопкой «Закрыть», клавишей Escape и любым
 * переходом на другой экран — последнее делает renderScreen.
 *
 * Высота ограничена с прокруткой: содержимое бывает длинным
 * (объяснение, «Подключить дом», поле кода), а на маленьком телефоне
 * без потолка нижние кнопки уезжали бы за край экрана.
 */
let sheetKeydown = null;
/** Что сделать, если человек закрыл шторку сам — не выбрав ни одной кнопки */
let sheetOnDismiss = null;

/**
 * `closeButton: false` — без общей кнопки «Закрыть», когда в самой шторке
 * уже есть кнопка отказа («Нет, позже»): две кнопки об одном путают.
 * `onDismiss` — закрытие мимо кнопок (касание фона, Esc) тоже ответ,
 * и шторка должна его запомнить, а не всплыть снова при следующем запуске.
 */
export function openSheet(markup, label, { closeButton = true, onDismiss = null } = {}) {
  let host = document.querySelector('#appSheet');
  if (!host) {
    host = document.createElement('div');
    host.id = 'appSheet';
    document.body.appendChild(host);
  }

  host.innerHTML = html`
    <div class="dp-backdrop" data-action="sheet-close"></div>
    <div class="dp-sheet" role="dialog" aria-modal="true" aria-label="${esc(label)}"
         style="max-height:88dvh;overflow-y:auto">
      ${markup}
      ${closeButton ? html`
      <div class="dp-foot">
        <button type="button" class="dp-cancel" data-action="sheet-close">Закрыть</button>
      </div>` : ''}
    </div>`;
  document.body.classList.add('dp-locked');
  sheetOnDismiss = onDismiss;

  if (!sheetKeydown) {
    sheetKeydown = (event) => { if (event.key === 'Escape') dismissSheet(); };
    document.addEventListener('keydown', sheetKeydown);
  }

  // Фокус на кнопку, а не на поле: поле на телефоне сразу выдвинуло бы клавиатуру
  host.querySelector('.dp-sheet button')?.focus({ preventScroll: true });
}

/** Человек закрыл шторку сам: касание фона, «Закрыть», Esc */
export function dismissSheet() {
  const onDismiss = sheetOnDismiss;
  closeSheet();
  onDismiss?.();
}

/** Закрыть шторку программно — после выбора кнопки или при смене экрана */
export function closeSheet() {
  sheetOnDismiss = null;
  const host = document.querySelector('#appSheet');
  if (!host || !host.innerHTML) return;
  host.innerHTML = '';
  document.body.classList.remove('dp-locked');
  if (sheetKeydown) {
    document.removeEventListener('keydown', sheetKeydown);
    sheetKeydown = null;
  }
}

/**
 * Адрес для глаз, а не для реестра.
 *
 * Реестр пишет «344038, обл Ростовская, г Ростов-на-Дону, пр-кт Ленина,
 * д. 85/3» — индекс, область первым словом, сокращения «пр-кт», «ул»,
 * «б-р». Так адрес стоял в заголовке «Совета дома», в форме жалобы,
 * в кабинетах (аудит 26 сентября). Житель ищет глазами «проспект Ленина»,
 * а не «пр-кт». Индекс и область убираем — дом и так в одном регионе
 * с человеком; город оставляем.
 *
 * Только для вывода: ключи домов считаются от исходной строки, и её
 * в базе не трогаем.
 */
const ADDRESS_WORDS = [
  [/^пр-кт\.?\s/i, 'проспект '],
  [/^ул\.?\s/i, 'улица '],
  [/^пер\.?\s/i, 'переулок '],
  [/^б-р\.?\s/i, 'бульвар '],
  [/^пл\.?\s/i, 'площадь '],
  [/^ш\.?\s/i, 'шоссе '],
  [/^наб\.?\s/i, 'набережная '],
  [/^проезд\s/i, 'проезд '],
  [/^мкр\.?\s/i, 'микрорайон '],
  [/^туп\.?\s/i, 'тупик '],
];

export function displayAddress(raw) {
  const parts = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return parts
    .filter((p) => !/^\d{6}$/.test(p))
    .filter((p) => !/^(обл|область|край|респ|республика)\s|\s(обл|область|край)\.?$|^р-н\s|\sр-н$/i.test(p))
    .map((p) => {
      if (/^г\.?\s/i.test(p)) return p.replace(/^г\.?\s+/i, '');
      for (const [re, word] of ADDRESS_WORDS) if (re.test(p)) return p.replace(re, word);
      return p;
    })
    .join(', ');
}
