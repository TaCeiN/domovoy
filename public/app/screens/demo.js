import { api, ApiError } from '../api.js';
import { platform } from '../platform.js';
import { esc, html, formatDate, toast, withLoading, confirmAction } from '../ui.js';
import { maxAutoLogin } from '../config.js';
import { wipNote } from '../wip.js';

/**
 * Демо-дом на экране входа.
 *
 * Эксперт хакатона открывает приложение без квитанции — и видит роли
 * выдуманного дома: председатель, собственники, жилец, новичок. Нажал —
 * вошёл этим жителем. В MAX роль держится на его аккаунте (бот тоже
 * отвечает от имени персонажа), в браузере — просто сессия.
 *
 * Включает и выключает оператор (кабинет → «Демо-дом»). Выключенное демо
 * не рисует здесь ничего.
 */

/** Место под блок: наполняется после загрузки ролей */
export function demoBlockMarkup(config) {
  return config?.demoEnabled ? '<div id="demoBlock" class="demo-block"></div>' : '';
}

export async function mountDemoBlock(root) {
  const box = root.querySelector('#demoBlock');
  if (!box) return;

  let data;
  try {
    data = await api.demoRoles();
  } catch {
    box.remove();
    return;
  }

  box.innerHTML = html`
    <div class="field-label" style="margin-top:26px">Посмотреть без квитанции</div>
    ${wipNote('demoHouse')}
    ${data.released ? html`
      <div class="ask-card">
        <div class="ask-h">Вашу роль передали другому эксперту</div>
        <div class="ask-d">«${esc(data.released.roleTitle)}» забрали
          ${esc(formatDate(data.released.releasedAt))}. Выберите роль ниже.</div>
      </div>` : ''}
    <div class="dt-p" style="font-size:13px;color:var(--tx-2);margin:0 0 10px">
      ${data.inMax
        ? 'Выберите, кем войти в демо-дом. Ваш аккаунт MAX станет этим жителем — бот тоже будет отвечать от его имени. Занятую роль можно забрать.'
        : 'Выберите, кем войти в демо-дом. Ничего сканировать не нужно.'}
    </div>
    <div class="list">
      ${data.roles.map((r) => html`
        <button class="row tappable" data-action="demo-take" data-key="${esc(r.key)}">
          ${r.avatar ? html`<img class="demo-ava" src="icons/avatars/${esc(r.avatar)}.webp" alt="" aria-hidden="true">` : ''}
          <div class="content">
            <div class="t">${esc(r.title)}</div>
            <div class="d">${esc(r.subtitle)}</div>
            ${data.inMax ? html`
              <div class="d demo-state ${r.mine ? 'mine' : r.holderName ? 'busy' : ''}">
                ${r.mine
                  ? 'это вы'
                  : r.holderName
                    ? `занята · ${esc(r.holderName)} · с ${esc(formatDate(r.heldSince))}`
                    : 'свободна'}
              </div>` : ''}
          </div>
          <span class="chev"><svg width="12" height="12" viewBox="0 0 14 14" fill="none"><path d="M5 3L9 7L5 11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        </button>`).join('')}
    </div>`;
}

/**
 * Взять роль. Занятая роль и «свой житель на этом MAX» спрашивают согласия;
 * токен сохраняет api.js, дальше — обычный запуск приложения.
 */
export async function takeDemoRole(target, onSuccess) {
  const key = target.dataset.key;

  await withLoading(target, async () => {
    let opts = {};
    for (;;) {
      try {
        await api.demoTake(key, opts);
        maxAutoLogin.allow();
        platform.haptic('medium');
        onSuccess();
        return;
      } catch (error) {
        const body = error instanceof ApiError ? (error.body ?? {}) : {};
        if (body.error === 'taken' && !opts.takeover) {
          const ok = await confirmAction({
            title: 'Роль занята',
            text: `Сейчас её держит ${body.holderName ?? 'другой эксперт'}`
              + `${body.heldSince ? `, с ${formatDate(body.heldSince)}` : ''}. `
              + 'Забрать себе? У него роль пропадёт, он сможет выбрать другую.',
            confirmLabel: 'Забрать себе',
          });
          if (!ok) return;
          opts = { ...opts, takeover: true };
          continue;
        }
        if (body.error === 'has_own' && !opts.unlinkMine) {
          const ok = await confirmAction({
            title: 'К вашему MAX уже привязан житель',
            text: `«${body.ownName}» останется в приложении, но отвяжется от вашего аккаунта MAX. Взять роль?`,
            confirmLabel: 'Отвязать и взять',
          });
          if (!ok) return;
          opts = { ...opts, unlinkMine: true };
          continue;
        }
        toast(error.message);
        return;
      }
    }
  });
}
