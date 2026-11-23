<script setup lang="ts">
import { computed, reactive, ref, onMounted, onUnmounted } from 'vue';
import { MessageBus } from '@ui-shared/api/messageBus';
import type { HostToUiMessage } from '@ui-shared/protocol/hostMessages';
import type { RepositoryConnectionState, ConnectionMode, RepositoryOptionDto } from './main';

const props = defineProps<{
  initialState: RepositoryConnectionState | null;
  messageBus: MessageBus;
}>();

const mode = ref<ConnectionMode>(props.initialState?.mode ?? 'connect');
const target = ref(props.initialState?.target ?? '');
const repoPath = ref(props.initialState?.initialBinding?.repoPath ?? '');
const repoUser = ref(props.initialState?.initialBinding?.repoUser ?? '');
// Пароль не преднаполняем: он хранится в SecretStorage и в webview не приходит.
const repoPassword = ref('');
const repoPasswordSet = ref(props.initialState?.initialBinding?.repoPasswordSet ?? false);
const loading = ref(false);
const error = ref('');

// Опции текущего режима: набор, подписи и значения по умолчанию приходят от host (issues #184, #185).
const options: readonly RepositoryOptionDto[] = props.initialState?.form.options ?? [];
const supportRules = props.initialState?.form.supportRules ?? [];
const values = reactive<Record<string, boolean | string>>(
  Object.fromEntries(options.map((option) => [option.id, option.defaultValue]))
);
// Правило показывается и отправляется только при включённом флаге, от которого оно зависит.
const visibleOptions = computed(() =>
  options.filter((option) => option.kind === 'flag' || values[option.requires] === true)
);

function browseRepoPath(): void {
  props.messageBus.send({
    type: 'request',
    requestId: 'browse',
    name: 'browseRepoPath',
  });
}

// Поля проверяет только расширение (`validateBindingForm`): его ошибка и так приходит в форму (#184),
// а своя проверка формы расходилась с ним текстами и обработкой пробелов (#203).
function submit(): void {
  error.value = '';
  loading.value = true;

  const formData = {
    repoPath: repoPath.value,
    repoUser: repoUser.value,
    repoPassword: repoPassword.value,
    ...Object.fromEntries(visibleOptions.value.map((option) => [option.id, values[option.id]])),
  };

  props.messageBus.send({
    type: 'command',
    command: 'submit',
    payload: formData,
  });
}

function cancel(): void {
  props.messageBus.send({ type: 'command', command: 'cancel' });
}

function handleHostMessage(msg: HostToUiMessage): void {
  if (msg.type === 'status') {
    if (msg.kind === 'loading') loading.value = true;
    else loading.value = false;
  }
  if (msg.type === 'error') {
    error.value = msg.message;
    loading.value = false;
  }
}

// Ответ host на запрос выбора папки (browseRepoPath). Корреляция по requestId,
// который шлёт browseRepoPath; payload содержит выбранный путь.
function handleReply(msg: HostToUiMessage): void {
  if (msg.type !== 'reply' || msg.requestId !== 'browse') return;
  const payload = msg.payload as { repoPath?: string } | undefined;
  if (payload?.repoPath) {
    repoPath.value = payload.repoPath;
  }
}

onMounted(() => {
  props.messageBus.on('status', handleHostMessage);
  props.messageBus.on('error', handleHostMessage);
  props.messageBus.on('reply', handleReply);
});

onUnmounted(() => {
  props.messageBus.off('status', handleHostMessage);
  props.messageBus.off('error', handleHostMessage);
  props.messageBus.off('reply', handleReply);
});
</script>

<template>
  <div class="connection-form">
    <h2 class="form-title">
      {{ mode === 'connect' ? 'Подключение к хранилищу' : 'Создание хранилища' }}
    </h2>
    <p class="form-subtitle">{{ target }}</p>

    <div class="form-field">
      <label class="field-label" for="repoPath">Путь к хранилищу</label>
      <div class="field-row">
        <vscode-textfield
          id="repoPath"
          :value="repoPath"
          placeholder="tcp://server:1542/repo или /путь/к/хранилищу"
          :disabled="loading"
          @input="(e: Event) => repoPath = (e.target as HTMLInputElement).value"
        />
        <vscode-button appearance="icon" @click="browseRepoPath" :disabled="loading" aria-label="Обзор...">
          <span class="codicon codicon-folder-opened"></span>
        </vscode-button>
      </div>
    </div>

    <div class="form-field">
      <label class="field-label" for="repoUser">Пользователь</label>
      <vscode-textfield
        id="repoUser"
        :value="repoUser"
        placeholder="Имя пользователя хранилища"
        :disabled="loading"
        @input="(e: Event) => repoUser = (e.target as HTMLInputElement).value"
      />
    </div>

    <div class="form-field">
      <label class="field-label" for="repoPassword">Пароль</label>
      <input
        id="repoPassword"
        class="field-input"
        type="password"
        v-model="repoPassword"
        :placeholder="repoPasswordSet ? 'Пароль задан (оставьте пустым, чтобы не менять)' : 'Пароль'"
        :disabled="loading"
      />
    </div>

    <template v-if="options.length > 0">
      <vscode-divider></vscode-divider>

      <div v-for="option in visibleOptions" :key="option.id" class="form-option">
        <vscode-checkbox
          v-if="option.kind === 'flag'"
          :checked="values[option.id] === true"
          :disabled="loading"
          :title="option.hint"
          @change="(e: Event) => values[option.id] = (e.target as HTMLInputElement).checked"
        >
          {{ option.label }}
        </vscode-checkbox>
        <template v-else>
          <label class="field-label" :for="option.id">{{ option.label }}</label>
          <vscode-single-select
            :id="option.id"
            :value="values[option.id]"
            :disabled="loading"
            :title="option.hint"
            @change="(e: Event) => values[option.id] = (e.target as HTMLSelectElement).value"
          >
            <vscode-option v-for="rule in supportRules" :key="rule.value" :value="rule.value">{{ rule.label }}</vscode-option>
          </vscode-single-select>
        </template>
        <p class="option-hint">{{ option.hint }}</p>
      </div>
    </template>

    <div v-if="error" class="form-error">{{ error }}</div>

    <div class="form-actions">
      <vscode-button @click="submit" :disabled="loading">
        {{ loading ? (mode === 'connect' ? 'Подключение...' : 'Создание...') : mode === 'connect' ? 'Подключиться' : 'Создать' }}
      </vscode-button>
      <vscode-button appearance="secondary" @click="cancel" :disabled="loading">
        Отмена
      </vscode-button>
    </div>
  </div>
</template>

<style scoped>
.connection-form {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground);
}

.form-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.form-subtitle {
  margin: 0;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.field-row {
  display: flex;
  gap: 4px;
}

.field-row vscode-textfield {
  flex: 1;
}

.field-input {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  padding: 4px 8px;
  font-family: inherit;
  font-size: inherit;
}

.field-input:focus {
  outline: 1px solid var(--vscode-focusBorder);
}

.form-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.option-hint {
  margin: 0 0 0 26px;
  font-size: 12px;
  color: var(--vscode-descriptionForeground);
}

.form-option vscode-single-select + .option-hint {
  margin-left: 0;
}

.form-error {
  white-space: pre-line;
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  color: var(--vscode-errorForeground);
  padding: 8px;
  border-radius: 2px;
  font-size: 12px;
}

.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
</style>
