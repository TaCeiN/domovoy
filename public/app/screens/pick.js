import { api } from '../api.js';
import { platform } from '../platform.js';
import { html, esc, setHtml, toast, withLoading, plural } from '../ui.js';
import {
  renderMockCard, mockRow, mockFavorites, handleMockAction,
  mockSheetHtml, mountMockSheet, unmountMockSheet, openMockSheet, closeMockSheet, collapseMockSheet,
  mockSheetState, mockSheetTop,
} from './pick-mock.js';
import { PIN_SVG } from './pick-icons.js';

/**
 * Подбор дома: карта многоквартирных домов, карточка дома, отзыв, «Мои дома».
 *
 * Открывается и гостю из MAX без квитанции: сервер пускает по подписи
 * initData, а сессии у такого человека нет — поэтому экран не трогает
 * `state.me` нигде, кроме необязательного старта с дома жителя.
 *
 * Карта — тот же Leaflet из public/vendor/, что и карта покрытия
 * оператора. Кружки на мелком масштабе считает сервер: плагин кластеров
 * не нужен, а в мессенджер не уходят десятки тысяч точек.
 */

const FORM_LABEL = {
  uk: 'Управляющая компания',
  tsj: 'ТСЖ',
  zhsk: 'ЖСК',
  direct: 'Непосредственное управление',
  unknown: 'Способ управления неизвестен',
};
const ASPECTS = [
  ['uk', 'Работа УК'], ['clean', 'Чистота подъезда'], ['neighbors', 'Соседи'],
  ['quiet', 'Тишина'], ['yard', 'Двор и парковка'],
];
const NEAR = [
  ['shop', 'Продуктовый магазин'], ['pharmacy', 'Аптека'], ['school', 'Школа'],
  ['kindergarten', 'Детский сад'], ['stop', 'Остановка'],
];
const SPEED = {
  day: 'Отвечают обычно в течение дня',
  days: 'Отвечают обычно за 1–3 дня',
  slow: 'Отвечают обычно дольше 3 дней',
};

/**
 * Старт без квитанции и без геопозиции — центр Ростова-на-Дону: сегодня
 * загружен один регион. С новым регионом старт не меняется — человек
 * сразу ищет свой город поиском или кнопкой «◎».
 */
const DEFAULT_VIEW = { lat: 47.2357, lon: 39.7015, zoom: 12 };

/** Место карты переживает уход в карточку дома и возврат */
let view = null;
/** Дома видимой области — для экрана «Список» */
let visibleHouses = [];
/** ЖК заглушки видимой области — для «Списка» (docs/mock-complexes.md) */
let visibleComplexes = [];
/** Ключ ЖК, чья шторка открыта: после «Списка» и «Моих домов» она снова внизу */
let selectedMock = null;
/** Карта показывает ЖК заглушки, а не дома — от этого зависят подсказки «Списка» */
let mockMode = false;
let map = null;
/** Свой дом человека — метка «Ваш дом», чтобы на карте было от чего отсчитывать */
let homeAt = null;
/** Где человек смотрел карту в последний раз — от этой точки считается список ЖК */
let lastCenter = null;
/**
 * Дом, чья плашка открыта. Переживает уход в подробную карточку:
 * после «Назад» человек видит ту же плашку, а не пустую карту.
 */
let selected = null;

