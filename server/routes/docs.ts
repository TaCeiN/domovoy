import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Документация собственного API — для экспертов и платформы проверки.
 *
 *   /openapi.yaml   — OpenAPI 3.1: все методы, кроме кабинета оператора;
 *   /DATA-API.yaml  — обязательные проверки основного сценария;
 *   /API-TEST-DATA.json — роли демо-дома и тела запросов для проверки.
 *
 * Файлы лежат в корне репозитория, в образ их кладёт Dockerfile. Читаются
 * один раз при старте: меняются они только вместе с кодом. Сверку с
 * настоящими ответами держит server/contract.test.ts.
 */
const FILES = ['openapi.yaml', 'DATA-API.yaml', 'API-TEST-DATA.json'] as const;

export async function docsRoutes(app: FastifyInstance) {
  for (const name of FILES) {
    let body: string | null = null;
    try {
      body = readFileSync(join(process.cwd(), name), 'utf-8');
    } catch {
      body = null;
    }
    app.get(`/${name}`, async (_request, reply) => {
      if (body === null) return reply.code(404).send({ error: 'not_found', message: 'Документация не найдена' });
      const type = name.endsWith('.json') ? 'application/json' : 'application/yaml';
      return reply.type(`${type}; charset=utf-8`).send(body);
    });
  }
}
