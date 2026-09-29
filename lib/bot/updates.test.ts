import { test } from 'node:test';
import assert from 'node:assert/strict';
import { incomingFromUpdate } from './updates.ts';
import { NO_TEXT } from './handle.ts';

const message = (body: Record<string, unknown>, chat = 'dialog') => ({
  update_type: 'message_created',
  message: { sender: { user_id: 7 }, recipient: { chat_type: chat }, body: { mid: 'm1', ...body } },
});

test('текст из лички — как есть', () => {
  assert.deepEqual(incomingFromUpdate(message({ text: 'привет' })), { maxUserId: 7, text: 'привет', mid: 'm1' });
});

test('стикер, фото, голосовое — не молчим: особый текст, на который бот просит написать словами', () => {
  assert.deepEqual(incomingFromUpdate(message({ attachments: [{ type: 'sticker' }] })), { maxUserId: 7, text: NO_TEXT, mid: 'm1' });
});

test('групповой чат и сообщения ботов — мимо', () => {
  assert.equal(incomingFromUpdate(message({ text: 'привет' }, 'chat')), null);
  assert.equal(incomingFromUpdate({ update_type: 'message_created', message: { sender: { user_id: 7, is_bot: true }, body: { mid: 'm2', text: 'x' } } }), null);
});
