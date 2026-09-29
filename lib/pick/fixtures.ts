import { account, appUser, bill, property, request, requestEvent, uk, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import type { Database } from '../../db/client.ts';

/**
 * ФИКСТУРЫ тестов подбора дома — не поведение приложения.
 *
 * Житель заводится сразу с нужным статусом привязки: тесты подбора
 * не о том, кто кого подтверждает (это lib/auth/*.test.ts).
 */

let counter = 0;

export async function resident(
  db: Database,
  houseKey: string,
  opts: { status?: 'active' | 'pending'; maxUserId?: number; decidedAt?: Date } = {},
): Promise<{ userId: string; propertyId: string }> {
  counter++;
  const userId = newId('usr');
  const propertyId = newId('prp');
  await db.insert(appUser).values({
    id: userId,
    fullName: `Житель ${counter}`,
    maxUserId: opts.maxUserId ?? null,
    maxChatId: opts.maxUserId ? 900_000 + counter : null,
  });
  await db.insert(property).values({
    id: propertyId, addressRaw: `тестовый дом ${houseKey}, кв. ${counter}`, houseKey, flat: String(counter),
  });
  await db.insert(userProperty).values({
    id: newId('ubd'), userId, propertyId, role: 'owner',
    // Подтверждён давно: просьбы и письма ждут трёх дней после решения
    status: opts.status ?? 'active', decidedAt: opts.decidedAt ?? new Date('2026-01-01T00:00:00Z'),
  });
  return { userId, propertyId };
}

export async function complaint(
  db: Database,
  who: { userId: string; propertyId: string },
  opts: { category?: string; at?: Date; answerAfterHours?: number | null } = {},
): Promise<void> {
  counter++;
  const id = newId('req');
  const at = opts.at ?? new Date();
  await db.insert(request).values({
    id, number: counter, numberScope: 'pick-test', propertyId: who.propertyId, authorId: who.userId,
    kind: 'complaint', category: opts.category ?? 'Сантехника', title: 'т', description: 'о', status: 'new', createdAt: at,
  });
  if (opts.answerAfterHours != null) {
    await db.insert(requestEvent).values({
      id: newId('evt'), requestId: id, type: 'comment', text: 'ответ', actor: 'dispatcher',
      createdAt: new Date(at.getTime() + opts.answerAfterHours * 3_600_000),
    });
  }
}

export async function billFor(db: Database, propertyId: string, period: string, rubles: number): Promise<void> {
  counter++;
  const ukId = newId('uk');
  const accountId = newId('acc');
  await db.insert(uk).values({ id: ukId, name: 'УК', inn: `77${String(counter).padStart(8, '0')}` });
  await db.insert(account).values({ id: accountId, propertyId, ukId, persAcc: `A${counter}` });
  await db.insert(bill).values({ id: newId('bil'), accountId, propertyId, period, sumKopecks: rubles * 100, source: 'qr_scan' });
}
