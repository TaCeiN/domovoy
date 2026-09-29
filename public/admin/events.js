import { displayAddress, esc, html, formatDate, emptyState, toast, withLoading } from '../app/ui.js';

/**
 * События оператора — первый раздел кабинета.
 *
 * Рассылок нет намеренно: оператор заходит сюда сам. Раздел отвечает на один
 * вопрос — «что сейчас без меня никто не разберёт». Событие исчезает само,
 * когда исчезла причина (у дома появился председатель, заявку решили),
 * а «Просмотрено» только гасит счётчик новых.
 */

const KIND_TONE = {
  house_claim: 'accent',
  orphan_request: 'danger',
  unknown_house: 'warn',
  no_org: 'muted',
};

const KIND_HINT = {
  house_claim: 'Житель просит подключить дом: проставьте форму, подключите организацию или назначьте председателя.',
  orphan_request: 'Обращение никто не прочитает: у дома нет председателя, а у организации — кабинета.',
  unknown_house: 'Адреса нет в реестре: проверьте, правильно ли житель указал дом.',
  no_org: 'Дом в реестре есть, организации нет: жалобы этого жителя разбираете вы.',
};

export const eventsState = {
  kind: '',
  unseenOnly: true,
  /** Последний ответ: ключи показанных событий для «отметить все» */
  shown: [],
};

export function unseenTotal(unseen) {
  return Object.values(unseen ?? {}).reduce((sum, n) => sum + n, 0);
}

export function eventsSection(data) {
  eventsState.shown = data.rows.map((r) => ({ kind: r.kind, refId: r.refId }));
  const total = unseenTotal(data.unseen);

  const chip = (kind, label, count) => html`
    <button class="dsp-chip ${eventsState.kind === kind ? 'on' : ''}"
            data-action="events-kind" data-kind="${esc(kind)}">
      ${esc(label)}${count ? html` <b>${count}</b>` : ''}
    </button>`;

  return html`
    <section class="dsp-card">
      <div class="dsp-section-head">
        <div>
          <h2>События</h2>
          <p class="dsp-dim">${total ? `Новых: ${total}` : 'Новых событий нет'}</p>
        </div>
        <div class="dsp-actions">
          <label class="dsp-check">
            <input type="checkbox" data-action="events-unseen" ${eventsState.unseenOnly ? 'checked' : ''}>
            только новые
          </label>
          ${data.rows.some((r) => !r.seen)
            ? '<button class="dsp-mini" data-action="events-seen-all">Отметить показанные просмотренными</button>'
            : ''}
        </div>
      </div>

      <div class="dsp-chips">
        ${chip('', 'Все', total)}
        ${data.kinds.map((k) => chip(k.kind, k.label, data.unseen[k.kind])).join('')}
      </div>

      ${eventsState.kind
        ? html`<div class="dsp-note ${KIND_TONE[eventsState.kind]}">${esc(KIND_HINT[eventsState.kind])}</div>`
        : ''}

      ${data.rows.length === 0
        ? emptyState(eventsState.unseenOnly ? 'Всё просмотрено' : 'Событий нет', 'Здесь появится то, что требует оператора')
        : html`
          <div class="dsp-table-wrap">
          <table class="dsp-table dsp-events">
            <thead><tr><th>Когда</th><th>Событие</th><th>Адрес</th><th>Житель</th><th><span class="sr-only">Действия</span></th></tr></thead>
            <tbody>
              ${data.rows.map((r) => html`
                <tr class="${r.seen ? 'seen' : 'fresh'}">
                  <td class="dsp-nowrap dsp-muted-cell">${esc(formatDate(r.at))}</td>
                  <td>
                    <span class="dsp-badge ${KIND_TONE[r.kind]}" title="${esc(KIND_HINT[r.kind])}">${esc(data.kinds.find((k) => k.kind === r.kind)?.label ?? r.kind)}</span>
                    ${r.detail ? html`<div class="dsp-dim">${esc(r.detail)}</div>` : ''}
                  </td>
                  <td class="dsp-addr-cell">${esc(displayAddress(r.address))}</td>
                  <td>${esc(r.userName ?? '—')}</td>
                  <td class="dsp-row-actions">
                    <button class="dsp-mini" data-action="open-house" data-key="${esc(r.houseKey)}">Дом</button>
                    ${r.userId ? html`<button class="dsp-mini" data-action="open-user" data-id="${esc(r.userId)}">Житель</button>` : ''}
                    ${r.seen ? '' : html`<button class="dsp-mini" data-action="event-seen"
                        data-kind="${esc(r.kind)}" data-ref="${esc(r.refId)}">Просмотрено</button>`}
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
          </div>
          ${data.total > data.rows.length ? html`<p class="dsp-dim">Показаны ${data.rows.length} из ${data.total}</p>` : ''}`}
    </section>`;
}

/** true — действие обработано разделом событий */
export async function handleEventsAction(action, target, { api, render }) {
  switch (action) {
    case 'events-kind':
      eventsState.kind = target.dataset.kind;
      await render();
      return true;

    case 'events-unseen':
      eventsState.unseenOnly = target.checked;
      await render();
      return true;

    case 'event-seen':
      await withLoading(target, async () => {
        await api.eventsSeen([{ kind: target.dataset.kind, refId: target.dataset.ref }]);
      });
      await render();
      return true;

    case 'events-seen-all': {
      if (!eventsState.shown.length) return true;
      await withLoading(target, async () => {
        const { marked } = await api.eventsSeen(eventsState.shown);
        toast(`Отмечено: ${marked}`);
      });
      await render();
      return true;
    }

    default:
      return false;
  }
}
