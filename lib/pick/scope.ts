import { sql } from 'drizzle-orm';
import { house } from '../../db/schema.ts';

/**
 * Какие дома есть в подборе: многоквартирные.
 *
 * Признак берём из ДАННЫХ — фонд, ГАР, число квартир, — как в правиле
 * частного дома (`effectiveHouse`). Частный дом по реестру или по решению
 * оператора исключается: у него нет соседей и нечего описывать в отзыве.
 * Дом на две квартиры — тоже: это не тот дом, который выбирают по отзывам.
 *
 * Одно правило в двух видах — для SQL и для одной строки. Меняются вместе.
 */

export const MIN_PICKER_FLATS = 3;

export interface ScopeInput {
  houseKind: string | null;
  garMkd: boolean | null;
  flatCount: number | null;
  garFlats: number | null;
  registryForm: string | null;
  form: string;
}

export function isPickerHouse(h: ScopeInput): boolean {
  if (h.registryForm === 'private' || h.form === 'private') return false;
  return h.houseKind === 'mkd'
    || h.garMkd === true
    || (h.flatCount ?? 0) >= MIN_PICKER_FLATS
    || (h.garFlats ?? 0) >= MIN_PICKER_FLATS;
}

export const PICKER_HOUSE = sql`(
  coalesce(${house.registryForm}, '') <> 'private' and ${house.form} <> 'private'
  and (${house.houseKind} = 'mkd' or ${house.garMkd} = true
       or coalesce(${house.flatCount}, 0) >= ${MIN_PICKER_FLATS}
       or coalesce(${house.garFlats}, 0) >= ${MIN_PICKER_FLATS})
)`;
