import { api } from '../api.js';
import { html, esc, toast, plural } from '../ui.js';
import { platform } from '../platform.js';
import { wipBadge } from '../wip.js';
import { API_BASE } from '../config.js';
import { PIN_SVG } from './pick-icons.js';

/**
 * ЗАГЛУШКА MVP: ЖК в подборе дома (docs/mock-complexes.md).
 *
 * Весь вид ЖК — здесь, чтобы убрать заглушку удалением одного файла
 * и развилок в pick.js. Каждая плашка и карточка несут метку pickMock.
 *
 * ♥ ЖК живёт только на устройстве: таблица избранного ссылается
 * на настоящие дома, и мешать с ними заглушку незачем.
 */

const FAV_KEY = 'domovoy-pick-fav';

/** Вкладки полной карточки ЖК — как в референсе владельца (29.09) */
/**
 * «Рядом», а не «Инфраструктура»: четыре вкладки должны влезть в ширину
 * телефона без прокрутки — спрятанную за край вкладку не находят (29.09).
 */
const TABS = [['about', 'О ЖК'], ['reviews', 'Отзывы'], ['developer', 'Застройщик'], ['infra', 'Рядом']];
const PLACE_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="9.5" r="2.5" stroke="currentColor" stroke-width="1.8"/></svg>';
const HOUSE_ICON = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 10.5 12 4l8 6.5V20H4v-9.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10 20v-5h4v5" stroke="currentColor" stroke-width="1.8"/></svg>';

function readFav() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY) ?? '[]'); } catch { return []; }
}
function writeFav(list) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch { /* приватный режим — ♥ не запомнится */ }
}
const isFav = (key) => readFav().some((c) => c.key === key);

/** «Мои дома» показывают и ЖК, отмеченные на этом устройстве */
export function mockFavorites() {
  return readFav();
}

