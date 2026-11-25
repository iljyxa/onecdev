<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { getVscodeApi } from '@ui-shared/api/vscodeApi';
import type { MessageBus } from '@ui-shared/api/messageBus';
import type { HostToUiMessage } from '@ui-shared/protocol/hostMessages';
import type { PropertiesViewState } from '@ui-shared/types/property';
import PropertiesView from './views/PropertiesView.vue';

type PropertiesPanelState =
  | { readonly generation: number; readonly kind: 'properties'; readonly selection: number; readonly view: PropertiesViewState }
  | { readonly generation: number; readonly kind: 'empty'; readonly message?: string };

const props = defineProps<{ messageBus: MessageBus; sessionId?: string }>();
const state = ref<PropertiesPanelState | null>(null);
const vscode = getVscodeApi();
const savedState = vscode.getState() as { sessionId?: string; alphabetical?: boolean } | undefined;
// VS Code может восстановить состояние webview при открытии новой сессии.
const alphabetical = ref(props.sessionId !== undefined &&
  savedState?.sessionId === props.sessionId && savedState.alphabetical === true);

function changeOrder(value: boolean): void {
  alphabetical.value = value;
  vscode.setState({ sessionId: props.sessionId, alphabetical: value });
}

function handleHostMessage(message: HostToUiMessage): void {
  if (message.type === 'state') {
    state.value = message.state as PropertiesPanelState;
  }
}

function sendCommand(command: string, payload?: Record<string, unknown>): void {
  // structuredClone не принимает Vue Proxy, которые могут входить в payload.
  const safePayload = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
  props.messageBus.send({ type: 'command', command, viewVersion: state.value?.generation, payload: safePayload });
}

onMounted(() => props.messageBus.on('state', handleHostMessage));
onUnmounted(() => props.messageBus.off('state', handleHostMessage));
</script>

<template>
  <main class="properties-panel">
    <PropertiesView
      v-if="state?.kind === 'properties'"
      :key="state.selection"
      :state="state.view"
      :alphabetical="alphabetical"
      @update:alphabetical="changeOrder"
      @command="sendCommand"
    />
    <p v-else class="properties-panel__hint">
      {{ state?.message ?? 'Выберите объект конфигурации, чтобы посмотреть его свойства.' }}
    </p>
  </main>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
}

.properties-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 0 10px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}

.properties-panel__hint {
  color: var(--vscode-descriptionForeground);
  text-align: center;
}
</style>
