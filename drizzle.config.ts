import type { Config } from 'drizzle-kit';

const url = process.env.DATABASE_URL;

if (!url) {
  throw new Error(
    'DATABASE_URL не задан. Локально: docker compose up -d db, ' +
    'затем скопируйте .env.example в .env.local',
  );
}

export default {
  schema: './db/schema.ts',
  out: './db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
} satisfies Config;
