import { and, eq, isNull } from 'drizzle-orm';
import { chairman, dispatcher, managingOrg, property } from '../../db/schema.ts';
import { houseState } from '../house/form.ts';
import type { Database } from '../../db/client.ts';

/**
 * Кому адресовано обращение.
 *
 * ЦЕПОЧКА: организация → председатель → никто. Организация сильнее
 * председателя, потому что чинить обязана она, а совет дома отвечает
 * там, где обязанной организации нет — при ТСЖ без штата
 * и непосредственном управлении.
 *
 * 'none' — не ошибка и не повод закрыть форму. Ядро продукта в том,
 * что у жителя остаётся ДАТИРОВАННОЕ доказательство жалобы, и оно
 * остаётся, даже когда прочитать её сегодня некому.
 */
export type Addressee =
  | {
      kind: 'org';
      orgId: string;
      name: string;
      /**
       * Настоящий телефон организации из реестра. `null`, если его там нет.
       *
       * Пустое поле — это ответ, а выдуманный номер ответом не является.
       * До аудита 11 сентября в карточке обращения стоял литерал
       * «+7 (495) 123-45-67 · будни 8:00–20:00», а на экране аварийных
       * служб — «+7 495 000-00-00». По таким номерам звонят.
       */
      phone: string | null;
      /**
       * Есть ли у организации СВОЙ КАБИНЕТ, то есть живой человек,
       * который заявку прочитает.
       *
       * ЗАЧЕМ ОТДЕЛЬНО ОТ САМОГО ФАКТА ОРГАНИЗАЦИИ. Строка в реестре
       * лицензий есть у каждого дома области — измерено 11 сентября:
       * 14 221 дом, и кабинет диспетчера заведён у восьми. Пока это
       * не различалось, приложение обещало всем остальным «диспетчер
       * увидит заявку сразу, срок реакции 24 часа, статус придёт
       * уведомлением» — и молчало навсегда, а через сутки показывало
       * жителю красное «Срок вышел». Обвиняло оно при этом компанию,
       * которая о заявке не знает.
       *
       * Тот же признак уже считает `decidersForHouse` (lib/auth/claims.ts)
       * ради кнопки «Подключить дом»; здесь он нужен ради текста.
       */
      hasCabinet: boolean;
    }
  | { kind: 'chairman'; name: string }
  | { kind: 'none' };

export async function addresseeForProperty(
  db: Database,
  propertyId: string,
): Promise<Addressee> {
  const [row] = await db
    .select({ houseKey: property.houseKey })
    .from(property)
    .where(eq(property.id, propertyId))
    .limit(1);
  if (!row) return { kind: 'none' };

  const state = await houseState(db, row.houseKey);

  if (state.orgId) {
    const [org] = await db
      .select({
        name: managingOrg.name,
        shortName: managingOrg.shortName,
        phone: managingOrg.phone,
      })
      .from(managingOrg)
      .where(eq(managingOrg.id, state.orgId))
      .limit(1);
    if (org) {
      const [cabinet] = await db
        .select({ id: dispatcher.id })
        .from(dispatcher)
        .where(eq(dispatcher.orgId, state.orgId))
        .limit(1);

      return {
        kind: 'org',
        orgId: state.orgId,
        name: org.shortName ?? org.name,
        phone: org.phone?.trim() || null,
        hasCabinet: Boolean(cabinet),
      };
    }
  }

  const [chair] = await db
    .select({ name: chairman.name })
    .from(chairman)
    .where(and(eq(chairman.houseKey, row.houseKey), isNull(chairman.revokedAt)))
    .limit(1);
  if (chair) return { kind: 'chairman', name: chair.name };

  return { kind: 'none' };
}

/** Область сквозной нумерации заявок: организация либо сам дом. */
export function numberScopeFor(orgId: string | null, houseKey: string): string {
  return orgId ?? `house:${houseKey}`;
}