/** Сердце — та же форма, что у кнопки «Мои дома» на карте: контур, пока дом не в избранном */
const HEART_PATH = 'M12 20.3s-7.8-4.6-7.8-10.2A4.6 4.6 0 0 1 12 7a4.6 4.6 0 0 1 7.8 3.1c0 5.6-7.8 10.2-7.8 10.2z';
const heartIcon = (on) => (on
  ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${HEART_PATH}" fill="currentColor"/></svg>`
  : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${HEART_PATH}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`);

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function ratingColor(rating) {
  // Дом без отзывов — фирменный синий, как в макете; оценка красит только дома с отзывами
  if (rating === null || rating === undefined) return cssVar('--accent') || '#007AFF';
  if (rating >= 4) return cssVar('--positive');
  if (rating >= 3) return cssVar('--attention');
  return cssVar('--negative');
}

function ratingLine(rating, count) {
  if (!count) return 'Отзывов пока нет';
  return `★ ${rating.toFixed(1)} · ${count} ${plural(count, 'отзыв', 'отзыва', 'отзывов')}`;
}

/** Без области: «г Аксай, ул Мира, д. 1» */
function shortAddress(address) {
  return address.split(',').map((p) => p.trim())
    .filter((p) => !/^(обл|край|респ|АО|аобл)(\s|\.|$)/i.test(p)).join(', ');
}

function meters(m) {
  if (m === null || m === undefined) return 'дальше 1,5 км';
  return m < 1000 ? `${m} м` : `${(m / 1000).toFixed(1).replace('.', ',')} км`;
}

function debounce(fn, ms) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'vendor/leaflet/leaflet.css';
    document.head.append(css);
    const script = document.createElement('script');
    script.src = 'vendor/leaflet/leaflet.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Карта не загрузилась'));
    document.head.append(script);
  });
}

/* ─────────────── карта ─────────────── */

export function renderPick() {
  return html`
    <div class="pick">
      <div class="pick-search">
        <label class="pick-field">
          <svg class="pick-field-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="m15.5 15.5 5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          <input id="pickQuery" type="search" placeholder="Улица и номер дома" autocomplete="off"
                 enterkeyhint="search" aria-label="Улица и номер дома">
          <button class="pick-clear" data-action="pick-clear" aria-label="Очистить" hidden>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5L15 15M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </label>
        <!--
          Только у заглушки ЖК: что показать на карте — ЖК или районы
          (референс владельца 29.09). Слой карты, а не второй вид приложения.
        -->
        <div class="pick-suggest" id="pickSuggest" hidden></div>
      </div>
      <div class="pick-map" id="pickMap"></div>
      <div class="pick-hint" id="pickHint" hidden>Приблизьте карту, чтобы увидеть дома</div>
      <div class="pick-sheet" id="pickSheet" aria-hidden="true"></div>
      ${mockSheetHtml()}
      <div class="pick-tools">
        <button class="pick-tool" data-action="pick-favorites" aria-label="Мои дома">
          ${heartIcon(true)}
        </button>
        <button class="pick-tool" data-action="pick-list" aria-label="Дома списком">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5h11M9 12h11M9 17.5h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="4.5" cy="6.5" r="1.4" fill="currentColor"/><circle cx="4.5" cy="12" r="1.4" fill="currentColor"/><circle cx="4.5" cy="17.5" r="1.4" fill="currentColor"/></svg>
        </button>
      </div>
    </div>`;
}

async function startView(state) {
  const key = state.currentProperty?.houseKey;
  if (key && homeAt?.key !== key) {
    const own = await api.pickHouse(key).catch(() => null);
    homeAt = own?.lat ? { key, lat: own.lat, lon: own.lon } : null;
  }
  if (view) return view;
  /*
   * 14, а не 16: на 16 в кадре пара улиц и ни одного ЖК — ближайший
   * в 800 м, — и карта выглядела пустой (30.09). На 14 видно округу.
   */
  if (homeAt) return { lat: homeAt.lat, lon: homeAt.lon, zoom: 14 };
  return null;
}

/**
 * Кнопки карты не прячутся под плашкой, а поднимаются над ней.
 * Считаем по раскладке (offsetTop), а не по getBoundingClientRect:
 * у кнопок уже может стоять сдвиг, и он исказил бы расчёт.
 */
function liftTools(host) {
  const sheet = host.querySelector('#pickSheet');
  const tools = host.querySelector('.pick-tools');
  if (!sheet || !tools) return;
  // Верх того, что закрывает низ карты: плашка дома или шторка ЖК на трети
  const top = sheet.classList.contains('open') ? sheet.offsetTop : mockSheetTop();
  const gap = 12;
  const lift = top !== null ? (tools.offsetTop + tools.offsetHeight) - (top - gap) : 0;
  tools.style.transform = lift > 0 ? `translateY(${-lift}px)` : '';
}

function hideSheet(host) {
  selected = null;
  const sheet = host.querySelector('#pickSheet');
  if (!sheet) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  liftTools(host);
}

function showSheet(host, h) {
  const sheet = host.querySelector('#pickSheet');
  if (!sheet) return;
  selected = h;
  const facts = [h.builtYear ? `${h.builtYear} г.` : null, h.floors ? `${h.floors} ${plural(h.floors, 'этаж', 'этажа', 'этажей')}` : null]
    .filter(Boolean).join(' · ');
  setHtml(sheet, html`
    <div class="pick-sheet-addr">${esc(shortAddress(h.address))}</div>
    ${facts ? html`<div class="pick-sheet-meta">${esc(facts)}</div>` : ''}
    <div class="pick-sheet-meta">${esc(ratingLine(h.rating, h.reviews))}</div>
    <button class="btn-primary" data-action="pick-open" data-key="${esc(h.houseKey)}">Подробнее</button>`);
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
  liftTools(host);
}

/* ─────────────── активный ЖК: перелёт и выделение ─────────────── */

/** Где активный ЖК — чтобы после «Списка» вернуть к нему карту без запроса карточки */
let selectedAt = null;
/**
 * Метки ЖК по ключу: выделить активную можно без перерисовки всего слоя.
 *
 * ЖК — обычные метки Leaflet (элементы), а не точки на холсте, как у домов.
 * Холст во время перелёта растягивается вместе с масштабом, и точки
 * раздувались в огромные круги; метки же Leaflet переставляет каждый кадр
 * в своём размере. ЖК в заглушке десятки — элементы им по карману;
 * тысячи настоящих домов остаются на холсте.
 */
const mockMarkers = new Map();

/**
 * Слипшиеся ЖК на среднем масштабе (просьба владельца 27.09).
 *
 * Дома группирует сервер (lib/pick/houses.ts), а ЖК заглушки приходят все
 * точками. Группируем здесь: жадно, по экранным пикселям текущего масштаба,
 * и ТОЛЬКО внутри одного района (28.09): кружок не должен собирать ЖК
 * с двух сторон границы. Выбранный ЖК всегда стоит отдельно — его шторка
 * открыта, метку прятать нельзя. На совсем отдалённой карте вместо этого —
 * районы целиком (drawDistricts).
 */
const MOCK_CLUSTER_PX = 44;

function groupByPixels(items, m, radius) {
  const zoom = m.getZoom();
  const groups = [];
  for (const item of items) {
    const p = m.project([item.lat, item.lon], zoom);
    const own = item.key === selectedMock;
    const near = own ? null
      : groups.find((g) => !g.own && g.district === item.district && g.p.distanceTo(p) < radius);
    if (near) near.items.push(item);
    else groups.push({ p, own, district: item.district, items: [item] });
  }
  return groups.map((g) => g.items);
}
/** Район из поиска, чьи ЖК подсветить, когда карта их перерисует */
let pendingFlash = null;
const FLASH_MS = 2000;

/* ─────────────── районы на отдалённой карте (просьба владельца 28.09) ─────────────── */

/**
 * До этого масштаба включительно карта показывает районы, а не ЖК:
 * цветная граница каждого района и плашка «Советский · 4 ЖК» в нём.
 * Ближе — плашки уходят, остаются тонкие границы районов и ЖК.
 */
const DISTRICT_ZOOM = 12;
/** Цвета районов по порядку — яркие, различимые и на светлой, и на тёмной карте */
const DISTRICT_COLORS = ['#5398FF', '#03B820', '#FF832A', '#8C5BFF', '#FF48B6', '#0EB5C4', '#D9A400', '#E5484D'];
/** Районы с границами — один раз за открытие подбора; `[]`, если заглушки ЖК нет */
let districts = null;
let districtsLoad = null;
/**
 * Район, в который вошли поиском или нажатием: остальные районы скрыты,
 * видны ЖК, граница вспыхивает один раз. Отдалил карту дальше, чем
 * встал район, — снова все районы.
 */
let focusDistrict = null;
/** Район, чью границу подсветить, когда карта долетит и перерисуется */
let pendingArea = null;
let districtRenderer = null;
let flashRenderer = null;
let reloadMap = null;

function loadDistricts() {
  districtsLoad ??= api.pickDistricts()
    .then((r) => { districts = r.districts ?? []; return districts; })
    .catch(() => { districtsLoad = null; return []; });
  return districtsLoad;
}

const districtShort = (name) => name.replace(/\s*район$/i, '');

/**
 * Районы на карте — всегда (просьба владельца 28.09, вторая правка).
 *
 * Район выглядит одинаково на любом масштабе — граница с заливкой
 * (владелец 28.09). Отдалённо (`labels`) поверх — плашка «Советский ·
 * 4 ЖК», нажатие входит в район. Близко плашек нет, видны ЖК, а касание
 * района не перехватывает касание карты. `only` — вошли в район
 * (поиском или нажатием): он один, остальных нет.
 */
function drawDistricts(host, layer, { labels, only }) {
  const L = window.L;
  districts.forEach((d, i) => {
    if (only && d.name !== only) return;
    const color = DISTRICT_COLORS[i % DISTRICT_COLORS.length];
    const area = L.geoJSON(d.geometry, {
      renderer: districtRenderer, interactive: labels, bubblingMouseEvents: false,
      style: { color, weight: 2, opacity: 0.9, fillColor: color, fillOpacity: 0.14 },
    });
    if (labels) area.on('click', () => enterDistrict(host, d));
    area.addTo(layer);
    if (!labels) return;
    const count = d.count ? `${d.count} ЖК` : 'ЖК нет';
    L.marker([d.label.lat, d.label.lon], {
      icon: L.divIcon({
        className: 'district-pin',
        html: `<div style="--dc:${color}"><b>${esc(districtShort(d.name))}</b><span>${esc(count)}</span></div>`,
        iconSize: null,
      }),
      keyboard: false,
    })
      .on('click', () => enterDistrict(host, d))
      .addTo(layer);
  });
}

/**
 * Войти в район: карта охватывает его целиком, остальные районы уходят,
 * граница вспыхивает один раз, ЖК района — тоже.
 */
function enterDistrict(host, d) {
  if (!map) return;
  const L = window.L;
  hideSheet(host);
  closeMockSheet();
  const bounds = L.latLngBounds([[d.bbox.south, d.bbox.west], [d.bbox.north, d.bbox.east]]);
  const fits = map.getBoundsZoom(bounds, false, L.point(40, 40));
  /*
   * Район влезает в экран — показываем его целиком. Не влезает (у Советского
   * граница уходит далеко на запад, в поля) — не отлетаем до масштаба, где
   * ЖК слипаются в точку: смотрим на его ЖК, граница вспыхнет по краям.
   */
  const zoom = Math.min(Math.max(fits, DISTRICT_ZOOM), 15);
  const center = fits < DISTRICT_ZOOM && d.focus ? L.latLng(d.focus.lat, d.focus.lon) : bounds.getCenter();
  focusDistrict = { name: d.name, zoom };
  pendingArea = d.geometry ? d : null;
  pendingFlash = d.name;
  if (map.getZoom() === zoom && map.getCenter().distanceTo(center) < 50) {
    reloadMap?.(); // карта уже там — moveend не придёт, перерисовать самим
  } else if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    map.setView(center, zoom, { animate: false });
  } else {
    map.flyTo(center, zoom, { duration: 0.7 });
  }
}

/**
 * Вспышка границы района. Анимируется прозрачность целого слоя карты
 * (`.leaflet-districtFlash-pane`), а не заливка фигуры внутри SVG: фигуры
 * браузер анимирует на основном потоке — на слабых телефонах это рывки.
 */
function flashArea(d) {
  const L = window.L;
  const pane = map.getPane('districtFlash');
  const accent = cssVar('--accent') || '#471AFF';
  const area = L.geoJSON(d.geometry, {
    renderer: flashRenderer, interactive: false,
    style: { color: accent, weight: 3, opacity: 1, fillColor: accent, fillOpacity: 0.22 },
  }).addTo(map);
  pane.classList.remove('flash');
  void pane.offsetWidth;
  pane.classList.add('flash');
  setTimeout(() => {
    area.remove();
    pane.classList.remove('flash');
  }, 2300);
}

/**
 * Активный ЖК — метка мягкого фиолетового цвета и чуть крупнее: человек видит,
 * чья шторка открыта. Цвет и размер — в CSS (`.mock-pin.active`).
 */
function markActive() {
  for (const [key, marker] of mockMarkers) {
    const active = key === selectedMock;
    marker.getElement()?.classList.toggle('active', active);
    marker.setZIndexOffset(active ? 1000 : 0);
  }
}

/** ЖК выбранного в поиске района один раз вспыхивают — видно, где они */
function flashDistrict(name) {
  for (const marker of mockMarkers.values()) {
    if (marker.options.district !== name) continue;
    const el = marker.getElement();
    if (!el) continue;
    el.classList.remove('flash');
    void el.offsetWidth; // перезапуск анимации, если класс уже стоял
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), FLASH_MS);
  }
}

/**
 * Карта летит к ЖК и ставит его в верхнюю треть: нижнюю закрывает шторка.
 * Недалеко и на том же масштабе — просто плавный сдвиг, иначе — перелёт
 * с отдалением; при «уменьшении движения» в системе — сразу, без анимации.
 */
function flyToMock(lat, lon) {
  if (!map) return;
  const zoom = Math.max(map.getZoom(), 15);
  const h = map.getSize().y;
  const target = map.unproject(map.project([lat, lon], zoom).add([0, h * 0.17]), zoom);
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) map.setView(target, zoom, { animate: false });
  else if (zoom === map.getZoom()) map.panTo(target, { animate: true, duration: 0.6 });
  else map.flyTo(target, zoom, { duration: 0.8 });
}

/**
 * ЖК на карте — шторка снизу (pick-mock.js) вместо плашки дома.
 * Точка известна (касание, поиск) — летим сразу; нет («Похожие ЖК»,
 * «Мои дома») — после того как карточка пришла с координатами.
 * `peek` — открыть мини-карточку, даже если шторка была раскрыта (выбор из поиска).
 */
async function showMock(host, key, at = null, { peek = false } = {}) {
  selectedMock = key;
  hideSheet(host);
  if (at) {
    selectedAt = at;
    markActive();
    flyToMock(at.lat, at.lon);
  }
  const card = await openMockSheet(key, { peek });
  if (!card || selectedMock !== key || at) return;
  selectedAt = { lat: card.lat, lon: card.lon };
  markActive();
  flyToMock(card.lat, card.lon);
}

async function loadHouses(host, layer) {
  if (!map) return;
  const L = window.L;
  const b = map.getBounds();
  const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(',');
  let answer;
  try {
    answer = await api.pickHouses(bbox, map.getZoom());
    if (answer.kind === 'complexes') await loadDistricts();
  } catch (error) {
    toast(error.message);
    return;
  }
  if (!map) return;

  layer.clearLayers();
  const c = map.getCenter();
  lastCenter = { lat: c.lat, lon: c.lng };
  host.querySelector('#pickHint').hidden = answer.kind !== 'zoom_in';
  visibleHouses = answer.kind === 'houses' ? answer.houses : [];
  visibleComplexes = answer.kind === 'complexes' ? answer.complexes : [];
  mockMode = answer.kind === 'complexes';
  if (answer.kind === 'complexes') {
    const input = host.querySelector('#pickQuery');
    input.placeholder = 'Район или ЖК';
    input.setAttribute('aria-label', 'Район или ЖК');
  }

  mockMarkers.clear();
  const zoom = map.getZoom();
  // Отдалил карту дальше, чем встал выбранный район, — снова все районы
  if (focusDistrict && zoom < focusDistrict.zoom) focusDistrict = null;
  // Районы — всегда; плашки вместо ЖК — только отдалённо и не внутри выбранного района.
  // Переключателя «ЖК / Районы» нет (30.09): масштаб сам решает, что показать
  const labels = !focusDistrict && zoom <= DISTRICT_ZOOM;
  if (answer.kind === 'complexes' && districts?.length) drawDistricts(host, layer, { labels, only: focusDistrict?.name });
  const showDistricts = answer.kind === 'complexes' && districts?.length && labels;
  if (answer.kind === 'complexes' && !showDistricts) {
    if (pendingArea) {
      flashArea(pendingArea);
      pendingArea = null;
    }
    for (const group of groupByPixels(answer.complexes, map, MOCK_CLUSTER_PX)) {
      if (group.length > 1) {
        // Слипшиеся ЖК — кружок с числом; нажатие приближает к ним, и они расходятся
        const bounds = L.latLngBounds(group.map((c) => [c.lat, c.lon]));
        L.marker(bounds.getCenter(), {
          icon: L.divIcon({ className: 'pick-cluster mock-cluster', html: `<span>${group.length}</span>`, iconSize: [40, 40] }),
          keyboard: false,
        })
          .on('click', () => map.flyToBounds(bounds, { padding: [70, 70], maxZoom: 17, duration: 0.6 }))
          .addTo(layer);
        continue;
      }
      const [c] = group;
      // Клик метки Leaflet до карты не всплывает (bubblingMouseEvents у неё false) — шторка не закроется
      const marker = L.marker([c.lat, c.lon], {
        // Иконка владельца, а не цвет рейтинга: рейтинг — в плашке, метка — «здесь ЖК» (29.09)
        icon: L.divIcon({
          className: `mock-pin${c.key === selectedMock ? ' active' : ''}`,
          html: `<span class="mock-pin-halo"></span>${PIN_SVG}`,
          iconSize: [36, 36],
        }),
        keyboard: false,
        district: c.district,
      })
        .on('click', () => showMock(host, c.key, { lat: c.lat, lon: c.lon }))
        .addTo(layer);
      mockMarkers.set(c.key, marker);
    }
    markActive();
    if (pendingFlash) {
      flashDistrict(pendingFlash);
      pendingFlash = null;
    }
  }

  if (answer.kind === 'clusters') {
    for (const c of answer.clusters) {
      L.marker([c.lat, c.lon], {
        icon: L.divIcon({ className: 'pick-cluster', html: `<span>${c.count}</span>`, iconSize: [40, 40] }),
      })
        .on('click', () => map.setView([c.lat, c.lon], Math.min(map.getZoom() + 2, 16)))
        .addTo(layer);
    }
  }
  if (answer.kind === 'houses') {
    for (const h of answer.houses) {
      /**
       * Тень — тёмный полупрозрачный кружок под точкой, а не CSS-фильтр
       * drop-shadow: размытие по всему слою пересчитывалось на каждой
       * перерисовке и рвало анимации на слабых телефонах.
       */
      L.circleMarker([h.lat, h.lon], {
        radius: 11, stroke: false, fillColor: '#000', fillOpacity: 0.18, interactive: false,
      }).addTo(layer);
      /**
       * bubblingMouseEvents: false обязателен. У векторной метки Leaflet клик
       * по умолчанию всплывает до карты, а клик по карте прячет плашку —
       * плашка показывалась и пряталась в одно касание, и дом не открывался.
       */
      L.circleMarker([h.lat, h.lon], {
        radius: 8, weight: 3, color: '#fff', fillColor: ratingColor(h.rating), fillOpacity: 1,
        bubblingMouseEvents: false,
      })
        .on('click', () => showSheet(host, h))
        .addTo(layer);
    }
  }
}

const bboxAttr = (b) => esc([b.south, b.west, b.north, b.east].join(','));

function renderSuggest(box, result) {
  const rows = [
    // Районы — только у заглушки ЖК (docs/mock-complexes.md): карта охватывает их ЖК
    ...(result.districts ?? []).map((d) => html`
      <button class="pick-suggest-row" data-action="pick-district" data-bbox="${bboxAttr(d.bbox)}"
              data-district="${esc(d.district)}">
        <span class="pick-suggest-main">${esc(d.district)}</span>
        <span class="pick-suggest-sub">${esc(d.count)} ЖК</span>
      </button>`),
    // ЖК не уводит с карты: она летит к нему и открывает шторку
    ...result.houses.map((h) => html`
      <button class="pick-suggest-row" data-action="${h.label === 'ЖК' ? 'pick-mock-show' : 'pick-open'}"
              data-key="${esc(h.houseKey)}" data-lat="${esc(h.lat ?? '')}" data-lon="${esc(h.lon ?? '')}">
        <span class="pick-suggest-main">${esc(shortAddress(h.address))}</span>
        <span class="pick-suggest-sub">${esc(h.label ?? 'дом')}</span>
      </button>`),
    ...result.streets.map((s) => html`
      <button class="pick-suggest-row" data-action="pick-street"
              data-bbox="${s.bbox ? bboxAttr(s.bbox) : ''}">
        <span class="pick-suggest-main">${esc(s.label)}</span>
        <span class="pick-suggest-sub">${s.bbox ? 'улица' : 'улица · домов на карте нет'}</span>
      </button>`),
  ];
  setHtml(box, rows.length ? rows.join('') : '<div class="pick-suggest-empty">Ничего не нашлось</div>');
  box.hidden = false;
}

/** Карта рисуется после разметки. Возвращает уборку для `state.cleanup`. */
export async function mountPick(host, state) {
  /**
   * Карта во всю страницу, без прокрутки. Пока страница была выше экрана,
   * касание карты отдавало ей фокус (Leaflet ставит tabindex), браузер
   * докручивал страницу — и строка с названием уезжала за край.
   */
  host.classList.add('pick-page');
  try {
    await loadLeaflet();
  } catch (error) {
    toast(error.message);
    return () => {};
  }
  const el = host.querySelector('#pickMap');
  if (!el) return () => {};

  const L = window.L;
  const start = await startView(state);
  const at = start ?? DEFAULT_VIEW;
  /**
   * preferCanvas: сотни точек домов рисуются на одном холсте, а не сотнями
   * SVG-элементов. Так дешевле и двигать карту, и держать её под выезжающей
   * карточкой дома на слабом телефоне.
   */
  const m = L.map(el, { zoomControl: false, preferCanvas: true }).setView([at.lat, at.lon], at.zoom);
  /*
   * Без префикса «Leaflet» с флагом: лицензия библиотеки (BSD) подписи на
   * карте не требует. Обязательна подпись данных — «© OpenStreetMap»
   * (ODbL), она ниже, у слоя тайлов, и остаётся.
   */
  m.attributionControl.setPrefix(false);
  map = m;
  /*
   * Карта всегда светлая, и в тёмной теме приложения тоже (владелец
   * 28.09): приглушённые тайлы читались хуже, а цветные районы на них
   * тускнели. Раньше тут стоял класс `.dim` с прозрачностью тайлов.
   */
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap',
  }).addTo(map);
  /*
   * Районы — своими слоями под метками ЖК (600) и над тайлами (200).
   * SVG, а не общий холст карты: холст при перелёте растягивается вместе
   * с масштабом, а граница района должна ехать ровно по улицам.
   */
  m.createPane('districts').style.zIndex = 390;
  m.createPane('districtFlash').style.zIndex = 395;
  districtRenderer = L.svg({ pane: 'districts' });
  flashRenderer = L.svg({ pane: 'districtFlash' });
  const layer = L.layerGroup().addTo(map);
  if (homeAt) {
    L.marker([homeAt.lat, homeAt.lon], {
      icon: L.divIcon({ className: 'home-pin', html: '<span>Ваш дом</span>', iconSize: [0, 0] }),
      interactive: false, keyboard: false, zIndexOffset: -500,
    }).addTo(map);
  }

  const reload = debounce(() => loadHouses(host, layer), 250);
  reloadMap = reload;
  m.on('moveend', () => {
    if (map !== m) return;
    const c = m.getCenter();
    view = { lat: c.lat, lon: c.lng, zoom: m.getZoom() };
    reload();
  });
  mountMockSheet(host, (state) => {
    if (state === 'closed') {
      selectedMock = null;
      selectedAt = null;
      markActive();
    }
    liftTools(host);
  });
  // Касание пустого места карты — плашку и шторку закрыть
  m.on('click', () => {
    hideSheet(host);
    closeMockSheet();
  });
  /**
   * Выбранный дом ушёл за край карты — человек пошёл смотреть другие,
   * плашка про ушедший дом больше не нужна.
   */
  m.on('move', () => {
    if (map !== m || !selected) return;
    if (!m.getBounds().contains([selected.lat, selected.lon])) hideSheet(host);
  });
  loadHouses(host, layer);
  // Вернулись из подробной карточки — та же плашка снова внизу
  if (selected) showSheet(host, selected);
  // Вернулись из «Списка» или «Моих домов» — к тому ЖК, что там выбрали
  if (selectedMock) showMock(host, selectedMock, selectedAt);

  const input = host.querySelector('#pickQuery');
  const box = host.querySelector('#pickSuggest');
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { box.hidden = true; return; }
    try {
      renderSuggest(box, await api.pickSearch(q));
    } catch (error) {
      toast(error.message);
    }
  }, 300);
  input.addEventListener('input', search);
  // Крестик — только когда есть что стирать
  const clear = host.querySelector('.pick-clear');
  input.addEventListener('input', () => { clear.hidden = !input.value; });
  // Начал набирать — ищет другое: карточка дома уходит, остаются поиск и карта
  input.addEventListener('input', () => {
    if (!input.value.trim()) return;
    if (mockSheetState() !== 'closed') closeMockSheet();
    hideSheet(host);
  });

  /**
   * Уборка зовётся В НАЧАЛЕ смены экрана, а старый экран ещё виден весь
   * переход (карточка дома выезжает поверх карты). Снести карту сразу —
   * на её месте серый прямоугольник. Отцепляем сразу, удаляем после.
   */
  return () => {
    const leaving = map;
    map = null;
    unmountMockSheet();
    // Точки принадлежали уходящей карте — на новой их нарисуют заново
    mockMarkers.clear();
    setTimeout(() => leaving?.remove(), 600);
  };
}

/* ─────────────── карточка дома ─────────────── */

function starsRow(value) {
  const full = Math.round(value ?? 0);
  return '★★★★★'.slice(0, full) + '☆☆☆☆☆'.slice(0, 5 - full);
}

function passportRows(p) {
  const rows = [
    ['Год постройки', p.builtYear],
    ['Этажей', p.floors],
    ['Квартир', p.flats],
    ['Подъездов', p.entrances],
    ['Лифтов', p.elevators],
    ['Стены', p.wallMaterial],
    ['Газ в доме', p.gas === null ? null : p.gas ? 'есть' : 'нет'],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  return rows.map(([k, v]) => html`<div class="pick-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
}

