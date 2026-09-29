/**
 * Служебные команды бота MAX.
 *
 *   npm run bot:poll               локально: сообщения боту опросом, без HTTPS
 *   npm run bot:eval               набор живых фраз → настоящий GigaChat, процент попаданий
 *   npm run prod:bot -- status     подписки вебхука бота
 *   npm run prod:bot -- subscribe  подписать вебхук на https://$DOMAIN/api/max/webhook
 *   npm run prod:bot -- unsubscribe
 *
 * Пока вебхук подписан, опрос ничего не получает: MAX отдаёт события
 * либо так, либо так. Для локальной разработки — `unsubscribe`, потом
 * `bot:poll`; вернуть бой — `subscribe`.
 */
import { MaxBot } from '../lib/max/bot-api.ts';
import { GigaChat, readCa } from '../lib/gigachat/client.ts';
import { CLASSIFY, SYSTEM_PROMPT } from '../lib/bot/prompt.ts';
import { EVAL_AGENT, EVAL_PHRASES } from '../lib/bot/eval-phrases.ts';
import { runAgent } from '../lib/agent/loop.ts';
import { checkFacts } from '../lib/agent/guard.ts';
import { TOOLS, type Tool } from '../lib/agent/tools.ts';
import type { IntentContext } from '../lib/bot/intents.ts';
import { createRuntime } from '../lib/bot/runtime.ts';
import { incomingFromUpdate } from '../lib/bot/updates.ts';
import { getDb, closeDb, describeConnection } from './client.ts';

const [command] = process.argv.slice(2);
const env = process.env;

function need(name: string): string {
  const value = env[name];
  if (!value) {
    console.error(`Не задано ${name}`);
    process.exit(1);
  }
  return value;
}

const bot = () => new MaxBot({ token: need('MAX_BOT_TOKEN'), baseUrl: env.MAX_API_BASE || undefined, timeoutMs: 45_000 });

