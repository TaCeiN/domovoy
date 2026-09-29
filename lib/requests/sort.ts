/**
 * Порядок очереди в кабинете УК.
 *
 *   deadline — сначала просроченные и горящие (как было всегда);
 *   newest   — новые сверху: разобрать свежее за утро;
 *   oldest   — старые сверху: не забытое ли что-то.
 *
 * Просьба владельца 27.09: сортировка только по сроку реакции прятала
 * свежие заявки без срока в самый низ.
 */
export const REQUEST_SORTS = ['deadline', 'newest', 'oldest'] as const;
export type RequestSort = (typeof REQUEST_SORTS)[number];

export function readSort(raw: unknown): RequestSort {
  return REQUEST_SORTS.includes(raw as RequestSort) ? (raw as RequestSort) : 'deadline';
}

/** Сортирует копию; очередь по сроку приходит из listForDispatcher уже готовой */
export function sortRequests<T extends { createdAt: Date }>(rows: T[], sort: RequestSort): T[] {
  if (sort === 'deadline') return rows;
  const dir = sort === 'newest' ? -1 : 1;
  return [...rows].sort((a, b) => dir * (a.createdAt.getTime() - b.createdAt.getTime()));
}
