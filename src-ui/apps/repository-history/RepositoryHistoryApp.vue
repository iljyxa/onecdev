<script setup lang="ts">
// Панель только рисует готовый DTO хоста: подписи, даты, сообщения и строка догрузки собраны
// в RepositoryHistoryView.ts, здесь нет ни форматирования, ни решений о состоянии.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { MessageBus } from '@ui-shared/api/messageBus';
import type { HostToUiMessage } from '@ui-shared/protocol/hostMessages';
import type { RepositoryHistoryUiMessage, RepositoryHistoryViewDto } from '@ui-shared/types/repositoryHistory';

type ToolbarCommand = Extract<RepositoryHistoryUiMessage, { type: 'command' }>['command'];

const props = defineProps<{
  initialState: RepositoryHistoryViewDto | null;
  messageBus: MessageBus;
}>();

const state = ref<RepositoryHistoryViewDto | null>(props.initialState);
// Раскрытые версии — состояние отображения, а не данных: переживает обновления state по номеру версии.
const expanded = ref<ReadonlySet<number>>(new Set());

const busy = computed(() => state.value?.status === 'loading');

function send(command: ToolbarCommand): void {
  props.messageBus.send({ type: 'command', command });
}

function toggle(verNum: number): void {
  const next = new Set(expanded.value);
  if (next.has(verNum)) {
    next.delete(verNum);
  } else {
    next.add(verNum);
  }
  expanded.value = next;
}

function loadOlder(): void {
  if (state.value?.older?.state !== 'loading') {
    send('loadMore');
  }
}

function handleState(message: HostToUiMessage<RepositoryHistoryViewDto>): void {
  if (message.type === 'state') {
    state.value = message.state;
  }
}

onMounted(() => {
  props.messageBus.on('state', handleState);
});

onUnmounted(() => {
  props.messageBus.off('state', handleState);
});
</script>

<template>
  <div class="history" v-if="state">
    <header class="toolbar">
      <div class="heading">
        <h2 class="title">{{ state.title }}</h2>
        <p v-if="state.description" class="description">{{ state.description }}</p>
      </div>
      <div class="actions">
        <button type="button" class="tool-button" title="Обновить" :disabled="busy" @click="send('refresh')">
          <span class="codicon codicon-refresh" />
        </button>
        <button v-if="state.canClearFilter" type="button" class="tool-button" title="Сбросить фильтр: вся история" @click="send('clearFilter')">
          <span class="codicon codicon-clear-all" />
        </button>
        <button type="button" class="tool-button" title="Отчёт через Конфигуратор" @click="send('exportReport')">
          <span class="codicon codicon-graph" />
        </button>
      </div>
    </header>

    <div v-if="state.message" class="message" :class="{ error: state.status === 'failed' }">
      <span v-if="busy" class="codicon codicon-loading codicon-modifier-spin" />
      <span>{{ state.message }}</span>
      <button v-if="state.canExportReport" type="button" class="link-button" @click="send('exportReport')">
        Отчёт через Конфигуратор
      </button>
    </div>

    <ul class="versions">
      <li v-for="version in state.versions" :key="version.verNum" class="version">
        <div
          class="version-row"
          role="button"
          tabindex="0"
          :title="version.tooltip"
          @click="toggle(version.verNum)"
          @keydown.enter.prevent="toggle(version.verNum)"
          @keydown.space.prevent="toggle(version.verNum)"
        >
          <span class="codicon" :class="expanded.has(version.verNum) ? 'codicon-chevron-down' : 'codicon-chevron-right'" />
          <span class="version-title">{{ version.title }}</span>
          <span v-if="version.summary" class="version-summary">{{ version.summary }}</span>
        </div>
        <div v-if="expanded.has(version.verNum)" class="version-body">
          <p v-if="version.comment" class="comment">{{ version.comment }}</p>
          <p class="meta">Версия конфигурации: {{ version.configVersion }} · платформа {{ version.platformVersion }}</p>
          <p v-if="version.label" class="meta">
            <span class="codicon codicon-tag" /> {{ version.label.name }} ({{ version.label.author }}, {{ version.label.date }})
            <span v-if="version.label.comment"> — {{ version.label.comment }}</span>
          </p>
          <ul class="changes">
            <li v-for="change in version.changes" :key="change.objectId" class="change" :class="change.kind">
              <span class="change-kind">{{ change.kindText }}</span>
              <span class="change-title">{{ change.title }}</span>
            </li>
            <li v-if="version.hiddenChanges > 0" class="change hidden">… и ещё {{ version.hiddenChanges }}</li>
          </ul>
        </div>
      </li>
    </ul>

    <div
      v-if="state.older"
      class="older"
      role="button"
      tabindex="0"
      :title="state.older.tooltip"
      :class="state.older.state"
      @click="loadOlder"
      @keydown.enter.prevent="loadOlder"
    >
      <span v-if="state.older.state === 'loading'" class="codicon codicon-loading codicon-modifier-spin" />
      <span v-else class="codicon codicon-fold-down" />
      <span>{{ state.older.label }}</span>
      <span v-if="state.older.description" class="older-description">({{ state.older.description }})</span>
    </div>
  </div>
</template>

<style scoped>
.history {
  padding: 8px 12px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
}

.toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--vscode-panel-border, transparent);
}

.title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.description,
.meta,
.older-description,
.version-summary {
  color: var(--vscode-descriptionForeground);
}

.description {
  margin: 2px 0 0;
  font-size: 12px;
}

.actions {
  display: flex;
  gap: 2px;
}

.tool-button,
.link-button {
  border: none;
  background: transparent;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  cursor: pointer;
}

.tool-button {
  padding: 3px;
  border-radius: 4px;
}

.tool-button:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground);
}

.tool-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.link-button {
  padding: 0;
  color: var(--vscode-textLink-foreground);
}

.link-button:hover {
  text-decoration: underline;
}

.message {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 8px 0;
  white-space: pre-wrap;
}

.message.error {
  color: var(--vscode-errorForeground);
}

.versions,
.changes {
  list-style: none;
  margin: 0;
  padding: 0;
}

.version-row,
.older {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  cursor: pointer;
  border-radius: 2px;
}

.version-row:hover,
.older:hover {
  background: var(--vscode-list-hoverBackground);
}

.version-row:focus-visible,
.older:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
}

.version-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.version-body {
  padding: 2px 0 6px 26px;
}

.comment {
  margin: 2px 0;
  white-space: pre-wrap;
}

.meta {
  margin: 2px 0;
  font-size: 12px;
}

.change {
  display: flex;
  gap: 8px;
  padding: 1px 0;
}

.change-kind {
  min-width: 72px;
  color: var(--vscode-descriptionForeground);
}

.change.added .change-kind {
  color: var(--vscode-gitDecoration-addedResourceForeground);
}

.change.removed .change-kind {
  color: var(--vscode-gitDecoration-deletedResourceForeground);
}

.change.modified .change-kind {
  color: var(--vscode-gitDecoration-modifiedResourceForeground);
}

.change.hidden {
  color: var(--vscode-descriptionForeground);
}

.older {
  margin-top: 4px;
  color: var(--vscode-textLink-foreground);
}

.older.loading {
  cursor: default;
  color: var(--vscode-descriptionForeground);
}

.older.failed {
  color: var(--vscode-errorForeground);
}
</style>
