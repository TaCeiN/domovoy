import { sql } from 'drizzle-orm';
import { getTableName, getTableColumns, is } from 'drizzle-orm';
import { PgTable, PgText, PgVarchar } from 'drizzle-orm/pg-core';
import * as schema from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';

/**
 * Просмотр таблиц базы — только чтение.
 *
 * ЗАЧЕМ. Оператору нужно видеть систему целиком: когда что-то пошло
 * не так, экраны под задачи отвечают на заранее заданные вопросы,
 * а вопрос обычно новый. Без этого раздела смотреть всё равно придётся —
 * через psql, то есть админка не закроет ту боль, ради которой её делают.
 *
 * ПОЧЕМУ БЕЛЫЙ СПИСОК, А НЕ ЛЮБОЕ ИМЯ. Имя таблицы приходит из запроса.
 * Подставлять его в SQL можно только сверив со списком — иначе это
 * внедрение SQL в чистом виде. Список берётся из самой схемы Drizzle,
 * а не пишется руками: новая таблица появляется в разделе сама,
 * и никто не забудет её добавить.
 */

/** Имена всех таблиц схемы — источником служит она сама. */
const ALL_TABLES: PgTable[] = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable));

export const ADMIN_TABLES: readonly string[] = ALL_TABLES
  .map((table) => getTableName(table))
  .sort();

/**
 * Колонки, которых не существует для читателя.
 *
 * Хеш пароля годится для перебора офлайн, а хеш токена — это
 * действующий ключ от чужой сессии. Просмотр таблиц не должен
 * превращаться в выгрузку учёток.
 */
export const SECRET_COLUMNS: readonly string[] = ['password_hash', 'token_hash'];

export const PAGE_SIZE = 50;

export interface TableInfo {
  name: string;
  rows: number;
}

export interface TablePage {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

function tableByName(name: string): PgTable {
  const found = ALL_TABLES.find((table) => getTableName(table) === name);
  if (!found) throw new Error(`Неизвестная таблица: ${name}`);
  return found;
}

/** Имена колонок в базе, без секретных. */
function visibleColumns(table: PgTable): string[] {
  return Object.values(getTableColumns(table))
    .map((column) => column.name)
    .filter((name) => !SECRET_COLUMNS.includes(name));
}

/** Текстовые колонки: только по ним имеет смысл искать подстрокой. */
function textColumns(table: PgTable): string[] {
  return Object.values(getTableColumns(table))
    .filter((column) => is(column, PgText) || is(column, PgVarchar))
    .map((column) => column.name)
    .filter((name) => !SECRET_COLUMNS.includes(name));
}

export async function listTables(db: Database): Promise<TableInfo[]> {
  const out: TableInfo[] = [];
  for (const name of ADMIN_TABLES) {
    const result = await db.execute(
      sql`select count(*)::int as n from ${sql.identifier(name)}`,
    );
    const row = (result.rows ?? result)[0] as { n: number } | undefined;
    out.push({ name, rows: Number(row?.n ?? 0) });
  }
  return out;
}

export async function readTable(
  db: Database,
  name: string,
  opts: { page?: number; q?: string } = {},
): Promise<TablePage> {
  const table = tableByName(name);
  const columns = visibleColumns(table);
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const q = (opts.q ?? '').trim();

  /**
   * Имя таблицы и имена колонок идут через `sql.identifier`: они уже
   * сверены со схемой, но экранирование снимает вопрос целиком.
   * Значение поиска — обычный параметр, в текст запроса не попадает.
   */
  const selected = sql.join(columns.map((c) => sql.identifier(c)), sql`, `);
  const from = sql.identifier(name);

  const searchable = textColumns(table);
  const where = q && searchable.length
    ? sql` where ${sql.join(
        searchable.map((c) => sql`${sql.identifier(c)} ilike ${'%' + q + '%'}`),
        sql` or `,
      )}`
    : sql``;

  const counted = await db.execute(
    sql`select count(*)::int as n from ${from}${where}`,
  );
  const total = Number(((counted.rows ?? counted)[0] as { n: number })?.n ?? 0);

  const result = await db.execute(
    sql`select ${selected} from ${from}${where} limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`,
  );

  return {
    name,
    columns,
    rows: (result.rows ?? result) as Record<string, unknown>[],
    total,
    page,
    pageSize: PAGE_SIZE,
  };
}
