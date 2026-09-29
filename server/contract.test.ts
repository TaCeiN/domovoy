import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parse } from 'yaml';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formatsModule from 'ajv-formats';
import { buildApp } from './app.ts';
import { testDb, resetTables, closeTestDb, isDbAvailable, TEST_URL } from '../lib/test-db.ts';
import { closeDb } from '../db/client.ts';
import { seedDemo } from '../lib/demo/seed.ts';
import { setDemoEnabled } from '../lib/demo/setting.ts';
import { resetRateLimits } from './rate-limit.ts';

/**
 * Контракт собственного API: DATA-API.yaml и openapi.yaml против настоящих ответов.
 *
 * Эксперты хакатона прогоняют проверки из DATA-API.yaml на бою, на демо-доме,
 * и сверяют коды, форматы и обязательные поля с заявленным контрактом.
 * Здесь те же проверки идут по порядку на свежем демо-доме в тестовой базе:
 * поменял ответ маршрута — тест упадёт до сдачи, а не у экспертов.
 *
 * Второе: каждый маршрут приложения (кроме кабинета оператора) описан
 * в openapi.yaml, и каждый описанный — существует.
 */

process.env.DATABASE_URL = TEST_URL;

const available = await isDbAvailable();
const skip = available ? false : 'нет локальной базы: docker compose up -d db';

type Json = Record<string, unknown>;
const openapi = parse(readFileSync('openapi.yaml', 'utf-8')) as Json;
const dataApi = parse(readFileSync('DATA-API.yaml', 'utf-8')) as {
  auth: { roles: Record<string, { login?: { method: string; path: string; body?: unknown }; token?: string }> };
  checks: Array<{
    id: string; role: string;
    request: { method: string; path: string; query?: Record<string, string>; headers?: Record<string, string>; body?: unknown };
    response: { status: number[]; contentType?: string; requiredFields?: string[]; json?: Json; openapi?: string };
    save?: Record<string, string>;
  }>;
};

/** JSON-указатель «#/a/b~1c» по документу OpenAPI */
function pointer(ref: string): unknown {
  return ref.replace(/^#\//, '').split('/').reduce<unknown>((node, raw) => {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    return (node as Json)?.[key];
  }, openapi);
}

/** Подставить $ref рекурсивно: схемы нашего документа без циклов */
function deref(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(deref);
  if (node && typeof node === 'object') {
    const ref = (node as Json).$ref;
    if (typeof ref === 'string') return deref(pointer(ref));
    return Object.fromEntries(Object.entries(node as Json).map(([k, v]) => [k, deref(v)]));
  }
  return node;
}

function pick(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Json)?.[key], obj);
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats — CommonJS: в ESM функция приходит то сразу, то в .default
const addFormats = ((formatsModule as unknown as { default?: unknown }).default ?? formatsModule) as (a: Ajv2020) => void;
addFormats(ajv);

const app = buildApp();
const vars: Record<string, string> = {};
const tokens: Record<string, string> = {};