function reviewCard(r) {
  const when = new Date(r.updatedAt).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' });
  return html`
    <div class="pick-review">
      <div class="pick-review-top">
        <span class="pick-stars">${starsRow(r.overall)}</span>
        <span class="pick-review-who">Житель дома, подтверждён · ${esc(when)}</span>
      </div>
      ${r.hiddenReason ? html`<div class="pick-review-hidden">Скрыт оператором: ${esc(r.hiddenReason)}. Его видите только вы.</div>` : ''}
      ${r.pros ? html`<div class="pick-review-plus"><b>Нравится:</b> ${esc(r.pros)}</div>` : ''}
      ${r.cons ? html`<div class="pick-review-minus"><b>Не нравится:</b> ${esc(r.cons)}</div>` : ''}
    </div>`;
}

export async function renderPickHouse(state, params) {
  const h = await api.pickHouse(params.key);
  if (h.kind === 'mock') return renderMockCard(h);
  const s = h.summary;
  const m = h.management;
  const mine = h.reviews.find((r) => r.mine);

  return html`
    <div class="pick-head">
      <div>
        <div class="pick-addr">${esc(shortAddress(h.address))}</div>
        <div class="pick-sub">${esc(ratingLine(s.rating, s.count))}</div>
      </div>
      <button class="pick-fav ${h.favorite ? 'on' : ''}" data-action="pick-fav" data-key="${esc(h.houseKey)}"
              data-on="${h.favorite ? '1' : ''}" aria-label="В мои дома">${heartIcon(h.favorite)}</button>
    </div>

    ${h.passport.emergency ? html`<div class="pick-alarm">Дом признан аварийным</div>` : ''}

    ${h.canReview ? html`
      <button class="btn-primary" data-action="pick-review" data-key="${esc(h.houseKey)}">
        ${mine ? 'Изменить мой отзыв' : 'Оставить отзыв о доме'}
      </button>` : ''}

    <div class="s-label"><h2>Отзывы жителей</h2></div>
    <div class="pick-card">
      ${s.count ? ASPECTS.map(([key, label]) => html`
        <div class="pick-aspect">
          <span>${esc(label)}</span>
          <span class="pick-bar"><i style="width:${((s.aspects[key] ?? 0) / 5) * 100}%"></i></span>
          <b>${s.aspects[key]?.toFixed(1) ?? '—'}</b>
        </div>`).join('')
        : '<div class="pick-muted">Жители этого дома ещё не оставили отзывов</div>'}
    </div>
    ${h.reviews.map(reviewCard).join('')}

    ${passportRows(h.passport) ? html`
      <div class="s-label"><h2>О доме</h2></div>
      <div class="pick-card">${passportRows(h.passport)}</div>` : ''}

    <div class="s-label"><h2>Кто управляет</h2></div>
    <div class="pick-card">
      <div class="pick-row"><span>${esc(FORM_LABEL[m.form] ?? FORM_LABEL.unknown)}</span><b>${esc(m.orgName ?? '—')}</b></div>
      ${m.license ? html`<div class="pick-row"><span>Лицензия</span><b>${esc(m.license)}</b></div>` : ''}
      ${m.phone ? html`<div class="pick-row"><span>Телефон</span><b>${esc(m.phone)}</b></div>` : ''}
      ${m.hasChairman ? '<div class="pick-muted">Председатель совета дома есть в приложении</div>' : ''}
    </div>

    <div class="s-label"><h2>Обращения в УК</h2></div>
    <div class="pick-card">
      ${h.complaints.enough
        ? html`
          ${h.complaints.speed ? html`<div class="pick-line">${esc(SPEED[h.complaints.speed])}</div>` : ''}
          ${h.complaints.topCategory ? html`<div class="pick-line">Чаще всего пишут про: <b>${esc(h.complaints.topCategory.toLowerCase())}</b></div>` : ''}`
        : '<div class="pick-muted">Пока мало данных</div>'}
    </div>

    ${h.payment ? html`
      <div class="s-label"><h2>Платёж за ЖКУ</h2></div>
      <div class="pick-card">
        <div class="pick-line">В среднем ≈ <b>${esc(h.payment.toLocaleString('ru-RU'))} ₽</b> в месяц за квартиру</div>
        <div class="pick-muted">По квитанциям жителей в приложении</div>
      </div>` : ''}

    ${h.near ? html`
      <div class="s-label"><h2>Рядом</h2></div>
      <div class="pick-card">
        ${NEAR.map(([key, label]) => html`<div class="pick-row"><span>${esc(label)}</span><b>${esc(meters(h.near[key]))}</b></div>`).join('')}
        <div class="pick-muted">По прямой · © OpenStreetMap</div>
      </div>` : ''}

    <div class="s-label"><h2>Квартиры в этом доме</h2></div>
    <div class="pick-links">
      ${h.listings.map((l) => html`
        <button class="pick-link" data-action="pick-listing" data-url="${esc(l.url)}">${esc(l.label)}</button>`).join('')}
    </div>
    <div class="pick-muted pick-sources">
      Паспорт дома — реестр Фонда развития территорий. Обращения и платёж —
      по данным жителей в приложении. Цены квартир мы не показываем:
      их знают только площадки объявлений.
    </div>`;
}

