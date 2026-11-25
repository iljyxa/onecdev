<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PropertyControl } from '@ui-shared/types/property';

const props = defineProps<{
  controls: readonly PropertyControl[];
}>();

const activeTab = ref<'main' | 'aux'>('main');
const mainControls = computed(() => props.controls.filter((control) => control.id.startsWith('Default')));
const auxiliaryControls = computed(() => {
  const auxiliary = props.controls.filter((control) => control.id.startsWith('Auxiliary'));
  const rest = props.controls.filter((control) => !control.id.startsWith('Default') && !control.id.startsWith('Auxiliary'));
  return [...auxiliary, ...rest];
});

const visibleControls = computed(() => activeTab.value === 'main' ? mainControls.value : auxiliaryControls.value);
</script>

<template>
  <div class="forms-section">
    <div class="tabbar" role="tablist" aria-label="Формы">
      <button
        class="tab-button"
        :class="{ active: activeTab === 'main' }"
        type="button"
        role="tab"
        :aria-selected="activeTab === 'main'"
        @click="activeTab = 'main'"
      >
        Основные
      </button>
      <button
        class="tab-button"
        :class="{ active: activeTab === 'aux' }"
        type="button"
        role="tab"
        :aria-selected="activeTab === 'aux'"
        @click="activeTab = 'aux'"
      >
        Дополнительные
      </button>
    </div>

    <div class="form">
      <slot :controls="visibleControls" />
      <div v-if="visibleControls.length === 0" class="empty">
        {{ activeTab === 'main' ? 'Нет основных форм.' : 'Нет дополнительных форм.' }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.forms-section,
.form {
  display: grid;
  gap: 12px;
}

.tabbar {
  display: inline-flex;
  width: fit-content;
  gap: 4px;
  padding: 2px;
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent));
  border-radius: 6px;
  background: var(--vscode-input-background);
}

.tab-button {
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--vscode-descriptionForeground);
  background: transparent;
  font: inherit;
  cursor: pointer;
}

.tab-button.active {
  color: var(--vscode-foreground);
  border-color: var(--vscode-input-border, var(--vscode-panel-border, transparent));
  background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
}

.empty {
  padding: 12px;
  color: var(--vscode-descriptionForeground);
  border: 1px dashed var(--vscode-panel-border, var(--vscode-input-border, transparent));
  border-radius: 6px;
}

@media (max-width: 760px) {
  .tabbar {
    display: flex;
    flex-wrap: wrap;
    width: auto;
  }

  .tab-button {
    flex: 1;
  }

}
</style>
