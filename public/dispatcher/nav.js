import { esc, html } from '../app/ui.js';

/**
 * Боковое меню кабинетов — диспетчера УК и оператора.
 *
 * Разделов у кабинетов по семь-восемь, и строка вкладок над содержимым
 * переносилась в две строки уже на ноутбуке. Меню слева, как в VK и MAX:
 * место под названия есть всегда, счётчик стоит на своём разделе,
 * а содержимому остаётся вся ширина — таблицам она нужнее.
 *
 * Иконки — яркие градиентные плитки, как в приложении жителя: раздел
 * узнаётся по цвету раньше, чем прочитано название.
 */

const ICONS = {
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  map: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 1 1 13 0c0 5.4-6.5 11-6.5 11Z"/><circle cx="12" cy="10" r="2.3"/>',
  house: '<path d="M4 10.5 12 4l8 6.5v9H4v-9Z"/><path d="M10 19.5v-5h4v5"/>',
  inbox: '<path d="M4 13.5 6.5 5h11l2.5 8.5V19H4v-5.5Z"/><path d="M4 13.5h4.5l1 2h5l1-2H20"/>',
  people: '<circle cx="9" cy="8.5" r="3"/><path d="M3.5 19c.6-3 2.8-4.8 5.5-4.8s4.9 1.8 5.5 4.8"/><path d="M15.5 5.8a3 3 0 0 1 0 5.4M17.5 14.6c1.6.6 2.7 2.1 3 4.4"/>',
  org: '<path d="M4 20V6l8-2v16"/><path d="M12 9h8v11"/><path d="M7 9h2M7 12.5h2M7 16h2M15 13h2M15 16.5h2"/>',
  db: '<ellipse cx="12" cy="6" rx="7" ry="2.8"/><path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6"/><path d="M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8"/>',
  log: '<path d="M7 4h10v16H7z"/><path d="M10 8.5h4M10 12h4M10 15.5h2.5"/>',
  wrench: '<path d="M14.5 5.5a4 4 0 0 0 4.9 5.2L11 19a2.1 2.1 0 0 1-3-3l8.3-8.4"/>',
  crown: '<path d="m4 8 4 4 4-6 4 6 4-4-1.5 11h-13L4 8Z"/>',
  megaphone: '<path d="M4 10v4l11 4.5V5.5L4 10Z"/><path d="M15 9.5a2.5 2.5 0 0 1 0 5M7 14.5l1 4.5"/>',
  poll: '<path d="M5 19V11M12 19V5M19 19v-6"/>',
  play: '<path d="M8 5.5v13l10.5-6.5L8 5.5Z"/>',
  wallet: '<path d="M4 7h14a2 2 0 0 1 2 2v9H6a2 2 0 0 1-2-2V7Z"/><path d="M4 7l11-3v3M16 12.5h1.5"/>',
};

/** Пары цветов градиента: у соседних разделов разные, чтобы меню не сливалось */
const TONES = {
  blue: ['#00BFFF', '#1A5CFF'],
  violet: ['#8A5CFF', '#5B1AFF'],
  pink: ['#FF5C9D', '#E0138C'],
  orange: ['#FFB23F', '#FF6A1A'],
  green: ['#3DDC84', '#11A860'],
  teal: ['#2ED3C6', '#0E8FA8'],
  red: ['#FF6B6B', '#E5213A'],
  gray: ['#9AA3B5', '#5D6678'],
};

export function navIcon(icon, tone) {
  const [from, to] = TONES[tone] ?? TONES.blue;
  return html`
    <span class="dsp-nav-icon" style="background:linear-gradient(135deg, ${from}, ${to})">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#fff" stroke-width="1.9"
           stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[icon] ?? ICONS.house}</svg>
    </span>`;
}

/**
 * Рисует меню в боковую панель страницы.
 * items — { id, label, icon, tone, count? }; attr — имя data-атрибута
 * с id раздела, которое ждёт обработчик действия `tab` этого кабинета.
 */
export function renderNav(target, items, current, attr) {
  const nav = document.querySelector(target);
  if (!nav) return;
  nav.innerHTML = items.map((item) => html`
    <button class="dsp-nav-item ${item.id === current ? 'on' : ''}" data-action="tab"
            data-${attr}="${esc(item.id)}" title="${esc(item.label)}"
            ${item.id === current ? 'aria-current="page"' : ''}>
      ${navIcon(item.icon, item.tone)}
      <span class="dsp-nav-label">${esc(item.label)}</span>
      ${item.count ? html`<span class="dsp-nav-count">${item.count > 999 ? '999+' : item.count}</span>` : ''}
    </button>`).join('');
}

/** Боковая панель видна только после входа: на экране входа меню вести некуда */
export function setSignedIn(name) {
  document.body.classList.toggle('dsp-signed', Boolean(name));
  const who = document.querySelector('[data-role="who"]');
  if (who) who.textContent = name ?? '';
  const initial = document.querySelector('[data-role="avatar"]');
  if (initial) initial.textContent = (name ?? '').trim().charAt(0).toUpperCase();
}

/**
 * Строка поиска раздела: поле и кнопка в одну линию, Enter ищет.
 * Раньше это была мобильная форма с кнопкой во всю ширину — на мониторе
 * она занимала треть экрана над результатами.
 */
export function searchBar({ id, value, placeholder, action, reset = null }) {
  return html`
    <div class="dsp-searchbar">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
           stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
      <input type="search" id="${esc(id)}" value="${esc(value ?? '')}" placeholder="${esc(placeholder)}"
             aria-label="${esc(placeholder)}" data-enter="${esc(action)}">
      ${reset && value ? html`<button class="dsp-act" data-action="${esc(reset)}">Сбросить</button>` : ''}
      <button class="dsp-act primary" data-action="${esc(action)}">Найти</button>
    </div>`;
}

/** Enter в строке поиска нажимает её кнопку; true — нажатие обработано */
export function enterSearch(event, handleAction) {
  const enter = event.target?.dataset?.enter;
  if (!enter) return false;
  const button = event.target.closest('.dsp-searchbar')?.querySelector(`[data-action="${enter}"]`);
  if (button) handleAction(enter, button);
  return true;
}

/** Заголовок раздела: название крупно, под ним — одна строка о том, что здесь делают */
export function pageHead(title, sub = '', right = '') {
  return html`
    <div class="dsp-page-head">
      <div>
        <h1>${esc(title)}</h1>
        ${sub ? html`<p class="dsp-dim">${esc(sub)}</p>` : ''}
      </div>
      ${right}
    </div>`;
}
