<script setup lang="ts">
import { computed } from 'vue';
import type { PropertyControl } from '@ui-shared/types/property';

const props = defineProps<{
  control: PropertyControl;
  readonly: boolean;
}>();

const emit = defineEmits<{
  pick: [key: string];
  clear: [key: string];
}>();

const displayValue = computed(() => {
  const raw = typeof props.control.value === 'string' ? props.control.value : '';
  const marker = '.Form.';
  const index = raw.lastIndexOf(marker);
  return index >= 0 ? raw.slice(index + marker.length) : raw;
});
</script>

<template>
  <div class="control-row">
    <label class="control-label" :for="'prop-' + control.id" :title="control.id">{{ control.label }}</label>
    <div class="form-picker">
      <input
        class="prop-field form-input"
        :id="'prop-' + control.id"
        :class="{ 'has-clear': displayValue }"
        type="text"
        :value="displayValue"
        placeholder="Генерируется автоматически"
        readonly
      />
      <div class="form-actions">
        <button
          class="icon-action"
          type="button"
          title="Выбрать форму"
          :disabled="readonly || control.readonly"
          @click="emit('pick', control.id)"
        >
          <span class="codicon codicon-ellipsis" aria-hidden="true"></span>
        </button>
        <button
          v-if="displayValue"
          class="icon-action"
          type="button"
          title="Очистить форму"
          :disabled="readonly || control.readonly"
          @click="emit('clear', control.id)"
        >
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      </div>
    </div>
    <div v-if="control.inherited" class="property-note">
      Значение из основной конфигурации. Переопределение через панель свойств пока недоступно.
    </div>
    <div v-else-if="control.readonly" class="property-note">Служебное свойство доступно только для чтения.</div>
  </div>
</template>

<style scoped>
.control-row {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.control-label {
  font-size: 13px;
  font-weight: 600;
}

.form-picker {
  position: relative;
  min-width: 0;
}

.form-input {
  padding-right: 36px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.form-input.has-clear {
  padding-right: 64px;
}

.form-input::placeholder {
  color: var(--vscode-input-placeholderForeground);
}

.form-actions {
  position: absolute;
  top: 50%;
  right: 4px;
  display: inline-flex;
  gap: 4px;
  transform: translateY(-50%);
}

.icon-action {
  width: 24px;
  height: 24px;
  min-width: 24px;
  padding: 0;
  display: inline-grid;
  place-items: center;
  border: 0;
  border-radius: 4px;
  color: var(--vscode-icon-foreground, var(--vscode-foreground));
  background: transparent;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}

.icon-action:hover:not(:disabled) {
  background: var(--vscode-list-hoverBackground);
}

.icon-action:disabled {
  opacity: 0.45;
  cursor: default;
}

.property-note {
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
  line-height: 1.4;
}

</style>
