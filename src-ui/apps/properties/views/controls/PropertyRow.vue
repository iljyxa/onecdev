<script setup lang="ts">
import { onBeforeUpdate, onUpdated, ref } from 'vue';
import type { PropertyControl } from '@ui-shared/types/property';
import PropertyBooleanControl from './PropertyBooleanControl.vue';
import PropertyEnumControl from './PropertyEnumControl.vue';
import PropertyFormControl from './PropertyFormControl.vue';
import PropertyReferenceListControl from './PropertyReferenceListControl.vue';
import PropertyTextControl from './PropertyTextControl.vue';
import PropertyTypeControl from './PropertyTypeControl.vue';

const props = defineProps<{
  control: PropertyControl;
  readonly: boolean;
  selected: boolean;
}>();

const emit = defineEmits<{
  command: [name: string, payload?: Record<string, unknown>];
  select: [];
}>();

const row = ref<HTMLElement | null>(null);
let hadFocus = false;

onBeforeUpdate(() => {
  hadFocus = row.value?.contains(document.activeElement) ?? false;
});

onUpdated(() => {
  // При очистке значения кнопка удаления исчезает, поэтому фокус возвращается на строку.
  if (hadFocus && document.activeElement === document.body) {
    row.value?.focus({ preventScroll: true });
  }
});

function onChange(value: unknown): void {
  if (!props.readonly) {
    emit('command', 'propertyChanged', { key: props.control.id, value });
  }
}
</script>

<template>
  <div
    ref="row"
    class="property-row"
    role="group"
    :class="{ 'property-row--selected': selected }"
    :tabindex="readonly || control.readonly ? 0 : -1"
    :aria-label="control.label"
    @focusin="emit('select')"
    @click="emit('select')"
  >
    <PropertyFormControl
      v-if="control.formPicker"
      :control="control"
      :readonly="readonly"
      @pick="emit('command', 'openFormPicker', { key: $event })"
      @clear="emit('command', 'clearFormProperty', { key: $event })"
    />
    <PropertyTextControl
      v-else-if="control.kind === 'string' || control.kind === 'localizedString'"
      :control="control"
      :readonly="readonly"
      @change="onChange"
      @invalid-name="emit('command', 'invalidName')"
      @commit="row?.focus({ preventScroll: true })"
    />
    <PropertyBooleanControl
      v-else-if="control.kind === 'boolean'"
      :control="control"
      :readonly="readonly"
      @change="onChange"
    />
    <PropertyEnumControl
      v-else-if="control.kind === 'enum' || control.kind === 'multiEnum'"
      :control="control"
      :readonly="readonly"
      @change="onChange"
    />
    <PropertyTypeControl
      v-else-if="control.kind === 'metadataType'"
      :control="control"
      :readonly="readonly"
      @open-picker="emit('command', 'openTypePicker', $event)"
      @update-qualifiers="emit('command', 'updateTypeQualifiers', $event)"
    />
    <PropertyReferenceListControl
      v-else-if="control.kind === 'metadataReferenceList'"
      :control="control"
      :readonly="readonly"
      @add="emit('command', 'openMetadataReferencePicker', { key: $event })"
      @remove="emit('command', 'removeMetadataReference', $event)"
    />
  </div>
</template>

<style scoped>
.property-row {
  min-width: 0;
  padding: 4px;
  border-inline-start: 2px solid transparent;
}

.property-row--selected {
  border-inline-start-color: var(--vscode-focusBorder);
}

.property-row:focus-visible {
  outline: 1px solid var(--vscode-focusBorder);
  outline-offset: -1px;
}
</style>
