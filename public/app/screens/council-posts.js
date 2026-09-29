import { api } from '../api.js';
import { platform } from '../platform.js';
import { displayAddress,
  esc, html, formatDate, toast, withLoading, emptyState, errorState, moreLine, keepScroll,
} from '../ui.js';
import {
  POST_KINDS, DEFAULT_POST_KIND, readPostForm, showPickedPhoto, pickedPostPhoto,
} from '../house-admin.js';
import { dateField, todayValue } from '../datepicker.js';

/**
 * Объявления совета дома.
 *
 * ПРАВИЛА ОБЩИЕ С КАБИНЕТОМ УК, ВЁРСТКА СВОЯ. Типы объявлений, их
 * подсказки и разбор формы берутся из house-admin.js: разъехавшись,
 * два кабинета начнут публиковать разное в одну и ту же ленту дома.
 * А вот разметка там дисперчерская (классы dsp-*), и в приложении
 * жителя для неё нет ни строчки CSS — поэтому здесь она своя,
 * с теми же идентификаторами полей.
 */

const KIND_TONE = { outage: 'bad', meeting: 'new', news: '' };

/** Сколько объявлений показано: за год их набирается больше сотни. */
const POSTS_STEP = 50;
let postsShown = POSTS_STEP;

export async function renderCouncilPosts(state) {
  const house = state.council?.house;
  if (!house) return errorState(new Error('Дом не выбран'), 'council');

  let data;
  try {
    data = await api.chairmanPosts(house.houseKey, postsShown);
  } catch (error) {
    return errorState(error, 'council');
  }

  const posts = data.posts;
  const total = data.total ?? posts.length;

  return html`
    <div class="dt-meta" style="margin-top:0">${esc(displayAddress(house.houseLabel))}</div>

    ${posts.length === 0
      ? emptyState(
          'Объявлений пока нет',
          'Напишите первое — его увидят жители дома',
        )
      : html`
        <div class="list" style="margin-top:14px">${posts.map(postRow).join('')}</div>
        ${moreLine({ shown: posts.length, total, action: 'council-posts-more' })}`}

    <button class="btn-primary" data-action="council-post-new">Написать объявление</button>`;
}

/**
 * Строка объявления.
 *
 * Снятое остаётся в списке приглушённым и без кнопки: председатель
 * должен видеть, что он снял, иначе снятие выглядит как пропажа.
 */
function postRow(p) {
  return html`
    <div class="row" style="${p.removed ? 'opacity:.55' : ''}">
      <span class="sq ${p.removed || p.expired ? '' : KIND_TONE[p.category] ?? ''}">
        <svg viewBox="0 0 20 20" fill="none"><rect x="3" y="4.5" width="14" height="11" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M6.5 8.5H13.5M6.5 11.5H11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
      </span>
      <div class="content">
        <div class="t">${esc(p.title)}</div>
        <div class="d">
          ${esc(p.categoryLabel)} · ${esc(formatDate(p.publishedAt))}
          ${p.expiresAt ? ` · до ${esc(formatDate(p.expiresAt))}` : ''}
        </div>
        <div class="d" style="font-size:12px">${stateWords(p)}</div>
      </div>
      ${p.removed ? '' : html`
        <button class="pay-quickbtn tappable" style="background:var(--fade);color:var(--negative)"
                data-action="ha-remove" data-id="${esc(p.id)}">Снять</button>`}
    </div>`;
}

/**
 * Состояние словами.
 *
 * «На главном экране» — только у действующего отключения: баннер наверху
 * показывает именно их. Обещать это собранию и новости было бы неправдой.
 */
function stateWords(p) {
  if (p.removed) return 'Снято';
  if (p.expired) return 'Срок вышел, в ленте не показывается';
  if (p.category === 'outage') return 'На главном экране у жителей';
  return 'В ленте дома';
}

