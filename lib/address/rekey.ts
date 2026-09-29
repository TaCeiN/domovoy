import { parseAddress } from './normalize.ts';

/**
 * План пересчёта ключей домов реестра.
 *
 * ЗАЧЕМ. Ключ дома считается из адреса, и когда правила разбора меняются,
 * записи в базе остаются со старыми ключами. Житель при этом считает свой
 * дом по новым — связка «дом → управляющая компания» рвётся на ровном
 * месте, а выглядит это как «у моего дома нет УК».
 *
 * ПОЧЕМУ УДАЛЕНИЕ. Когда правила становятся мягче, два дома реестра могут
 * дать один ключ: так вышло, когда дробь приравняли к корпусу — «85/3»
 * и «85, к. 3» стали одним домом. Уникальный индекс по ключу второй
 * записи не пустит, а значит одна из них должна уйти.
 *
 * Кто именно — решается тем же правилом, что и выбор дома в pick-house.ts:
 * дом остаётся за ДЕЙСТВУЮЩЕЙ организацией. Заблокированная держала его
 * лишь потому, что его не забрала действующая.
 *
 * План считается целиком и заранее, а не по ходу обхода: иначе исход
 * зависел бы от того, в каком порядке база вернула строки.
 */

export interface HouseRow {
  id: string;
  addressRaw: string;
  houseKey: string;
  /** Организация заблокирована в ГИС ЖКХ */
  blocked: boolean;
}

export interface RekeyPlan {
  updates: { id: string; houseKey: string }[];
  deletes: string[];
  /** Адрес не разбирается — такие не трогаем вовсе */
  unparsed: string[];
}

export function planRekey(rows: HouseRow[]): RekeyPlan {
  const plan: RekeyPlan = { updates: [], deletes: [], unparsed: [] };

  /** Новый ключ → все записи, которые на него претендуют */
  const byKey = new Map<string, HouseRow[]>();

  for (const row of rows) {
    const key = parseAddress(row.addressRaw).houseKey;
    if (!key) {
      plan.unparsed.push(row.id);
      continue;
    }
    const group = byKey.get(key);
    if (group) group.push(row);
    else byKey.set(key, [row]);
  }

  for (const [key, group] of byKey) {
    /**
     * Победитель: действующая организация, иначе первый по идентификатору.
     *
     * Сортировка по id, а не «первый из базы»: она даёт один и тот же
     * ответ при любом порядке строк, и повторный прогон не переставит
     * дома местами.
     */
    const sorted = [...group].sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });

    const [winner, ...losers] = sorted;
    for (const loser of losers) plan.deletes.push(loser.id);
    if (winner.houseKey !== key) plan.updates.push({ id: winner.id, houseKey: key });
  }

  return plan;
}
