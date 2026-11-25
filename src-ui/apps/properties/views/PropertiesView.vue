<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type {
  PropertiesViewState,
  PropertyControl,
  PropertySectionDto,
} from '@ui-shared/types/property';
import PropertyRow from './controls/PropertyRow.vue';
import PropertyFormsSection from './controls/PropertyFormsSection.vue';
import SubsystemMembershipCard from './controls/SubsystemMembershipCard.vue';
import ExchangePlanContentCard from './controls/ExchangePlanContentCard.vue';

const props = defineProps<{
  state: PropertiesViewState;
  alphabetical: boolean;
}>();

const emit = defineEmits<{
  command: [name: string, payload?: Record<string, unknown>];
  'update:alphabetical': [value: boolean];
}>();

type PropertyCard =
  | { readonly kind: 'section'; readonly key: string; readonly order: number; readonly section: PropertySectionDto }
  | { readonly kind: 'subsystems'; readonly key: string; readonly order: number }
  | { readonly kind: 'exchangePlanContent'; readonly key: string; readonly order: number };

const sectionCards = computed(() => {
  return props.state.sections.map((section) => ({
    kind: 'section' as const,
    key: `section:${section.title}`,
    order: section.order,
    section,
  })).sort((a, b) => a.order - b.order);
});

const extraCards = computed(() => {
  // Подсистемы и обмен данными — служебные блоки, всегда в конце списка,
  // независимо от order секций (у некоторых объектов секции без явного order).
  const extraCards: PropertyCard[] = [];
  if (props.state.subsystemSnapshot) {
    extraCards.push({ kind: 'subsystems', key: 'extra:subsystems', order: 0 });
  }
  if (props.state.exchangePlanContentSnapshot) {
    extraCards.push({ kind: 'exchangePlanContent', key: 'extra:exchangePlanContent', order: 0 });
  }

  return extraCards;
});

const cards = computed(() => [...sectionCards.value, ...extraCards.value]);
const query = ref('');
const selectedId = ref<string>();
const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase('ru'));

function filterControls(controls: PropertyControl[]): PropertyControl[] {
  const text = normalizedQuery.value;
  return text ? controls.filter(({ id, label }) =>
    id.toLowerCase().includes(text) || label.toLocaleLowerCase('ru').includes(text)
  ) : controls;
}

const visibleCards = computed<PropertyCard[]>(() => {
  const extras = normalizedQuery.value ? [] : extraCards.value;
  if (props.alphabetical) {
    const controls = filterControls(props.state.alphabeticalControls);
    return controls.length
      ? [{ kind: 'section', key: 'alphabetical', order: 0, section: { title: '', order: 0, controls } }, ...extras]
      : extras;
  }

  const sections = sectionCards.value.map((card) => ({
    ...card,
    section: { ...card.section, controls: filterControls(card.section.controls) },
  })).filter(({ section }) => section.controls.length > 0);
  return [...sections, ...extras];
});

const selectedControl = computed(() => visibleCards.value
  .flatMap((card) => card.kind === 'section' ? card.section.controls : [])
  .find(({ id }) => id === selectedId.value));

const MAIN_SECTION_TITLES = new Set(['Основное', 'Основные']);

const collapsed = ref<Set<string>>(new Set());

/** При смене объекта раскрываем только основную секцию или первую доступную. */
function resetCollapsed(): void {
  const list = cards.value;
  if (list.length === 0) {
    collapsed.value = new Set();
    return;
  }
  const mainCard =
    list.find((card) => card.kind === 'section' && MAIN_SECTION_TITLES.has(card.section.title)) ?? list[0];
  const next = new Set<string>();
  for (const card of list) {
    if (card.key !== mainCard.key) {
      next.add(card.key);
    }
  }
  collapsed.value = next;
}

function syncCollapsedCards(previousKeys: Set<string>): void {
  const list = cards.value;
  if (list.length === 0) {
    collapsed.value = new Set();
    return;
  }
  const keys = new Set(list.map((card) => card.key));
  const mainCard =
    list.find((card) => card.kind === 'section' && MAIN_SECTION_TITLES.has(card.section.title)) ?? list[0];
  const next = new Set([...collapsed.value].filter((key) => keys.has(key)));
  for (const card of list) {
    if (card.key !== mainCard.key && !previousKeys.has(card.key)) {
      next.add(card.key);
    }
  }
  collapsed.value = next;
}

