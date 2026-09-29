import { api } from '../api.js';
import { platform } from '../platform.js';
import {
  esc, html, formatDate, errorState, emptyState, toast, withLoading, plural,
  moreLine, keepScroll,
} from '../ui.js';
import { waitingText } from './home.js';
import { wipNote } from '../wip.js';

/**
 * Жизнь дома: объявления УК, объявления соседей, опросы.
 *
 * ПРО ОПРОСЫ — важное. Это опросы, а не общее собрание собственников.
 * ОСС по ЖК РФ требует подсчёта по долям в праве собственности, кворума,
 * реестра собственников и протокола. Мы этого не делаем, поэтому оговорка
 * приходит с сервера полем legalNotice и выводится всегда: если оставить
 * её на совести вёрстки, она однажды потеряется, и приложение начнёт
 * обещать юридическую силу, которой у него нет.
 */

const CATEGORY_TONE = {
  outage: 'bad',
  meeting: 'new',
  news: '',
  market: 'ok',
};

/* ─────────────── лента ─────────────── */

/**
 * Сколько карточек ленты показано сейчас.
 *
 * За год дом накапливает больше сотни объявлений — десять экранов
 * прокрутки, где человек читает две верхние карточки.
 */
const FEED_STEP = 50;

/** Почему номер не получен — ответ `platform.requestContact()` */
const SHARE_PHONE_FAIL = {
  unavailable: 'Поделиться телефоном можно в приложении внутри MAX',
  declined: 'Без номера телефона соседи смогут связаться только по тексту ниже',
  timeout: 'MAX не ответил. Попробуйте ещё раз или напишите, как связаться, в поле ниже',
};
let feedShown = FEED_STEP;
/** Доска, для которой посчитано показанное: у соседей свой счёт */
let feedScope = null;

