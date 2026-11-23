import type { InstalledOnecPlatform } from './platform';

export type StandaloneServerSwitch = 'allow' | 'deny';

export interface StandaloneServerSettings {
  readonly ibsrvPath: string;
  readonly platformPath: string;
  readonly dataPath: string;
  readonly databasePath: string;
  readonly httpAddress: string;
  readonly httpPort: number;
  readonly httpBase: string;
  readonly name: string;
  readonly distributeLicenses: StandaloneServerSwitch;
  readonly scheduleJobs: StandaloneServerSwitch;
}

export interface StandaloneServerSettingsSnapshot {
  readonly configured: boolean;
  readonly settings: StandaloneServerSettings;
  readonly platforms: readonly InstalledOnecPlatform[];
  readonly configPath: string;
  readonly logPath: string;
  readonly warnings: readonly string[];
}

export interface SaveStandaloneServerSettingsInput {
  readonly ibsrvPath: string;
  readonly platformPath: string;
  readonly databasePath: string;
  readonly httpAddress: string;
  readonly httpPort: number;
  readonly httpBase: string;
  readonly name: string;
  readonly distributeLicenses: StandaloneServerSwitch;
  readonly scheduleJobs: StandaloneServerSwitch;
}

/** `ready` шлёт `main.ts` после монтирования; хост его не обрабатывает как действие панели (issue #182). */
export type StandaloneServerUiMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | ({ readonly type: 'save' } & SaveStandaloneServerSettingsInput);

