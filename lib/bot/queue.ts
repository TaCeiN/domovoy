/**
 * Порядок и нагрузка для бота.
 *
 * `perKey` — сообщения одного человека разбираются по очереди: два
 * быстрых сообщения подряд иначе читали бы и писали его память
 * одновременно, и второе затирало бы первое.
 *
 * `limit` — не больше N одновременных обращений к GigaChat: на
 * бесплатном тарифе параллельных потоков мало, лишний получит ошибку.
 */

export function perKey() {
  const tails = new Map<string, Promise<unknown>>();
  return function run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(job);
    tails.set(key, next);
    void next.catch(() => {}).finally(() => {
      if (tails.get(key) === next) tails.delete(key);
    });
    return next;
  };
}

export function limit(n: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (active >= n) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await job();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
