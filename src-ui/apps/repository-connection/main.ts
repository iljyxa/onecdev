import { createApp } from 'vue';
import '@ui-shared/vscode-elements';
import { loadInitialState } from '@ui-shared/api/loadInitialState';
import { MessageBus } from '@ui-shared/api/messageBus';
import RepositoryConnectionApp from './RepositoryConnectionApp.vue';

/** Режим диалога: подключение или создание хранилища */
export type ConnectionMode = 'connect' | 'create';

/**
 * Опция формы. Состав по режиму, подписи, подсказки и значения по умолчанию задаёт host
 * (`infra/repository/RepositoryConnectionOptions.ts`); форма их только рисует.
 */
export type RepositoryOptionDto =
  | {
    readonly kind: 'flag';
    readonly id: string;
    readonly label: string;
    readonly hint: string;
    readonly defaultValue: boolean;
  }
  | {
    readonly kind: 'rule';
    readonly id: string;
    readonly label: string;
    readonly hint: string;
    readonly defaultValue: string;
    /** Флаг, без которого правило скрыто и не отправляется. */
    readonly requires: string;
  };

export interface RepositoryConnectionFormDto {
  readonly options: readonly RepositoryOptionDto[];
  readonly supportRules: readonly { readonly value: string; readonly label: string }[];
}

/** Начальное состояние, переданное host-провайдером */
export interface RepositoryConnectionState {
  readonly mode: ConnectionMode;
  readonly target: string;
  readonly initialBinding: RepositoryBindingDto | null;
  readonly form: RepositoryConnectionFormDto;
}

/** DTO ранее сохранённых параметров подключения (без пароля) */
export interface RepositoryBindingDto {
  readonly repoPath: string;
  readonly repoUser: string;
  /** Пароль в форму не преднаполняется — только признак того, что он задан. */
  readonly repoPasswordSet: boolean;
}

const initialState = loadInitialState<RepositoryConnectionState>('repository-connection');
const messageBus = new MessageBus();

const app = createApp(RepositoryConnectionApp, { initialState, messageBus });
app.provide('messageBus', messageBus);
app.mount('#app');

messageBus.start();
messageBus.send({ type: 'ready' });