export async function renderFeed(state, { category } = {}) {
  /**
   * Соседи, лента и опросы — уровень 1: это данные ДРУГИХ людей, и до
   * подтверждения председателем показывать их нельзя. Пустой список здесь
   * читался бы как «в доме ничего не происходит», а дело не в этом.
   */
  const waiting = state?.currentProperty;
  if (waiting?.status === 'pending') {
    /**
     * Паспорт дома — не данные соседей, его можно сразу.
     *
     * Вкладка «Дом» была тупиком для большинства домов: «откроется после
     * подтверждения — подтвердить некому» (аудит 26 сентября). А сведения
     * о самом доме из реестров — год, этажность, кто управляет, отзывы
     * без имён — открыты даже гостю подбора. Их и показываем.
     */
    return html`
      ${waiting.houseKey ? html`
        <button class="btn-primary" data-action="pick-open" data-key="${esc(waiting.houseKey)}"
                style="margin-top:0">Паспорт дома</button>` : ''}
      <div class="dt-card">
        <div class="meter-name">Лента и соседи откроются после подтверждения</div>
        <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
          ${waitingText(waiting)}
        </div>
      </div>`;
  }

  let posts;
  let total;
  try {
    const scope = category === 'market' ? 'market' : 'house';
    if (scope !== feedScope) {
      feedShown = FEED_STEP;
      feedScope = scope;
    }
    const data = await api.feed(scope, feedShown);
    total = data.total ?? data.posts.length;
    posts = data.posts
      /**
       * Вторая проверка поверх серверного scope.
       *
       * Доски обязаны быть раздельными: «Объявления дома» — это отключения
       * и собрания, а не «продам велосипед». Дублирующий фильтр стоит
       * ничего и держит экран честным, даже если до браузера доехал старый
       * или чужой ответ — с кэшем такое уже случалось.
       */
      .filter((p) => (scope === 'market' ? p.category === 'market' : p.category !== 'market'));
  } catch (error) {
    return errorState(error, category === 'market' ? 'market' : 'feed');
  }

  const isMarket = category === 'market';

  /**
   * Две доски — один экран.
   *
   * Плитки с главной убраны, и переключатель здесь стал единственным
   * входом на доску соседей. Смешивать доски нельзя: рядом с объявлением
   * УК «продам велосипед» обесценивает первое, а объявление соседа
   * начинает выглядеть официальным.
   */
  /**
   * Председатель пишет объявления дома — кнопка там, где их читают.
   *
   * Раньше писать можно было только из «Совета дома», и председатель,
   * открыв пустую ленту своего дома, не находил, как её заполнить
   * (аудит 26 сентября). Форма та же, в «Совете дома».
   */
  const houseKey = state?.currentProperty?.houseKey;
  const isChairman = !isMarket && (state?.chairman?.houses ?? []).some((h) => h.houseKey === houseKey);

  const boards = html`
    <div class="segmented" style="margin-bottom:14px">
      <button class="${isMarket ? '' : 'on'}" data-action="feed" data-swap="1">Объявления дома</button>
      <button class="${isMarket ? 'on' : ''}" data-action="market" data-swap="1">Соседи предлагают</button>
    </div>
    ${isChairman && posts.length ? html`
      <button class="btn-primary secondary" data-action="council" style="margin:0 0 14px">
        Написать объявление
      </button>` : ''}`;

  if (posts.length === 0) {
    return html`
      ${boards}
      ${emptyState(
        isMarket ? 'Пока никто ничего не предлагает' : 'Объявлений пока нет',
        isMarket
          ? 'Продаёте вещь, отдаёте стройматериалы или предлагаете услугу? Поделитесь с соседями'
          // Про УК писать нельзя: у дома с ТСЖ, на непосредственном
          // управлении или просто с одним председателем её нет вовсе,
          // а объявления дома ведёт совет
          : 'Здесь появятся новости дома, отключения и сообщения от совета дома',
        isMarket
          ? { action: 'new-post', label: 'Разместить объявление' }
          : isChairman ? { action: 'council', label: 'Написать объявление' } : null,
        isMarket ? 'market' : 'posts',
      )}`;
  }

  /**
   * Непрочитанные — вверх, прочитанные — под подписью.
   *
   * Порядок внутри групп прежний, по дате. Разделитель нужен, чтобы
   * граница не выглядела сбоем сортировки: без него человек видит,
   * что после свежего объявления идёт прошлогоднее, и не понимает почему.
   *
   * Порядок НЕ переставляется, пока человек в разделе: он открыл
   * объявление, вернулся — и строка не уехала вниз у него на глазах.
   * Перестановка происходит при следующем входе в раздел.
   */
  const unread = posts.filter((p) => p.unread);
  const seen = posts.filter((p) => !p.unread);

  const list = unread.length && seen.length
    ? html`
      <div class="list">${unread.map(postRow).join('')}</div>
      <div class="notif-day">Прочитанные</div>
      <div class="list">${seen.map(postRow).join('')}</div>`
    : `<div class="list">${posts.map(postRow).join('')}</div>`;

  return html`
    ${boards}
    ${list}
    ${moreLine({ shown: posts.length, total, action: 'feed-more' })}
    ${isMarket ? '<button class="btn-primary" data-action="new-post">Разместить объявление</button>' : ''}`;
}

/**
 * Строка объявления в списке: иконка категории, заголовок, подпись.
 * По иконке человек отличает отключение от объявления соседа.
 */
const CHEVRON = '<svg width="12" height="12" viewBox="0 0 14 14" fill="none">'
  + '<path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.6" '
  + 'stroke-linecap="round" stroke-linejoin="round"/></svg>';

function postRow(p) {
  const tone = p.expired ? '' : CATEGORY_TONE[p.category] ?? '';
  const meta = html`
    ${esc(p.categoryLabel)} · ${esc(p.author)} · ${esc(formatDate(p.publishedAt))}
    ${p.expired ? ' · завершено' : ''}`;

  return html`
    <button class="row tappable ${p.expired ? 'faded' : ''}" data-action="post" data-id="${esc(p.id)}">
      <span class="sq ${tone}">${categoryIcon(p.category)}</span>
      <div class="content">
        <div class="t ${p.unread ? 'unread' : ''}">${esc(p.title)}</div>
        <div class="d">${meta}</div>
      </div>
      <span class="chev">${CHEVRON}</span>
    </button>`;
}

