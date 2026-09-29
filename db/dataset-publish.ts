/**
 * Выкладка собранного набора в релиз GitHub.
 *
 *   npm run dataset:publish -- --region 61
 *
 * Релиз `dataset-NN` один на регион и переиспользуется: новый файл
 * заменяет старый под тем же адресом, и `dataset:load` на любой машине
 * всегда качает свежий, ничего не зная о датах сборки.
 *
 * Если `gh` не установлен — печатает, что сделать руками в браузере.
 * Выкладывает только владелец репозитория.
 */
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readDataset } from '../lib/dataset/format.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const code = (arg('region') ?? '').padStart(2, '0');
if (!/^\d{2}$/.test(code) || code === '00') {
  console.error('Укажите код субъекта: npm run dataset:publish -- --region 61');
  process.exit(1);
}

const file = arg('file') ?? join('var', 'datasets', `dataset-${code}.ndjson.gz`);
if (!existsSync(file)) {
  console.error(`Набора нет: ${file}\nСобрать: npm run dataset:build -- --region ${code}`);
  process.exit(1);
}

// Манифест читаем, чтобы не выложить чужой регион и чтобы подписать релиз
const { manifest, rows } = await readDataset(createReadStream(file), code);
await rows.return(undefined);

const r = manifest.report;
const tag = `dataset-${code}`;
const repo = process.env.DATASET_REPO || 'TaCeiN/domovoy-datasets';
const notes = [
  `${manifest.regionName}. Собран ${manifest.builtAt.slice(0, 10)}: ГАР ${manifest.sources.gar}, ФРТ ${manifest.sources.frt ?? '—'}, OSM ${manifest.sources.osm ?? '—'}.`,
  '',
  r ? `Домов: ${r.houses}. Домов фонда: ${r.frtHouses} (по GUID ФИАС ${r.byGuid}, по адресу ${r.byKey}, только из фонда ${r.addedFromFrt}). Организаций: ${r.orgs}. С координатами: ${r.withCoords}.` : '',
  r ? `УК ${r.forms.uk} · ТСЖ ${r.forms.tsj} · ЖСК ${r.forms.zhsk} · частные ${r.forms.private} · неизвестно ${r.forms.unknown} · нет в фонде ${r.forms.none}.` : '',
  `Этапы: ${Object.entries(manifest.stages).map(([k, v]) => `${k} ${v ? '✓' : '—'}`).join(', ')}.`,
  '',
  `Загрузить: npm run dataset:load -- --region ${code}`,
].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n');

console.log(`Файл: ${file} (${(statSync(file).size / 1048576).toFixed(1)} МБ), SHA-256 ${manifest.sha256.slice(0, 12)}…`);

const gh = spawnSync('gh', ['--version'], { stdio: 'ignore' });
if (gh.status !== 0) {
  console.log(`
gh не установлен — выложить руками:

  1. https://github.com/${repo}/releases/new
     (если релиз ${tag} уже есть: https://github.com/${repo}/releases/tag/${tag} → Edit)
  2. Tag: ${tag}, Title: ${manifest.regionName} — набор данных
  3. Перетащить файл ${file}; старый файл с тем же именем удалить
  4. Описание:

${notes}

Или установить gh (winget install GitHub.cli), выполнить gh auth login и запустить эту команду снова.`);
  process.exit(0);
}

const run = (args: string[]) => spawnSync('gh', args, { stdio: 'inherit' }).status === 0;

const exists = spawnSync('gh', ['release', 'view', tag, '--repo', repo], { stdio: 'ignore' }).status === 0;
if (!exists && !run(['release', 'create', tag, '--repo', repo, '--title', `${manifest.regionName} — набор данных`, '--notes', notes])) {
  process.exit(1);
}
if (exists) run(['release', 'edit', tag, '--repo', repo, '--notes', notes]);
if (!run(['release', 'upload', tag, file, '--repo', repo, '--clobber'])) process.exit(1);

console.log(`\nВыложено: https://github.com/${repo}/releases/tag/${tag}`);
