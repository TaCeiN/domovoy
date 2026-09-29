import { api } from './api.js';
import { esc, html } from './ui.js';
import { setBackHook } from './router.js';

/**
 * Домовёнок — помощник внутри мини-приложения.
 *
 * Кнопка с Домовёнком — только на главной, над вкладками (на других экранах
 * она закрывала бы кнопки). По нажатию — шторка во весь рост: переписка,
 * готовые вопросы, поле ввода. Разговор ведёт сервер (`POST /api/assistant`)
 * тем же кодом, что бот MAX: модель видит только текст жителя, суммы
 * и номера пишет код.
 *
 * Кнопки ответа: `message` — быстрый ответ, уходит текстом; `open_app`
 * с payload — переход внутри приложения по тем же правилам, что ссылка
 * из бота (deeplink.js).
 *
 */

/**
 * Картинки Домовёнка по анимациям. Пока их нет — квадрат с названием
 * анимации. Появился файл — вписать сюда путь, например
 * `idle: '/app/mascot/idle.webp'`, и квадрат сменится картинкой везде.
 */
const MASCOT = {
  idle: 'app/mascot/idle.webp',
  hello: 'app/mascot/hello.webp',
  think: 'app/mascot/think.webp',
  talk: 'app/mascot/talk.webp',
  done: 'app/mascot/done.webp',
  confused: 'app/mascot/confused.webp',
  alert: 'app/mascot/alert.webp',
};

/**
 * Одноразовые анимации (hello, talk, done…) браузер проигрывает один раз на
 * адрес: второй показ того же файла сразу встаёт на последний кадр.
 * Поэтому файл качаем один раз, а каждый показ получает свою ссылку
 * на тот же blob в памяти — анимация стартует заново без загрузки.
 * Петли (idle, think) так не нужно: у них общий бесконечный круг.
 */
const ONE_SHOT = new Set(['hello', 'talk', 'done', 'confused', 'alert']);
const blobs = new Map();

function preloadOneShots() {
  for (const [anim, src] of Object.entries(MASCOT)) {
    if (!ONE_SHOT.has(anim) || blobs.has(anim)) continue;
    blobs.set(anim, fetch(src).then((r) => (r.ok ? r.blob() : null)).catch(() => null));
  }
}

async function freshSrc(anim) {
  const blob = await blobs.get(anim);
  return blob ? URL.createObjectURL(blob) : MASCOT[anim];
}

/** Какие анимации нужны — для владельца, который их генерирует */
export const MASCOT_ANIMS = {
  idle: 'кнопка на главной, ждёт',
  hello: 'шторка открылась, приветствие',
  think: 'вопрос ушёл, ждём ответа',
  talk: 'отвечает, 3,5 с после ответа',
  done: 'ответил — большой палец, 3,8 с после talk, затем снова idle',
  confused: 'не понял или не по его части — пожимает плечами, 4,1 с',
  alert: 'опасность: газ, пожар, затопление — ладонь «стоп», 4 с',
};

/**
 * Как Домовёнок проигрывает анимации (просьба владельца 27.09):
 *
 *   открыл шторку   hello → idle
 *   спросил         think, пока отвечает GigaChat
 *   ответ           talk → done → idle
 *   опасность       alert → idle
 *   не понял        confused → idle
 *
 * Последний шаг без длительности — на нём Домовёнок остаётся.
 */
/**
 * Ответ не раньше чем через MIN_THINK_MS. GigaChat отвечает за доли секунды,
 * и ответ «выстреливал» раньше, чем человек видел, что Домовёнок думает:
 * выглядело как заготовленная реплика, а не разговор (просьба владельца 27.09).
 */
const MIN_THINK_MS = 2000;
/**
 * «Открой счётчики»: ответ «Открываю…» виден чуть больше секунды, потом
 * шторка закрывается и приложение переходит на экран само. Кнопка под
 * ответом остаётся — на случай, если человек успел закрыть шторку.
 */
const OPEN_AFTER_MS = 1300;
const waitFrom = (started) => new Promise((resolve) => {
  setTimeout(resolve, Math.max(0, MIN_THINK_MS - (Date.now() - started)));
});

const SCENES = {
  // hello длится 4 с — ровно ролик (app/mascot/hello.webp), конец в позе idle
  open: [['hello', 4000], ['idle']],
  think: [['think']],
  // Длительности — ровно ролики (app/mascot/*.webp): каждый кончается в позе idle
  answer: [['talk', 3500], ['done', 3800], ['idle']],
  alert: [['alert', 4000], ['idle']],
  confused: [['confused', 4100], ['idle']],
};
let timers = [];