const HEART = 'M12 20.3s-7.8-4.6-7.8-10.2A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 7.8 3.1c0 5.6-7.8 10.2-7.8 10.2z';
const heart = (on) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${HEART}" ${on
  ? 'fill="currentColor"' : 'fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"'}/></svg>`;
const CART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h2l2.2 10.2a1.5 1.5 0 0 0 1.5 1.2h8.6a1.5 1.5 0 0 0 1.5-1.1L21 8H6.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="9.5" cy="19.5" r="1.3" fill="currentColor"/><circle cx="17" cy="19.5" r="1.3" fill="currentColor"/></svg>';

const place = (c) => [c.address, c.microdistrict, c.district].filter(Boolean).join(' · ');
/** 4 500 000 → «от 4,5 млн ₽», 12 000 000 → «от 12 млн ₽» */
const price = (n) => (n ? `от ${String(Math.round(n / 1e5) / 10).replace('.', ',')} млн ₽` : null);
const stars = (v) => {
  const full = Math.round(v);
  return html`<span class="mock-stars" aria-label="${esc(v)} из 5">${'★'.repeat(full)}<i>${'★'.repeat(5 - full)}</i></span>`;
};

/* ─────────────── шторка ЖК ─────────────── */

/**
 * Касание ЖК — снизу шторка на треть экрана с верхом карточки. Потянуть
 * за край вверх — на весь экран, вниз — обратно на треть, из трети — закрыть.
 *
 * Шторка во всю высоту карты и двигается только сдвигом (transform):
 * менять высоту в анимации — рывки на слабых телефонах.
 *
 * На трети тянуть можно за любое место: прокрутки там нет. На весь экран —
 * только за ручку, иначе перетаскивание спорило бы с прокруткой карточки.
 * Касание без движения — обычное нажатие: кнопки внутри работают.
 */

const PEEK = 1 / 3;
/**
 * Защита от ложного свайпа. Нажатие пальцем почти всегда чуть сдвигает
 * точку касания — до DRAG_START_PX шторка не шевелится вовсе, и нажатие
 * остаётся нажатием. Положение меняется, только если протянули дальше
 * SNAP_PX, иначе шторка возвращается на место. Движение больше вбок, чем
 * по вертикали, — не свайп шторки.
 */
const DRAG_START_PX = 14;
const SNAP_PX = 90;
/** Из раскрытой шторки дотянули ниже этой доли высоты — закрыть сразу, минуя треть */
const CLOSE_FROM_FULL = 0.6;

let sheet = null;
let body = null;
let sheetState = 'closed';
let onSheetChange = () => {};
let drag = null;
/** После перетаскивания браузер шлёт click туда, где отпустили палец, — его гасим */
let swallowClick = false;

export function mockSheetHtml() {
  return html`
    <div class="mock-sheet" id="mockSheet" data-state="closed" aria-hidden="true">
      <div class="mock-sheet-grip" aria-hidden="true"><span></span></div>
      <div class="mock-sheet-body"></div>
    </div>`;
}

export const mockSheetState = () => sheetState;

/**
 * Раскрытая шторка встаёт до самого верха, поверх поиска (CSS `top: 0`
 * у .mock-sheet, просьба владельца 28.09). Отступ `top` оставлен в расчёте:
 * треть — от всей карты, видимая часть = (высота + top) / 3.
 */
const topGap = () => sheet.offsetTop;

/** Верх видимой части шторки от верха карты — чтобы кнопки карты поднимались над ней */
export function mockSheetTop() {
  if (!sheet || sheetState !== 'peek') return null;
  return topGap() + offsetFor('peek');
}

function offsetFor(state) {
  const h = sheet.offsetHeight;
  if (state === 'full') return 0;
  if (state === 'peek') return h - (h + topGap()) * PEEK;
  return h;
}

/**
 * В покое сдвиг ставится долей высоты (проценты + постоянный отступ),
 * а не пикселями: при возврате на карту шторка открывается, пока страница
 * ещё въезжает, и высота в пикселях в этот миг — не та, что через секунду.
 */
function restTransform(state) {
  if (state === 'full') return 'translateY(0)';
  if (state === 'closed') return 'translateY(100%)';
  return `translateY(calc(${(1 - PEEK) * 100}% - ${topGap() * PEEK}px))`;
}

function setSheet(state) {
  if (!sheet) return;
  sheetState = state;
  sheet.dataset.state = state;
  sheet.setAttribute('aria-hidden', state === 'closed' ? 'true' : 'false');
  sheet.style.transform = restTransform(state);
  if (state !== 'full') body.scrollTop = 0;
  onSheetChange(state);
}

export const collapseMockSheet = () => setSheet('peek');
export const expandMockSheet = () => setSheet('full');
export const closeMockSheet = () => setSheet('closed');

/**
 * Открыть шторку ЖК; карточка возвращается — карте нужны её координаты.
 * `peek` — мини-карточкой, даже если шторка была раскрыта (выбор из поиска).
 */
export async function openMockSheet(key, { peek = false } = {}) {
  if (!sheet) return null;
  let card;
  try {
    card = await api.pickHouse(key);
  } catch (error) {
    toast(error.message);
    return null;
  }
  if (!sheet) return null;
  body.innerHTML = renderMockCard(card);
  body.scrollTop = 0;
  // «Похожие ЖК» в раскрытой шторке переключают её, не сворачивая
  setSheet(sheetState === 'full' && !peek ? 'full' : 'peek');
  return card;
}

function onDown(e) {
  if (sheetState === 'closed') return;
  const fromGrip = Boolean(e.target.closest('.mock-sheet-grip'));
  /**
   * На трети тянут за любое место. Раскрытую — за ручку или за верх карточки
   * (название и плашку фактов): вниз — свернуть или закрыть, вверх —
   * прокрутка карточки, которую здесь делаем сами (браузеру этот блок
   * отдан целиком, иначе он забрал бы жест себе).
   */
  const fromTop = Boolean(e.target.closest('.mock-top, .mock-hero'));
  if (sheetState === 'full' && !fromGrip && !fromTop) return;
  drag = {
    x: e.clientX, y: e.clientY, base: offsetFor(sheetState), id: e.pointerId,
    moved: false, fromGrip, mode: 'sheet', scroll0: body.scrollTop,
  };
  /**
   * Движение слушаем на окне, а не на шторке: мышь и быстрый палец уходят
   * за её край раньше, чем набирается порог, и события достаются карте.
   */
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function onMove(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const dy = e.clientY - drag.y;
  const dx = e.clientX - drag.x;
  if (!drag.moved) {
    if (Math.abs(dy) < DRAG_START_PX && Math.abs(dx) < DRAG_START_PX) return;
    // Больше вбок, чем по вертикали, — не свайп шторки: отпускаем жест
    if (Math.abs(dx) > Math.abs(dy)) { endDrag(); return; }
    drag.moved = true;
    // Раскрытая шторка: вверх — листать карточку; вниз, пока она не у начала, — листать назад
    if (sheetState === 'full' && (dy < 0 || drag.scroll0 > 0)) drag.mode = 'scroll';
    else sheet.classList.add('dragging');
  }
  e.preventDefault();
  if (drag.mode === 'scroll') {
    body.scrollTop = drag.scroll0 - dy;
    return;
  }
  const pos = Math.min(Math.max(drag.base + dy, 0), sheet.offsetHeight);
  sheet.style.transform = `translateY(${pos}px)`;
}

function endDrag() {
  drag = null;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onUp);
}

function onUp(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { moved, fromGrip, mode, base } = drag;
  const dy = e.clientY - drag.y;
  endDrag();
  if (!sheet) return;
  sheet.classList.remove('dragging');
  if (!moved) {
    // Касание ручки — то же, что потянуть: треть ↔ весь экран
    if (fromGrip) setSheet(sheetState === 'full' ? 'peek' : 'full');
    return;
  }
  // После пальца щелчка обычно нет вовсе — флаг не должен съесть следующее настоящее нажатие
  swallowClick = true;
  setTimeout(() => { swallowClick = false; }, 400);
  if (mode === 'scroll') return;

  if (dy < -SNAP_PX) setSheet('full');
  else if (dy > SNAP_PX) {
    const reached = (base + dy) / sheet.offsetHeight;
    if (sheetState === 'full' && reached < CLOSE_FROM_FULL) setSheet('peek');
    else setSheet('closed');
  } else setSheet(sheetState);
}

/** Шторка живёт вместе с картой: `mountPick` зовёт при появлении, уборка — при уходе */
export function mountMockSheet(host, onChange) {
  sheet = host.querySelector('#mockSheet');
  body = sheet?.querySelector('.mock-sheet-body') ?? null;
  sheetState = 'closed';
  onSheetChange = onChange;
  if (!sheet) return;
  sheet.addEventListener('pointerdown', onDown);
  // Доехала — пересчитать то, что зависит от её высоты (кнопки карты над шторкой)
  sheet.addEventListener('transitionend', () => onSheetChange(sheetState));
}

/**
 * Щелчок после перетаскивания приходит туда, где отпустили, — часто в карту,
 * а касание карты закрывает шторку. Гасим его на окне, до всех обработчиков.
 */
window.addEventListener('click', (e) => {
  if (!swallowClick) return;
  swallowClick = false;
  e.stopPropagation();
  e.preventDefault();
}, true);

export function unmountMockSheet() {
  sheet = null;
  body = null;
  sheetState = 'closed';
  onSheetChange = () => {};
}

function reviewCard(r) {
  return html`
    <div class="mock-review">
      <div class="mock-review-top"><b>${esc(r.name)}, кв. ${esc(r.flat)}</b>${stars(r.stars)}</div>
      <div class="mock-review-plus">${esc(r.plus)}</div>
      <div class="mock-review-minus">${esc(r.minus)}</div>
    </div>`;
}

/** Что запомнить о ЖК для строки в «Моих домах» — те же поля, что у точки карты */
const toFav = (c) => ({
  key: c.key, name: c.name, rating: c.rating, reviews: c.reviewCount, microdistrict: c.microdistrict,
  developer: c.developer, grocery: c.grocery, priceFrom: c.priceFrom, quote: c.reviews[0]?.plus ?? null,
});

/**
 * Карточка ЖК по референсу владельца (29.09).
 *
 * Одна разметка на оба положения шторки: на трети видна плашка
 * `.mock-peek` (фото, название, район, рейтинг), раскрытая — полная
 * карточка `.mock-full` с фото во всю ширину и вкладками. Переключает
 * их CSS по `data-state` шторки: перерисовывать при каждом свайпе незачем.
 */
export function renderMockCard(c) {
  const fav = isFav(c.key);
  const avito = c.listings[0];
  const photoUrl = c.photo ? `${API_BASE}${c.photo.url}` : null;
  const reviews = `${c.reviewCount} ${plural(c.reviewCount, 'отзыв', 'отзыва', 'отзывов')}`;
  const rate = html`<div class="mock-rate">★ <b>${esc(c.rating.toFixed(1))}</b> <span>${esc(reviews)}</span></div>`;
  const cost = price(c.priceFrom);

  return html`
    <div class="mock-top">
      <button class="mock-peek" data-action="pick-mock-expand" aria-label="Подробнее о ${esc(c.name)}">
        ${photoUrl
          ? html`<span class="mock-thumb" style="background-image:url('${esc(photoUrl)}')"></span>`
          : html`<span class="mock-thumb empty">${PIN_SVG}</span>`}
        <span class="mock-peek-main">
          ${wipBadge('pickMock')}
          <span class="mock-peek-name">${esc(c.name)}</span>
          <span class="mock-peek-place">${esc(c.district ?? c.microdistrict ?? '')}</span>
          ${rate}
        </span>
        <span class="mock-peek-go" aria-hidden="true"><svg viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
      </button>
    </div>

    <div class="mock-full">
      <div class="mock-hero ${photoUrl ? '' : 'empty'}" ${photoUrl ? html`style="background-image:url('${esc(photoUrl)}')"` : ''}>
        ${photoUrl ? '' : PIN_SVG}
        <div class="mock-hero-btns">
          <button class="mock-round" data-action="pick-mock-collapse" aria-label="Свернуть">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <span class="mock-hero-gap"></span>
          <button class="mock-round ${fav ? 'on' : ''}" data-action="pick-mock-fav" data-key="${esc(c.key)}"
                  data-fav="${esc(JSON.stringify(toFav(c)))}" aria-label="В мои дома">${heart(fav)}</button>
          <button class="mock-round" data-action="pick-mock-share" data-key="${esc(c.key)}" data-name="${esc(c.name)}" data-address="${esc(c.address)}" aria-label="Поделиться">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M5 13v6h14v-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        ${c.photo ? html`<span class="mock-credit">${esc(c.photo.credit)}</span>` : ''}
      </div>

      <div class="mock-sheet-card">
        ${wipBadge('pickMock')}
        <div class="mock-title">${esc(c.name)}</div>
        <div class="mock-peek-place">${esc(c.district ?? '')}</div>
        ${rate}

        <div class="mock-tabs" role="tablist">
          ${TABS.map(([id, label], i) => html`
            <button class="chip ${i === 0 ? 'sel' : ''}" role="tab" data-action="pick-mock-tab" data-tab="${id}">${esc(label)}</button>`).join('')}
        </div>

        <section class="mock-tab" data-tab="about">
          <div class="mock-stats">
            ${cost ? html`<div><b>${esc(cost.replace('от ', ''))}</b><span>Цена от</span></div>` : ''}
            <!-- Рейтинг уже стоит под названием — вместо него примерная оплата ЖКУ (владелец 29.09) -->
            ${c.utilities ? html`<div><b>≈ ${esc(c.utilities.toLocaleString('ru-RU'))} ₽</b><span>ЖКУ в месяц</span></div>` : ''}
            <div><b>${c.grocery ? 'Есть' : 'Нет'}</b><span>Продуктовый</span></div>
          </div>
          <div class="pick-card mock-line">
            <span class="mock-line-ic">${PLACE_ICON}</span>
            <span><b>${esc(c.address)}</b><small>${esc([c.microdistrict, c.district, 'Ростов-на-Дону'].filter(Boolean).join(', '))}</small></span>
          </div>
          ${c.developer ? html`
            <button class="pick-card mock-line" data-action="pick-mock-tab" data-tab="developer">
              <span class="mock-line-ic">${HOUSE_ICON}</span>
              <span><small>Застройщик</small><b>${esc(c.developer)}</b></span>
              <span class="mock-peek-go" aria-hidden="true"><svg viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            </button>` : ''}
          ${c.blurb ? html`<div class="mock-blurb">${esc(c.blurb)}</div>` : ''}
          ${c.reviews[0] ? html`
            <div class="mock-sub-head">
              <h2>Отзывы жителей</h2>
              <button class="link-btn" data-action="pick-mock-tab" data-tab="reviews">${esc(reviews)} ›</button>
            </div>
            ${reviewCard(c.reviews[0])}` : ''}
        </section>

        <section class="mock-tab" data-tab="reviews" hidden>
          ${c.reviews.map(reviewCard).join('')}
          <button class="mock-add" data-action="pick-mock-review">+ Оставить отзыв</button>
        </section>

        <section class="mock-tab" data-tab="developer" hidden>
          <div class="pick-card">
            <div class="pick-row"><span>Застройщик</span><b>${esc(c.developer ?? '—')}</b></div>
            ${cost ? html`<div class="pick-row"><span>Цена</span><b>${esc(cost)}</b></div>` : ''}
          </div>
          ${avito ? html`
            <div class="mock-compare">
              <span>Сравнить с актуальными объявлениями</span>
              <button class="mock-compare-btn" data-action="pick-listing" data-url="${esc(avito.url)}">${esc(avito.label)} ↗</button>
            </div>` : ''}
        </section>

        <section class="mock-tab" data-tab="infra" hidden>
          ${c.tags.length
            ? html`<div class="mock-tags">${c.tags.map((t) => html`<span class="mock-tag">${esc(t)}</span>`).join('')}</div>`
            : '<div class="pick-muted">Пока нет данных</div>'}
        </section>

        ${c.similar.length ? html`
          <div class="mock-sub-head"><h2>Похожие ЖК</h2></div>
          ${c.similar.map((s) => html`
            <button class="pick-card mock-row" data-action="pick-open" data-key="${esc(s.key)}">
              <span class="mock-row-top"><b>${esc(s.name)}</b>${stars(s.rating)}</span>
              <span class="mock-place">${esc([s.microdistrict, s.developer].filter(Boolean).join(' · '))}</span>
            </button>`).join('')}` : ''}
      </div>
    </div>`;
}

/** Строка «Списка» и «Моих домов» — как карточка в конце макета */
/** «800 м», «4,2 км», «37 км» — до ЖК от точки, где смотрели карту */
function distanceLabel(km) {
  if (km < 1) return `${Math.max(100, Math.round(km * 10) * 100)} м`;
  return `${km < 10 ? km.toFixed(1).replace('.', ',') : Math.round(km)} км`;
}

export function mockRow(c) {
  const cost = price(c.priceFrom);
  return html`
    <button class="pick-card mock-row" data-action="pick-open" data-key="${esc(c.key)}">
      <span class="mock-row-top"><b>${esc(c.name)}</b>${stars(c.rating)}</span>
      <span class="mock-place">${esc([
        c.distanceKm != null ? distanceLabel(c.distanceKm) : null, c.microdistrict, c.developer,
      ].filter(Boolean).join(' · '))}</span>
      ${c.grocery || cost ? html`
        <span class="mock-row-meta">
          ${c.grocery ? html`<span class="mock-chip">${CART} Продуктовый рядом</span>` : ''}
          ${cost ? html`<span>${esc(cost)}</span>` : ''}
        </span>` : ''}
      ${c.quote ? html`<span class="mock-quote">«${esc(c.quote)}»</span>` : ''}
    </button>`;
}

export async function handleMockAction(action, target, ctx) {
  switch (action) {
    case 'pick-mock-close':
      closeMockSheet();
      return true;

    case 'pick-mock-expand':
      expandMockSheet();
      return true;

    case 'pick-mock-collapse':
      // Отдельной страницей (pick-house) шторки нет — «назад» уводит с экрана
      if (sheet) collapseMockSheet();
      else await ctx?.back();
      return true;

    case 'pick-mock-tab': {
      const card = target.closest('.mock-sheet-card');
      if (!card) return true;
      const tab = target.dataset.tab;
      card.querySelectorAll('.mock-tabs .chip').forEach((c) => c.classList.toggle('sel', c.dataset.tab === tab));
      card.querySelectorAll('.mock-tab').forEach((s) => { s.hidden = s.dataset.tab !== tab; });
      card.querySelector('.mock-tabs')?.scrollIntoView({ block: 'nearest' });
      return true;
    }

    case 'pick-mock-share': {
      /**
       * Ссылка открывает именно этот ЖК (deeplink.js, `p_<slug>`). Через бота
       * MAX — приложение живёт там, и на бою вход из браузера закрыт;
       * бота нет (локальный стенд) — тот же параметр в адресе сайта.
       */
      const payload = `p_${target.dataset.key.replace(/^mock:/, '')}`;
      const bot = await api.config().then((c) => c.botUsername).catch(() => null);
      const link = bot
        ? `https://max.ru/${bot}?startapp=${payload}`
        : `${location.origin}/?startapp=${payload}`;
      const text = `${target.dataset.name}, ${target.dataset.address} — отзывы жителей в приложении «Домовой»: ${link}`;
      try {
        if (!(await platform.share(text))) toast('Ссылка скопирована');
      } catch {
        // Закрыл окно «Поделиться» — это не ошибка
      }
      return true;
    }

    case 'pick-mock-fav': {
      const key = target.dataset.key;
      const list = readFav();
      const on = !list.some((c) => c.key === key);
      writeFav(on ? [...list, JSON.parse(target.dataset.fav)] : list.filter((c) => c.key !== key));
      target.classList.toggle('on', on);
      target.innerHTML = heart(on);
      platform.haptic('light');
      toast(on ? 'Добавлено в «Мои дома»' : 'Убрано из «Моих домов»');
      return true;
    }
    case 'pick-mock-review':
      toast('Отзывы о ЖК пока примерные — оставить свой можно будет позже');
      return true;
    default:
      return false;
  }
}