resetCollapsed();
watch(
  () => cards.value.map((card) => card.key).join('\n'),
  (_current, previous) => {
    syncCollapsedCards(new Set((previous ?? '').split('\n').filter(Boolean)));
  }
);

function isCollapsed(card: PropertyCard): boolean {
  if (card.kind === 'section' && (props.alphabetical || normalizedQuery.value)) {
    return false;
  }
  return collapsed.value.has(card.key);
}

function toggleSection(key: string): void {
  const next = new Set(collapsed.value);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  collapsed.value = next;
}

function readonlyText(): string {
  if (props.state.readonlyReason === 'support') {
    return 'Только чтение: объект на поддержке';
  }
  if (props.state.readonlyReason === 'supportChangesForbidden') {
    return 'Только чтение: изменения конфигурации запрещены в настройках поддержки';
  }
  if (props.state.readonlyReason === 'repository') {
    return 'Только чтение: объект не захвачен в хранилище';
  }
  return 'Только чтение';
}

function send(name: string, payload?: Record<string, unknown>): void {
  emit('command', name, payload);
}
</script>

<template>
  <div class="properties-view">
    <header class="properties-header">
      <h2 class="properties-title" :title="state.title">{{ state.title }}</h2>
      <span v-if="state.readonly" class="readonly-badge">{{ readonlyText() }}</span>
    </header>

    <div class="properties-toolbar">
      <input
        v-model="query"
        type="search"
        class="prop-field properties-search"
        aria-label="Поиск по свойствам"
        placeholder="Поиск по свойствам"
      />
      <button
        type="button"
        class="properties-order"
        aria-label="Сортировать по алфавиту"
        :aria-pressed="alphabetical"
        :title="alphabetical ? 'Показать по группам' : 'Показать по алфавиту'"
        @click="emit('update:alphabetical', !alphabetical)"
      >А-Я</button>
    </div>

    <div v-if="state.diagnostics?.length" class="diagnostics-section">
      <div
        v-for="(d, index) in state.diagnostics"
        :key="index"
        class="diagnostic-item"
        :class="'diagnostic-' + d.kind"
      >
        <span class="diagnostic-icon" aria-hidden="true">
          {{ d.kind === 'error' ? '!' : d.kind === 'warning' ? '?' : 'i' }}
        </span>
        <span class="diagnostic-message">{{ d.message }}</span>
      </div>
    </div>

    <div v-if="visibleCards.length" class="sections-list">
      <template v-for="card in visibleCards" :key="card.key">
        <section
          v-if="card.kind === 'section'"
          class="property-section"
          :class="{ 'is-expanded': !isCollapsed(card) }"
        >
          <button
            v-if="!alphabetical"
            type="button"
            class="section-header"
            :aria-expanded="!isCollapsed(card)"
            :disabled="Boolean(normalizedQuery)"
            @click="toggleSection(card.key)"
          >
            <span
              class="section-chevron codicon"
              :class="isCollapsed(card) ? 'codicon-chevron-right' : 'codicon-chevron-down'"
              aria-hidden="true"
            ></span>
            <span class="section-title">{{ card.section.title }}</span>
          </button>
          <div v-show="!isCollapsed(card)" :class="{ 'section-body': !alphabetical }">
            <PropertyFormsSection
              v-if="!normalizedQuery && card.section.title === 'Формы'"
              v-slot="{ controls }"
              :controls="card.section.controls"
            >
              <PropertyRow
                v-for="control in controls"
                :key="control.id"
                :control="control"
                :readonly="state.readonly"
                :selected="selectedId === control.id"
                @select="selectedId = control.id"
                @command="send"
              />
            </PropertyFormsSection>
            <div v-else class="section-controls">
              <PropertyRow
                v-for="control in card.section.controls"
                :key="control.id"
                :control="control"
                :readonly="state.readonly"
                :selected="selectedId === control.id"
                @select="selectedId = control.id"
                @command="send"
              />
            </div>
          </div>
        </section>

        <section
          v-else-if="card.kind === 'subsystems' && state.subsystemSnapshot"
          class="property-section"
          :class="{ 'is-expanded': !isCollapsed(card) }"
        >
          <button type="button" class="section-header" @click="toggleSection(card.key)">
            <span
              class="section-chevron codicon"
              :class="isCollapsed(card) ? 'codicon-chevron-right' : 'codicon-chevron-down'"
              aria-hidden="true"
            ></span>
            <span class="section-title">Подсистемы</span>
          </button>
          <div v-show="!isCollapsed(card)" class="section-body">
            <SubsystemMembershipCard
              :snapshot="state.subsystemSnapshot"
              :readonly="state.readonly"
              @add="send('openSubsystemMembershipPicker')"
              @remove="send('removeSubsystemMembership', { value: $event })"
            />
          </div>
        </section>

        <section
          v-else-if="card.kind === 'exchangePlanContent' && state.exchangePlanContentSnapshot"
          class="property-section"
          :class="{ 'is-expanded': !isCollapsed(card) }"
        >
          <button type="button" class="section-header" @click="toggleSection(card.key)">
            <span
              class="section-chevron codicon"
              :class="isCollapsed(card) ? 'codicon-chevron-right' : 'codicon-chevron-down'"
              aria-hidden="true"
            ></span>
            <span class="section-title">Обмен данными</span>
          </button>
          <div v-show="!isCollapsed(card)" class="section-body">
            <ExchangePlanContentCard :snapshot="state.exchangePlanContentSnapshot" />
          </div>
        </section>
      </template>
    </div>

    <div v-else class="empty-state">
      <p>{{ normalizedQuery ? 'Свойства не найдены.' : 'Для выбранного объекта свойства не отображаются.' }}</p>
    </div>

    <footer v-if="selectedControl" class="property-details" aria-live="polite">
      <strong>{{ selectedControl.label }}</strong>
      <code>{{ selectedControl.id }}</code>
      <p v-if="selectedControl.hint">{{ selectedControl.hint }}</p>
    </footer>
  </div>
