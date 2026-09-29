import { eq } from 'drizzle-orm';
import { property } from '../../db/schema.ts';
import { parseReceipt } from '../qr/receipt.ts';
import { parseAddress, looseHouseKey } from '../address/normalize.ts';
import { accessLevel } from './access.ts';
import { upsertUk, upsertAccount, upsertBill } from './bind.ts';
import type { Database } from '../../db/client.ts';

/**
 * Квитанция, отнесённая к своему объекту.
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ `bindByReceipt`. Там квитанция ОПОЗНАЁТ человека
 * и заводит заявку на доступ. Здесь человек уже вошёл, уже имеет доступ
 * к объекту и говорит: «этот счёт относится вот к этой квартире».
 * Разные вопросы и разные права — поэтому и код разный.
 *
 * Ради этого всё и затевается: у квитанции расчётного центра адреса
 * может не быть вовсе, и раньше человеку приходилось выбирать свою улицу
 * в справочнике КЛАДР руками, а объект получал пометку «адрес указали вы».
 * Когда объект известен заранее, спрашивать нечего.
 */

export interface AttachInput {
  userId: string;
  propertyId: string;
  qrString: string;
}

export type AttachResult =
  | { status: 'ok'; accountId: string; persAcc: string }
  | { status: 'no_access' }
  | { status: 'invalid_qr'; reason: string }
  | { status: 'address_mismatch'; printedAddress: string }
  | { status: 'account_elsewhere' };

export async function attachReceipt(db: Database, input: AttachInput): Promise<AttachResult> {
  /**
   * Уровень 0 достаточен: свои квитанции — это своё. Ждать председателя
   * ради собственной платёжки незачем, начисления по неподтверждённому
   * объекту и так пишутся.
   */
  const level = await accessLevel(db, input.userId, input.propertyId);
  if (level === 'none') return { status: 'no_access' };

  const parsed = parseReceipt(input.qrString);
  if (!parsed.ok) return { status: 'invalid_qr', reason: parsed.reason };

  const receipt = parsed.receipt;
  if (!receipt.payer.persAcc) return { status: 'invalid_qr', reason: 'missing_pers_acc' };

  const [target] = await db
    .select({
      houseKey: property.houseKey,
      flat: property.flat,
      addressRaw: property.addressRaw,
    })
    .from(property)
    .where(eq(property.id, input.propertyId))
    .limit(1);

  if (!target) return { status: 'no_access' };

  /**
   * Напечатанный адрес обязан сойтись с объектом.
   *
   * Иначе человек молча складывает в свою квартиру чужие начисления,
   * а потом не понимает, откуда в аналитике лишние деньги. Отказ честнее.
   *
   * Сначала строгий ключ, потом свободный: строгий расходится на разной
   * записи одного адреса — «д. 85, к. 3» против «85к3», — и отказать
   * человеку на его же квитанции было бы хуже, чем пропустить.
   */
  const printed = receipt.payer.address?.trim();
  if (printed) {
    const parsedAddress = parseAddress(printed);
    const sameHouse = parsedAddress.houseKey === target.houseKey
      || looseHouseKey(printed) === looseHouseKey(target.addressRaw);
    const sameFlat = (parsedAddress.flat ?? '') === (target.flat ?? '');

    if (!sameHouse || !sameFlat) {
      return { status: 'address_mismatch', printedAddress: printed };
    }
  }

  const ukRow = await upsertUk(db, receipt);
  const accountRow = await upsertAccount(db, input.propertyId, ukRow.id, receipt);

  /**
   * Счёт уже заведён на другой квартире и НЕ переезжает: перенос делает
   * УК из своего кабинета, где видно и счёт, и квартиру. Иначе строкой QR
   * с чужим номером счёта его можно было бы утащить к себе.
   */
  if (accountRow.propertyId !== input.propertyId) return { status: 'account_elsewhere' };

  await upsertBill(
    db, accountRow.id, input.propertyId, receipt, input.userId, level === 'full',
  );

  return { status: 'ok', accountId: accountRow.id, persAcc: receipt.payer.persAcc };
}