/* ─────────────── отзыв ─────────────── */

export async function renderPickReview(state, params) {
  const h = await api.pickHouse(params.key);
  const mine = h.reviews.find((r) => r.mine);
  const row = ([key, label]) => {
    const value = mine?.stars[key] ?? 0;
    return html`
      <div class="pick-rate" data-aspect="${key}" data-value="${value}">
        <div class="pick-rate-label">${esc(label)}</div>
        <div class="pick-rate-stars">
          ${[1, 2, 3, 4, 5].map((n) => html`
            <button class="pick-star ${n <= value ? 'on' : ''}" data-action="pick-star" data-v="${n}"
                    aria-label="${n} из 5">★</button>`).join('')}
        </div>
      </div>`;
  };

  return html`
    <div class="pick-sub" style="margin-bottom:14px">${esc(shortAddress(h.address))}</div>
    ${ASPECTS.map(row).join('')}
    <div class="field-label" style="margin-top:18px">Что нравится</div>
    <textarea id="pickPros" maxlength="1000" rows="3" placeholder="Необязательно">${esc(mine?.pros ?? '')}</textarea>
    <div class="field-label">Что не нравится</div>
    <textarea id="pickCons" maxlength="1000" rows="3" placeholder="Необязательно">${esc(mine?.cons ?? '')}</textarea>
    <div class="pick-muted" style="margin:8px 0 14px">
      Имени и квартиры никто не увидит — только «Житель дома, подтверждён».
      Не пишите имена и номера квартир соседей.
    </div>
    <button class="btn-primary" data-action="pick-review-save" data-key="${esc(h.houseKey)}">Сохранить</button>`;
}

