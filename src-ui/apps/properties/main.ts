import { createApp } from 'vue';
import '@vscode/codicons/dist/codicon.css';
import '@ui-shared/vscode-elements';
import './styles/controls.css';
import { loadInitialState } from '@ui-shared/api/loadInitialState';
import { MessageBus } from '@ui-shared/api/messageBus';
import PropertiesApp from './PropertiesApp.vue';

const messageBus = new MessageBus();
const initialState = loadInitialState<{ sessionId: string }>('properties');
const app = createApp(PropertiesApp, { messageBus, sessionId: initialState?.sessionId });
app.provide('messageBus', messageBus);
app.mount('#app');

messageBus.start();
messageBus.send({ type: 'ready' });
