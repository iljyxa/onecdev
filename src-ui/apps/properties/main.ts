import { createApp } from 'vue';
import '@vscode/codicons/dist/codicon.css';
import '@ui-shared/vscode-elements';
import './styles/controls.css';
import { MessageBus } from '@ui-shared/api/messageBus';
import PropertiesApp from './PropertiesApp.vue';

const messageBus = new MessageBus();
const app = createApp(PropertiesApp, { messageBus });
app.provide('messageBus', messageBus);
app.mount('#app');

messageBus.start();
messageBus.send({ type: 'ready' });
