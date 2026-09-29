import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perKey, limit } from './queue.ts';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('сообщения одного человека — по очереди, разных — параллельно', async () => {
  const run = perKey();
  const log: string[] = [];
  const job = (name: string, ms: number) => async () => { log.push(`+${name}`); await tick(ms); log.push(`-${name}`); };
  await Promise.all([run('a', job('a1', 20)), run('a', job('a2', 1)), run('b', job('b1', 5))]);
  assert.ok(log.indexOf('-a1') < log.indexOf('+a2'), log.join(' '));
  assert.ok(log.indexOf('+b1') < log.indexOf('-a1'), 'другой человек не ждёт');
});

test('упавшее сообщение не останавливает очередь', async () => {
  const run = perKey();
  await assert.rejects(run('a', async () => { throw new Error('x'); }));
  assert.equal(await run('a', async () => 'ok'), 'ok');
});

test('не больше N одновременно', async () => {
  const run = limit(2);
  let now = 0;
  let peak = 0;
  await Promise.all([1, 2, 3, 4, 5].map(() => run(async () => {
    now += 1; peak = Math.max(peak, now); await tick(5); now -= 1;
  })));
  assert.equal(peak, 2);
});
