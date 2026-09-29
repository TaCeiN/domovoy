import { esc, html } from './ui.js';

/**
 * Свой выбор даты и времени.
 *
 * ЗАЧЕМ СВОЙ. `<input type="date">` и `datetime-local` рисуют системное
 * окно, и оно разное везде: в вебвью на Android одно, на iOS барабаны,
 * в браузере на компьютере третье. Ни одно не похоже на приложение,
 * а пожилой человек по внешнему виду решает, «то ли это окно вообще,
 * не выкинуло ли меня куда-то».
 *
 * ЗНАЧЕНИЕ ЛЕЖИТ ТАМ ЖЕ. Под кнопкой прячется обычный `<input>` с тем же
 * id и в том же формате, что отдавал системный: `ГГГГ-ММ-ДД` без времени
 * и `ГГГГ-ММ-ДДTЧЧ:ММ` с ним. Поэтому код, который его читает, менять
 * не пришлось нигде.
 *
 * НАСТРОЙКИ ЖИВУТ В РАЗМЕТКЕ, а не в памяти модуля: экраны приложения
 * перерисовываются целиком, и любое состояние рядом с полем пережило бы
 * не каждую перерисовку. `data-time`, `data-min`, `data-max` на кнопке —
 * это же состояние, но неразрушимое.
 */

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const MONTHS_SHORT = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];
const MONTHS_IN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
/** Неделя начинается с понедельника: календарь для России, не для США */
const WEEKDAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Насколько далеко ходят стрелки года */
const YEARS_BACK = 20;
const YEARS_AHEAD = 20;

/** Минуты выбираются четвертями часа: точнее человеку и не нужно */
const MINUTES = ['00', '15', '30', '45'];

/** «2029-03-12» → «12 марта 2029», с временем → «12 марта 2029, 18:00» */
export function humanDate(value) {
  const parts = parseValue(value);
  if (!parts) return '';
  const day = `${parts.d} ${MONTHS_IN[parts.m]} ${parts.y}`;
  return parts.time ? `${day}, ${parts.time}` : day;
}

function parseValue(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(value ?? ''));
  if (!m) return null;
  const mo = Number(m[2]) - 1;
  const d = Number(m[3]);
  if (mo < 0 || mo > 11 || d < 1 || d > 31) return null;
  return {
    y: Number(m[1]),
    m: mo,
    d,
    time: m[4] ? `${m[4]}:${m[5]}` : '',
    hh: m[4] ? Number(m[4]) : 12,
    mm: m[5] ? Number(m[5]) : 0,
  };
}