function categoryIcon(category) {
  const paths = {
    outage: '<path d="M10 2L18 17H2L10 2Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8V11.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="10" cy="14" r=".9" fill="currentColor"/>',
    meeting: '<circle cx="7" cy="7.5" r="2.6" stroke="currentColor" stroke-width="1.4"/><circle cx="14" cy="8.5" r="2.1" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 16C2.5 13.2 4.5 11.8 7 11.8C9.5 11.8 11.5 13.2 11.5 16M12.5 12.2C15 12.2 17.5 13.2 17.5 16" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    market: '<path d="M3.5 6.8H16.5L15.6 16.5H4.4L3.5 6.8Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M7 6.8V5C7 3.9 8.3 3 10 3C11.7 3 13 3.9 13 5V6.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
    news: '<rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M6 8H14M6 11.5H11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  };
  return `<svg viewBox="0 0 20 20" fill="none">${paths[category] ?? paths.news}</svg>`;
}

/* ─────────────── карточка объявления ─────────────── */

export async function renderPost(state, { id }) {
  /**
   * Соседи, лента и опросы — уровень 1: это данные ДРУГИХ людей, и до
   * подтверждения председателем показывать их нельзя. Пустой список здесь
   * читался бы как «в доме ничего не происходит», а дело не в этом.
   */
  const waiting = state?.currentProperty;
  if (waiting?.status === 'pending') {
    /**
     * Паспорт дома — не данные соседей, его можно сразу.
     *
     * Вкладка «Дом» была тупиком для большинства домов: «откроется после
     * подтверждения — подтвердить некому» (аудит 26 сентября). А сведения
     * о самом доме из реестров — год, этажность, кто управляет, отзывы
     * без имён — открыты даже гостю подбора. Их и показываем.
     */
    return html`
      ${waiting.houseKey ? html`
        <button class="btn-primary" data-action="pick-open" data-key="${esc(waiting.houseKey)}"
                style="margin-top:0">Паспорт дома</button>` : ''}
      <div class="dt-card">
        <div class="meter-name">Лента и соседи откроются после подтверждения</div>
        <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
          ${waitingText(waiting)}
        </div>
      </div>`;
  }

  let posts;
  try {
    posts = (await api.feed()).posts;
  } catch (error) {
    return errorState(error, 'feed');
  }

  const p = posts.find((x) => x.id === id);
  if (!p) return emptyState('Объявление не найдено', 'Возможно, его уже убрали');

  return html`
    <div class="post-hero ${esc(p.category)} ${p.expired ? 'expired' : ''}">
      <span class="post-hero-ic">${categoryIcon(p.category)}</span>
      <div class="post-hero-text">
        <div class="post-kind">${esc(p.categoryLabel)}${p.expired ? ' · завершено' : ''}</div>
        <div class="post-title">${esc(p.title)}</div>
      </div>
    </div>

    <div class="post-by">
      <span class="post-avatar ${esc(p.type)}">${esc(initials(p))}</span>
      <div class="post-by-text">
        <div class="post-by-name">${esc(p.author)}</div>
        <div class="post-by-date">${esc(formatDate(p.publishedAt))}</div>
      </div>
    </div>

    ${p.expiresAt && !p.expired ? html`
      <div class="post-until">
        <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12" rx="2.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 8.5H17M7 3V6M13 3V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        Действует до ${esc(formatDate(p.expiresAt))}
      </div>` : ''}

    <div class="post-body">${postBody(p.body)}</div>

    ${!p.mine && (p.phone || p.maxUsername || p.contact) ? html`
      <div class="dt-card">
        <div class="pay-label">Как связаться</div>
        ${p.contact ? html`<div class="dt-p" style="margin-top:6px">${esc(p.contact)}</div>` : ''}
        ${p.phone ? html`
          <a class="btn-primary" href="tel:${esc(p.phone)}">Позвонить · ${esc(formatPhone(p.phone))}</a>
          <button class="btn-primary secondary" data-action="post-write"
                  data-username="${esc(p.maxUsername ?? '')}" data-title="${esc(p.title)}">Написать в MAX</button>` : ''}
      </div>` : ''}

    ${p.type === 'resident' ? html`
      <div class="dt-p" style="color:var(--tx-2);font-size:13px">
        Объявление разместил сосед. Управляющая компания за него не отвечает
        и в сделке не участвует.
      </div>` : ''}

    ${p.type === 'chair' ? html`
      <div class="dt-p" style="color:var(--tx-2);font-size:13px">
        Опубликовал председатель совета дома — он выбран жильцами,
        а учётку подтвердила управляющая компания.
      </div>` : ''}`;
}

/** Кружок автора: УК и председатель — значком, сосед — инициалами */
function initials(p) {
  if (p.type === 'uk') return 'УК';
  if (p.type === 'chair') return 'П';
  const words = String(p.author ?? '').trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('') || 'С';
}

/**
 * Текст объявления: абзацы по пустой строке, строки с «-», «•», «*» —
 * списком. Раньше весь текст шёл одним куском через <br>, и длинное
 * объявление об отключении читалось как простыня (просьба владельца 27.09).
 * Экранируем каждую строку — текст пишут люди.
 */
function postBody(body) {
  const blocks = String(body ?? '').replace(/\r/g, '').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  return blocks.map((block) => {
    const lines = block.split('\n');
    const bullet = /^\s*[-•*–—]\s+/;
    if (lines.length > 1 && lines.every((l) => bullet.test(l))) {
      return `<ul>${lines.map((l) => `<li>${esc(l.replace(bullet, ''))}</li>`).join('')}</ul>`;
    }
    return `<p>${lines.map(esc).join('<br>')}</p>`;
  }).join('');
}

/* ─────────────── новое объявление ─────────────── */

export function renderPostForm() {
  return html`
    <div class="field-label" style="margin-top:2px">Заголовок</div>
    <input type="text" id="postTitle" placeholder="Например: Отдам детский велосипед">
    <div class="field-error" id="postTitleErr"></div>

    <div class="field-label">Описание</div>
    <textarea id="postBody" placeholder="Что предлагаете, в каком состоянии, на каких условиях"></textarea>
    <div class="field-error" id="postBodyErr"></div>

    <!--
      Фотография одна: вторая потребовала бы решать, какая из них главная.
      Сервер её хранит, но лента пока не показывает — см. wip.js.
    -->
    <div class="field-label">Фотография</div>
    ${wipNote('postPhoto')}
    <label class="btn-primary secondary">
      Прикрепить фотографию
      <input type="file" id="postPhoto" hidden accept="image/*" data-action="pick-post-photo">
    </label>
    <div id="postPhotoName" class="file-chosen">Необязательно</div>

    <div class="field-label">Как с вами связаться</div>
    <!--
      Переключатель, а не поле: соседу нужна кнопка «Позвонить», а не номер,
      который надо переписывать. Телефон — подтверждённый MAX, его нельзя
      вписать чужой.
    -->
    <button type="button" class="list share-toggle" data-action="post-share-toggle" aria-pressed="false" id="postShare">
      <span class="share-toggle-text">
        <span class="t">Показать мой телефон соседям</span>
        <span class="d">Соседи смогут позвонить или написать вам в MAX</span>
      </span>
      <span class="toggle"><span class="knob"></span></span>
    </button>
    <input type="text" id="postContact" placeholder="Или напишите: квартира, когда удобно" style="margin-top:10px">

    <div class="dt-p" style="color:var(--tx-2);font-size:13px">
      Объявление увидят только жители вашего дома. Показывайте лишь те
      контакты, которые готовы им доверить.
    </div>

    <button class="btn-primary" data-action="submit-post">Разместить</button>`;
}

/* ─────────────── опросы ─────────────── */

export async function renderPolls(state) {
  /**
   * Соседи, лента и опросы — уровень 1: это данные ДРУГИХ людей, и до
   * подтверждения председателем показывать их нельзя. Пустой список здесь
   * читался бы как «в доме ничего не происходит», а дело не в этом.
   */
  const waiting = state?.currentProperty;
  if (waiting?.status === 'pending') {
    /**
     * Паспорт дома — не данные соседей, его можно сразу.
     *
     * Вкладка «Дом» была тупиком для большинства домов: «откроется после
     * подтверждения — подтвердить некому» (аудит 26 сентября). А сведения
     * о самом доме из реестров — год, этажность, кто управляет, отзывы
     * без имён — открыты даже гостю подбора. Их и показываем.
     */
    return html`
      ${waiting.houseKey ? html`
        <button class="btn-primary" data-action="pick-open" data-key="${esc(waiting.houseKey)}"
                style="margin-top:0">Паспорт дома</button>` : ''}
      <div class="dt-card">
        <div class="meter-name">Лента и соседи откроются после подтверждения</div>
        <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
          ${waitingText(waiting)}
        </div>
      </div>`;
  }

  let polls;
  try {
    polls = (await api.polls()).polls;
  } catch (error) {
    return errorState(error, 'polls');
  }

  if (polls.length === 0) {
    return emptyState(
      'Опросов нет',
      'Когда управляющая компания захочет узнать мнение жителей, опрос появится здесь',
    );
  }

  return html`
    <div class="list">
      ${polls.map((p) => html`
        <button class="row tappable" data-action="poll" data-id="${esc(p.id)}">
          <span class="sq ${p.closed ? '' : 'new'}">
            ${p.myOptionId
              // Галочка — только когда голос отдан: она читалась как «уже проголосовали»
              ? '<svg viewBox="0 0 20 20" fill="none"><path d="M3.5 10L8 14.5L16.5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>'
              : '<svg viewBox="0 0 20 20" fill="none"><rect x="3.5" y="3.5" width="13" height="13" rx="3" stroke="currentColor" stroke-width="1.6"/><path d="M7 8H13M7 12H11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'}
          </span>
          <div class="content">
            <div class="t">${esc(p.title)}</div>
            <div class="d">
              ${p.closed ? 'Завершён' : 'Идёт'} ·
              ${p.myOptionId ? 'вы проголосовали' : 'вы ещё не голосовали'}
            </div>
          </div>
          <span class="chev"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </button>`).join('')}
    </div>`;
}

export async function renderPoll(state, { id }) {
  /**
   * Соседи, лента и опросы — уровень 1: это данные ДРУГИХ людей, и до
   * подтверждения председателем показывать их нельзя. Пустой список здесь
   * читался бы как «в доме ничего не происходит», а дело не в этом.
   */
  const waiting = state?.currentProperty;
  if (waiting?.status === 'pending') {
    /**
     * Паспорт дома — не данные соседей, его можно сразу.
     *
     * Вкладка «Дом» была тупиком для большинства домов: «откроется после
     * подтверждения — подтвердить некому» (аудит 26 сентября). А сведения
     * о самом доме из реестров — год, этажность, кто управляет, отзывы
     * без имён — открыты даже гостю подбора. Их и показываем.
     */
    return html`
      ${waiting.houseKey ? html`
        <button class="btn-primary" data-action="pick-open" data-key="${esc(waiting.houseKey)}"
                style="margin-top:0">Паспорт дома</button>` : ''}
      <div class="dt-card">
        <div class="meter-name">Лента и соседи откроются после подтверждения</div>
        <div class="dt-p" style="font-size:14px;color:var(--tx-2);margin-top:6px">
          ${waitingText(waiting)}
        </div>
      </div>`;
  }

  let p;
  try {
    p = await api.poll(id);
  } catch (error) {
    return errorState(error, 'polls');
  }
  return pollBody(p);
}

/**
 * Итог завершённого опроса — строками, а не кнопками.
 *
 * Раньше завершённый опрос рисовал те же кнопки с пустыми кружками, только
 * выключенные: выглядело так, будто можно проголосовать, а нажатие
 * молчало (27.09.2026). Теперь кружков нет, победитель выделен, свой
 * голос подписан.
 */
function pollResult(p) {
  if (!p.showResults) {
    return html`<div class="voted-note">Опрос завершён. Итоги видны только его участникам.</div>`;
  }
  const top = Math.max(...p.options.map((o) => o.votes ?? 0));
  const winners = p.options.filter((o) => top > 0 && o.votes === top);
  return html`
    <div class="poll-final">
      ${winners.length === 1
        ? html`Итог: <b>${esc(winners[0].text)}</b> — ${esc(winners[0].percent)}%`
        : top > 0 ? 'Итог: голоса разделились поровну' : 'Никто не проголосовал'}
    </div>
    <div class="poll-results">
      ${p.options.map((o) => {
        const win = winners.includes(o);
        return html`
          <div class="vote-opt result ${win ? 'win' : ''}">
            <div class="vote-opt-top">
              <span>${esc(o.text)}</span>
              ${o.id === p.myOptionId ? '<span class="vote-mine">ваш голос</span>' : ''}
            </div>
            <div class="vote-bar-bg" style="display:block">
              <div class="vote-bar" style="width:${o.percent ?? 0}%"></div>
            </div>
            <div class="vote-pct" style="display:block">${o.percent ?? 0}% · ${o.votes ?? 0} ${plural(o.votes ?? 0, 'голос', 'голоса', 'голосов')}</div>
          </div>`;
      }).join('')}
    </div>`;
}

function pollBody(p) {
  const voted = Boolean(p.myOptionId);

  return html`
    <div class="dt-title">${esc(p.title)}</div>
    ${p.description ? `<div class="dt-p">${esc(p.description)}</div>` : ''}
    <div class="dt-meta">
      ${p.closed ? 'Опрос завершён' : 'Опрос идёт'}
      ${p.closesAt && !p.closed ? ` · до ${esc(formatDate(p.closesAt))}` : ''}
      ${p.showResults ? ` · ${p.total} ${plural(p.total, 'голос', 'голоса', 'голосов')}` : ''}
    </div>

    ${p.closed ? pollResult(p) : html`
    <div id="pollOpts" style="margin-top:16px">
      ${p.options.map((o) => {
        const chosen = o.id === p.myOptionId;
        const hasResult = o.percent !== null;
        return html`
          <button class="vote-opt ${chosen ? 'chosen' : ''}"
                  ${p.closed ? 'disabled' : ''}
                  data-action="vote" data-poll="${esc(p.id)}" data-opt="${esc(o.id)}">
            <div class="vote-opt-top">
              <span>${esc(o.text)}</span>
              <span class="vote-check">
                ${chosen ? '<svg viewBox="0 0 16 16" fill="none"><path d="M3.5 8.2L6.5 11.2L12.5 4.8" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' : ''}
              </span>
            </div>
            ${hasResult ? html`
              <div class="vote-bar-bg" style="display:block">
                <div class="vote-bar" style="width:${o.percent}%"></div>
              </div>
              <div class="vote-pct" style="display:block">${o.percent}% · ${o.votes} ${plural(o.votes, 'голос', 'голоса', 'голосов')}</div>` : ''}
          </button>`;
      }).join('')}
    </div>`}

    ${!p.showResults && !voted ? html`
      <div class="voted-note">
        Результаты откроются после вашего голоса. Передумаете — голос
        можно изменить, пока опрос идёт.
      </div>` : ''}

    <div class="dt-p" style="color:var(--tx-2);font-size:13px">
      ${esc(p.legalNotice)}
    </div>`;
}

/* ─────────────── действия ─────────────── */

export async function handleHouseAction(action, target, ctx) {
  switch (action) {
    case 'post':
      /**
       * Отметку ставим ДО показа, но её неудачу глотаем: карточка
       * обязана открыться в любом случае — она важнее отметки.
       */
      api.markPostRead(target.dataset.id).catch(() => {});
      await ctx.show('post', { id: target.dataset.id });
      return true;

    case 'feed-more':
      feedShown += FEED_STEP;
      await keepScroll(() => ctx.refresh());
      return true;

    case 'new-post':
      await ctx.show('new-post');
      return true;

    /**
     * Поля выбора файла шлют `change`, а не `click` — оба слушателя
     * стоят в main.js. Здесь только показываем, что выбрано: без этого
     * кнопка выглядит нажатой впустую.
     */
    case 'pick-post-photo': {
      const name = document.querySelector('#postPhotoName');
      const file = target.files?.[0];
      if (name) {
        name.textContent = file
          ? file.name
          : 'Необязательно';
      }
      return true;
    }

    case 'poll':
      await ctx.show('poll', { id: target.dataset.id });
      return true;

    case 'vote': {
      if (target.disabled) return true;
      try {
        const updated = await api.vote(target.dataset.poll, target.dataset.opt);
        platform.haptic('medium');
        // Сервер возвращает опрос целиком — перерисовываем без второго запроса
        const host = document.querySelector('#screen');
        if (host) host.innerHTML = pollBody(updated);
      } catch (error) {
        toast(error.message);
      }
      return true;
    }

    /**
     * Показать телефон соседям. Номер — только подтверждённый MAX:
     * если его ещё нет, MAX спросит разрешение поделиться номером.
     */
    case 'post-share-toggle': {
      // Пока ждём ответа MAX, повторные нажатия не запускают второй запрос
      if (target.dataset.busy) return true;
      const on = target.getAttribute('aria-pressed') !== 'true';
      if (on && !ctx.state.me?.user?.phoneVerified) {
        target.dataset.busy = '1';
        target.setAttribute('aria-busy', 'true');
        if (platform.inMax) toast('Подтвердите номер в окне MAX');
        try {
          const { contact, reason } = await platform.requestContact();
          if (!contact) {
            toast(SHARE_PHONE_FAIL[reason] ?? SHARE_PHONE_FAIL.declined);
            return true;
          }
          await api.verifyPhone(contact);
          await ctx.refreshMe();
        } catch (error) {
          toast(error.message);
          return true;
        } finally {
          delete target.dataset.busy;
          target.removeAttribute('aria-busy');
        }
      }
      target.setAttribute('aria-pressed', String(on));
      target.querySelector('.toggle')?.classList.toggle('on', on);
      return true;
    }

    /**
     * Написать автору в MAX.
     *
     * Ссылки на личный диалог по id или телефону у MAX нет
     * (dev.max.ru/help/deeplinks). Есть ник — открываем профиль, а готовое
     * сообщение копируем. Ника нет — «Отправить в MAX» с вписанным текстом,
     * получателя человек выбирает сам: телефон автора показан рядом.
     */
    case 'post-write': {
      const message = `Здравствуйте! Пишу по поводу вашего объявления «${target.dataset.title}» из приложения «Домовой».`;
      const username = target.dataset.username;
      if (username) {
        try { await navigator.clipboard?.writeText(message); } catch { /* буфер недоступен */ }
        toast('Сообщение скопировано — вставьте его в чат');
        platform.openMaxLink(`https://max.ru/${encodeURIComponent(username)}`);
      } else {
        platform.openMaxLink(`https://max.ru/:share?text=${encodeURIComponent(message)}`);
      }
      return true;
    }

    case 'submit-post': {
      const title = document.querySelector('#postTitle');
      const body = document.querySelector('#postBody');
      const contact = document.querySelector('#postContact');

      if (!check(title, '#postTitleErr', 3, 'Придумайте короткий заголовок')) return true;
      if (!check(body, '#postBodyErr', 5, 'Опишите объявление подробнее')) return true;

      await withLoading(target, async () => {
        try {
          const created = await api.createPost({
            propertyId: ctx.state.currentProperty?.propertyId,
            title: title.value.trim(),
            body: body.value.trim(),
            contact: contact?.value.trim(),
            sharePhone: document.querySelector('#postShare')?.getAttribute('aria-pressed') === 'true',
          });

          /**
           * Фотография идёт вторым запросом, как вложения к обращению.
           *
           * Если она не дошла — объявление всё равно опубликовано, и текст
           * человека не пропадает. Про фотографию говорим отдельно: молча
           * потерять её хуже, чем сказать, что не вышло.
           */
          const picked = document.querySelector('#postPhoto')?.files?.[0];
          let photoFailed = '';
          if (picked && created?.id) {
            try {
              await api.attachPostPhoto(created.id, picked);
            } catch (error) {
              photoFailed = error.message;
            }
          }

          platform.haptic('medium');
          toast(photoFailed
            ? `Объявление размещено, но фотография не приложилась: ${photoFailed}`
            : 'Объявление размещено');
          await ctx.show('market');
        } catch (error) {
          toast(error.message);
        }
      });
      return true;
    }

    default:
      return false;
  }
}

function check(input, errorSelector, min, message) {
  const node = document.querySelector(errorSelector);
  const ok = (input?.value ?? '').trim().length >= min;

  input?.classList.toggle('error', !ok);
  if (node) {
    node.textContent = ok ? '' : message;
    node.classList.toggle('show', !ok);
  }
  if (!ok) input?.focus();
  return ok;
}

/** +79995072238 → +7 999 507-22-38: номер, который читается вслух */
function formatPhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length !== 11) return phone;
  return `+7 ${digits.slice(1, 4)} ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
}
