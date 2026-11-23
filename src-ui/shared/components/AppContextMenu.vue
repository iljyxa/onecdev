<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue';
import type { IconDto } from '@ui-shared/types/icon';

/**
 * Пункт меню. Соседние пункты с разной `group` разделяются линией; пункт с `children`
 * открывает подменю (одного уровня) и сам не выбирается — `select` приходит только для листьев.
 */
export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: IconDto;
  readonly enabled?: boolean;
  readonly group?: string;
  readonly children?: readonly ContextMenuItem[];
}

const props = defineProps<{
  visible: boolean;
  x: number;
  y: number;
  items: readonly ContextMenuItem[];
}>();

const emit = defineEmits<{
  select: [item: ContextMenuItem];
  close: [];
}>();

const MARGIN = 8;

const menuRef = ref<HTMLElement | null>(null);
const submenuRef = ref<HTMLElement | null>(null);
const menuPosition = ref({ x: 0, y: 0 });
const maxHeight = ref<number | null>(null);

/** Открытое подменю: его пункт верхнего уровня и кнопка, от которой оно позиционируется. */
const submenu = ref<{ item: ContextMenuItem; trigger: HTMLElement } | null>(null);
const submenuPosition = ref({ x: 0, y: 0 });
const submenuMaxHeight = ref<number | null>(null);

function hasSeparatorBefore(items: readonly ContextMenuItem[], index: number): boolean {
  return index > 0 && items[index - 1].group !== items[index].group;
}

function isSubmenuOpen(item: ContextMenuItem): boolean {
  return submenu.value?.item.id === item.id;
}

function iconClass(icon?: IconDto): string {
  if (icon?.kind === 'codicon' && icon.name) {
    return `codicon codicon-${icon.name}`;
  }
  return 'codicon codicon-circle-outline';
}

function isAssetIcon(icon?: IconDto): icon is IconDto & { kind: 'asset'; lightUri: string; darkUri: string } {
  return icon?.kind === 'asset' && Boolean(icon.lightUri) && Boolean(icon.darkUri);
}

// URI иконок приходят от host и подставляются в CSS `url(...)`. Без проверки
// и экранирования возможна CSS-инъекция (закрывающая скобка/кавычка в значении).
// Пропускаем только ожидаемые схемы и оборачиваем в кавычки с экранированием.
const ALLOWED_ICON_SCHEMES = ['vscode-resource:', 'vscode-webview-resource:', 'https:', 'data:'];

function cssIconUrl(uri: string): string {
  const isAllowed = ALLOWED_ICON_SCHEMES.some((scheme) => uri.startsWith(scheme));
  if (!isAllowed) {
    return 'none';
  }
  const escaped = uri.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `url("${escaped}")`;
}

function close(): void {
  submenu.value = null;
  emit('close');
}

/** Кнопки пунктов одной панели (корня или подменю), без пунктов вложенной панели. */
function panelButtons(panel: Element): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>(':scope > .context-menu-item:not(:disabled)')];
}

async function openSubmenu(item: ContextMenuItem, trigger: HTMLElement, focusFirst: boolean): Promise<void> {
  if (item.enabled === false || !item.children?.length) {
    return;
  }
  if (!isSubmenuOpen(item)) {
    submenu.value = { item, trigger };
    submenuPosition.value = { x: -10000, y: 0 };
    submenuMaxHeight.value = null;
    await nextTick();
    placeSubmenu();
  }
  if (focusFirst && submenuRef.value) {
    panelButtons(submenuRef.value)[0]?.focus({ preventScroll: true });
  }
}

function closeSubmenu(focusTrigger: boolean): void {
  const trigger = submenu.value?.trigger;
  submenu.value = null;
  if (focusTrigger) {
    trigger?.focus({ preventScroll: true });
  }
}

/** Подменю — справа от пункта, а если не помещается — слева; по вертикали прижимается к окну. */
function placeSubmenu(): void {
  const panel = submenuRef.value;
  const trigger = submenu.value?.trigger;
  if (!panel || !trigger) {
    return;
  }
  const anchor = trigger.getBoundingClientRect();
  const rect = panel.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const availableHeight = Math.max(96, viewportHeight - MARGIN * 2);

  let x = anchor.right - 2;
  if (x + rect.width > viewportWidth - MARGIN) {
    x = anchor.left - rect.width + 2;
  }
  let y = anchor.top - 5;
  if (rect.height > availableHeight) {
    submenuMaxHeight.value = availableHeight;
    y = MARGIN;
  } else if (y + rect.height > viewportHeight - MARGIN) {
    y = viewportHeight - rect.height - MARGIN;
  }
  submenuPosition.value = { x: Math.max(MARGIN, x), y: Math.max(MARGIN, y) };
}

