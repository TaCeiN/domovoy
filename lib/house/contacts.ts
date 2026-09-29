import { and, eq, ne } from 'drizzle-orm';
import { houseContact, property, userProperty } from '../../db/schema.ts';
import { newId } from '../ids.ts';
import type { Database } from '../../db/client.ts';

/**
 * Телефоны дома: лифтёрская служба, диспетчерская, домофон.
 *
 * Номер вписывает человек, который за него отвечает, — председатель,
 * УК или оператор. Ни в одном реестре этих номеров нет, а придумывать
 * их нельзя: они стоят на экране аварийных служб, и по ним звонят.
 *
 * Логика одна на три кабинета. Маршруты только проверяют, чей это дом.
 */

export const CONTACT_KINDS = ['lift', 'uk_dispatch', 'intercom', 'electric', 'plumber', 'other'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const CONTACT_LABEL: Record<ContactKind, string> = {
  lift: 'Лифтёрская служба',
  uk_dispatch: 'Аварийно-диспетчерская служба',
  intercom: 'Домофон',
  electric: 'Электрик',
  plumber: 'Сантехник',
  other: 'Другое',
};

export type EditorRole = 'chairman' | 'dispatcher' | 'operator';

/** Своих номеров («Другое») на дом: больше — это уже телефонная книга */
export const OTHER_LIMIT = 5;
const LABEL_MAX = 60;
const NOTE_MAX = 80;

/** Справочник для форм: фронт не знает наших кодов. */
export function contactKinds() {
  return CONTACT_KINDS.map((kind) => ({ kind, label: CONTACT_LABEL[kind] }));
}

/**
 * Номер как вписали, но без мусора.
 *
 * Не переформатируем: «8 (863) 200-00-00» с квитанции житель узнаёт,
 * а «88632000000» — нет. Проверяем только, что это номер: цифры,
 * пробелы, скобки, дефисы и ведущий плюс; от 3 до 15 цифр.
 */
export function cleanPhone(raw: string): string | null {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!/^\+?[\d\s()-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, '').length;
  if (digits < 3 || digits > 15) return null;
  return s;
}

/** Название строки для человека: у «Другое» — то, что вписали. */
export function contactTitle(kind: string, label: string | null): string {
  if (kind === 'other') return label || CONTACT_LABEL.other;
  return CONTACT_LABEL[kind as ContactKind] ?? kind;
}

export interface ContactView {
  id: string;
  kind: ContactKind;
  title: string;
  phone: string;
  note: string | null;
  updatedByRole: EditorRole;
  updatedAt: Date;
}

export async function listContacts(db: Database, houseKey: string): Promise<ContactView[]> {
  const rows = await db
    .select()
    .from(houseContact)
    .where(eq(houseContact.houseKey, houseKey))
    .orderBy(houseContact.createdAt);

  const order = (kind: string) => {
    const i = CONTACT_KINDS.indexOf(kind as ContactKind);
    return i === -1 ? CONTACT_KINDS.length : i;
  };

  return rows
    .sort((a, b) => order(a.kind) - order(b.kind))
    .map((r) => ({
      id: r.id,
      kind: r.kind as ContactKind,
      title: contactTitle(r.kind, r.label),
      phone: r.phone,
      note: r.note,
      updatedByRole: r.updatedByRole as EditorRole,
      updatedAt: r.updatedAt,
    }));
}

/** Тело формы как есть: маршруты не разбирают его сами, чтобы не разойтись. */
export function readContactBody(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    kind: String(b.kind ?? ''),
    label: String(b.label ?? ''),
    phone: String(b.phone ?? ''),
    note: String(b.note ?? ''),
  };
}

export type SaveContactResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'bad_kind' | 'bad_phone' | 'no_label' | 'too_many'; message: string };

export async function saveContact(
  db: Database,
  input: {
    houseKey: string;
    kind: string;
    label?: string;
    phone: string;
    note?: string;
    role: EditorRole;
    by: string;
  },
): Promise<SaveContactResult> {
  if (!CONTACT_KINDS.includes(input.kind as ContactKind)) {
    return { ok: false, reason: 'bad_kind', message: 'Выберите, что это за служба' };
  }
  const phone = cleanPhone(input.phone);
  if (!phone) {
    return { ok: false, reason: 'bad_phone', message: 'Проверьте номер: нужны цифры, от 3 до 15' };
  }
  const label = (input.label ?? '').trim().slice(0, LABEL_MAX);
  if (input.kind === 'other' && !label) {
    return { ok: false, reason: 'no_label', message: 'Напишите, чей это номер' };
  }
  const note = (input.note ?? '').trim().slice(0, NOTE_MAX) || null;

  const values = {
    phone,
    note,
    label: input.kind === 'other' ? label : null,
    updatedByRole: input.role,
    updatedBy: input.by,
    updatedAt: new Date(),
  };

  // Готовая служба одна на дом: повторное сохранение заменяет номер
  if (input.kind !== 'other') {
    const [existing] = await db
      .select({ id: houseContact.id })
      .from(houseContact)
      .where(and(eq(houseContact.houseKey, input.houseKey), eq(houseContact.kind, input.kind)))
      .limit(1);
    if (existing) {
      await db.update(houseContact).set(values).where(eq(houseContact.id, existing.id));
      return { ok: true, id: existing.id };
    }
  } else {
    const others = await db
      .select({ id: houseContact.id })
      .from(houseContact)
      .where(and(eq(houseContact.houseKey, input.houseKey), eq(houseContact.kind, 'other')));
    if (others.length >= OTHER_LIMIT) {
      return { ok: false, reason: 'too_many', message: `Не больше ${OTHER_LIMIT} своих номеров` };
    }
  }

  const id = newId('hct');
  await db.insert(houseContact).values({ id, houseKey: input.houseKey, kind: input.kind, ...values });
  return { ok: true, id };
}

export async function findContact(db: Database, id: string) {
  const [row] = await db.select().from(houseContact).where(eq(houseContact.id, id)).limit(1);
  return row ?? null;
}

export async function removeContact(db: Database, id: string): Promise<void> {
  await db.delete(houseContact).where(eq(houseContact.id, id));
}

/**
 * Номера дома для жителя.
 *
 * Гейт тот же, что у телефона УК в `/api/me` (`hideAddress`): кому мы
 * не называем адрес — неподтверждённому, чей адрес подняли по номеру
 * счёта, — тому не называем и номера его дома. Новой ступени доступа
 * здесь нет. `null` — объект не его.
 */
export async function contactsForResident(
  db: Database,
  userId: string,
  propertyId: string,
): Promise<ContactView[] | null> {
  const [row] = await db
    .select({
      status: userProperty.status,
      addressFromUser: userProperty.addressFromUser,
      houseKey: property.houseKey,
    })
    .from(userProperty)
    .innerJoin(property, eq(userProperty.propertyId, property.id))
    .where(and(
      eq(userProperty.userId, userId),
      eq(userProperty.propertyId, propertyId),
      ne(userProperty.status, 'revoked'),
    ))
    .limit(1);

  if (!row) return null;
  if (row.status === 'pending' && !row.addressFromUser) return [];
  return listContacts(db, row.houseKey);
}