function play(scene) {
  timers.forEach(clearTimeout);
  timers = [];
  let at = 0;
  for (const [anim, ms] of SCENES[scene]) {
    timers.push(setTimeout(() => showAnim(anim), at));
    at += ms ?? 0;
  }
}

/**
 * Меняем только картинку Домовёнка, переписку не перерисовываем.
 *
 * Новая анимация проявляется поверх старой за 200 мс (только opacity),
 * старая убирается после: без этого смена кадра — рывок. Гладко выходит,
 * когда все анимации начинаются и кончаются в одной позе (см. спеку).
 */
function showAnim(anim) {
  const box = root?.querySelector('.dom-avatar');
  if (!box || box.dataset.anim === anim) return;
  box.dataset.anim = anim;
  const put = (src) => {
    if (!root || box.dataset.anim !== anim) {
      if (src?.startsWith('blob:')) URL.revokeObjectURL(src);
      return;
    }
    // Прозрачный Домовёнок просвечивал бы сквозь нового: старый слой гаснет
    for (const old of box.children) old.classList.add('out');
    const layer = document.createElement('div');
    layer.className = 'dom-layer';
    layer.innerHTML = mascot(anim, 'dom-avatar-pic', src);
    box.append(layer);
    setTimeout(() => {
      for (const old of [...box.querySelectorAll('.out')]) {
        const img = old.querySelector('img');
        if (img?.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
        old.remove();
      }
    }, 220);
  };
  if (ONE_SHOT.has(anim) && MASCOT[anim]) freshSrc(anim).then(put);
  else put(MASCOT[anim]);
}

function mascot(anim, cls = '', src = MASCOT[anim]) {
  return src
    ? html`<img class="mascot ${cls}" src="${src}" alt="Домовёнок">`
    : html`<div class="mascot mascot-ph ${cls}" role="img" aria-label="Домовёнок"><span>${esc(anim)}</span></div>`;
}

const SUGGESTIONS = [
  'Сколько платить?',
  'Что с моей заявкой?',
  'Когда сдавать показания?',
  'Телефон аварийной службы',
];

const HELLO = 'Привет! Я Домовёнок, помощник вашего дома. Подскажу по начислениям, '
  + 'обращениям, счётчикам и телефонам. Если что-то сломалось — опишите своими '
  + 'словами, я подготовлю обращение в управляющую компанию.';

/** Переписка живёт до перезапуска приложения: закрыл шторку — открыл, всё на месте */
const messages = [];
let root = null;
let busy = false;
let options = { propertyId: null, navigate: () => {} };

/** Кнопка на главной: якорь нулевой высоты над вкладками, см. .dom-fab-anchor */
export function mountAssistantButton() {
  if (document.querySelector('.dom-fab-anchor')) return;
  const tabs = document.querySelector('.apptabs');
  if (!tabs) return;
  const anchor = document.createElement('div');
  anchor.className = 'dom-fab-anchor';
  anchor.innerHTML = html`
    <button class="dom-fab" data-action="assistant-open" aria-label="Спросить Домовёнка">
      ${mascot('idle', 'dom-fab-pic')}
    </button>`;
  tabs.before(anchor);
}

export function openAssistant(opts) {
  preloadOneShots();
  options = { ...options, ...opts };
  if (root) return;
  if (messages.length === 0) messages.push({ who: 'bot', text: HELLO });

  root = document.createElement('div');
  root.className = 'dom-chat';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Домовёнок');
  root.innerHTML = html`
    <div class="dom-head">
      <div class="dom-avatar"></div>
      <div class="dom-title">
        <div class="dom-name">Домовёнок</div>
        <div class="dom-sub">помощник вашего дома</div>
      </div>
      <button class="dom-close" data-as="close" aria-label="Закрыть"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M5 5L15 15M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></button>
    </div>
    <div class="dom-body"><div class="chat dom-list"></div></div>
    <form class="dom-input" data-as="form">
      <textarea rows="1" placeholder="Спросите или опишите проблему" maxlength="2000"></textarea>
      <button type="submit" class="dom-send" aria-label="Отправить">
        <svg viewBox="0 0 20 20" fill="none"><path d="M3 10L17 3L12 17L10 11L3 10Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
      </button>
    </form>`;
  document.body.append(root);
  root.addEventListener('click', onClick);
  root.querySelector('form').addEventListener('submit', (e) => {
    e.preventDefault();
    const field = root.querySelector('textarea');
    const text = field.value.trim();
    if (!text) return;
    field.value = '';
    send(text);
  });
  // Enter — отправить, Shift+Enter — новая строка
  root.querySelector('textarea').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      root.querySelector('form').requestSubmit();
    }
  });
  setBackHook(() => { closeAssistant(); return true; });
  render();
  play('open');
  // Пересчёт вёрстки, а не requestAnimationFrame: в свёрнутом вебвью кадр
  // может не прийти, и шторка осталась бы прозрачной поверх экрана
  void root.offsetHeight;
  root.classList.add('on');
}

