import { eq } from 'drizzle-orm';
import { appSetting } from '../../db/schema.ts';
import type { Database } from '../../db/client.ts';

const KEY = 'demo_enabled';

/** Показывать ли демо-дом на экране входа. Нет строки — выключено. */
export async function isDemoEnabled(db: Database): Promise<boolean> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, KEY)).limit(1);
  return row?.value === true;
}

export async function setDemoEnabled(db: Database, enabled: boolean): Promise<void> {
  await db.insert(appSetting).values({ key: KEY, value: enabled })
    .onConflictDoUpdate({ target: appSetting.key, set: { value: enabled, updatedAt: new Date() } });
}
