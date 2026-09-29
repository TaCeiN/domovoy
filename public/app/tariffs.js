/**
 * Тарифы ЖКХ рядом со счётчиками — только настоящие цифры.
 *
 * Источники (собраны 27.09.2026, просьба владельца):
 *   вода и водоотведение, АО «Ростовводоканал», Ростов-на-Дону —
 *     с 01.01.2026 постановление РСТ Ростовской области № 596 от 18.12.2025;
 *     с 01.10.2026 холодная вода 69,15 ₽, водоотведение +4,31 ₽ (РСТ, сентябрь 2026);
 *   электроэнергия, городское население без электроплит — 5,99 → 6,66 ₽/кВт·ч;
 *   газ для населения Ростовской области — постановление РСТ, опубликовано
 *     11.07.2026: плита 9,30 → 10,22 ₽/м³, плита с колонкой 9,17 → 10,08 ₽/м³,
 *     отопление 9 014 → 9 903 ₽ за 1000 м³.
 *
 * Горячей воды здесь нет: в Ростове её цена зависит от поставщика тепла,
 * официальной единой цифры мы не нашли — выдумывать не будем.
 *
 * Цены на воду действуют только в Ростове-на-Дону, поэтому весь блок
 * показывается только для адресов в нём. Новую индексацию — новой строкой
 * в PERIODS, старые строки не трогать: по ним видно, как менялась цена.
 */

/** Дата смены тарифа: 1 октября 2026, полночь по Москве */
const OCT_2026 = Date.parse('2026-09-30T21:00:00Z');

const PERIODS = [
  {
    from: Date.parse('2025-12-31T21:00:00Z'),
    cold: 62.98, sewer: 44.12, elec: 5.99, gasStove: 9.30, gasStoveHeater: 9.17, gasHeating: 9.014,
  },
  {
    from: OCT_2026,
    cold: 69.15, sewer: 48.43, elec: 6.66, gasStove: 10.22, gasStoveHeater: 10.08, gasHeating: 9.903,
  },
];

export const TARIFF_SOURCE = 'Тарифы — Региональная служба по тарифам Ростовской области, для Ростова-на-Дону';

function periodAt(now) {
  return [...PERIODS].reverse().find((p) => now >= p.from) ?? PERIODS[0];
}

function nextAfter(now) {
  return PERIODS.find((p) => p.from > now) ?? null;
}

const rub = (n) => `${n.toFixed(2).replace('.', ',')} ₽`;

/** Строки тарифа: [подпись, цена сейчас, цена со следующей даты] */
const LINES = {
  cold: [['Холодная вода', 'cold'], ['Водоотведение', 'sewer']],
  elec: [['Электроэнергия', 'elec']],
  elec_t1: [['Электроэнергия', 'elec']],
  elec_t2: [['Электроэнергия', 'elec']],
  gas: [['Газ, плита', 'gasStove'], ['Газ, плита и колонка', 'gasStoveHeater']],
  heat: [['Газ на отопление', 'gasHeating']],
};

/** По какой строке считать примерную сумму: вода — вместе со стоками */
const COST_KEYS = { cold: ['cold', 'sewer'], elec: ['elec'], gas: ['gasStove'], heat: ['gasHeating'] };

export function tariffApplies(property) {
  return /ростов-на-дону/i.test(property?.addressRaw ?? '');
}

/**
 * Блок тарифа под счётчиком. `null` — тарифа нет (горячая вода, не Ростов).
 * `monthly` — обычный расход жителя за месяц по его же записям.
 */
export function tariffFor(kind, property, monthly, now = Date.now()) {
  if (!tariffApplies(property)) return null;
  if (kind === 'hot') {
    return { note: 'Тариф на горячую воду смотрите в квитанции: он зависит от поставщика тепла.' };
  }
  const lines = LINES[kind];
  if (!lines) return null;
  const cur = periodAt(now);
  const next = nextAfter(now);
  const unit = kind.startsWith('elec') ? 'кВт·ч' : 'м³';
  const rows = lines.map(([label, key]) => ({
    label,
    now: `${rub(cur[key])} за ${unit}`,
    next: next ? rub(next[key]) : null,
  }));
  const costKeys = COST_KEYS[kind.startsWith('elec') ? 'elec' : kind];
  const cost = monthly > 0 && costKeys
    ? Math.round(monthly * costKeys.reduce((sum, k) => sum + cur[k], 0))
    : null;
  return {
    rows,
    nextDate: next ? new Date(next.from).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'Europe/Moscow' }) : null,
    cost,
  };
}
