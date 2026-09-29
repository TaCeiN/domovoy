import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slaHoursFor, slaDueAt, slaState, slaLabel, DEFAULT_SLA_HOURS } from './sla.ts';

test('аварийные сроки жёстче бытовых', () => {
  assert.equal(slaHoursFor('Авария'), 2);
  assert.equal(slaHoursFor('Лифт'), 8);
  assert.equal(slaHoursFor('Сантехника'), 24);
  assert.equal(slaHoursFor('Общее имущество'), 72);
});

test('незнакомая категория получает срок по умолчанию, а не ноль', () => {
  assert.equal(slaHoursFor('Чего-то новое'), DEFAULT_SLA_HOURS);
  assert.ok(slaDueAt('Чего-то новое').getTime() > Date.now());
});

test('срок отсчитывается от момента создания', () => {
  const from = new Date('2026-08-21T10:00:00Z');
  assert.equal(slaDueAt('Сантехника', from).toISOString(), '2026-08-22T10:00:00.000Z');
  assert.equal(slaDueAt('Авария', from).toISOString(), '2026-08-21T12:00:00.000Z');
});

test('состояние срока: в порядке, скоро, просрочено', () => {
  const now = new Date('2026-08-21T12:00:00Z');
  const inHours = (h: number) => new Date(now.getTime() + h * 3600_000);

  assert.equal(slaState(inHours(20), 'Сантехника', now), 'ok');
  // Предупреждаем за четверть срока: у суточной заявки это последние 6 часов
  assert.equal(slaState(inHours(5), 'Сантехника', now), 'soon');
  assert.equal(slaState(inHours(-1), 'Сантехника', now), 'overdue');
  assert.equal(slaState(null, 'Сантехника', now), 'ok');
});

test('«скоро» зависит от категории, а не от фиксированного окна', () => {
  const now = new Date('2026-08-21T12:00:00Z');
  const inMinutes = (m: number) => new Date(now.getTime() + m * 60_000);

  // У двухчасовой аварии предупреждение — последние 30 минут
  assert.equal(slaState(inMinutes(20), 'Авария', now), 'soon');
  assert.equal(slaState(inMinutes(50), 'Авария', now), 'ok');
});

test('подпись срока склоняется по-русски', () => {
  const now = new Date('2026-08-21T12:00:00Z');
  const at = (ms: number) => new Date(now.getTime() + ms);

  assert.equal(slaLabel(at(3 * 3600_000), now), 'осталось 3 часа');
  assert.equal(slaLabel(at(1 * 3600_000), now), 'осталось 1 час');
  assert.equal(slaLabel(at(11 * 3600_000), now), 'осталось 11 часов');
  assert.equal(slaLabel(at(2 * 86400_000), now), 'осталось 2 дня');
  assert.equal(slaLabel(at(5 * 86400_000), now), 'осталось 5 дней');
  assert.equal(slaLabel(at(-2 * 3600_000), now), 'просрочено на 2 часа');
  assert.equal(slaLabel(at(21 * 60_000), now), 'осталось 21 минуту');
  assert.equal(slaLabel(null, now), 'без срока');
});
