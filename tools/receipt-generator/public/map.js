/**
 * Карта покрытия домов.
 *
 * Цвет точки — уровень покрытия (lib/coverage/levels.ts):
 *   ⚪ только адрес · 🟡 тип известен · 🟢 есть контакт · 🔵 договорились.
 * Частный сектор скрыт по умолчанию: договариваться там не с кем,
 * и полмиллиона серых точек спрятали бы многоквартирные дома.
 *
 * ПОЧЕМУ ХОЛСТ ПО ТАЙЛАМ. Домов с координатами — сотни тысяч, а маркер
 * Leaflet на каждый не переживёт и десяти тысяч. Точки разложены по сетке,
 * и каждый тайл рисует только свою клетку.
 */

const COLORS = ['#9aa0a6', '#e0a800', '#1f9d55', '#1565c0'];
const LABELS = ['только адрес', 'тип известен, контакта нет', 'есть контакт организации', 'договорились'];
const PRIVATE_COLOR = '#7b5ea7';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (n) => Number(n).toLocaleString('ru-RU');
const pct = (part, total) => (total ? `${Math.round((part / total) * 100)}%` : '—');

/** Leaflet замеряет контейнер в конструкторе — строить карту можно только после появления размера */
function whenSized(el) {
  if (el.clientWidth > 0 && el.clientHeight > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const watch = new ResizeObserver(() => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      watch.disconnect();
      resolve();
    });
    watch.observe(el);
  });
}

await whenSized($('map'));

const map = L.map('map', { zoomControl: false }).setView([47.5, 40.5], 8);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap' }).addTo(map);

/** Сетка точек по клеткам 0,05° — тайл рисует только свои клетки */
const CELL = 0.05;
const grid = new Map();
let points;

const data = await fetch('/api/map/data').then((r) => r.json());

if (!data.ready) {
  $('legendSub').textContent = 'Домов нет';
  $('legend').insertAdjacentHTML('beforeend', `
    <div class="empty">Загрузите набор данных региона: <code>${esc(data.command)}</code></div>`);
} else {
  renderLegend();
  drawPoints();
}

/* ─────────────── легенда ─────────────── */

function renderLegend() {
  const { counts, regionName, source } = data.meta;
  const mkd = counts.mkd;
  const levels = ['agreed', 'contact', 'kind', 'address'];

  $('legendSub').textContent = `${regionName}${source ? ` · ${source}` : ''}`;

  $('cover').innerHTML = levels.map((level) => {
    const i = ['address', 'kind', 'contact', 'agreed'].indexOf(level);
    return `<span class="seg" style="flex-grow:${mkd[level]};background:${COLORS[i]}"
                  title="${esc(LABELS[i])}: ${num(mkd[level])}"></span>`;
  }).join('');

  const row = (color, label, n, total) => `
    <li class="key"><i style="background:${color}"></i><span>${esc(label)}</span>
      <b>${num(n)}</b><em>${pct(n, total)}</em></li>`;

  $('keys').innerHTML = [
    ...levels.map((level) => {
      const i = ['address', 'kind', 'contact', 'agreed'].indexOf(level);
      return row(COLORS[i], LABELS[i], mkd[level], mkd.total);
    }),
    `<li class="key total"><span>многоквартирных и неизвестных домов</span><b>${num(mkd.total)}</b></li>`,
    `<li class="key total"><span>из них на карте</span><b>${num(mkd.onMap)}</b><em>${pct(mkd.onMap, mkd.total)}</em></li>`,
    `<li class="key total"><span>с жителями в приложении</span><b>${num(mkd.residents)}</b></li>`,
    row(PRIVATE_COLOR, 'частные по реестру', counts.private.total, 0),
    `<li class="key total"><span>вероятно частные (нет в реестре МКД, нет квартир)</span><b>${num(counts.likely.total)}</b></li>`,
  ].join('');

  for (const id of ['showLikely', 'showPrivate', 'onlyResidents']) $(id).onchange = () => points.redraw();
}

/* ─────────────── точки ─────────────── */

