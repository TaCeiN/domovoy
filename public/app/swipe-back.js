import { back, depth } from './router.js';
import { platform } from './platform.js';

/**
 * Свайп «Назад» внутри приложения (просьба владельца 27.09.2026).
 *
 * Кнопка «Назад» в шапке MAX далеко от большого пальца, а у телефонов
 * с тремя кнопками внизу системного жеста нет вовсе. Ведём пальцем
 * слева направо — экран едет за пальцем, слева проявляется стрелка;
 * отпустил за порогом — тот же `back()`, что у кнопки.
 *
 * Конец пути — корень вкладки: `reset` при нажатии на вкладку оставляет
 * в стеке один экран, и на нём жест молчит. Зашёл в объявление — жест
 * вернёт в ленту, в самой ленте — нет.
 *
 * Жест берём только со страницы (`#pages .page.active`): шторки, просмотр
 * фото и Домовёнок живут поверх, в body, и свайп по ним — их собственный.
 * Карта и то, что само листается вбок, палец не отдают.
 */

/** Сколько пройти пальцем, чтобы отпускание вернуло назад, px */
const COMMIT_PX = 90;
/** Быстрый короткий мах тоже считается, px/мс */
const COMMIT_SPEED = 0.5;
/** До этого сдвига ещё не ясно, листает человек вниз или ведёт вбок, px */
const SLOP_PX = 10;

const IGNORE = '.leaflet-container, input, textarea, select, [contenteditable], [data-no-swipe]';

let hint = null;

function arrow() {
  if (hint) return hint;
  hint = document.createElement('div');
  hint.className = 'swipe-back-hint';
  hint.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M15 5L8 12L15 19" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  document.body.append(hint);
  return hint;
}

/** Есть ли между пальцем и страницей что-то, что само листается влево */
function scrollsLeft(target, page) {
  for (let el = target; el && el !== page; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth + 1 && el.scrollLeft > 0) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === 'auto' || overflow === 'scroll') return true;
    }
  }
  return false;
}

export function initSwipeBack() {
  let track = null;

  document.addEventListener('touchstart', (event) => {
    track = null;
    if (event.touches.length !== 1 || depth() <= 1) return;
    const page = document.querySelector('#pages .page.active');
    const target = event.target;
    if (!page || !page.contains(target) || page.inert) return;
    if (target.closest(IGNORE) || scrollsLeft(target, page)) return;
    const t = event.touches[0];
    track = { page, x: t.clientX, y: t.clientY, dx: 0, t: event.timeStamp, lastX: t.clientX, lastT: event.timeStamp, on: false, armed: false };
  }, { passive: true });

  // Не пассивный: захватив жест, гасим прокрутку страницы под пальцем
  document.addEventListener('touchmove', (event) => {
    if (!track) return;
    const t = event.touches[0];
    const dx = t.clientX - track.x;
    const dy = t.clientY - track.y;

    if (!track.on) {
      if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
      // Вниз, вверх или влево — это не наш жест, отпускаем до следующего касания
      if (dx <= 0 || Math.abs(dy) * 1.2 > dx) { track = null; return; }
      track.on = true;
      track.x = t.clientX; // без рывка на величину SLOP_PX
      track.page.style.transition = 'none';
      arrow().style.setProperty('--p', '0');
      hint.classList.add('on');
    }

    event.preventDefault();
    track.dx = Math.max(0, t.clientX - track.x);
    track.speed = (t.clientX - track.lastX) / Math.max(1, event.timeStamp - track.lastT);
    track.lastX = t.clientX;
    track.lastT = event.timeStamp;

    track.page.style.transform = `translateX(${track.dx}px)`;
    const progress = Math.min(1, track.dx / COMMIT_PX);
    hint.style.setProperty('--p', progress.toFixed(3));
    const armed = progress >= 1;
    if (armed !== track.armed) {
      track.armed = armed;
      hint.classList.toggle('armed', armed);
      if (armed) platform.haptic('light');
    }
  }, { passive: false });

  const end = () => {
    const done = track;
    track = null;
    if (!done?.on) return;
    hint.classList.remove('on', 'armed');
    const { page } = done;
    page.style.transition = '';
    const commit = done.armed || (done.dx > 30 && done.speed > COMMIT_SPEED);
    if (!commit) {
      // Не дотянул — экран возвращается на место
      page.style.transform = '';
      return;
    }
    // Экран доезжает вправо до края сам, класс ухода (transitions.js) его
    // только растворяет: возврат в ноль и уход назад выглядели бы рывком
    // туда-обратно, а карточка над картой (переход 'down') без этого
    // висела бы сдвинутой, пока её не снимет страховочный таймер
    page.style.transform = 'translateX(100%)';
    back().finally(() => {
      // Назад отработал внутри экрана (шаг мастера) — экран тот же, вернуть на место
      if (page.isConnected && page.classList.contains('active')) page.style.transform = '';
    });
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}