</template>

<style scoped>
.properties-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.properties-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 0;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.properties-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--vscode-foreground);
}

.readonly-badge {
  font-size: 11px;
  padding: 1px 5px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border-radius: 2px;
}

.properties-toolbar {
  display: flex;
  gap: 6px;
  padding: 6px 0;
}

.properties-search {
  flex: 1;
  min-width: 0;
}

.properties-order {
  flex: none;
  padding: 0 8px;
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 5px;
  color: var(--vscode-foreground);
  background: var(--vscode-input-background);
  font: inherit;
  cursor: pointer;
}

.properties-order[aria-pressed='true'] {
  color: var(--vscode-inputOption-activeForeground);
  background: var(--vscode-inputOption-activeBackground);
  border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder));
}

.property-details {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  max-height: 30%;
  padding: 6px 0;
  overflow: auto;
  overflow-wrap: anywhere;
  border-top: 1px solid var(--vscode-panel-border);
  color: var(--vscode-descriptionForeground);
}

.property-details strong {
  color: var(--vscode-foreground);
}

.property-details p {
  flex-basis: 100%;
  margin: 0;
}

.diagnostics-section {
  padding: 4px 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.diagnostic-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 2px;
  font-size: 12px;
}

.diagnostic-error {
  background: var(--vscode-inputValidation-errorBackground);
  border: 1px solid var(--vscode-inputValidation-errorBorder);
  color: var(--vscode-errorForeground);
}

.diagnostic-warning {
  background: var(--vscode-inputValidation-warningBackground);
  border: 1px solid var(--vscode-inputValidation-warningBorder);
  color: var(--vscode-list-warningForeground);
}

.diagnostic-info {
  color: var(--vscode-descriptionForeground);
}

.diagnostic-icon {
  font-weight: bold;
  font-size: 14px;
  min-width: 16px;
  text-align: center;
}

.sections-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  padding-right: 6px;
}

.property-section {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--vscode-panel-border);
}

.property-section:last-child {
  border-bottom: none;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 6px 0;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.section-header:disabled {
  cursor: default;
}

.section-chevron {
  width: 16px;
  font-size: 16px;
  flex-shrink: 0;
  text-align: center;
  opacity: 0.8;
}

.section-title {
  margin: 0;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-descriptionForeground);
}

.section-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* Линия 3px проходит вертикально под центром иконки сворачивания (≈8px). */
  margin-left: 6px;
  padding: 0 0 8px 12px;
  border-left: 3px solid transparent;
}

.property-section.is-expanded .section-body {
  border-left-color: var(--vscode-focusBorder);
}

.section-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.empty-state {
  padding: 6px 0;
  color: var(--vscode-descriptionForeground);
  font-size: 12px;
}
</style>