switch (command) {
  case 'status': {
    console.log(JSON.stringify(await bot().subscriptions(), null, 2));
    break;
  }

  case 'subscribe': {
    const url = `https://${need('DOMAIN')}/api/max/webhook`;
    const result = await bot().subscribe(url, need('BOT_WEBHOOK_SECRET'), ['message_created', 'bot_started']);
    console.log(url, result);
    break;
  }

  case 'unsubscribe': {
    const url = `https://${need('DOMAIN')}/api/max/webhook`;
    console.log(url, await bot().unsubscribe(url));
    break;
  }

  case 'poll': {
    console.log('База →', describeConnection());
    const runtime = createRuntime(() => getDb());
    if (!runtime) throw new Error('Нужны MAX_BOT_TOKEN и MAX_BOT_USERNAME');
    console.log(env.GIGACHAT_AUTH_KEY ? 'GigaChat подключён' : 'GIGACHAT_AUTH_KEY нет — бот «глухой»');
    console.log('Жду сообщений боту… (Ctrl+C — выход)');
    let marker: number | undefined;
    for (;;) {
      try {
        const res = await bot().getUpdates(marker, 30);
        marker = res.marker ?? marker;
        for (const update of res.updates ?? []) {
          const incoming = incomingFromUpdate(update);
          if (incoming) {
            console.log(`${incoming.maxUserId}: ${incoming.text}`);
            runtime.enqueue(incoming);
          }
        }
      } catch (error) {
        console.error('Опрос:', (error as Error).message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  case 'eval': {
    const giga = new GigaChat({
      authKey: need('GIGACHAT_AUTH_KEY'),
      scope: env.GIGACHAT_SCOPE,
      model: env.GIGACHAT_MODEL,
      apiBase: env.GIGACHAT_API_BASE,
      ca: readCa(env.GIGACHAT_CA_FILE || 'certs/russian_trusted_root_ca.crt'),
    });
    let hits = 0;
    let tokens = 0;
    for (const [phrase, expected] of EVAL_PHRASES) {
      try {
        const { args, totalTokens } = await giga.callFunction(
          [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: phrase }], CLASSIFY,
        );
        tokens += totalTokens;
        const ok = args.intent === expected;
        if (ok) hits += 1;
        const extra = args.intent === 'complaint' ? `  → ${args.category ?? ''}: ${args.text ?? ''}${args.ask ? ` [? ${args.ask}]` : ''}` : '';
        console.log(`${ok ? '✓' : '✖'} ${phrase} → ${String(args.intent)}${ok ? '' : ` (ждали ${expected})`}${extra}`);
      } catch (error) {
        console.log(`✖ ${phrase} → ошибка: ${(error as Error).message}`);
      }
    }
    const n = EVAL_PHRASES.length;
    console.log(`\nПопаданий: ${hits} из ${n} (${Math.round((hits / n) * 100)}%). Токенов: ${tokens}, в среднем ${Math.round(tokens / n)} на фразу.`);
    break;
  }

  case 'eval-agent': {
    const giga = new GigaChat({
      authKey: need('GIGACHAT_AUTH_KEY'),
      scope: env.GIGACHAT_SCOPE,
      model: env.GIGACHAT_MODEL,
      apiBase: env.GIGACHAT_API_BASE,
      ca: readCa(env.GIGACHAT_CA_FILE || 'certs/russian_trusted_root_ca.crt'),
    });
    // Подставные данные в духе демо-дома: база не нужна; права настоящих инструментов проверяют тесты
    const SAMPLE: Record<string, unknown> = {
      my_bills: {
        months: [
          { month: 'сентябрь 2026', total: '6 640,00 ₽', services: [{ service: 'ЖКУ', sum: '5 120,00 ₽', status: 'не отмечено' }, { service: 'Электроэнергия', sum: '1 520,00 ₽', status: 'не отмечено' }] },
          { month: 'август 2026', total: '6 100,00 ₽', services: [{ service: 'ЖКУ', sum: '4 850,00 ₽', status: 'оплачено' }, { service: 'Электроэнергия', sum: '1 250,00 ₽', status: 'оплачено' }] },
        ],
        changeVsPreviousMonth: 'на 540,00 ₽ больше',
        notMarkedPaid: '6 640,00 ₽',
        note: 'статус оплаты — только по отметкам жителя в приложении, прошёл ли платёж, приложение не знает',
      },
      my_requests: {
        open: [{ number: '00002', category: 'Сантехника', title: 'Течёт кран в подвале', status: 'в работе', created: '26 сентября', assignee: 'Петров И., сантехник', deadline: '1 октября', waitingForResident: false }],
        recentlyClosed: [],
      },
      my_meters: {
        meters: [{ meter: 'Холодная вода', last: '123,4 м³', markedThisMonth: false }],
        window: 'Показания принимаются с 20 по 25 число',
        note: 'показания в приложении — дневник жителя, в УК они сами не уходят',
      },
      my_accounts: { services: ['ЖКУ', 'Электроэнергия', 'Газ'], note: 'номера лицевых счетов — только в приложении' },
      house_info: {
        managingCompany: { name: 'ООО «УК Демо-Дом»', phone: '+7 (863) 000-00-01' },
        requestsGoTo: 'управляющая компания',
        phones: [{ title: 'Лифтовая служба', phone: '+7 (863) 000-00-05', note: 'круглосуточно' }],
        emergency: 'единый номер 112, пожарные 101, полиция 102, скорая 103, газ 104',
      },
      outages: [{ title: 'Отключение горячей воды', text: 'Замена задвижки в подвале 2 подъезда', until: '1 октября, 18:00' }],
      house_feed: {
        posts: [{ date: '28 сентября', title: 'Собрание собственников 5 октября' }],
        openPolls: [{ title: 'Ставим шлагбаум?', until: '10 октября' }],
      },
      council_tasks: { locked: 'только председателю совета дома' },
      analytics: { months: [{ month: 'сентябрь 2026', total: '6 640,00 ₽' }, { month: 'август 2026', total: '6 100,00 ₽' }], average: '6 370,00 ₽' },
      find_complex: {
        complexes: [{ name: 'ЖК «Левенцовский»', district: 'Советский район', developer: 'ЮгСтройИнвест', priceFrom: 'от 4,5 млн ₽', rating: 4.6, slug: 'levencovsky' }],
        note: 'цены и отзывы примерные, для показа',
      },
    };
    const tools: Record<string, Tool> = Object.fromEntries(Object.values(TOOLS).map((t) => [t.def.name, {
      ...t,
      run: async (_ctx: IntentContext, args: Record<string, unknown>) => {
        const name = t.def.name;
        if (name === 'open') return { data: { opened: String(args.target ?? '') } };
        if (name === 'draft_complaint') {
          return { data: { drafted: true }, draft: { category: String(args.category ?? 'Другое'), text: String(args.text ?? '') } };
        }
        return { data: SAMPLE[name] ?? { empty: true } };
      },
    }]));
    let passed = 0;
    let tokens = 0;
    for (const phrase of EVAL_AGENT) {
      try {
        const r = await runAgent({ llm: giga, ctx: {} as IntentContext, history: [], input: phrase, tools });
        tokens += r.tokens;
        const used = r.used.length ? r.used.join(' → ') : '—';
        if (r.kind === 'draft') {
          passed += 1;
          console.log(`✓ ${phrase}\n    [${used}] черновик: ${r.draft.category}: ${r.draft.text}`);
        } else if (r.kind === 'give_up') {
          console.log(`✖ ${phrase}\n    [${used}] модель не закончила`);
        } else {
          const facts = checkFacts(r.text, r.sources);
          if (facts.ok) passed += 1;
          const note = facts.ok ? '' : `\n    выдумано: ${facts.unknown.join(', ')}`;
          console.log(`${facts.ok ? '✓' : '✖'} ${phrase}\n    [${used}] ${r.text.replace(/\n+/g, ' ')}${note}`);
        }
      } catch (error) {
        console.log(`✖ ${phrase} → ошибка: ${(error as Error).message}`);
      }
    }
    const n = EVAL_AGENT.length;
    console.log(`\nПрошли проверку фактов: ${passed} из ${n}. Токенов: ${tokens}, в среднем ${Math.round(tokens / n)} на фразу.`);
    break;
  }

  default:
    console.error('Команды: status | subscribe | unsubscribe | poll | eval | eval-agent');
    process.exit(1);
}

await closeDb();
