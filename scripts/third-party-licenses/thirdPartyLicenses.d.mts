// Типы для vite.shared.ts: конфиги Vite — TypeScript под типизированным линтом, а модуль — чистый ESM.

export interface PackageNotice {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly licenseFiles: readonly { readonly file: string; readonly text: string }[];
}

export const OUTPUT_FILE: string;
export const FRAGMENTS_DIR: string;

export function packageRootOf(moduleId: string): string | null;
export function readPackageNotice(root: string): PackageNotice;
export function renderThirdPartyLicenses(notices: readonly PackageNotice[]): string;
export function updateThirdPartyLicenses(args: {
  readonly outDir: string;
  readonly build: string;
  readonly moduleIds: Iterable<string>;
}): { readonly file: string; readonly packages: number };