function drawPoints() {
  data.points.forEach((point, index) => {
    const key = `${Math.floor(point[0] / CELL)}:${Math.floor(point[1] / CELL)}`;
    const cell = grid.get(key);
    if (cell) cell.push(index); else grid.set(key, [index]);
  });

  const visible = (point) => {
    const [, , , group, residents] = point;
    if ($('onlyResidents').checked && residents === 0) return false;
    if (group === 1) return $('showPrivate').checked;
    if (group === 2) return $('showLikely').checked;
    return true;
  };

  const Layer = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      const ctx = tile.getContext('2d');

      const nw = map.unproject(coords.scaleBy(size), coords.z);
      const se = map.unproject(coords.add([1, 1]).scaleBy(size), coords.z);
      const origin = coords.scaleBy(size);
      const radius = coords.z >= 15 ? 5 : coords.z >= 12 ? 3 : 2;

      // Высокие уровни рисуются поверх: синяя точка не должна прятаться под серой
      const drawn = [];
      for (let y = Math.floor(se.lat / CELL); y <= Math.floor(nw.lat / CELL); y++) {
        for (let x = Math.floor(nw.lng / CELL); x <= Math.floor(se.lng / CELL); x++) {
          for (const index of grid.get(`${y}:${x}`) ?? []) {
            if (visible(data.points[index])) drawn.push(index);
          }
        }
      }
      drawn.sort((a, b) => data.points[a][2] - data.points[b][2]);

      for (const index of drawn) {
        const [lat, lon, level, group] = data.points[index];
        const at = map.project([lat, lon], coords.z).subtract(origin);
        ctx.beginPath();
        ctx.arc(at.x, at.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = group === 1 ? PRIVATE_COLOR : COLORS[level];
        ctx.globalAlpha = group === 2 ? 0.5 : 0.9;
        ctx.fill();
      }
      return tile;
    },
  });

  points = new Layer({ pane: 'overlayPane' }).addTo(map);

  map.on('click', (event) => {
    const { lat, lng } = event.latlng;
    const at = map.latLngToContainerPoint(event.latlng);
    let best = null;
    let bestDist = 12;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const index of grid.get(`${Math.floor(lat / CELL) + dy}:${Math.floor(lng / CELL) + dx}`) ?? []) {
          const point = data.points[index];
          if (!visible(point)) continue;
          const dist = at.distanceTo(map.latLngToContainerPoint([point[0], point[1]]));
          if (dist < bestDist) { bestDist = dist; best = index; }
        }
      }
    }
    if (best !== null) openHouse(best);
  });
}

/* ─────────────── карточка дома ─────────────── */

const FORM = { uk: 'управляющая компания', tsj: 'ТСЖ', zhsk: 'ЖСК', direct: 'непосредственное', private: 'частный дом', unknown: 'неизвестно' };
const KIND = { mkd: 'многоквартирный', blocked: 'блокированной застройки', special: 'специализированный фонд' };

async function openHouse(index) {
  const house = await fetch(`/api/map/point?i=${index}`).then((r) => r.json());
  const level = ['address', 'kind', 'contact', 'agreed'].indexOf(house.coverage.level);
  const line = (dt, dd) => (dd ? `<div class="row"><dt>${esc(dt)}</dt><dd>${dd}</dd></div>` : '');

  $('panelBody').innerHTML = `
    <h2>${esc(house.address)}</h2>
    <dl>
      ${line('Покрытие', `<span class="tag" style="background:${COLORS[level]};color:#fff">${esc(LABELS[level])}</span>`)}
      ${line('Тип дома', esc(KIND[house.houseKind] ?? (house.coverage.isPrivate ? 'частный' : 'неизвестно')))}
      ${line('Управление', esc(FORM[house.registryForm] ?? 'нет в реестре фонда'))}
      ${line('Квартир', house.flats ? num(house.flats) : '')}
      ${line('Организация', house.org ? esc(house.org.name) : '')}
      ${line('ИНН', house.org ? esc(house.org.inn) : '')}
      ${line('Лицензия', house.org?.license ? esc(house.org.license) : '')}
      ${line('Телефон', house.org?.phone ? esc(house.org.phone) : '')}
      ${line('Почта', house.org?.email ? esc(house.org.email) : '')}
      ${line('Сайт', house.org?.site ? esc(house.org.site) : '')}
      ${line('Жителей в приложении', num(house.residents))}
      ${line('Председатель', house.hasChairman ? 'есть' : 'нет')}
    </dl>`;
  $('panel').hidden = false;
}

$('panelClose').onclick = () => { $('panel').hidden = true; };
