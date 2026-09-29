import { esc, html, emptyState } from '../app/ui.js';

/**
 * Покрытие домов в кабинете оператора.
 *
 * «Подключённый» дом — не тот, где уже есть жители, а тот, с которым можно
 * договориться: известна организация и как с ней связаться. Уровни считает
 * сервер (lib/coverage/levels.ts), здесь только показ.
 *
 * ДВА РЕЖИМА.
 * «Населённые пункты» — главный: координаты домов в сёлах есть у одного
 * из двадцати, и точки там врут, а сводка по пункту и его улицам — нет.
 * «Дома» — точки видимой части карты, там, где координаты есть.
 *
 * Leaflet грузится только при открытии раздела: остальному кабинету он не нужен.
 */

const LEVELS = ['address', 'kind', 'contact', 'agreed'];
export const LEVEL_LABEL = {
  agreed: 'договорились',
  contact: 'есть контакт',
  kind: 'тип известен',
  address: 'только адрес',
};
export const LEVEL_COLOR = { address: '#9aa0a6', kind: '#f5a524', contact: '#22b35e', agreed: '#2d81f7' };
const PRIVATE_COLOR = '#8b5cf6';
const POINTS_ZOOM = 13;

export const coverageState = {
  region: '',
  mode: 'places',
  query: '',
  sort: 'total',
  place: null,
  showPrivate: false,
};

let map = null;
let placesLayer = null;
let pointsLayer = null;
let lastData = null;

const num = (n) => Number(n ?? 0).toLocaleString('ru-RU');
const share = (part, total) => (total ? Math.round((part / total) * 100) : 0);

function loadLeaflet() {
  if (window.L) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '../vendor/leaflet/leaflet.css';
    document.head.append(css);
    const script = document.createElement('script');
    script.src = '../vendor/leaflet/leaflet.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Карта не загрузилась'));
    document.head.append(script);
  });
}

/** Цвет пункта — по доле домов, с которыми можно договориться */
function placeColor(place) {
  if (place.mkd.agreed > 0) return LEVEL_COLOR.agreed;
  const contact = share(place.mkd.contact, place.mkd.total);
  if (contact >= 50) return LEVEL_COLOR.contact;
  if (contact > 0) return '#8fd19e';
  return place.mkd.kind > 0 ? LEVEL_COLOR.kind : LEVEL_COLOR.address;
}

function levelBar(counts) {
  const total = counts.total || 1;
  return html`
    <div class="cov-bar" title="${LEVELS.map((l) => `${LEVEL_LABEL[l]}: ${num(counts[l])}`).join(' · ')}">
      ${['agreed', 'contact', 'kind', 'address'].map((l) => counts[l]
        ? html`<i style="width:${(counts[l] / total) * 100}%;background:${LEVEL_COLOR[l]}"></i>` : '').join('')}
    </div>`;
}

