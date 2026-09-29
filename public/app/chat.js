import { html, esc, eventAuthor, eventRole } from './ui.js';

/**
 * Переписка по обращению — как в Telegram (просьба владельца 29.09).
 *
 * Один разбор на обе стороны: житель видит себя справа, кабинет УК —
 * себя. По центру только факты (создание, смена статуса) и даты.
 * Раньше жительская лента и «таймлайн» УК считали события каждая
 * по-своему — и расходились при первой правке.
 *
 * Первое сообщение жителя — само обращение: описание и его вложения.
 * Вложения УК — своим сообщением в момент загрузки.
 */

const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля',
  'августа', 'сентября', 'октября', 'ноября', 'декабря'];

function dayLabel(value) {
  const d = new Date(value);
  const today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Сегодня';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (same(d, yesterday)) return 'Вчера';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === today.getFullYear() ? '' : ` ${d.getFullYear()}`}`;
}

const timeOf = (value) => {
  const d = new Date(value);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Кто это сказал: «Диспетчер · Диспетчер УК …» — роль уже в имени, второй раз не пишем */
function who(e) {
  const role = eventRole(e.actor);
  return e.actorName && e.actorName.toLowerCase().startsWith(role.toLowerCase()) ? e.actorName : eventAuthor(e);
}

/**
 * @param {{ events: any[], photos?: any[], description?: string, createdAt: string, authorName?: string }} r
 * @param {'resident' | 'dispatcher'} side — чьи сообщения справа
 * @param {{ file?: (f: any) => string }} [opts] — своя кнопка вложения: у кабинета
 *   УК другие адреса файлов и своя подгрузка картинок
 */
export function chatTimeline(r, side, opts = {}) {
  /**
   * Номер фото на странице: просмотрщик листает все `.att-thumb` экрана
   * по порядку (open-photo в requests.js), и индекс должен с ним совпасть.
   */
  let photoIndex = 0;

  const files = (list) => (list.length ? html`
    <div class="chat-files">
      ${list.map((f) => (opts.file ? opts.file(f) : f.mime?.startsWith('image/')
        ? html`<button class="att-thumb" data-action="open-photo" data-i="${photoIndex++}" data-url="${esc(f.url)}" aria-label="Фото"></button>`
        : html`<button class="chat-file" data-action="open-file" data-url="${esc(f.url)}">${esc(f.name)}</button>`)).join('')}
    </div>` : '');

  const bubble = ({ mine, author, text, at, attached = [] }) => html`
    <div class="chat-msg ${mine ? 'mine' : 'theirs'}">
      ${mine ? '' : html`<div class="chat-who">${esc(author)}</div>`}
      <div class="chat-bubble">
        ${files(attached)}
        ${text ? html`<div class="chat-t">${esc(text)}</div>` : ''}
        <div class="chat-time">${esc(timeOf(at))}</div>
      </div>
    </div>`;

  const photos = r.photos ?? [];
  const time = (at) => new Date(at).getTime();
  const comments = r.events.filter((e) => e.type === 'comment');

  /**
   * Файл — в то сообщение, с которым его отправили.
   *
   * Файлы уходят отдельным запросом сразу после текста, поэтому своё
   * сообщение у файла — последнее сообщение того же автора не позже него.
   * Раньше все файлы жителя складывались в само обращение: ответ с фото
   * выглядел отправленным без фото, а снимок молча появлялся наверху.
   * Файл УК без реплики рядом (5 минут) остаётся отдельным сообщением.
   */
  const attachedTo = new Map();
  const ukLoose = [];
  for (const f of photos) {
    const mineActor = f.byDispatcher ? 'dispatcher' : 'resident';
    const owner = comments
      .filter((e) => e.actor === mineActor && time(e.at) <= time(f.at))
      .at(-1);
    if (owner && (!f.byDispatcher || time(f.at) - time(owner.at) < 5 * 60_000)) {
      attachedTo.set(owner, [...(attachedTo.get(owner) ?? []), f]);
    } else if (f.byDispatcher) {
      ukLoose.push(f);
    } else {
      attachedTo.set('intro', [...(attachedTo.get('intro') ?? []), f]);
    }
  }

  const items = [
    { kind: 'intro', at: r.createdAt },
    ...r.events.filter((e) => e.type !== 'created').map((e) => ({ kind: 'event', at: e.at, e })),
    ...ukLoose.map((f) => ({ kind: 'ukfile', at: f.at, f })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at));

  const created = r.events.find((e) => e.type === 'created');
  let lastDay = '';
  const out = [];
  for (const item of items) {
    const day = dayLabel(item.at);
    if (day !== lastDay) {
      out.push(html`<div class="chat-day"><span>${esc(day)}</span></div>`);
      lastDay = day;
    }
    if (item.kind === 'intro') {
      out.push(bubble({
        mine: side === 'resident', author: r.authorName || 'Житель',
        text: r.description, at: r.createdAt, attached: attachedTo.get('intro') ?? [],
      }));
      // «Заявка принята диспетчером» — сразу под самим обращением
      if (created) out.push(html`<div class="chat-event"><div class="chat-event-t">${esc(created.text)}</div></div>`);
    } else if (item.kind === 'ukfile') {
      out.push(bubble({ mine: side === 'dispatcher', author: 'Управляющая компания', text: '', at: item.at, attached: [item.f] }));
    } else if (item.e.type === 'comment') {
      const e = item.e;
      const mine = side === 'resident' ? e.actor === 'resident' : e.actor === 'dispatcher';
      out.push(bubble({ mine, author: who(e), text: e.text, at: e.at, attached: attachedTo.get(e) ?? [] }));
    } else {
      const e = item.e;
      out.push(html`
        <div class="chat-event ${e.type === 'status' ? 'status' : ''}">
          <div class="chat-event-t">${esc(e.text)}</div>
          <div class="chat-event-d">${e.actor === 'system' ? '' : `${esc(who(e))} · `}${esc(timeOf(e.at))}</div>
        </div>`);
    }
  }
  return html`<div class="chat">${out.join('')}</div>`;
}
