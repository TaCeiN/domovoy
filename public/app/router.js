import { platform } from './platform.js';

/**
 * Навигация по экранам.
 *
 * Стек, а не история браузера: приложение живёт на одном URL, а внутри MAX
 * адресной строки нет вовсе. Кнопку «Назад» берём нативную, если она есть, —
 * пользователь ждёт её в шапке мессенджера, а не внутри страницы.
 */

const stack = [];
let render = null;

export function initRouter(renderFn) {
  render = renderFn;

  // Аппаратная «назад» на Android и свайп в браузере не должны
  // выкидывать человека из приложения на первом же шаге
  history.replaceState({ depth: 1 }, '');
  window.addEventListener('popstate', () => {
    if (stack.length > 1) {
      back();
      history.pushState({ depth: stack.length }, '');
    }
  });

  syncBackButton();
}

export function current() {
  return stack[stack.length - 1] ?? null;
}

export function depth() {
  return stack.length;
}

/**
 * Место прокрутки экрана, с которого уходим.
 *
 * Ищем активный `.page`, а не `#screen`: у экранов входа свой id,
 * а во время смены `#screen` может принадлежать ещё не показанному экрану.
 */
function activeScroll() {
  return document.querySelector('#pages .page.active')?.scrollTop ?? 0;
}

/** Заменяет весь стек: переключение вкладки начинает навигацию заново. */
export async function reset(name, params = {}) {
  stack.length = 0;
  stack.push({ name, params, scroll: 0 });
  syncBackButton();
  await render(name, params, { kind: 'fade', scroll: 0 });
}

/**
 * Перейти на экран. `kind: 'up'` — экран выезжает снизу поверх текущего
 * (карточка дома над картой); «Назад» тогда уводит его вниз, а не вбок.
 */
export async function go(name, params = {}, { kind = 'forward' } = {}) {
  const from = current();
  if (from) from.scroll = activeScroll();
  stack.push({ name, params, scroll: 0, kind });
  history.pushState({ depth: stack.length }, '');
  syncBackButton();
  await render(name, params, { kind, scroll: 0 });
}

let backHook = null;

/**
 * Перехватчик кнопки «Назад».
 * Экран может сам обработать возврат на шаг назад (например шаги в мастере).
 * Если функция возвращает true — переход по стеку роутера отменяется.
 */
export function setBackHook(fn) {
  backHook = fn;
}

/**
 * Назад — на прежнее место прокрутки.
 *
 * Раньше экран рисовался заново с начала, и длинный список после
 * возврата из карточки обращения оказывался наверху: человек терял
 * ровно то место, откуда ушёл.
 */
export async function back() {
  if (backHook && (await backHook())) return;
  if (stack.length <= 1) return;
  const leaving = stack.pop();
  const screen = current();
  syncBackButton();
  await render(screen.name, screen.params, {
    kind: leaving.kind === 'up' ? 'down' : 'back',
    scroll: screen.scroll ?? 0,
  });
}

/**
 * Соседний вид того же места — без шага «назад».
 *
 * Доски ленты «Объявления дома / Соседи предлагают» ходили через `go`:
 * каждый тап клал экран в стек, и «Назад» приходилось жать столько раз,
 * сколько человек переключал. Со сдвигом каждый тап ещё и въезжал бы
 * справа. `swap` заменяет верхнюю запись и растворяет.
 */
export async function swap(name, params = {}) {
  if (stack.length === 0) return reset(name, params);
  stack[stack.length - 1] = { name, params, scroll: 0 };
  syncBackButton();
  await render(name, params, { kind: 'fade', scroll: 0 });
}

/** Перерисовать текущий экран, не трогая стек. Без анимации — см. спеку. */
export async function refresh() {
  const screen = current();
  if (screen) await render(screen.name, screen.params, { kind: 'none', scroll: 0 });
}

function syncBackButton() {
  const visible = stack.length > 1;

  const button = document.querySelector('#hdBackBtn');
  if (button) button.style.display = visible ? 'flex' : 'none';

  // Вне MAX транспорта моста нет — дёргать его значит сорить
  // предупреждениями в консоль на каждом переходе
  if (platform.inMax) {
    if (button) button.style.display = 'none';
    if (visible) platform.backButton.show(() => back());
    else platform.backButton.hide();
  }
}