/* ─────────────── мои дома и список ─────────────── */

function houseRow(h) {
  return html`
    <button class="row tappable pick-list-row" data-action="pick-open" data-key="${esc(h.houseKey)}">
      <span class="pick-dot" style="background:${ratingColor(h.rating)}"></span>
      <span class="pick-list-main">
        <span class="pick-list-addr">${esc(shortAddress(h.address))}</span>
        <span class="pick-sub">${esc(ratingLine(h.rating, h.reviews))}</span>
      </span>
    </button>`;
}

export async function renderPickFavorites() {
  const { houses } = await api.pickFavorites();
  const complexes = mockFavorites();
  if (!houses.length && !complexes.length) {
    return '<div class="pick-muted">Здесь будут дома, отмеченные ♥ в карточке дома</div>';
  }
  return complexes.map(mockRow).join('') + houses.map(houseRow).join('');
}

/**
 * Список ЖК — все в радиусе LIST_RADIUS_KM от точки, где смотрели карту,
 * ближние сверху. Раньше в списке были только попавшие в видимую часть
 * карты: на приближенной карте — два-три ЖК, и казалось, что больше нет
 * (просьба владельца 27.09).
 */
const LIST_RADIUS_KM = 100;

function distanceKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

async function complexesAround(center) {
  const dLat = LIST_RADIUS_KM / 111;
  const dLon = LIST_RADIUS_KM / (111 * Math.cos(center.lat * Math.PI / 180));
  const bbox = [center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat]
    .map((n) => n.toFixed(5)).join(',');
  const answer = await api.pickHouses(bbox, 12);
  return (answer.complexes ?? [])
    .map((c) => ({ ...c, distanceKm: distanceKm(center, c) }))
    .filter((c) => c.distanceKm <= LIST_RADIUS_KM)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

export async function renderPickList() {
  if (mockMode) {
    let list = visibleComplexes;
    if (lastCenter) {
      try {
        list = await complexesAround(lastCenter);
      } catch (error) {
        toast(error.message);
      }
    }
    if (!list.length) return `<div class="pick-muted">В радиусе ${LIST_RADIUS_KM} км ЖК нет — найдите район поиском</div>`;
    return html`
      <div class="pick-muted" style="margin:0 0 10px">ЖК в радиусе ${LIST_RADIUS_KM} км, ближние сверху</div>
      ${list.map(mockRow).join('')}`;
  }
  if (!visibleHouses.length) {
    return '<div class="pick-muted">Приблизьте карту — здесь появятся дома видимой области</div>';
  }
  const sorted = [...visibleHouses].sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  return sorted.map(houseRow).join('');
}

/* ─────────────── просьба об отзыве на главной ─────────────── */

export function promptCard(prompt) {
  if (!prompt) return '';
  /*
   * Одна строка, а не карточка в полэкрана: просьба об отзыве стояла
   * выше «Моих обращений» и оттесняла главное (просьба владельца 27.09).
   */
  return html`
    <div class="pick-prompt">
      <button class="pick-prompt-row tappable" data-action="pick-prompt-open" data-key="${esc(prompt.houseKey)}">
        <span class="pick-prompt-stars" aria-hidden="true">★</span>
        <span class="pick-prompt-title">Оцените свой дом</span>
        <span class="pick-prompt-count">${prompt.reviews ? `отзывов ${esc(prompt.reviews)}` : 'будете первым'}</span>
      </button>
      <button class="pick-prompt-close" data-action="pick-prompt-close" data-key="${esc(prompt.houseKey)}"
              aria-label="Не сейчас">×</button>
    </div>`;
}

/* ─────────────── действия ─────────────── */

export async function handlePickAction(action, target, ctx) {
  if (await handleMockAction(action, target, ctx)) return true;
  switch (action) {
    /**
     * «Назад» в шапке при раскрытой шторке ЖК сворачивает её, а не уводит
     * с карты: для человека раскрытая шторка — отдельный экран.
     */
    case 'back':
      if (mockSheetState() !== 'full') return false;
      collapseMockSheet();
      return true;

    case 'pick-clear': {
      const input = document.querySelector('.page.active #pickQuery') ?? document.querySelector('#pickQuery');
      if (!input) return true;
      input.value = '';
      input.dispatchEvent(new Event('input'));
      input.focus();
      return true;
    }

    case 'pick-open': {
      const box = document.querySelector('#pickSuggest');
      if (box) box.hidden = true;
      const key = target.dataset.key;
      // ЖК открывается шторкой на карте; из «Списка» и «Моих домов» — возвратом на карту
      if (key.startsWith('mock:')) {
        const host = document.querySelector('.pick-page');
        if (map && host) await showMock(host, key);
        else {
          // Точку узнаем из карточки уже на карте: у строк «Моих домов» координат нет
          selectedMock = key;
          selectedAt = null;
          await ctx.back();
        }
        return true;
      }
      // Дом из поиска или списка — не тот, чья плашка открыта: после «Назад» её не показывать
      if (!target.closest('#pickSheet')) selected = null;
      // Карточка выезжает снизу поверх карты, «Назад» уводит её вниз
      await ctx.go('pick-house', { key }, { kind: 'up' });
      return true;
    }

    case 'pick-mock-show': {
      document.querySelector('#pickSuggest').hidden = true;
      document.querySelector('#pickQuery')?.blur();
      const lat = Number(target.dataset.lat);
      const lon = Number(target.dataset.lon);
      const at = Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
      const host = document.querySelector('.pick-page');
      // Из поиска — всегда мини-карточка; карточка прошлого ЖК уходит сразу, не дожидаясь новой
      closeMockSheet();
      if (host) await showMock(host, target.dataset.key, at, { peek: true });
      return true;
    }

    /**
     * Район из поиска: карточка прошлого ЖК закрывается, карта охватывает
     * район, его ЖК один раз вспыхивают. Вспышка ждёт перерисовки меток после
     * перелёта; если карта не сдвинулась и перерисовки нет — вспыхивают сразу.
     */
    case 'pick-district': {
      document.querySelector('#pickSuggest').hidden = true;
      document.querySelector('#pickQuery')?.blur();
      const [south, west, north, east] = target.dataset.bbox.split(',').map(Number);
      const name = target.dataset.district;
      const d = (await loadDistricts()).find((x) => x.name === name)
        ?? { name, bbox: { south, west, north, east }, geometry: null };
      enterDistrict(target.closest('.page') ?? document, d);
      return true;
    }

    case 'pick-street': {
      document.querySelector('#pickSuggest').hidden = true;
      if (!target.dataset.bbox) { toast('У домов этой улицы нет точек на карте'); return true; }
      const [south, west, north, east] = target.dataset.bbox.split(',').map(Number);
      map?.fitBounds([[south, west], [north, east]], { maxZoom: 16, padding: [30, 30] });
      return true;
    }

    case 'pick-favorites':
      await ctx.go('pick-favorites');
      return true;

    case 'pick-list':
      await ctx.go('pick-list');
      return true;

    case 'pick-fav': {
      const on = !target.dataset.on;
      try {
        await api.pickFavorite(target.dataset.key, on);
        target.dataset.on = on ? '1' : '';
        target.classList.toggle('on', on);
        target.innerHTML = heartIcon(on);
        platform.haptic('light');
        toast(on ? 'Добавлено в «Мои дома»' : 'Убрано из «Моих домов»');
      } catch (error) {
        toast(error.message);
      }
      return true;
    }

    case 'pick-review':
    case 'pick-prompt-open':
      await ctx.go('pick-review', { key: target.dataset.key });
      return true;

    case 'pick-prompt-close':
      target.closest('.pick-prompt')?.remove();
      await api.pickDismiss(target.dataset.key).catch(() => {});
      return true;

    case 'pick-star': {
      const row = target.closest('.pick-rate');
      const value = Number(target.dataset.v);
      row.dataset.value = String(value);
      row.querySelectorAll('.pick-star').forEach((star) => {
        star.classList.toggle('on', Number(star.dataset.v) <= value);
      });
      platform.haptic('light');
      return true;
    }

    case 'pick-review-save': {
      const stars = {};
      for (const row of document.querySelectorAll('.pick-rate')) {
        const value = Number(row.dataset.value);
        if (!value) { toast('Поставьте звёзды в каждой строке'); return true; }
        stars[row.dataset.aspect] = value;
      }
      await withLoading(target, async () => {
        try {
          await api.pickReview(target.dataset.key, {
            stars,
            pros: document.querySelector('#pickPros')?.value ?? '',
            cons: document.querySelector('#pickCons')?.value ?? '',
          });
          platform.haptic('medium');
          toast('Спасибо! Отзыв сохранён');
          await ctx.back();
        } catch (error) {
          toast(error.message);
        }
      });
      return true;
    }

    case 'pick-listing':
      platform.openLink(target.dataset.url);
      return true;

    default:
      return false;
  }
}