export function coverageSection(regions, data, streets) {
  lastData = data;
  if (!regions.length) {
    return emptyState('Регионов нет', 'Загрузите набор данных региона: npm run dataset:load -- --region 61');
  }

  const t = data.totals;
  const sorters = {
    total: (a, b) => b.mkd.total - a.mkd.total,
    contact: (a, b) => share(b.mkd.contact, b.mkd.total) - share(a.mkd.contact, a.mkd.total) || b.mkd.total - a.mkd.total,
    gap: (a, b) => (b.mkd.total - b.mkd.contact - b.mkd.agreed) - (a.mkd.total - a.mkd.contact - a.mkd.agreed),
    residents: (a, b) => b.residents - a.residents,
    name: (a, b) => a.name.localeCompare(b.name, 'ru'),
  };
  const needle = coverageState.query.trim().toLowerCase();
  const places = data.places
    .filter((p) => !needle || p.name.toLowerCase().includes(needle) || (p.district ?? '').toLowerCase().includes(needle))
    .sort(sorters[coverageState.sort] ?? sorters.total);

  const sortHead = (key, label) => html`
    <th><button class="dsp-sort ${coverageState.sort === key ? 'on' : ''}" data-action="cov-sort" data-sort="${key}">${label}</button></th>`;

  const place = coverageState.place ? data.places.find((p) => p.guid === coverageState.place) : null;

  return html`
    <section class="dsp-card cov">
      <div class="dsp-section-head">
        <div>
          <h2>Покрытие домов</h2>
          <p class="dsp-dim">С какими домами у нас достаточно данных, чтобы прийти и договориться</p>
        </div>
        <div class="dsp-actions">
          ${regions.length > 1 ? html`
            <select class="dsp-select" data-action="cov-region">
              ${regions.map((r) => html`<option value="${esc(r.code)}" ${r.code === coverageState.region ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
            </select>` : ''}
          <div class="dsp-segment">
            <button class="${coverageState.mode === 'places' ? 'on' : ''}" data-action="cov-mode" data-mode="places">Населённые пункты</button>
            <button class="${coverageState.mode === 'points' ? 'on' : ''}" data-action="cov-mode" data-mode="points">Дома</button>
          </div>
        </div>
      </div>

      <div class="dsp-counters cov-kpis">
        <div class="dsp-counter"><b>${num(t.mkd.total)}</b><span>многоквартирных и неизвестных</span></div>
        <div class="dsp-counter"><b style="color:${LEVEL_COLOR.contact}">${share(t.mkd.contact + t.mkd.agreed, t.mkd.total)}%</b><span>с контактом · ${num(t.mkd.contact + t.mkd.agreed)}</span></div>
        <div class="dsp-counter"><b style="color:${LEVEL_COLOR.agreed}">${num(t.mkd.agreed)}</b><span>договорились</span></div>
        <div class="dsp-counter"><b>${num(t.residents)}</b><span>домов с жителями</span></div>
        <div class="dsp-counter"><b>${num(t.private + t.likely)}</b><span>частных и вероятно частных</span></div>
      </div>
      ${levelBar(t.mkd)}
      <div class="cov-legend">
        ${['agreed', 'contact', 'kind', 'address'].map((l) => html`<span><i style="background:${LEVEL_COLOR[l]}"></i>${LEVEL_LABEL[l]}</span>`).join('')}
        ${coverageState.mode === 'points' ? html`
          <label class="dsp-check"><input type="checkbox" data-action="cov-private" ${coverageState.showPrivate ? 'checked' : ''}> частные дома</label>` : ''}
      </div>

      <div class="cov-layout ${coverageState.mode}">
        <div class="cov-map-wrap">
          <div id="covMap" class="cov-map"></div>
          ${coverageState.mode === 'points' ? '<div class="cov-map-note" id="covNote"></div>' : ''}
        </div>

        ${coverageState.mode === 'places' ? html`
          <div class="cov-side">
            ${place ? html`
              <div class="cov-place-head">
                <button class="dsp-mini" data-action="cov-place-close">← Все пункты</button>
                <h3>${esc(place.type)} ${esc(place.name)}</h3>
                <p class="dsp-dim">${esc(place.district ? `р-н ${place.district}` : '')} · домов ${num(place.total)}, многоквартирных ${num(place.mkd.total)}</p>
                ${levelBar(place.mkd)}
              </div>
              <table class="dsp-table cov-table">
                <thead><tr><th>Улица</th><th>МКД</th><th>Контакт</th><th>Жители</th></tr></thead>
                <tbody>
                  ${(streets ?? []).sort((a, b) => b.mkd.total - a.mkd.total || b.total - a.total).map((s) => html`
                    <tr>
                      <td>${esc(s.type)} ${esc(s.name)}<div class="dsp-dim">домов ${num(s.total)}</div></td>
                      <td>${num(s.mkd.total)}${levelBar(s.mkd)}</td>
                      <td>${share(s.mkd.contact + s.mkd.agreed, s.mkd.total)}%</td>
                      <td>${num(s.residents)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>` : html`
              <div class="dsp-searchbar cov-search">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
                     stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
                <input type="search" id="covQuery" placeholder="Найти пункт или район" aria-label="Найти пункт или район"
                       value="${esc(coverageState.query)}" data-action="cov-query">
              </div>
              <table class="dsp-table cov-table">
                <thead><tr>${sortHead('name', 'Пункт')}${sortHead('total', 'МКД')}${sortHead('contact', 'Контакт')}${sortHead('gap', 'Без контакта')}${sortHead('residents', 'Жители')}</tr></thead>
                <tbody>
                  ${places.slice(0, 300).map((p) => html`
                    <tr class="cov-row" data-action="cov-place" data-guid="${esc(p.guid)}">
                      <td><b>${esc(p.type)} ${esc(p.name)}</b><div class="dsp-dim">${esc(p.district ?? '')}</div></td>
                      <td>${num(p.mkd.total)}${levelBar(p.mkd)}</td>
                      <td>${share(p.mkd.contact + p.mkd.agreed, p.mkd.total)}%</td>
                      <td>${num(p.mkd.total - p.mkd.contact - p.mkd.agreed)}</td>
                      <td>${num(p.residents)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
              ${places.length > 300 ? html`<p class="dsp-dim">Показаны 300 из ${num(places.length)} — уточните поиск</p>` : ''}`}
          </div>` : ''}
      </div>
    </section>`;
}

/** Вызывается после вставки разметки: карта живёт в DOM, а не в строке */
export async function mountCoverage({ api, openHouse, render }) {
  const el = document.querySelector('#covMap');
  if (!el || !lastData) return;
  await loadLeaflet();
  const L = window.L;

  map?.remove();
  map = L.map(el, { zoomControl: true, preferCanvas: true });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);

  const located = lastData.places.filter((p) => p.lat !== null);
  if (located.length) {
    map.fitBounds(L.latLngBounds(located.map((p) => [p.lat, p.lon])), { padding: [20, 20] });
  } else {
    map.setView([47.5, 40.5], 7);
  }

  if (coverageState.mode === 'places') {
    placesLayer = L.layerGroup().addTo(map);
    const maxTotal = Math.max(1, ...located.map((p) => p.mkd.total));
    for (const place of located) {
      if (place.mkd.total === 0 && place.residents === 0) continue;
      const selected = place.guid === coverageState.place;
      L.circleMarker([place.lat, place.lon], {
        radius: 4 + 22 * Math.sqrt(place.mkd.total / maxTotal),
        color: selected ? '#111' : '#fff',
        weight: selected ? 3 : 1,
        fillColor: placeColor(place),
        fillOpacity: 0.8,
      })
        .bindTooltip(`${place.type} ${place.name}: МКД ${num(place.mkd.total)}, контакт ${share(place.mkd.contact + place.mkd.agreed, place.mkd.total)}%`)
        .on('click', () => { coverageState.place = place.guid; render(); })
        .addTo(placesLayer);
    }
    const place = located.find((p) => p.guid === coverageState.place);
    if (place) map.setView([place.lat, place.lon], 14);
    return;
  }

  /**
   * Дома — только видимой части карты и только вблизи: сотни тысяч точек
   * разом браузер не рисует, а на мелком масштабе они всё равно сливаются.
   */
  pointsLayer = L.layerGroup().addTo(map);
  const note = document.querySelector('#covNote');
  let timer = null;

  const refresh = async () => {
    pointsLayer.clearLayers();
    if (map.getZoom() < POINTS_ZOOM) {
      if (note) note.textContent = 'Приблизьте карту, чтобы увидеть дома';
      return;
    }
    const b = map.getBounds();
    const data = await api.coveragePoints(coverageState.region, [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]);
    if (note) note.textContent = data.truncated ? 'Показаны не все дома — приблизьте карту' : `Домов на экране: ${num(data.rows.length)}`;
    for (const [lat, lon, level, group, residents, key] of data.rows) {
      if (group !== 0 && !coverageState.showPrivate) continue;
      L.circleMarker([lat, lon], {
        radius: residents > 0 ? 6 : 4,
        color: residents > 0 ? '#111' : '#fff',
        weight: 1,
        fillColor: group === 1 ? PRIVATE_COLOR : LEVEL_COLOR[LEVELS[level]],
        fillOpacity: group === 2 ? 0.45 : 0.9,
      }).on('click', () => openHouse(key)).addTo(pointsLayer);
    }
  };

  map.on('moveend', () => { clearTimeout(timer); timer = setTimeout(refresh, 250); });
  if (map.getZoom() < POINTS_ZOOM) map.setView(map.getCenter(), POINTS_ZOOM);
  refresh();
}

export async function handleCoverageAction(action, target, { render }) {
  switch (action) {
    case 'cov-mode':
      coverageState.mode = target.dataset.mode;
      await render();
      return true;
    case 'cov-region':
      coverageState.region = target.value;
      coverageState.place = null;
      await render();
      return true;
    case 'cov-sort':
      coverageState.sort = target.dataset.sort;
      await render();
      return true;
    case 'cov-place':
      coverageState.place = target.dataset.guid;
      await render();
      return true;
    case 'cov-place-close':
      coverageState.place = null;
      await render();
      return true;
    case 'cov-private':
      coverageState.showPrivate = target.checked;
      await render();
      return true;
    case 'cov-query':
      return true;
    default:
      return false;
  }
}

/** Поиск по пунктам — на ввод, без перерисовки всего раздела и потери карты */
export function bindCoverageSearch() {
  const input = document.querySelector('#covQuery');
  if (!input) return;
  input.addEventListener('input', () => {
    coverageState.query = input.value;
    const needle = input.value.trim().toLowerCase();
    for (const row of document.querySelectorAll('.cov-row')) {
      row.hidden = Boolean(needle) && !row.textContent.toLowerCase().includes(needle);
    }
  });
}
