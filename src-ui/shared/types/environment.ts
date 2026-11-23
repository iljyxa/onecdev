import type { InstalledOnecPlatform } from './platform';

export interface ProjectLaunchSettings {
  readonly ibConnection: string;
  readonly dbUser: string;
  /** Пароль в webview не передаётся — только признак того, что он задан. */
  readonly dbPasswordSet: boolean;
  readonly platformPath: string;
  readonly v8Version: string;
}

export interface RegisteredInfoBase {
  readonly id: string;
  readonly name: string;
  readonly connection: string;
  readonly kind: 'file' | 'server' | 'unknown';
  readonly filePath?: string;
  readonly server?: string;
  readonly ref?: string;
}

export interface ProjectEnvironmentSnapshot {
  readonly envPath: string;
  readonly settings: ProjectLaunchSettings;
  readonly platforms: readonly InstalledOnecPlatform[];
  readonly bases: readonly RegisteredInfoBase[];
  readonly sources: readonly string[];
  readonly warnings: readonly string[];
}

export interface SaveProjectEnvironmentInput {
  readonly platformPath: string;
  readonly baseId: string;
  readonly dbUser: string;
  readonly dbPassword: string;
}

/** `ready` шлёт `main.ts` после монтирования; хост его не обрабатывает как действие панели (issue #182). */
export type ProjectEnvironmentUiMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | ({ readonly type: 'save' } & SaveProjectEnvironmentInput);