function onItemPointerEnter(item: ContextMenuItem, event: PointerEvent): void {
  if (item.children) {
    void openSubmenu(item, event.currentTarget as HTMLElement, false);
  } else {
    submenu.value = null;
  }
}

function onItemClick(item: ContextMenuItem, event: MouseEvent): void {
  if (item.children) {
    void openSubmenu(item, event.currentTarget as HTMLElement, true);
    return;
  }
  selectItem(item);
}

/** ↑/↓ — по пунктам панели, → — в подменю, ← — из подменю к его пункту. Esc — в `onEscape`. */
function onMenuKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement;
  const panel = target.closest('[data-menu-panel]');
  if (!panel) {
    return;
  }
  const inSubmenu = panel === submenuRef.value;
  const buttons = panelButtons(panel);
  const index = buttons.indexOf(target);

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (buttons.length === 0) {
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = index < 0
      ? (step > 0 ? 0 : buttons.length - 1)
      : (index + step + buttons.length) % buttons.length;
    if (!inSubmenu) {
      submenu.value = null;
    }
    buttons[next].focus({ preventScroll: false });
    return;
  }
  if (event.key === 'ArrowRight' && !inSubmenu && index >= 0) {
    const item = props.items.find((candidate) => candidate.id === target.dataset.itemId);
    if (item?.children) {
      event.preventDefault();
      void openSubmenu(item, target, true);
    }
    return;
  }
  if (event.key === 'ArrowLeft' && inSubmenu) {
    event.preventDefault();
    closeSubmenu(true);
  }
}

function onOutsidePointer(event: PointerEvent): void {
  if (menuRef.value?.contains(event.target as Node)) {
    return;
  }
  close();
}

function onOutsideFocus(event: FocusEvent): void {
  if (menuRef.value?.contains(event.target as Node)) {
    return;
  }
  close();
}

function onWindowBlur(): void {
  close();
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') {
    close();
  }
}

function onEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') {
    return;
  }
  // Esc сначала закрывает подменю, и только затем — всё меню.
  if (submenu.value) {
    closeSubmenu(true);
    return;
  }
  close();
}

function onScroll(event: Event): void {
  const target = event.target as Node;
  if (submenuRef.value?.contains(target)) {
    return;
  }
  if (menuRef.value?.contains(target)) {
    // Прокрутка корня уводит пункт из-под подменю — его позиция больше не верна.
    submenu.value = null;
    return;
  }
  close();
}

function selectItem(item: ContextMenuItem): void {
  if (item.enabled === false) {
    return;
  }
  emit('select', item);
}

async function updateMenuPosition(): Promise<void> {
  submenu.value = null;
  menuPosition.value = { x: props.x, y: props.y };
  maxHeight.value = null;
  await nextTick();
  await new Promise((resolve) => requestAnimationFrame(resolve));

  const menu = menuRef.value;
  if (!menu) {
    return;
  }

  const margin = MARGIN;
  const rect = menu.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const availableHeight = Math.max(96, viewportHeight - margin * 2);
  let x = props.x;
  let y = props.y;

  if (rect.width > viewportWidth - margin * 2) {
    x = margin;
  } else if (x + rect.width > viewportWidth - margin) {
    x = viewportWidth - rect.width - margin;
  }
  if (rect.height > availableHeight) {
    maxHeight.value = availableHeight;
    y = margin;
  } else if (y + rect.height > viewportHeight - margin) {
    y = viewportHeight - rect.height - margin;
  }

  menuPosition.value = {
    x: Math.max(margin, x),
    y: Math.max(margin, y),
  };
  menu.focus({ preventScroll: true });
}

function addListeners(): void {
  document.addEventListener('pointerdown', onOutsidePointer, true);
  document.addEventListener('focusin', onOutsideFocus, true);
  document.addEventListener('keydown', onEscape);
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('blur', onWindowBlur);
  window.addEventListener('resize', updateMenuPosition);
  window.addEventListener('scroll', onScroll, true);
}

function removeListeners(): void {
  document.removeEventListener('pointerdown', onOutsidePointer, true);
  document.removeEventListener('focusin', onOutsideFocus, true);
  document.removeEventListener('keydown', onEscape);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('blur', onWindowBlur);
  window.removeEventListener('resize', updateMenuPosition);
  window.removeEventListener('scroll', onScroll, true);
}

watch(() => props.visible, (visible) => {
  if (visible) {
    addListeners();
    void updateMenuPosition();
  } else {
    submenu.value = null;
    removeListeners();
  }
});

watch(() => [props.x, props.y, props.items.length], () => {
  if (props.visible) {
    void updateMenuPosition();
  }
});