function fill<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`)
      .replace(/\$\{(\w+)\}/g, (_, k) => vars[k] ?? `\${${k}}`) as T;
  }
  if (Array.isArray(value)) return value.map(fill) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)])) as T;
  }
  return value;
}

async function tokenFor(role: string): Promise<string | undefined> {
  if (role === 'guest') return undefined;
  if (tokens[role]) return tokens[role];
  const def = dataApi.auth.roles[role];
  assert.ok(def?.login, `роль ${role} без способа входа в DATA-API.yaml`);
  const res = await app.inject({
    method: def.login.method as 'POST', url: def.login.path,
    headers: { 'content-type': 'application/json' }, payload: fill(def.login.body ?? {}) as Json,
  });
  assert.equal(res.statusCode, 200, `вход роли ${role}: ${res.body}`);
  tokens[role] = pick(res.json(), def.token ?? 'token') as string;
  return tokens[role];
}

before(async () => {
  if (!available) return;
  await resetTables();
  resetRateLimits();
  const creds = await seedDemo(testDb());
  await setDemoEnabled(testDb(), true);
  vars.DEMO_UK_PASSWORD = creds.ukPassword;
});
after(async () => { await app.close(); await closeTestDb(); await closeDb(); });

test('каждая схема openapi.yaml компилируется', () => {
  const paths = openapi.paths as Record<string, Record<string, Json>>;
  for (const [path, ops] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(ops)) {
      for (const [code, resp] of Object.entries((op.responses ?? {}) as Json)) {
        const schema = (deref(resp) as Json)?.content as Json | undefined;
        const json = (schema?.['application/json'] as Json | undefined)?.schema;
        if (json) assert.doesNotThrow(() => ajv.compile(json as Json), `${method} ${path} ${code}`);
      }
    }
  }
});

test('openapi.yaml описывает все маршруты приложения и только их', async () => {
  await app.ready();
  const documented = new Set<string>();
  for (const [path, ops] of Object.entries(openapi.paths as Record<string, Json>)) {
    for (const method of Object.keys(ops)) {
      documented.add(`${method.toUpperCase()} ${path}`);
      const url = path.replace(/\{(\w+)\}/g, ':$1');
      assert.ok(app.hasRoute({ method: method.toUpperCase() as 'GET', url }), `описан, но нет в приложении: ${method} ${path}`);
    }
  }
  // Маршруты из кода — тем же поиском, что сборка документа; кабинет оператора не описываем
  const inCode: string[] = [];
  for (const file of readdirSync('server/routes')) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const src = readFileSync(`server/routes/${file}`, 'utf-8');
    for (const m of src.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/g)) {
      if (!m[2].startsWith('/api/') || m[2].startsWith('/api/admin')) continue;
      inCode.push(`${m[1].toUpperCase()} ${m[2].replace(/:(\w+)/g, '{$1}')}`);
    }
  }
  const missing = inCode.filter((r) => !documented.has(r));
  assert.deepEqual(missing, [], 'маршруты без описания в openapi.yaml');
});

test('проверки DATA-API.yaml проходят на демо-доме и совпадают с openapi.yaml', { skip }, async () => {
  for (const check of dataApi.checks) {
    const req = fill(check.request);
    const token = await tokenFor(check.role);
    const query = req.query ? `?${new URLSearchParams(req.query)}` : '';
    const res = await app.inject({
      method: req.method as 'GET',
      url: req.path + query,
      headers: {
        ...(req.headers ?? {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(req.body !== undefined ? { payload: req.body as Json } : {}),
    });

    const where = `проверка ${check.id} (${req.method} ${req.path})`;
    assert.ok(check.response.status.includes(res.statusCode), `${where}: код ${res.statusCode}, ждали ${check.response.status}: ${res.body}`);
    if (check.response.contentType) {
      assert.ok(String(res.headers['content-type']).startsWith(check.response.contentType), `${where}: тип ${res.headers['content-type']}`);
    }
    const body = res.headers['content-type']?.toString().includes('json') ? res.json() : null;
    for (const field of check.response.requiredFields ?? []) {
      assert.notEqual(pick(body, field), undefined, `${where}: нет обязательного поля ${field}`);
    }
    for (const [k, v] of Object.entries(check.response.json ?? {})) {
      assert.deepEqual(pick(body, k), v, `${where}: поле ${k}`);
    }
    if (check.response.openapi) {
      const resp = deref(pointer(check.response.openapi)) as Json;
      const schema = ((resp.content as Json)?.['application/json'] as Json)?.schema as Json;
      assert.ok(schema, `${where}: в openapi.yaml нет схемы по ${check.response.openapi}`);
      const validate = ajv.compile(schema);
      assert.ok(validate(body), `${where}: ответ не совпал со схемой openapi.yaml: ${ajv.errorsText(validate.errors)}`);
    }
    for (const [name, path] of Object.entries(check.save ?? {})) {
      const value = pick(body, path);
      assert.notEqual(value, undefined, `${where}: нечего сохранить в ${name}`);
      vars[name] = String(value);
      if (name === 'residentToken') tokens.resident = String(value);
      if (name === 'dispatcherToken') tokens.dispatcher = String(value);
    }
  }
});
