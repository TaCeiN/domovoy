/**
 * Тема оформления.
 *
 * Вынесена из main.js, потому что её читает и экран профиля: если оставить
 * её там, получится круг импортов — main тянет экраны, экраны тянут main.
 *
 * Режим «как в MAX» — это системная тема. Собственного API темы у моста MAX
 * нет (проверено, см. docs/max-integration.md), поэтому единственный честный
 * способ совпасть с мессенджером — следовать prefers-color-scheme, который
 * вебвью наследует от системы.
 */

const THEME_KEY = 'domovoy-theme';

export function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) || 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);

  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // Приватный режим блокирует хранилище — тема просто не переживёт перезапуск
  }

  const effective = effectiveTheme(mode);

  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', effective === 'light' ? '#FFFFFF' : '#1E1F24');
}

/** Какая тема на экране сейчас: «как в MAX» раскрывается в светлую или тёмную */
export function effectiveTheme(mode = readTheme()) {
  if (mode !== 'system') return mode;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
