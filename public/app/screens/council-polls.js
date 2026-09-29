import { api } from '../api.js';
import { platform } from '../platform.js';
import { displayAddress,
  esc, html, formatDate, plural, toast, withLoading, emptyState, errorState,
} from '../ui.js';
import { readPollForm } from '../house-admin.js';
import { dateField, todayValue } from '../datepicker.js';

/**
 * Опросы дома глазами председателя.
 *
 * РЕЗУЛЬТАТ ВИДЕН ВСЕГДА. Жителю проценты открываются только после его
 * голоса — чтобы чужой выбор не влиял на его собственный. Председатель
 * не голосующий, а организатор: прятать от него ход опроса незачем.
 *
 * ЭТО НЕ ОБЩЕЕ СОБРАНИЕ СОБСТВЕННИКОВ. ОСС по ЖК РФ требует подсчёта
 * по долям в праве собственности, кворума, реестра собственников
 * и протокола. Здесь голоса считаются по людям, и оговорка про это
 * стоит в форме — там, где человек принимает решение опубликовать.
 */

export async function renderCouncilPolls(state) {
  const house = state.council?.house;
  if (!house) return errorState(new Error('Дом не выбран'), 'council');

  let polls;
  try {
    polls = (await api.chairmanPolls(house.houseKey)).polls;
  } catch (error) {
    return errorState(error, 'council');
  }

  return html`
    <div class="dt-title" style="margin-top:0">Опросы</div>
    <div class="dt-meta">${esc(displayAddress(house.houseLabel))}</div>

    ${polls.length === 0
      ? emptyState(
          'Опросов пока нет',
          'Спросите жителей о том, что решаете вместе',
        )
      : polls.map(pollCard).join('')}

    <button class="btn-primary" data-action="council-poll-new">Запустить опрос</button>`;
}

function pollCard(p) {
  return html`
    <div class="dt-card">
      <div class="meter-name">${esc(p.title)}</div>
      <div class="dt-meta" style="margin-top:4px">
        ${p.closed ? 'Завершён' : 'Идёт'}
        ${p.closesAt && !p.closed ? ` · до ${esc(formatDate(p.closesAt))}` : ''}
        · ${p.total} ${plural(p.total, 'голос', 'голоса', 'голосов')}
      </div>

      ${p.options.map((o) => {
        // Проценты считает экран: сервер отдаёт голоса и общее число
        const percent = p.total ? Math.round((o.votes / p.total) * 100) : 0;
        return html`
          <div class="vote-opt">
            <div class="vote-opt-top"><span>${esc(o.text)}</span></div>
            <div class="vote-bar-bg" style="display:block">
              <div class="vote-bar" style="width:${percent}%"></div>
            </div>
            <div class="vote-pct" style="display:block">
              ${percent}% · ${o.votes} ${plural(o.votes, 'голос', 'голоса', 'голосов')}
            </div>
          </div>`;
      }).join('')}
    </div>`;
}

/** Форма опроса. Идентификаторы полей — общие с кабинетом УК. */
export function renderCouncilPollForm() {
  return html`
    <div class="dt-p" style="margin-top:2px;font-size:13px;color:var(--tx-2)">
      Это опрос, а не общее собрание собственников: голоса считаются
      по людям, а не по долям, и юридической силы у результата нет.
    </div>

    <div class="field-label">Вопрос</div>
    <input type="text" id="hpTitle" placeholder="Например: ставим ли шлагбаум на въезде">
    <div class="field-error" id="hpTitleErr"></div>

    <div class="field-label">Пояснение</div>
    <textarea id="hpDesc" placeholder="Зачем спрашиваем и что будет с результатом"></textarea>

    <div class="field-label">Варианты ответа, по одному в строке</div>
    <textarea id="hpOptions" placeholder="Каждый вариант с новой строки">За&#10;Против&#10;Воздержался</textarea>
    <div class="field-error" id="hpOptionsErr"></div>

    <div class="field-label">Голосование до</div>
    ${dateField({ id: 'hpCloses', withTime: true, min: todayValue(), placeholder: 'Срок не выбран' })}
    <div class="dt-p" style="font-size:13px;color:var(--tx-2)">
      Опрос закроется сам в это время. Остановить его раньше срока нельзя,
      поэтому ставьте дату, до которой ответ вам действительно нужен.
    </div>

    <button class="btn-primary" data-action="hp-create">Запустить опрос</button>`;
}

export async function handleCouncilPollsAction(action, target, ctx) {
  if (action === 'council-polls') {
    await ctx.go('council-polls');
    return true;
  }

  if (action === 'council-poll-new') {
    await ctx.go('council-poll-new');
    return true;
  }

  if (action === 'hp-create') {
    const payload = readPollForm();
    if (!payload) {
      const titleOk = (document.querySelector('#hpTitle')?.value ?? '').trim().length >= 1;
      showError('#hpTitle', '#hpTitleErr', titleOk, 'Сформулируйте вопрос');
      showError('#hpOptions', '#hpOptionsErr',
        (document.querySelector('#hpOptions')?.value ?? '')
          .split('\n').map((o) => o.trim()).filter(Boolean).length >= 2,
        'Нужно хотя бы два варианта, каждый с новой строки');
      // Курсор — в первое незаполненное поле
      document.querySelector(titleOk ? '#hpOptions' : '#hpTitle')?.focus();
      return true;
    }

    await withLoading(target, async () => {
      try {
        await api.chairmanCreatePoll({
          ...payload,
          houseKey: ctx.state.council.house.houseKey,
        });
        platform.haptic('medium');
        toast('Опрос запущен');
        await ctx.back();
      } catch (error) {
        toast(error.message);
      }
    });
    return true;
  }

  return false;
}

function showError(inputSelector, errorSelector, ok, message) {
  const input = document.querySelector(inputSelector);
  const node = document.querySelector(errorSelector);

  input?.classList.toggle('error', !ok);
  if (node) {
    node.textContent = ok ? '' : message;
    node.classList.toggle('show', !ok);
  }
}
