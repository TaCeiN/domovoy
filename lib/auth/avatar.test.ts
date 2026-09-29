import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avatarKind } from './avatar.ts';

test('по отчеству: «…вич» — мужской, «…вна» — женский', () => {
  assert.equal(avatarKind('Кузнецов Андрей Павлович'), 'male');
  assert.equal(avatarKind('Лебедева Ольга Викторовна'), 'female');
  assert.equal(avatarKind('Мамедов Эльдар Рашид оглы'), 'male');
  assert.equal(avatarKind('Алиева Лейла Рашид кызы'), 'female');
  assert.equal(avatarKind('Сидорова Анна Ильинична'), 'female');
});

test('без отчества — по имени, с мужскими именами на -а и -я', () => {
  assert.equal(avatarKind('Смирнова Анна'), 'female');
  assert.equal(avatarKind('Крутых Никита'), 'male');
  assert.equal(avatarKind('Ильин Илья'), 'male');
  assert.equal(avatarKind('Петров Иван'), 'male');
  assert.equal(avatarKind('Мария'), 'female');
});

test('не понять — null: пусто, заглушка, инициал вместо отчества', () => {
  assert.equal(avatarKind(''), null);
  assert.equal(avatarKind(null), null);
  assert.equal(avatarKind('Житель'), null);
  assert.equal(avatarKind('Смирнова Т'), null);
});