export function closeAssistant() {
  if (!root) return;
  const el = root;
  root = null;
  timers.forEach(clearTimeout);
  timers = [];
  setBackHook(null);
  el.classList.remove('on');
  setTimeout(() => el.remove(), 260);
}

function onClick(e) {
  const btn = e.target.closest('[data-as]');
  if (!btn) return;
  const kind = btn.dataset.as;
  if (kind === 'close') return closeAssistant();
  if (kind === 'say') return send(btn.dataset.text);
  if (kind === 'go') {
    const payload = btn.dataset.payload;
    closeAssistant();
    options.navigate(payload);
  }
}

async function send(text) {
  if (busy || !text) return;
  busy = true;
  messages.push({ who: 'me', text });
  render({ thinking: true });
  play('think');
  let scene = 'answer';
  const started = Date.now();
  try {
    const { replies } = await api.assistant(text, options.propertyId);
    await waitFrom(started);
    for (const r of replies) {
      messages.push({ who: 'bot', text: r.text, buttons: r.buttons ?? [], ai: Boolean(r.ai) });
    }
    const open = replies.find((r) => r.open)?.open;
    if (open) {
      const at = messages.length;
      setTimeout(() => {
        // Шторку закрыли или уже спросили другое — никуда не уводим
        if (!root || busy || messages.length !== at) return;
        closeAssistant();
        options.navigate(open);
      }, OPEN_AFTER_MS);
    }
    // Опасность важнее всего, потом «не понял»; черновик жалобы — обычный ответ
    const moods = replies.map((r) => r.mood);
    if (moods.includes('alert')) scene = 'alert';
    else if (moods.includes('confused')) scene = 'confused';
  } catch (error) {
    await waitFrom(started);
    messages.push({ who: 'bot', text: error.message || 'Не получилось ответить. Попробуйте ещё раз.' });
    scene = 'confused';
  } finally {
    busy = false;
    render();
    play(scene);
  }
}

function buttonsMarkup(rows) {
  const flat = rows.flat();
  // «Открыть приложение» без адреса внутри приложения ни к чему
  const go = flat.filter((b) => b.type === 'open_app' && b.payload);
  const say = flat.filter((b) => b.type === 'message');
  if (!go.length && !say.length) return '';
  return html`
    <div class="dom-actions">
      ${go.map((b) => html`<button class="dom-go" data-as="go" data-payload="${esc(b.payload)}">${esc(b.text)}</button>`).join('')}
      ${say.map((b) => html`<button class="chip dom-say" data-as="say" data-text="${esc(b.text)}">${esc(b.text)}</button>`).join('')}
    </div>`;
}

function render({ thinking = false } = {}) {
  if (!root) return;

  const onlyHello = messages.length === 1;
  root.querySelector('.dom-list').innerHTML = html`
    ${messages.map((m, i) => m.who === 'me'
      ? html`<div class="chat-msg mine"><div class="chat-bubble"><div class="chat-t">${esc(m.text)}</div></div></div>`
      : html`
        <div class="chat-msg">
          <div class="chat-bubble"><div class="chat-t">${esc(m.text)}</div></div>
          ${m.ai ? html`<div class="dom-ai-note">Ответ сгенерирован ИИ. Проверяйте важное.</div>` : ''}
          ${i === messages.length - 1 && !busy ? buttonsMarkup(m.buttons ?? []) : ''}
        </div>`).join('')}
    ${thinking ? html`
      <div class="chat-msg" aria-live="polite">
        <div class="chat-bubble dom-typing">
          <span class="dom-typing-t">Домовёнок думает</span>
          <span class="dom-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
      </div>` : ''}
    ${onlyHello ? html`
      <div class="dom-suggest">
        ${SUGGESTIONS.map((s) => html`<button class="chip dom-say" data-as="say" data-text="${esc(s)}">${esc(s)}</button>`).join('')}
      </div>` : ''}`;
  const body = root.querySelector('.dom-body');
  body.scrollTop = body.scrollHeight;
  root.querySelector('.dom-send').disabled = busy;
}
