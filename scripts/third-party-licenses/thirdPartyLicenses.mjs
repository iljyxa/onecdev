// Сборка THIRD_PARTY_LICENSES — тексты лицензий npm-пакетов, вшитых в dist/ (#115).
//
// Vite вшивает production-зависимости в бандл, а .vscodeignore исключает node_modules/**,
// поэтому без этого файла получатель VSIX не видит их уведомлений об авторском праве, которых
// требуют MIT/BSD/ISC. Перечень берётся из модулей, фактически попавших в бандл (их id отдаёт
// Vite-плагин из vite.shared.ts), а не из package.json: dependencies тянут транзитивные пакеты,
// а часть объявленных может целиком уйти при tree-shaking.
//
// Расширение собирается двумя независимыми прогонами Vite (node и webview), поэтому каждый
// прогон кладёт свой фрагмент в <outDir>/third-party/<build>.json, а итоговый файл
// перерисовывается из всех фрагментов. Пересборка одного прогона заменяет только свой фрагмент.

import fs from 'node:fs';
import path from 'node:path';

const NODE_MODULES = '/node_modules/';
const LICENSE_FILE = /^(licen[cs]e|copying)([-._].*)?$/i;
const RULE = '-'.repeat(80);

export const OUTPUT_FILE = 'THIRD_PARTY_LICENSES.txt';
export const FRAGMENTS_DIR = 'third-party';

/**
 * Корень npm-пакета, которому принадлежит модуль бандла, или null для собственного кода.
 * Учитывает служебный префикс `\0` и query (`?commonjs-proxy`), которые Vite/Rollup добавляют
 * к id, scoped-пакеты и вложенные node_modules (берётся ближайший к файлу). Разделители
 * приводятся к `/`: Node принимает их и на Windows, а фрагменты не зависят от платформы.
 *
 * @param {string} moduleId
 * @returns {string|null}
 */
export function packageRootOf(moduleId) {
  const normalized = moduleId.replace(/^\0/, '').replace(/\?.*$/, '').replace(/\\/g, '/');
  const at = normalized.lastIndexOf(NODE_MODULES);
  if (at < 0) {
    return null;
  }
  const base = normalized.slice(0, at + NODE_MODULES.length);
  const segments = normalized.slice(base.length).split('/');
  const name = segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
  return base + name;
}

/**
 * @param {unknown} pkg разобранный package.json
 * @returns {string}
 */
function licenseOf(pkg) {
  const { license, licenses } = /** @type {{license?: unknown, licenses?: unknown}} */ (pkg);
  if (typeof license === 'string') {
    return license;
  }
  // Устаревшая форма `licenses: [{type, url}]` — её до сих пор держит, например, ssh2.
  if (Array.isArray(licenses) && licenses.length > 0) {
    return licenses.map((item) => String(item.type)).join(' OR ');
  }
  return 'не указана в package.json';
}

/**
 * Имя, версия, лицензия и тексты всех файлов лицензии пакета (LICENSE*, COPYING*). Пакет без текста
 * лицензии роняет сборку: выпустить VSIX без обязательного уведомления хуже, чем упасть.
 *
 * @param {string} root корень пакета
 * @returns {{name: string, version: string, license: string, licenseFiles: {file: string, text: string}[]}}
 */
export function readPackageNotice(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const licenseFiles = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf-8').trim() }));
  if (licenseFiles.length === 0) {
    throw new Error(
      `${pkg.name}@${pkg.version} (${root}): нет файла лицензии (LICENSE*, COPYING*) — ` +
        'текст лицензии вшитого пакета обязателен в THIRD_PARTY_LICENSES'
    );
  }
  return { name: pkg.name, version: pkg.version, license: licenseOf(pkg), licenseFiles };
}

/**
 * @param {{name: string, version: string, license: string, licenseFiles: {file: string, text: string}[]}[]} notices
 * @returns {string}
 */
export function renderThirdPartyLicenses(notices) {
  const unique = new Map(notices.map((notice) => [`${notice.name}@${notice.version}`, notice]));
  const sorted = [...unique.values()].sort(
    (a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en')
  );
  const lines = [
    'onecdev — сторонние компоненты, вшитые в сборку',
    '================================================',
    '',
    'Файл формируется при сборке по модулям npm-пакетов, фактически попавшим в dist/.',
    'Для каждого пакета приведены версия, лицензия из package.json и полный текст',
    'файлов лицензии пакета. Лицензия самого onecdev — GPL-3.0-only (LICENSE, NOTICE).',
    '',
  ];
  for (const notice of sorted) {
    lines.push(RULE, `${notice.name} ${notice.version}`, `Лицензия: ${notice.license}`, '');
    for (const { file, text } of notice.licenseFiles) {
      if (notice.licenseFiles.length > 1) {
        lines.push(`[${file}]`, '');
      }
      lines.push(text, '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * Записывает фрагмент прогона `build` и перерисовывает итоговый файл из всех фрагментов.
 *
 * @param {{outDir: string, build: string, moduleIds: Iterable<string>}} args
 * @returns {{file: string, packages: number}} путь итогового файла и число пакетов в нём
 */
export function updateThirdPartyLicenses({ outDir, build, moduleIds }) {
  const roots = new Set();
  for (const id of moduleIds) {
    const root = packageRootOf(id);
    if (root) {
      roots.add(root);
    }
  }
  const notices = [...roots].sort().map(readPackageNotice);

  const fragmentsDir = path.join(outDir, FRAGMENTS_DIR);
  fs.mkdirSync(fragmentsDir, { recursive: true });
  fs.writeFileSync(path.join(fragmentsDir, `${build}.json`), `${JSON.stringify(notices, null, 2)}\n`, 'utf-8');

  const all = fs
    .readdirSync(fragmentsDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => JSON.parse(fs.readFileSync(path.join(fragmentsDir, name), 'utf-8')));
  const file = path.join(outDir, OUTPUT_FILE);
  fs.writeFileSync(file, renderThirdPartyLicenses(all), 'utf-8');
  return { file, packages: new Set(all.map((n) => `${n.name}@${n.version}`)).size };
}
