/**
 * Обучение жителя: карточки «что здесь где» поверх приложения.
 *
 * Показывается само один раз на устройстве — после первого входа на
 * главную — и в любой момент из профиля («Как пользоваться приложением»).
 * Отметка живёт в памяти браузера, а не в аккаунте: эксперт, меняющий
 * роли демо-дома на одном устройстве, видит обучение один раз.
 *
 * Пользователь пожилой, поэтому на карточке одна мысль, одна большая
 * кнопка и счётчик словами «2 из 6», а не точками. Домовёнок — статичная
 * картинка: анимированные webp маскота для этого слишком шумные.
 */
import { esc, html } from './ui.js';
import { setBackHook } from './router.js';

const SEEN_KEY = 'domovoy-tutorial-seen';

function seen() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return false; }
}

function markSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* приватный режим — покажем ещё раз */ }
}

/** Нерабочие копии настоящих элементов: человек узнает их на главной */
const DEMO = {
  complaint: html`
    <div class="services tutorial-services" aria-hidden="true">
      <div class="svc c1">
        <span class="ic"><i class="svc-icon" style="--svc-icon:url('icons/services/complaint.svg')"></i></span>
        <span class="label">Подать обращение</span>
      </div>
    </div>`,
  chat: html`
    <div class="chat tutorial-chat" aria-hidden="true">
      <div class="chat-msg">
        <div class="chat-who">Диспетчер УК</div>
        <div class="chat-bubble"><div class="chat-t">Сантехник придёт сегодня до 18:00</div></div>
      </div>
    </div>`,
  pay: html`
    <div class="tutorial-pay" aria-hidden="true">
      <span class="tutorial-pay-l">К оплате</span>
      <span class="tutorial-pay-v">6 640,00 ₽</span>
    </div>`,
};

/**
 * Карточки под человека: пять общих и одна о его положении — председатель
 * узнаёт о своём разделе, неподтверждённый — почему у него пусто в ленте.
 * Председатель важнее: одна карточка, а не две.
 */
export function tutorialCards(state) {
  const cards = [
    { title: 'Здравствуйте! Я Домовёнок',
      text: 'Покажу, как устроено приложение «Домовой». Это займёт минуту.' },
    { title: 'Что-то сломалось? Нажмите эту кнопку',
      text: 'Выберите, что случилось, и опишите своими словами. Можно приложить фото.',
      demo: 'complaint' },
    { title: 'Ответ управляющей компании придёт в «Обращения»',
      text: 'Кнопка внизу экрана. Выглядит как переписка в мессенджере.',
      demo: 'chat' },
    { title: 'На главной — сколько платить и ваши счётчики',
      text: 'Показания записывайте в «Показания счётчиков».',
      demo: 'pay' },
  ];

  const properties = state.me?.properties ?? [];
  if (state.chairman?.isChairman) {
    cards.push({ title: 'Вы председатель совета дома',
      text: 'Соседи просятся в приложение дома — подтверждайте их в «Совете дома».' });
  } else if (properties.length && properties.every((p) => p.status !== 'active')) {
    cards.push({ title: 'Соседи скоро подтвердят вас',
      text: 'До этого новости дома закрыты, но жалоба в УК работает уже сейчас.' });
  }

  cards.push({ title: 'Если забудете — загляните в Профиль',
    text: 'Там кнопка «Как пользоваться приложением».' });
  return cards;
}

/** Тире не переносится в начало строки, короткий предлог — в конец */
const nbsp = (text) => text
  .replace(/ —/g, '\u00a0—')
  .replace(/(^|\s)(в|и|к|с|о|у|а|на|до|по|не|за|из|от)\s/gi, '$1$2\u00a0');

let open = null;

function cardMarkup(card, index, total) {
  const last = index === total - 1;
  return html`
    <div class="tutorial-top">
      <span class="tutorial-n">${index + 1} из ${total}</span>
      ${last ? '' : html`<button class="tutorial-skip" data-action="tutorial-skip">Пропустить</button>`}
    </div>
    <div class="tutorial-body">
      <img class="tutorial-mascot" src="app/mascot/still.webp" alt="" width="112" height="112">
      <h2 class="tutorial-title">${esc(nbsp(card.title))}</h2>
      <p class="tutorial-text">${esc(nbsp(card.text))}</p>
      ${card.demo ? DEMO[card.demo] : ''}
    </div>
    <button class="btn-primary tutorial-next" data-action="tutorial-next">${last ? 'Понятно, начать' : 'Дальше'}</button>`;
}

function show(index) {
  if (!open) return;
  open.index = index;
  const sheet = open.el.querySelector('.tutorial-card');
  sheet.innerHTML = cardMarkup(open.cards[index], index, open.cards.length);
}

export function closeTutorial() {
  if (!open) return;
  const { el } = open;
  open = null;
  markSeen();
  setBackHook(null);
  el.classList.remove('on');
  setTimeout(() => el.remove(), 220);
}

function step(delta) {
  if (!open) return;
  const next = open.index + delta;
  if (next < 0) return;
  if (next >= open.cards.length) { closeTutorial(); return; }
  show(next);
}

export function openTutorial(state) {
  if (open) return;
  const el = document.createElement('div');
  el.className = 'tutorial';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-label', 'Как пользоваться приложением');
  el.innerHTML = '<div class="tutorial-card"></div>';
  document.body.append(el);
  open = { el, cards: tutorialCards(state), index: 0 };
  show(0);
  // «Назад» MAX — предыдущая карточка, с первой — закрыть
  setBackHook(() => {
    if (open?.index > 0) step(-1);
    else closeTutorial();
    return true;
  });
  // Пересчёт вёрстки вместо requestAnimationFrame: в свёрнутом вебвью кадр
  // может не прийти, и обучение осталось бы прозрачным (как у просмотра фото)
  void el.offsetHeight;
  el.classList.add('on');

  // Смахивание вбок — соседняя карточка
  let start = null;
  el.addEventListener('pointerdown', (e) => { start = { x: e.clientX, y: e.clientY }; });
  const end = (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    start = null;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) step(dx < 0 ? 1 : -1);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', () => { start = null; });
}

/** Сам — один раз на устройстве, после первого входа на главную */
export function maybeShowTutorial(state) {
  if (!state.me || seen()) return;
  openTutorial(state);
}

export function handleTutorialAction(action) {
  if (action === 'tutorial-next') { step(1); return true; }
  if (action === 'tutorial-skip') { closeTutorial(); return true; }
  return false;
}
