import { sql } from 'drizzle-orm';
import { operatorEventSeen } from '../../db/schema.ts';
import { effectiveHouse } from '../house/form.ts';
import type { Database } from '../../db/client.ts';

/**
 * События оператора — то, что без него никто не разберёт.
 *
 * ПОЧЕМУ НЕ РАССЫЛКА. Оператор регулярно заходит в кабинет сам — так решил
 * владелец. Письмо или сообщение в мессенджер дублировало бы кабинет
 * и однажды ушло бы не туда.
 *
 * ПОЧЕМУ НЕ ТАБЛИЦА СОБЫТИЙ. События выводятся запросом из самих данных:
 * заявка открыта, у дома нет организации, жалобу некому прочитать.
 * Копия в отдельной таблице разошлась бы с правдой в тот момент, когда
 * у дома появился председатель, а событие осталось висеть. Хранится только
 * отметка «оператор это видел».
 */

export type EventKind = 'house_claim' | 'unknown_house' | 'no_org' | 'orphan_request';

export const EVENT_KINDS: EventKind[] = ['house_claim', 'orphan_request', 'unknown_house', 'no_org'];

export const EVENT_LABEL: Record<EventKind, string> = {
  house_claim: 'Заявка «Подключить дом»',
  orphan_request: 'Жалоба без адресата',
  unknown_house: 'Житель из дома вне реестра',
  no_org: 'Житель из дома без организации',
};

export interface OperatorEvent {
  kind: EventKind;
  /** id заявки, привязки жителя или обращения — в зависимости от вида */
  refId: string;
  at: string;
  houseKey: string;
  address: string;
  userId: string | null;
  userName: string | null;
  detail: string | null;
  seen: boolean;
}

export interface EventsQuery {
  kind?: EventKind;
  unseenOnly?: boolean;
  limit?: number;
}

type Row = Record<string, unknown>;
const rowsOf = (result: { rows: unknown[] }) => result.rows as Row[];

async function houseClaims(db: Database): Promise<Omit<OperatorEvent, 'seen'>[]> {
  const result = await db.execute(sql`
    select hc.id, hc.created_at, hc.house_key, hc.user_id, hc.note, u.full_name,
           coalesce(h.address_raw, (select min(p.address_raw) from property p where p.house_key = hc.house_key)) as address
      from house_claim hc
      join app_user u on u.id = hc.user_id
      left join house h on h.house_key = hc.house_key
     where hc.status = 'open'`);
  return rowsOf(result).map((r) => ({
    kind: 'house_claim', refId: String(r.id), at: new Date(String(r.created_at)).toISOString(),
    houseKey: String(r.house_key), address: String(r.address ?? r.house_key),
    userId: String(r.user_id), userName: String(r.full_name), detail: (r.note as string | null) ?? null,
  }));
}

/**
 * Жители из домов, о которых реестр ничего не знает или где некому управлять.
 *
 * Привязки pending и active: заявка на доступ — тоже живой человек,
 * который ждёт. Отозванные — уже не событие.
 */
async function residents(db: Database): Promise<Omit<OperatorEvent, 'seen'>[]> {
  const result = await db.execute(sql`
    select up.id, up.created_at, up.user_id, u.full_name, p.house_key, p.address_raw,
           h.house_key as known, h.address_raw as registry_address,
           h.form, h.org_id, h.multi_flat, h.registry_form, h.registry_org_id, h.gar_flats, h.gar_mkd,
           mo.license_number as registry_license
      from user_property up
      join property p on p.id = up.property_id
      join app_user u on u.id = up.user_id
      left join house h on h.house_key = p.house_key
      left join managing_org mo on mo.id = h.registry_org_id
     where up.status in ('pending', 'active')`);

  const events: Omit<OperatorEvent, 'seen'>[] = [];
  for (const r of rowsOf(result)) {
    const base = {
      refId: String(r.id), at: new Date(String(r.created_at)).toISOString(), houseKey: String(r.house_key),
      address: String(r.address_raw), userId: String(r.user_id), userName: String(r.full_name), detail: null,
    };

    if (!r.known || !r.registry_address) {
      events.push({ kind: 'unknown_house', ...base });
      continue;
    }

    const state = effectiveHouse({
      form: String(r.form), orgId: (r.org_id as string | null) ?? null, multiFlat: (r.multi_flat as boolean | null) ?? null,
      registryForm: (r.registry_form as string | null) ?? null, registryOrgId: (r.registry_org_id as string | null) ?? null,
      registryLicense: (r.registry_license as string | null) ?? null, garFlats: (r.gar_flats as number | null) ?? null,
      garMkd: (r.gar_mkd as boolean | null) ?? null,
    });
    // Частному дому организация не положена — жалобы такого жителя и так идут оператору
    if (!state.orgId && state.form !== 'private') events.push({ kind: 'no_org', ...base });
  }
  return events;
}

/**
 * Открытые обращения, которые никто, кроме оператора, не прочитает:
 * у дома нет председателя, а организации нет или у неё нет кабинета.
 */
async function orphanRequests(db: Database): Promise<Omit<OperatorEvent, 'seen'>[]> {
  const result = await db.execute(sql`
    select r.id, r.created_at, r.number, r.title, r.author_id, u.full_name, p.house_key, p.address_raw
      from request r
      join property p on p.id = r.property_id
      join app_user u on u.id = r.author_id
     where r.status not in ('done', 'rejected')
       and not exists (select 1 from chairman c where c.house_key = p.house_key and c.revoked_at is null)
       and (r.org_id is null or not exists (select 1 from dispatcher d where d.org_id = r.org_id))`);
  return rowsOf(result).map((r) => ({
    kind: 'orphan_request', refId: String(r.id), at: new Date(String(r.created_at)).toISOString(),
    houseKey: String(r.house_key), address: String(r.address_raw),
    userId: String(r.author_id), userName: String(r.full_name), detail: `№${r.number} · ${r.title}`,
  }));
}

export async function operatorEvents(db: Database, query: EventsQuery): Promise<{
  rows: OperatorEvent[]; unseen: Record<EventKind, number>; total: number;
}> {
  const [claims, people, requests, seenRows] = await Promise.all([
    houseClaims(db), residents(db), orphanRequests(db),
    db.select({ kind: operatorEventSeen.kind, refId: operatorEventSeen.refId }).from(operatorEventSeen),
  ]);
  const seen = new Set(seenRows.map((s) => `${s.kind}:${s.refId}`));

  const all: OperatorEvent[] = [...claims, ...requests, ...people]
    .map((event) => ({ ...event, seen: seen.has(`${event.kind}:${event.refId}`) }))
    .sort((a, b) => b.at.localeCompare(a.at));

  const unseen = { house_claim: 0, unknown_house: 0, no_org: 0, orphan_request: 0 } as Record<EventKind, number>;
  for (const event of all) if (!event.seen) unseen[event.kind]++;

  const filtered = all.filter((event) =>
    (!query.kind || event.kind === query.kind) && (!query.unseenOnly || !event.seen));

  return { rows: filtered.slice(0, query.limit ?? 200), unseen, total: filtered.length };
}

export async function markEventsSeen(
  db: Database,
  adminId: string,
  items: { kind: EventKind; refId: string }[],
): Promise<number> {
  if (items.length === 0) return 0;
  const rows = await db.insert(operatorEventSeen)
    .values(items.map((item) => ({ kind: item.kind, refId: item.refId, seenBy: adminId })))
    .onConflictDoNothing()
    .returning({ refId: operatorEventSeen.refId });
  return rows.length;
}
