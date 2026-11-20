import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OutputBundle, Plugin } from 'vite';
import { updateThirdPartyLicenses } from './scripts/third-party-licenses/thirdPartyLicenses.mjs';

export const rootDir = path.dirname(fileURLToPath(import.meta.url));

export const aliases = {
  '@ui': path.resolve(rootDir, 'src-ui'),
  '@ui-shared': path.resolve(rootDir, 'src-ui/shared'),
};

/*
 * Внешними остаются только модули, которые даёт среда выполнения. Всё остальное вшивается в
 * бандл: VSIX не должен зависеть от node_modules, иначе `vsce package --no-dependencies`
 * выпускает пакет без них, и активация падает на первом require. ssh2 вшивается
 * целиком; cpu-features — его опциональный нативный аддон, ssh2 загружает его в try/catch
 * и без аддона работает на чистом JS.
 */
export const nodeExternal = [
  'vscode',
  '@vscode/test-electron',
  'cpu-features',
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

export interface WebviewManifestEntry {
  readonly script: string;
  readonly styles: readonly string[];
}

export type WebviewManifest = Record<string, WebviewManifestEntry>;

/*
 * THIRD_PARTY_LICENSES (#115): node_modules в VSIX не попадает, поэтому тексты лицензий вшитых
 * пакетов собираются по модулям, фактически оказавшимся в бандле. JS-модули берутся из
 * moduleIds чанков, а CSS и шрифты (codicons) — из originalFileNames ассетов: в sourcemap
 * их нет. Логика — в scripts/third-party-licenses, здесь только чтение бандла.
 */
export function thirdPartyLicensesPlugin(build: string, outDir: string): Plugin {
  return {
    name: 'onecdev-third-party-licenses',
    apply: 'build',
    generateBundle(_options, bundle: OutputBundle) {
      const moduleIds = Object.values(bundle).flatMap((item) =>
        item.type === 'chunk' ? item.moduleIds : item.originalFileNames.map((file) => path.resolve(rootDir, file))
      );
      const { packages } = updateThirdPartyLicenses({ outDir: path.resolve(rootDir, outDir), build, moduleIds });
      this.info(`THIRD_PARTY_LICENSES: ${String(packages)} пакетов`);
    },
  };
}
