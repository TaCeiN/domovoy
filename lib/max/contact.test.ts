import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateContact, signContactForTesting, normalisePhone } from './contact.ts';

const BOT_TOKEN = process.env.MAX_BOT_TOKEN ?? 'test-token';
const USER_ID = 67890;
const now = () => Math.floor(Date.now() / 1000);

test('подписанный телефон проходит проверку', () => {
  const authDate = String(now());
  const hash = signContactForTesting('+7 999 123-45-67', authDate, USER_ID, BOT_TOKEN);
  const r = validateContact({ phone: '+7 999 123-45-67', authDate, hash },
    { botToken: BOT_TOKEN, userId: USER_ID });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.phone, '79991234567');
});

test('телефон нормализуется без плюса и разделителей', () => {
  assert.equal(normalisePhone('+7 (999) 123-45-67'), '79991234567');
});

test('подменённый номер отвергается', () => {
  const authDate = String(now());
  const hash = signContactForTesting('79991234567', authDate, USER_ID, BOT_TOKEN);
  const r = validateContact({ phone: '79990000000', authDate, hash },
    { botToken: BOT_TOKEN, userId: USER_ID });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'bad_signature');
});

test('подпись привязана к конкретному пользователю', () => {
  const authDate = String(now());
  const hash = signContactForTesting('79991234567', authDate, USER_ID, BOT_TOKEN);
  const r = validateContact({ phone: '79991234567', authDate, hash },
    { botToken: BOT_TOKEN, userId: 11111 });
  assert.equal(r.ok, false);
});

test('протухший контакт отвергается', () => {
  const authDate = String(now() - 7200);
  const hash = signContactForTesting('79991234567', authDate, USER_ID, BOT_TOKEN);
  const r = validateContact({ phone: '79991234567', authDate, hash },
    { botToken: BOT_TOKEN, userId: USER_ID });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.reason, 'expired');
});

test('authDate в миллисекундах тоже понимается', () => {
  const ms = Date.now();
  const hash = signContactForTesting('79991234567', ms, USER_ID, BOT_TOKEN);
  const r = validateContact({ phone: '79991234567', authDate: ms, hash },
    { botToken: BOT_TOKEN, userId: USER_ID });
  assert.equal(r.ok, true);
});
