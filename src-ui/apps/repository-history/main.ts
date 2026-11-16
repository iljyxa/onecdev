import { createApp } from 'vue';
import '@vscode/codicons/dist/codicon.css';
import '@ui-shared/vscode-elements';
import { loadInitialState } from '@ui-shared/api/loadInitialState';
import { MessageBus } from '@ui-shared/api/messageBus';
import type { RepositoryHistoryViewDto } from '@ui-shared/types/repositoryHistory';
import RepositoryHistoryApp from './RepositoryHistoryApp.vue';
import './styles.css';

const initialState = loadInitialState<RepositoryHistoryViewDto>('repository-history');
const messageBus = new MessageBus();

const app = createApp(RepositoryHistoryApp, { initialState, messageBus });
app.provide('messageBus', messageBus);
app.mount('#app');

messageBus.start();
messageBus.send({ type: 'ready' });