function dayValue(y, m, d) {
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Сегодня в формате поля: удобно как граница «не раньше сегодня» */
export function todayValue() {
  const n = new Date();
  return dayValue(n.getFullYear(), n.getMonth(), n.getDate());
}

/**
 * Поле в форме: скрытое значение плюс кнопка, которая его показывает.
 *
 * `withTime` — нужен ли второй шаг с часами. `min`/`max` в формате
 * `ГГГГ-ММ-ДД` закрывают недоступные дни: мастера на вчера не вызвать.
 */
export function dateField({
  id, value = '', placeholder = 'Дата не выбрана', withTime = false, min = '', max = '',
}) {
  const shown = humanDate(value);
  return html`
    <input type="hidden" id="${esc(id)}" value="${esc(value)}">
    <button type="button" class="dp-trigger" data-action="dp-open" data-for="${esc(id)}"
            data-time="${withTime ? '1' : ''}" data-min="${esc(min)}" data-max="${esc(max)}">
      <span class="dp-value ${shown ? '' : 'empty'}">${esc(shown || placeholder)}</span>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect x="3.5" y="5" width="17" height="15.5" rx="3" stroke="currentColor" stroke-width="1.6"/>
        <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </button>`;
}

/* ─────────────── состояние открытого календаря ─────────────── */

let open = null;

function sheetHost() {
  let host = document.querySelector('#dpSheet');
  if (!host) {
    host = document.createElement('div');
    host.id = 'dpSheet';
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Пометить выбранной одну кнопку из ряда, не трогая остальную разметку.
 *
 * Минуты размечены классом `.dp-month` (та же плитка, что у месяцев),
 * поэтому селектор приходит снаружи: у часов и минут он разный.
 */
function selectOne(selector, target) {
  for (const node of sheetHost().querySelectorAll(selector)) {
    node.classList.toggle('sel', node === target);
  }
}

function openPicker(trigger) {
  const id = trigger.dataset.for;
  const input = document.querySelector(`#${CSS.escape(id)}`);
  if (!input) return;

  const picked = parseValue(input.value);
  const now = new Date();
  open = {
    id,
    withTime: trigger.dataset.time === '1',
    min: trigger.dataset.min || '',
    max: trigger.dataset.max || '',
    view: 'days',
    day: picked ? dayValue(picked.y, picked.m, picked.d) : '',
    hh: picked?.hh ?? 12,
    mm: picked?.mm ?? 0,
    year: picked?.y ?? now.getFullYear(),
    month: picked?.m ?? now.getMonth(),
  };
  render();
}

function close() {
  open = null;
  sheetHost().innerHTML = '';
  document.body.classList.remove('dp-locked');
}

function apply(value) {
  const input = document.querySelector(`#${CSS.escape(open.id)}`);
  const trigger = document.querySelector(`[data-action="dp-open"][data-for="${CSS.escape(open.id)}"]`);
  if (input) input.value = value;
  if (trigger) {
    const shown = humanDate(value);
    const label = trigger.querySelector('.dp-value');
    if (label) {
      label.textContent = shown || 'Дата не выбрана';
      label.classList.toggle('empty', !shown);
    }
  }
  close();
}

/** Собрать значение из выбранного дня и времени */
function commit() {
  if (!open.day) return close();
  const value = open.withTime
    ? `${open.day}T${String(open.hh).padStart(2, '0')}:${String(open.mm).padStart(2, '0')}`
    : open.day;
  apply(value);
}

/* ─────────────── разметка ─────────────── */

function daysGrid() {
  const { year, month, day: picked, min, max } = open;
  const first = new Date(year, month, 1);
  /** getDay(): воскресенье это 0, а у нас неделя с понедельника */
  const lead = (first.getDay() + 6) % 7;
  const total = new Date(year, month + 1, 0).getDate();
  const today = todayValue();

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="dp-day empty"></span>');
  for (let d = 1; d <= total; d++) {
    const value = dayValue(year, month, d);
    // Границы сравниваем строками: формат ГГГГ-ММ-ДД для этого и годится
    const off = (min && value < min) || (max && value > max);
    const classes = [
      'dp-day',
      value === picked ? 'sel' : '',
      value === today ? 'today' : '',
      off ? 'off' : '',
    ].filter(Boolean).join(' ');
    cells.push(off
      ? html`<span class="${classes}">${d}</span>`
      : html`<button type="button" class="${classes}" data-action="dp-day" data-d="${value}">${d}</button>`);
  }
  return cells.join('');
}

function timeView() {
  const hours = [];
  for (let h = 0; h < 24; h++) {
    hours.push(html`
      <button type="button" class="dp-hour ${h === open.hh ? 'sel' : ''}"
              data-action="dp-hour" data-h="${h}">${String(h).padStart(2, '0')}</button>`);
  }

  return html`
    <div class="dp-nav">
      <button type="button" class="dp-arrow" data-action="dp-back-days" aria-label="Назад к календарю">${ARROW_LEFT}</button>
      <div class="dp-title">${esc(humanDate(open.day))}</div>
      <span class="dp-arrow" style="visibility:hidden"></span>
    </div>
    <div class="dp-sub">Час</div>
    <div class="dp-hours">${hours.join('')}</div>
    <div class="dp-sub">Минуты</div>
    <div class="dp-minutes">
      ${MINUTES.map((m) => html`
        <button type="button" class="dp-month ${Number(m) === open.mm ? 'sel' : ''}"
                data-action="dp-minute" data-m="${m}">${m}</button>`).join('')}
    </div>`;
}

function monthsView() {
  return html`
    <div class="dp-nav">
      <button type="button" class="dp-arrow" data-action="dp-year-prev" aria-label="Год назад">${ARROW_LEFT}</button>
      <div class="dp-title">${open.year}</div>
      <button type="button" class="dp-arrow" data-action="dp-year-next" aria-label="Год вперёд">${ARROW_RIGHT}</button>
    </div>
    <div class="dp-months">
      ${MONTHS_SHORT.map((name, i) => html`
        <button type="button" class="dp-month ${i === open.month ? 'sel' : ''}"
                data-action="dp-month" data-m="${i}">${esc(name)}</button>`).join('')}
    </div>`;
}

function daysView() {
  return html`
    <div class="dp-nav">
      <button type="button" class="dp-arrow" data-action="dp-prev" aria-label="Предыдущий месяц">${ARROW_LEFT}</button>
      <button type="button" class="dp-title" data-action="dp-months">
        ${esc(MONTHS[open.month])} ${open.year}
      </button>
      <button type="button" class="dp-arrow" data-action="dp-next" aria-label="Следующий месяц">${ARROW_RIGHT}</button>
    </div>
    <div class="dp-week">${WEEKDAYS.map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="dp-grid">${daysGrid()}</div>`;
}

function render() {
  if (!open) return;
  document.body.classList.add('dp-locked');

  const body = open.view === 'months' ? monthsView()
    : open.view === 'time' ? timeView()
      : daysView();

  /**
   * «Готово» есть только на шаге времени: там иначе не понять, что выбор
   * закончен. На календаре день выбирается одним нажатием — лишняя
   * кнопка это ещё одно место, где человек застревает.
   */
  sheetHost().innerHTML = html`
    <div class="dp-backdrop" data-action="dp-close"></div>
    <div class="dp-sheet" role="dialog" aria-modal="true" aria-label="Выбор даты">
      ${body}
      <div class="dp-foot">
        <button type="button" class="dp-clear" data-action="dp-clear">Очистить</button>
        ${open.view === 'time'
          ? html`<button type="button" class="dp-done" data-action="dp-done">Готово</button>`
          : html`<button type="button" class="dp-cancel" data-action="dp-close">Закрыть</button>`}
      </div>
    </div>`;
}

const ARROW_LEFT =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M14.5 6L8.5 12l6 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ARROW_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M9.5 6l6 6-6 6" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* ─────────────── действия ─────────────── */

export async function handleDateAction(action, target) {
  if (action === 'dp-open') {
    openPicker(target);
    return true;
  }
  if (!open) return false;

  if (action === 'dp-close') { close(); return true; }
  if (action === 'dp-clear') { apply(''); return true; }
  if (action === 'dp-done') { commit(); return true; }

  if (action === 'dp-day') {
    open.day = target.dataset.d;
    // Со временем день это ещё не ответ: спрашиваем часы вторым шагом
    if (open.withTime) { open.view = 'time'; render(); } else commit();
    return true;
  }

  if (action === 'dp-back-days') { open.view = 'days'; render(); return true; }
  /**
   * Час и минуты меняют ОДИН класс на одной кнопке — и раньше ради этого
   * звали render(), а он переписывает разметку шторки целиком. Узел
   * .dp-sheet создавался заново, и анимация выезда снизу отыгрывалась
   * на каждое касание: экран дёргался, пока человек выбирал время.
   *
   * Правило: render() зовём, когда меняется ВИД; выбор внутри вида
   * правит классы.
   */
  if (action === 'dp-hour') {
    open.hh = Number(target.dataset.h);
    selectOne('.dp-hour', target);
    return true;
  }
  if (action === 'dp-minute') {
    open.mm = Number(target.dataset.m);
    selectOne('.dp-minutes .dp-month', target);
    return true;
  }

  if (action === 'dp-months') { open.view = 'months'; render(); return true; }

  if (action === 'dp-month') {
    open.month = Number(target.dataset.m);
    open.view = 'days';
    render();
    return true;
  }

  if (action === 'dp-prev' || action === 'dp-next') {
    const step = action === 'dp-prev' ? -1 : 1;
    const date = new Date(open.year, open.month + step, 1);
    open.year = date.getFullYear();
    open.month = date.getMonth();
    render();
    return true;
  }

  if (action === 'dp-year-prev' || action === 'dp-year-next') {
    const now = new Date().getFullYear();
    const next = open.year + (action === 'dp-year-prev' ? -1 : 1);
    // Дальше этих границ ходить незачем: сроки живут годами, не веками
    if (next >= now - YEARS_BACK && next <= now + YEARS_AHEAD) {
      open.year = next;
      render();
    }
    return true;
  }

  return false;
}