/** Форма объявления. Идентификаторы полей — общие с кабинетом УК. */
export function renderCouncilPostForm() {
  return html`
    <div class="field-label" style="margin-top:2px">Тип</div>
    <div class="chips" id="haKind">
      ${POST_KINDS.map((k) => html`
        <span class="chip ${k.value === DEFAULT_POST_KIND ? 'sel' : ''}" data-action="ha-kind"
              data-v="${esc(k.value)}" data-hint="${esc(k.hint)}">${esc(k.label)}</span>
      `).join('')}
    </div>
    <div class="dt-p" style="font-size:13px;color:var(--tx-2);margin-top:8px" id="haKindHint">
      ${esc(POST_KINDS.find((k) => k.value === DEFAULT_POST_KIND).hint)}
    </div>

    <div class="field-label">Заголовок</div>
    <input type="text" id="haTitle" placeholder="Например: субботник во дворе в эту субботу">
    <div class="field-error" id="haTitleErr"></div>

    <div class="field-label">Текст</div>
    <textarea id="haBody" placeholder="Что происходит, где и что делать жильцам"></textarea>
    <div class="field-error" id="haBodyErr"></div>

    <div class="field-label">Актуально до</div>
    ${dateField({ id: 'haExpires', withTime: true, min: todayValue(), placeholder: 'Без срока' })}
    <div class="dt-p" style="font-size:13px;color:var(--tx-2)">
      После этого времени объявление перестанет висеть на главном экране
      жителя. Без срока «нет воды до 18:00» остаётся там навсегда —
      у собрания и новости срок можно не ставить.
    </div>

    <button class="btn-primary" data-action="ha-publish">Опубликовать</button>`;
}

export async function handleCouncilPostsAction(action, target, ctx) {
  if (action === 'council-posts') {
    // Вход в раздел показывает свежее: прошлый «показать ещё» не тянем
    postsShown = POSTS_STEP;
    await ctx.go('council-posts');
    return true;
  }

  if (action === 'council-posts-more') {
    postsShown += POSTS_STEP;
    await keepScroll(() => ctx.refresh());
    return true;
  }

  if (action === 'council-post-new') {
    await ctx.go('council-post-new');
    return true;
  }

  // Подсказка меняется вместе с типом: у отключения она про рассылку
  if (action === 'ha-kind') {
    target.parentElement?.querySelectorAll('.chip')
      .forEach((chip) => chip.classList.remove('sel'));
    target.classList.add('sel');
    const hint = document.querySelector('#haKindHint');
    if (hint) hint.textContent = target.dataset.hint ?? '';
    return true;
  }

  if (action === 'ha-photo') {
    showPickedPhoto(target);
    return true;
  }

  if (action === 'ha-publish') {
    const payload = readPostForm();
    if (!payload) {
      const titleOk = fieldError('#haTitle', '#haTitleErr', 3, 'Придумайте короткий заголовок');
      fieldError('#haBody', '#haBodyErr', 5, 'Опишите объявление подробнее');
      // Курсор — в первое незаполненное поле: иначе экран прыгает к нижнему,
      // и человек дописывает текст, не заметив пустого заголовка
      document.querySelector(titleOk ? '#haBody' : '#haTitle')?.focus();
      return true;
    }

    await withLoading(target, async () => {
      try {
        const result = await api.chairmanCreatePost({
          ...payload,
          houseKey: ctx.state.council.house.houseKey,
        });
        /**
         * Фотография идёт вторым запросом, как вложения к обращению.
         * Не дошла — объявление всё равно опубликовано: терять
         * написанный текст из-за картинки нельзя.
         */
        const photo = pickedPostPhoto();
        let photoFailed = '';
        if (photo && result?.id) {
          try {
            await api.attachPostPhoto(result.id, photo);
          } catch (error) {
            photoFailed = error.message;
          }
        }

        platform.haptic('medium');
        toast(photoFailed
          ? `Опубликовано, но фотография не приложилась: ${photoFailed}`
          : result.notified
            ? `Опубликовано, уведомление ушло ${result.notified} жильцам`
            : 'Опубликовано');
        await ctx.back();
      } catch (error) {
        toast(error.message);
      }
    });
    return true;
  }

  if (action === 'ha-remove') {
    await withLoading(target, async () => {
      try {
        await api.chairmanRemovePost(target.dataset.id, ctx.state.council.house.houseKey);
        toast('Объявление снято');
        await ctx.refresh();
      } catch (error) {
        toast(error.message);
      }
    });
    return true;
  }

  return false;
}

/** Подсветить поле и объяснить, чего не хватает. */
function fieldError(inputSelector, errorSelector, min, message) {
  const input = document.querySelector(inputSelector);
  const node = document.querySelector(errorSelector);
  const ok = (input?.value ?? '').trim().length >= min;

  input?.classList.toggle('error', !ok);
  if (node) {
    node.textContent = ok ? '' : message;
    node.classList.toggle('show', !ok);
  }
  return ok;
}