onUnmounted(removeListeners);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="context-menu"
      role="menu"
      tabindex="-1"
      data-menu-panel="root"
      :style="{
        left: menuPosition.x + 'px',
        top: menuPosition.y + 'px',
        maxHeight: maxHeight ? maxHeight + 'px' : undefined,
      }"
      @contextmenu.prevent
      @keydown="onMenuKeydown"
    >
      <template v-for="(item, index) in items" :key="item.id">
        <div v-if="hasSeparatorBefore(items, index)" class="context-menu-separator" role="separator" />
        <button
          class="context-menu-item"
          :class="{ 'context-menu-item--open': isSubmenuOpen(item) }"
          type="button"
          role="menuitem"
          :data-item-id="item.id"
          :aria-haspopup="item.children ? 'menu' : undefined"
          :aria-expanded="item.children ? isSubmenuOpen(item) : undefined"
          :disabled="item.enabled === false"
          @pointerenter="onItemPointerEnter(item, $event)"
          @click="onItemClick(item, $event)"
        >
          <span class="context-menu-icon" aria-hidden="true">
            <span
              v-if="isAssetIcon(item.icon)"
              class="context-menu-asset"
              :style="{ '--icon-light': cssIconUrl(item.icon.lightUri), '--icon-dark': cssIconUrl(item.icon.darkUri) }"
            />
            <span v-else-if="item.icon" :class="iconClass(item.icon)" />
          </span>
          <span class="context-menu-label">{{ item.label }}</span>
          <span v-if="item.children" class="context-menu-chevron codicon codicon-chevron-right" aria-hidden="true" />
        </button>
      </template>

      <!-- Подменю — внутри корня: клик в нём не считается «кликом вне меню». -->
      <div
        v-if="submenu"
        ref="submenuRef"
        class="context-menu context-menu--submenu"
        role="menu"
        data-menu-panel="sub"
        :aria-label="submenu.item.label"
        :style="{
          left: submenuPosition.x + 'px',
          top: submenuPosition.y + 'px',
          maxHeight: submenuMaxHeight ? submenuMaxHeight + 'px' : undefined,
        }"
      >
        <template v-for="(child, index) in submenu.item.children ?? []" :key="child.id">
          <div v-if="hasSeparatorBefore(submenu.item.children ?? [], index)" class="context-menu-separator" role="separator" />
          <button
            class="context-menu-item"
            type="button"
            role="menuitem"
            :data-item-id="child.id"
            :disabled="child.enabled === false"
            @click="selectItem(child)"
          >
            <span class="context-menu-icon" aria-hidden="true">
              <span
                v-if="isAssetIcon(child.icon)"
                class="context-menu-asset"
                :style="{ '--icon-light': cssIconUrl(child.icon.lightUri), '--icon-dark': cssIconUrl(child.icon.darkUri) }"
              />
              <span v-else-if="child.icon" :class="iconClass(child.icon)" />
            </span>
            <span class="context-menu-label">{{ child.label }}</span>
          </button>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 10000;
  min-width: 196px;
  max-width: min(360px, calc(100vw - 16px));
  padding: 4px;
  overflow: auto;
  color: var(--vscode-menu-foreground, var(--vscode-foreground));
  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
  border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-panel-border)));
  border-radius: 8px;
  box-shadow: 0 4px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
  outline: none;
}

.context-menu-item {
  width: 100%;
  min-height: 24px;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr) 14px;
  align-items: center;
  gap: 6px;
  padding: 3px 10px 3px 6px;
  border: 0;
  border-radius: 4px;
  color: inherit;
  background: transparent;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: left;
  cursor: pointer;
}

.context-menu-item:hover:not(:disabled),
.context-menu-item:focus-visible,
.context-menu-item--open {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
  color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
  outline: none;
}

.context-menu-item:disabled {
  opacity: 0.5;
  cursor: default;
}

.context-menu-icon {
  width: 18px;
  height: 18px;
  display: inline-grid;
  place-items: center;
  color: var(--vscode-menu-foreground, var(--vscode-icon-foreground));
  font-size: 14px;
}

.context-menu-asset {
  width: 14px;
  height: 14px;
  display: block;
  background-image: var(--icon-light);
  background-size: contain;
  background-repeat: no-repeat;
  background-position: center;
}

body.vscode-dark .context-menu-asset,
body.vscode-high-contrast:not(.vscode-high-contrast-light) .context-menu-asset {
  background-image: var(--icon-dark);
}

.context-menu-separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--vscode-menu-separatorBackground, var(--vscode-widget-border, var(--vscode-panel-border)));
}

.context-menu-chevron {
  justify-self: end;
  font-size: 12px;
  opacity: 0.8;
}

.context-menu-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.context-menu::-webkit-scrollbar {
  width: 10px;
}

.context-menu::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background);
}

.context-menu::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground);
}
</style>
