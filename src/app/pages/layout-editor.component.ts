import { httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, HostListener, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { CdkDrag, CdkDragDrop, CdkDropList, CdkDropListGroup, moveItemInArray, transferArrayItem } from '@angular/cdk/drag-drop';
import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonDirective } from '@openng/optimus-ui/button';
import { CheckboxModule } from '@openng/optimus-ui/checkbox';
import { PanelModule } from '@openng/optimus-ui/panel';
import { defaultSpan, FIELD_TYPE_CATALOG, fieldTypeIcon, logicalFieldType } from '../core/field-types';
import { orderedColumns, placementNames, resolvedSearch, searchChoices, SEARCH_LABEL, seedBody, withSearches } from '../core/layout-shape';
import {
  ColumnCondition,
  CustomFilter,
  CustomFilterMode,
  CustomFilterType,
  FieldDefinition,
  FilterValueSource,
  LayoutBody,
  LayoutBox,
  LayoutDocument,
  LayoutPage,
  ListLayoutBody,
  PageKind,
  SearchMode,
  WizardLayoutBody,
} from '../core/models';
import { conditionNeedsValue, QUERY_CONDITIONS } from '../core/query-conditions';
import { LayoutStore } from '../core/layout-store';
import { MetadataCatalog } from '../core/metadata-catalog';
import { SnelloApi, dataFields } from '../core/snello-api';
import { ToastService } from '../core/toast';
import { FieldRow } from '../field-row';
import { Icon } from '../icon';
import { PageBar } from '../page-bar';
import { MetaIcon } from '../meta-icon';

const SIDE_KEY = 'studio-side-width';
const SIDE_DEFAULT = 280;
const clampSide = (width: number) => Math.min(560, Math.max(220, Math.round(width)));

interface LayoutDraft {
  kind: PageKind;
  enabled: boolean;
  name: string;
}

@Component({
  selector: 'app-layout-editor',
  imports: [DatePipe, NgTemplateOutlet, CdkDrag, CdkDropList, CdkDropListGroup, ButtonDirective, FormsModule, CheckboxModule, PanelModule, FieldRow, Icon, MetaIcon, PageBar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '[class.embedded]': 'embedded()' },
  templateUrl: './layout-editor.component.html',
})
export class LayoutEditorComponent {
  protected readonly api = inject(SnelloApi);
  private readonly store = inject(LayoutStore);
  readonly metadatas = inject(MetadataCatalog);
  private readonly router = inject(Router);
  private readonly boundRoute = signal<string | null>(null);

  readonly id = input<string>();
  /** True when shown inside another page (the library split view) instead of on its own route. */
  readonly embedded = input(false);
  readonly metadata = input<string>();
  readonly page = input<string>();

  readonly name = signal('');
  readonly metadataName = signal('');
  readonly pageType = signal<PageKind>('edit');
  readonly body = signal<LayoutBody>({ kind: 'wizard', pages: [] });
  readonly selectedPageId = signal<string | null>(null);
  readonly selectedBoxId = signal<string | null>(null);
  readonly pendingSeed = signal(false);
  readonly saved = signal(false);
  readonly viewNotice = signal('');
  private readonly toasts = inject(ToastService);
  private readonly notify = effect(() => {
    const message = this.viewNotice() || (this.saved() ? 'Layout saved.' : '');
    if (!message) return;
    this.toasts.show(message);
    untracked(() => {
      this.saved.set(false);
      this.viewNotice.set('');
    });
  });
  readonly saving = signal(false);
  readonly loadError = signal('');
  readonly showJson = signal(false);
  readonly drafts = signal<LayoutDraft[]>(freshDrafts(''));

  readonly metadataOptions = computed(() => this.metadatas.list());

  readonly fieldResource = httpResource<FieldDefinition[]>(() => {
    const name = this.metadataName();
    return name ? this.api.fieldsRequest(name) : undefined;
  }, {
    defaultValue: [],
    parse: dataFields,
  });

  readonly fields = computed(() => {
    const status = this.fieldResource.status();
    if (status !== 'resolved' && status !== 'local') return [];
    return [...this.fieldResource.value()].sort((left, right) => (left.order_num ?? 0) - (right.order_num ?? 0));
  });

  readonly wizard = computed(() => {
    const body = this.body();
    return body.kind === 'wizard' ? body : null;
  });

  readonly listBody = computed(() => {
    const body = this.body();
    return body.kind === 'list' ? body : null;
  });

  readonly columns = computed(() => {
    const body = this.listBody();
    return body ? orderedColumns(body) : [];
  });
  readonly customFilters = computed(() => this.listBody()?.filters ?? []);
  readonly conditionsOpen = signal(false);
  readonly settingsOpen = signal(false);
  readonly queryConditions = QUERY_CONDITIONS;
  readonly filterTypes: CustomFilterType[] = ['string', 'boolean', 'date', 'numeric'];

  readonly sideWidth = signal(clampSide(Number(localStorage.getItem(SIDE_KEY)) || SIDE_DEFAULT));

  startResize(event: PointerEvent, studio: HTMLElement): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const right = studio.getBoundingClientRect().right;
    const move = (moveEvent: PointerEvent) => this.sideWidth.set(clampSide(right - moveEvent.clientX));
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      localStorage.setItem(SIDE_KEY, String(this.sideWidth()));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  resizeKey(event: KeyboardEvent): void {
    const step = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0;
    if (!step) return;
    event.preventDefault();
    this.sideWidth.update((width) => clampSide(width + step));
    localStorage.setItem(SIDE_KEY, String(this.sideWidth()));
  }

  resetSide(): void {
    this.sideWidth.set(SIDE_DEFAULT);
    localStorage.setItem(SIDE_KEY, String(SIDE_DEFAULT));
  }

  readonly selectedFieldName = signal<string | null>(null);
  readonly selectedField = computed(() => {
    const name = this.selectedFieldName();
    return name ? (this.activeBox()?.fields.find((field) => field.fieldName === name) ?? null) : null;
  });
  readonly activeBox = computed(() => {
    const boxes = this.selectedPage()?.boxes ?? [];
    return boxes.find((box) => box.id === this.selectedBoxId()) ?? boxes[0] ?? null;
  });
  readonly selectedPage = computed(() => {
    const wizard = this.wizard();
    if (!wizard) return null;
    return wizard.pages.find((page) => page.id === this.selectedPageId()) ?? wizard.pages[0] ?? null;
  });

  readonly usedNames = computed(() => new Set(placementNames(this.body())));
  readonly canCreate = computed(() => {
    if (this.id() || !this.metadataName()) return false;
    const status = this.fieldResource.status();
    if (status !== 'resolved' && status !== 'local') return false;
    return this.drafts().some((draft) => draft.enabled);
  });
  readonly existingForMetadata = computed(() =>
    this.store.all().filter((item) => item.metadataName === this.metadataName()),
  );
  readonly viewTargets = computed(() => {
    if (!this.id() || this.pageType() !== 'edit' || this.body().kind !== 'wizard') return [];
    return this.store.all().filter((item) => item.metadataName === this.metadataName() && item.pageType === 'view');
  });
  readonly jsonText = computed(() => JSON.stringify(this.body(), null, 2));

  copyJson(): void {
    void navigator.clipboard.writeText(this.jsonText()).then(() => this.toasts.show('JSON copied.'));
  }

  @HostListener('document:keydown.escape')
  closeJson(): void {
    if (this.showJson()) this.showJson.set(false);
  }

  constructor() {
    effect(() => {
      const routeId = this.id() ?? '';
      const ready = this.store.ready();
      const presetMetadata = this.metadata();
      const presetPage = this.page();
      const status = this.metadatas.resource.status();
      if (!ready) return;
      if (status === 'idle' || status === 'loading' || status === 'reloading') return;
      untracked(() => {
        if (this.boundRoute() === routeId) return;
        this.boundRoute.set(routeId);
        this.loadError.set('');
        if (routeId) {
          const saved = this.store.find(routeId);
          if (!saved) {
            this.loadError.set('Layout not found');
            return;
          }
          this.hydrate(saved);
          return;
        }
        if (presetPage === 'list' || presetPage === 'edit' || presetPage === 'view') {
          this.pageType.set(presetPage);
        }
        if (presetMetadata) {
          this.metadataName.set(presetMetadata);
          this.drafts.set(freshDrafts(presetMetadata, presetPage === 'list' || presetPage === 'edit' || presetPage === 'view' ? presetPage : undefined));
          this.pendingSeed.set(true);
        }
      });
    });

    effect(() => {
      if (!this.pendingSeed()) return;
      const name = this.metadataName();
      const status = this.fieldResource.status();
      if (!name || status === 'idle' || status === 'loading' || status === 'reloading') return;
      if (status === 'error') {
        untracked(() => this.pendingSeed.set(false));
        return;
      }
      const fields = this.fields();
      const stale = fields.some((field) => field.metadata_name && field.metadata_name !== name);
      if (stale) return;
      const kind = this.pageType();
      untracked(() => {
        const seeded = seedBody(kind, fields);
        this.body.set(seeded);
        if (seeded.kind === 'wizard') {
          this.selectedPageId.set(seeded.pages[0]?.id ?? null);
          this.selectedBoxId.set(seeded.pages[0]?.boxes[0]?.id ?? null);
        }
        this.name.set(`${name} ${kind}`);
        this.pendingSeed.set(false);
      });
    });

    effect(() => {
      const fields = this.fields();
      const body = this.body();
      const metadata = this.metadataName();
      if (body.kind !== 'list' || fields.length === 0) return;
      if (fields.some((field) => field.metadata_name && field.metadata_name !== metadata)) return;
      const next = withSearches(body, fields);
      if (next === body) return;
      untracked(() => this.body.set(next));
    });
  }

  onName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.saved.set(false);
    this.viewNotice.set('');
  }

  readonly confirmDialog = signal<{
    title: string;
    message: string;
    confirmLabel: string;
    danger: boolean;
    action: () => void;
    cancel?: () => void;
  } | null>(null);

  closeConfirm(confirmed: boolean): void {
    const dialog = this.confirmDialog();
    this.confirmDialog.set(null);
    if (!dialog) return;
    if (confirmed) dialog.action();
    else dialog.cancel?.();
  }

  onMetadata(select: HTMLSelectElement): void {
    const name = select.value;
    if (name === this.metadataName()) return;
    if (this.metadataName() && placementNames(this.body()).length) {
      this.confirmDialog.set({
        title: 'Change metadata?',
        message: 'Changing metadata rebuilds the layout.',
        confirmLabel: 'Continue',
        danger: false,
        action: () => this.applyMetadata(name),
        cancel: () => (select.value = this.metadataName()),
      });
      return;
    }
    this.applyMetadata(name);
  }

  private applyMetadata(name: string): void {
    this.metadataName.set(name);
    this.saved.set(false);
    this.viewNotice.set('');
    this.drafts.set(freshDrafts(name));
    if (this.id()) {
      this.name.set(name ? `${name} ${this.pageType()}` : '');
      this.pendingSeed.set(!!name);
    }
  }

  setPageType(kind: PageKind): void {
    if (kind === this.pageType()) return;
    const crossing = (kind === 'list') !== (this.pageType() === 'list');
    if (crossing && this.metadataName()) {
      this.confirmDialog.set({
        title: 'Switch layout type?',
        message: 'Switching between list and form rebuilds the body.',
        confirmLabel: 'Continue',
        danger: false,
        action: () => this.applyPageType(kind, crossing),
      });
      return;
    }
    this.applyPageType(kind, crossing);
  }

  private applyPageType(kind: PageKind, crossing: boolean): void {
    this.pageType.set(kind);
    this.saved.set(false);
    this.viewNotice.set('');
    if (this.metadataName()) this.name.set(`${this.metadataName()} ${kind}`);
    if (crossing && this.metadataName()) this.pendingSeed.set(true);
  }

  fieldOf(name: string): FieldDefinition | undefined {
    return this.fields().find((field) => field.name === name);
  }

  typeOf(name: string): string {
    const field = this.fieldOf(name);
    return field ? logicalFieldType(field) : 'string';
  }

  typeIcon(name: string): string {
    return fieldTypeIcon(this.typeOf(name));
  }

  mockKind(name: string): 'area' | 'check' | 'drop' | 'select' | 'date' | 'map' | 'input' {
    const type = this.typeOf(name);
    if (['text', 'tinymce', 'monaco'].includes(type)) return 'area';
    if (['boolean', 'passivation'].includes(type)) return 'check';
    if (['media', 'image'].includes(type)) return 'drop';
    if (['select', 'multiselect', 'tags', 'join', 'lookup', 'multijoin', 'multilookup', 'realtionships'].includes(type)) return 'select';
    if (['date', 'datetime', 'time'].includes(type)) return 'date';
    if (['gmaplocation', 'gmappath'].includes(type)) return 'map';
    return 'input';
  }

  typeTitle(name: string): string {
    const type = this.typeOf(name);
    return FIELD_TYPE_CATALOG.find((item) => item.id === type)?.label ?? type;
  }

  searchOf(name: string): SearchMode {
    const column = this.columns().find((item) => item.fieldName === name);
    return resolvedSearch(column?.search, this.fieldOf(name));
  }

  searchOptions(name: string): SearchMode[] {
    return searchChoices(this.fieldOf(name));
  }

  searchLabel(mode: SearchMode): string {
    return SEARCH_LABEL[mode];
  }

  setSearch(name: string, event: Event): void {
    const search = (event.target as HTMLSelectElement).value as SearchMode;
    if (!this.searchOptions(name).includes(search)) return;
    this.patchList((body) => {
      body.columns = body.columns.map((column) => (column.fieldName === name ? { ...column, search } : column));
    });
  }

  toggleColumn(name: string): void {
    this.patchList((body) => {
      body.columns = body.columns.map((column) =>
        column.fieldName === name ? { ...column, visible: !column.visible } : column,
      );
    });
  }

  setBlockSpan(boxId: string, span: 4 | 6 | 12): void {
    this.patchWizard((body) => {
      const box = body.pages.flatMap((page) => page.boxes).find((item) => item.id === boxId);
      box?.fields.forEach((field) => (field.span = span));
    });
  }

  dropColumn(event: CdkDragDrop<unknown>): void {
    if (event.previousIndex === event.currentIndex) return;
    this.patchList((body) => {
      const ordered = orderedColumns(body);
      moveItemInArray(ordered, event.previousIndex, event.currentIndex);
      body.columns = ordered.map((column, order) => ({ ...column, order }));
    });
  }

  dropField(event: CdkDragDrop<string>): void {
    if (event.previousContainer.id === 'palette-list') {
      this.addField(event.item.data as string, event.container.data, event.currentIndex);
      this.selectedBoxId.set(event.container.data);
      return;
    }
    const fromId = event.previousContainer.data;
    const toId = event.container.data;
    if (fromId === toId && event.previousIndex === event.currentIndex) return;
    this.patchWizard((body) => {
      const boxes = body.pages.flatMap((page) => page.boxes);
      const from = boxes.find((item) => item.id === fromId);
      const to = boxes.find((item) => item.id === toId);
      if (!from || !to) return;
      if (from === to) moveItemInArray(from.fields, event.previousIndex, event.currentIndex);
      else transferArrayItem(from.fields, to.fields, event.previousIndex, event.currentIndex);
    });
    this.selectedBoxId.set(toId);
  }

  moveColumn(name: string, direction: -1 | 1): void {
    const columns = this.columns();
    const index = columns.findIndex((column) => column.fieldName === name);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= columns.length) return;
    this.patchList((body) => {
      const ordered = orderedColumns(body);
      const current = ordered[index];
      const next = ordered[target];
      if (!current || !next) return;
      ordered[index] = next;
      ordered[target] = current;
      body.columns = ordered.map((column, order) => ({ ...column, order }));
    });
  }

  filterTypeLabel(type: CustomFilterType): string {
    if (type === 'boolean') return 'Boolean';
    if (type === 'date') return 'Date';
    if (type === 'numeric') return 'Numeric';
    return 'String';
  }

  needsValue(suffix: string): boolean {
    return conditionNeedsValue(suffix);
  }

  addFilter(): void {
    this.patchList((body) => {
      body.filters = [...(body.filters ?? []), emptyFilter()];
    });
  }

  removeFilter(id: string): void {
    this.patchList((body) => {
      body.filters = (body.filters ?? []).filter((item) => item.id !== id);
    });
  }

  setFilterLabel(id: string, event: Event): void {
    this.patchFilter(id, { label: (event.target as HTMLInputElement).value });
  }

  setFilterType(id: string, event: Event): void {
    const type = (event.target as HTMLSelectElement).value as CustomFilterType;
    if (!this.filterTypes.includes(type)) return;
    this.patchFilter(id, { type });
  }

  setFilterMode(id: string, event: Event): void {
    const mode = (event.target as HTMLSelectElement).value as CustomFilterMode;
    if (mode !== 'columns' && mode !== 'developer') return;
    this.patchList((body) => {
      const filter = (body.filters ?? []).find((item) => item.id === id);
      if (!filter || filter.mode === mode) return;
      filter.mode = mode;
      if (mode === 'columns' && filter.conditions.length === 0) filter.conditions = [emptyCondition()];
    });
  }

  setFilterName(id: string, event: Event): void {
    this.patchFilter(id, { name: (event.target as HTMLInputElement).value });
  }

  setFilterSuffix(id: string, event: Event): void {
    const suffix = (event.target as HTMLSelectElement).value;
    if (!QUERY_CONDITIONS.some((item) => item.suffix === suffix)) return;
    this.patchFilter(id, { suffix });
  }

  addCondition(filterId: string): void {
    this.patchList((body) => {
      const filter = (body.filters ?? []).find((item) => item.id === filterId);
      if (!filter) return;
      filter.conditions = [...filter.conditions, emptyCondition()];
    });
  }

  removeCondition(filterId: string, conditionId: string): void {
    this.patchList((body) => {
      const filter = (body.filters ?? []).find((item) => item.id === filterId);
      if (!filter) return;
      filter.conditions = filter.conditions.filter((item) => item.id !== conditionId);
    });
  }

  setConditionField(filterId: string, conditionId: string, event: Event): void {
    this.patchCondition(filterId, conditionId, { fieldName: (event.target as HTMLSelectElement).value });
  }

  setConditionSuffix(filterId: string, conditionId: string, event: Event): void {
    const suffix = (event.target as HTMLSelectElement).value;
    if (!QUERY_CONDITIONS.some((item) => item.suffix === suffix)) return;
    this.patchCondition(filterId, conditionId, conditionNeedsValue(suffix) ? { suffix } : { suffix, value: '', source: 'fixed' });
  }

  setConditionSource(filterId: string, conditionId: string, event: Event): void {
    const source = (event.target as HTMLSelectElement).value as FilterValueSource;
    if (source !== 'fixed' && source !== 'dynamic') return;
    this.patchCondition(filterId, conditionId, source === 'dynamic' ? { source, value: '' } : { source });
  }

  setConditionValue(filterId: string, conditionId: string, event: Event): void {
    this.patchCondition(filterId, conditionId, { value: (event.target as HTMLInputElement | HTMLSelectElement).value });
  }

  readonly pageDialog = signal<{ mode: 'add' | 'edit'; id: string; title: string } | null>(null);

  openAddPage(): void {
    this.pageDialog.set({ mode: 'add', id: '', title: `Page ${(this.wizard()?.pages.length ?? 0) + 1}` });
  }

  openEditPage(page: LayoutPage): void {
    this.pageDialog.set({ mode: 'edit', id: page.id, title: page.title });
  }

  confirmPageDialog(title: string): void {
    const dialog = this.pageDialog();
    if (!dialog) return;
    const clean = title.trim() || dialog.title;
    if (dialog.mode === 'add') this.addPage(clean);
    else this.patchWizard((body) => {
      const page = body.pages.find((item) => item.id === dialog.id);
      if (page) page.title = clean;
    });
    this.pageDialog.set(null);
  }

  addPage(title?: string): void {
    const page: LayoutPage = {
      id: crypto.randomUUID(),
      title: title ?? `Page ${(this.wizard()?.pages.length ?? 0) + 1}`,
      boxes: [{ id: crypto.randomUUID(), title: 'Block', fields: [] }],
    };
    this.patchWizard((body) => body.pages.push(page));
    this.selectedPageId.set(page.id);
    this.selectedBoxId.set(page.boxes[0]?.id ?? null);
  }

  selectPage(id: string): void {
    this.selectedPageId.set(id);
    const page = this.wizard()?.pages.find((item) => item.id === id);
    this.selectedBoxId.set(page?.boxes[0]?.id ?? null);
  }

  removePage(id: string): void {
    const title = this.wizard()?.pages.find((page) => page.id === id)?.title || 'this page';
    this.confirmDialog.set({
      title: `Delete “${title}”?`,
      message: 'The page and all its blocks and fields are removed from this layout.',
      confirmLabel: 'Delete page',
      danger: true,
      action: () => {
        this.patchWizard((body) => {
          body.pages = body.pages.filter((page) => page.id !== id);
        });
        this.selectedPageId.set(this.wizard()?.pages[0]?.id ?? null);
        this.selectedBoxId.set(this.wizard()?.pages[0]?.boxes[0]?.id ?? null);
      },
    });
  }

  addBox(title = 'Block'): void {
    const pageId = this.selectedPage()?.id;
    if (!pageId) return;
    const box: LayoutBox = { id: crypto.randomUUID(), title, fields: [] };
    this.patchWizard((body) => {
      body.pages.find((page) => page.id === pageId)?.boxes.push(box);
    });
    this.selectedBoxId.set(box.id);
  }

  readonly fieldPicker = signal<{ boxId: string; query: string } | null>(null);

  /** Fields not placed yet, filtered by the picker's search text. */
  readonly pickableFields = computed(() => {
    const picker = this.fieldPicker();
    if (!picker) return [];
    const query = picker.query.trim().toLowerCase();
    const used = this.usedNames();
    return this.fields().filter((field) => {
      const name = field.name ?? '';
      if (!name || used.has(name)) return false;
      return !query || name.toLowerCase().includes(query) || (field.label ?? '').toLowerCase().includes(query);
    });
  });

  openFieldPicker(boxId: string): void {
    this.selectedBoxId.set(boxId);
    this.fieldPicker.set({ boxId, query: '' });
  }

  setPickerQuery(event: Event): void {
    const picker = this.fieldPicker();
    if (picker) this.fieldPicker.set({ ...picker, query: (event.target as HTMLInputElement).value });
  }

  pickField(name: string): void {
    const picker = this.fieldPicker();
    if (!picker) return;
    this.addField(name, picker.boxId);
    this.selectedBoxId.set(picker.boxId);
    this.selectedFieldName.set(name);
    this.fieldPicker.set(null);
  }

  readonly blockDialog = signal<{ mode: 'add' | 'edit'; id: string; title: string } | null>(null);

  openEditBlock(box: LayoutBox): void {
    this.blockDialog.set({ mode: 'edit', id: box.id, title: box.title });
  }

  openAddBlock(): void {
    const count = this.selectedPage()?.boxes.length ?? 0;
    this.blockDialog.set({ mode: 'add', id: '', title: `Block ${count + 1}` });
  }

  confirmBlockDialog(title: string): void {
    const dialog = this.blockDialog();
    if (!dialog) return;
    const clean = title.trim() || dialog.title;
    if (dialog.mode === 'add') this.addBox(clean);
    else
      this.patchWizard((body) => {
        for (const page of body.pages) {
          const box = page.boxes.find((item) => item.id === dialog.id);
          if (box) box.title = clean;
        }
      });
    this.blockDialog.set(null);
  }

  selectField(boxId: string, name: string): void {
    this.selectedBoxId.set(boxId);
    this.selectedFieldName.set(name);
  }

  selectBox(id: string): void {
    if (this.selectedBoxId() !== id) this.selectedFieldName.set(null);
    this.selectedBoxId.set(id);
  }

  removeBox(id: string): void {
    const title = this.wizard()?.pages.flatMap((page) => page.boxes).find((box) => box.id === id)?.title || 'this block';
    this.confirmDialog.set({
      title: `Delete “${title}”?`,
      message: 'The block and its fields are removed from this layout.',
      confirmLabel: 'Delete block',
      danger: true,
      action: () =>
        this.patchWizard((body) => {
          for (const page of body.pages) page.boxes = page.boxes.filter((box) => box.id !== id);
        }),
    });
  }

  addField(name: string, targetBoxId?: string, index?: number): void {
    if (this.usedNames().has(name)) return;
    const page = this.selectedPage();
    if (!page) return;
    const boxId = this.selectedBoxId() ?? page.boxes[0]?.id;
    if (!boxId && !targetBoxId) {
      this.addBox();
    }
    const target = targetBoxId ?? this.selectedBoxId() ?? boxId;
    if (!target) return;
    const definition = this.fieldOf(name);
    this.patchWizard((body) => {
      const box = body.pages.flatMap((item) => item.boxes).find((item) => item.id === target);
      if (!box || box.fields.some((field) => field.fieldName === name)) return;
      box.fields.splice(index ?? box.fields.length, 0, {
        fieldName: name,
        required: !!definition?.mandatory,
        span: definition ? defaultSpan(definition) : 4,
      });
    });
  }

  readonly noEntry = () => false;

  toggleRequired(boxId: string, name: string): void {
    this.patchWizard((body) => {
      const field = body.pages.flatMap((page) => page.boxes).find((box) => box.id === boxId)?.fields.find((item) => item.fieldName === name);
      if (field) field.required = !field.required;
    });
  }

  showIfChoices(name: string, current: string | null | undefined): FieldDefinition[] {
    const choices = this.fields().filter((field) => !!field.name && field.name !== name);
    if (current && !choices.some((field) => field.name === current)) {
      return [{ name: current, label: current }, ...choices];
    }
    return choices;
  }

  setShowIf(boxId: string, name: string, enabled: boolean): void {
    const current = this.wizard()?.pages.flatMap((page) => page.boxes).find((box) => box.id === boxId)?.fields.find((item) => item.fieldName === name);
    if (!current || !!current.showIf === enabled) return;
    this.patchWizard((body) => {
      const field = body.pages.flatMap((page) => page.boxes).find((box) => box.id === boxId)?.fields.find((item) => item.fieldName === name);
      if (!field) return;
      field.showIf = enabled;
      if (!enabled) field.showIfField = null;
    });
  }

  setShowIfField(boxId: string, name: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.patchWizard((body) => {
      const field = body.pages.flatMap((page) => page.boxes).find((box) => box.id === boxId)?.fields.find((item) => item.fieldName === name);
      if (!field) return;
      field.showIf = true;
      field.showIfField = value || null;
    });
  }

  readonly spanOptions: { value: 4 | 6 | 12; label: string; title: string }[] = [
    { value: 12, label: 'Full', title: 'Full row' },
    { value: 6, label: '½', title: 'Half row' },
    { value: 4, label: '⅓', title: 'Third of a row' },
  ];

  setSpan(boxId: string, name: string, span: 4 | 6 | 12): void {
    this.patchWizard((body) => {
      const field = body.pages.flatMap((page) => page.boxes).find((box) => box.id === boxId)?.fields.find((item) => item.fieldName === name);
      if (field) field.span = span;
    });
  }

  moveField(boxId: string, name: string, direction: -1 | 1): void {
    this.patchWizard((body) => {
      const box = body.pages.flatMap((page) => page.boxes).find((item) => item.id === boxId);
      if (!box) return;
      const index = box.fields.findIndex((field) => field.fieldName === name);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= box.fields.length) return;
      const current = box.fields[index];
      const next = box.fields[target];
      if (!current || !next) return;
      box.fields[index] = next;
      box.fields[target] = current;
    });
  }

  removeField(boxId: string, name: string): void {
    const label = this.fieldOf(name)?.label || name;
    this.confirmDialog.set({
      title: `Remove “${label}”?`,
      message: 'The field is taken out of this block. You can add it again later from the field list.',
      confirmLabel: 'Remove field',
      danger: true,
      action: () => {
        this.patchWizard((body) => {
          const box = body.pages.flatMap((page) => page.boxes).find((item) => item.id === boxId);
          if (box) box.fields = box.fields.filter((field) => field.fieldName !== name);
        });
        if (this.selectedFieldName() === name) this.selectedFieldName.set(null);
      },
    });
  }

  existingNames(): string {
    return this.existingForMetadata().map((item) => item.name).join(', ');
  }

  draftLabel(kind: PageKind): string {
    if (kind === 'list') return 'List';
    if (kind === 'view') return 'View';
    return 'Edit';
  }

  toggleDraft(kind: PageKind): void {
    this.drafts.update((drafts) => drafts.map((draft) => (draft.kind === kind ? { ...draft, enabled: !draft.enabled } : draft)));
  }

  renameDraft(kind: PageKind, event: Event): void {
    const name = (event.target as HTMLInputElement).value;
    this.drafts.update((drafts) => drafts.map((draft) => (draft.kind === kind ? { ...draft, name } : draft)));
  }

  createDrafts(): void {
    const metadataName = this.metadataName();
    if (!metadataName || !this.canCreate()) return;
    const fields = this.fields();
    const metadata = this.metadataOptions().find((item) => item.table_name === metadataName);
    const created: LayoutDocument[] = [];
    for (const draft of this.drafts()) {
      if (!draft.enabled) continue;
      created.push({
        id: crypto.randomUUID(),
        name: draft.name.trim() || `${metadataName} ${draft.kind === 'list' ? 'list' : draft.kind}`,
        metadataName,
        metadataUuid: metadata?.uuid ?? '',
        pageType: draft.kind,
        updatedAt: new Date().toISOString(),
        body: seedBody(draft.kind, fields),
      });
    }
    void this.persist(created);
  }

  /** When the stored layout was last saved. */
  readonly updatedAt = computed(() => {
    const id = this.id();
    return id ? (this.store.all().find((item) => item.id === id)?.updatedAt ?? '') : '';
  });

  /** True when the editor differs from the saved layout (or the layout was never saved). */
  readonly dirty = computed(() => {
    const id = this.id();
    const stored = id ? this.store.all().find((item) => item.id === id) : undefined;
    if (!stored) return true;
    const snapshot = (doc: { name: string; pageType: string; metadataName: string; body: unknown }) =>
      JSON.stringify([doc.name, doc.pageType, doc.metadataName, doc.body]);
    return (
      snapshot(stored) !==
      snapshot({ name: this.name().trim() || stored.name, pageType: this.pageType(), metadataName: this.metadataName(), body: this.body() })
    );
  });

  @HostListener('document:keydown', ['$event'])
  saveShortcut(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
    event.preventDefault();
    if (this.id() && this.dirty()) this.save();
  }

  save(): void {
    const metadataName = this.metadataName();
    if (!metadataName || this.saving()) return;
    void this.persist([this.currentDocument()]);
  }

  async updateViews(): Promise<void> {
    const body = this.body();
    const views = this.viewTargets();
    if (body.kind !== 'wizard' || views.length === 0 || this.saving()) return;
    this.saving.set(true);
    this.loadError.set('');
    this.saved.set(false);
    this.viewNotice.set('');
    try {
      await this.store.save(this.currentDocument());
      const arrangement = structuredClone(body);
      for (const view of views) {
        await this.store.save({
          ...view,
          updatedAt: new Date().toISOString(),
          body: structuredClone(arrangement),
        });
      }
      this.viewNotice.set(views.length === 1 ? 'View updated.' : 'Views updated.');
    } catch {
      this.loadError.set("Can't update the view.");
    } finally {
      this.saving.set(false);
    }
  }

  private currentDocument(): LayoutDocument {
    const metadataName = this.metadataName();
    const metadata = this.metadataOptions().find((item) => item.table_name === metadataName);
    return {
      id: this.id() || crypto.randomUUID(),
      name: this.name().trim() || `${metadataName} ${this.pageType()}`,
      metadataName,
      metadataUuid: metadata?.uuid ?? '',
      pageType: this.pageType(),
      updatedAt: new Date().toISOString(),
      body: this.body(),
    };
  }

  private async persist(documents: LayoutDocument[]): Promise<void> {
    this.loadError.set('');
    this.saving.set(true);
    try {
      const saved: LayoutDocument[] = [];
      for (const document of documents) saved.push(await this.store.save(document));
      const target = saved.find((item) => item.pageType === 'list') ?? saved[0];
      if (!target) return;
      this.saved.set(true);
      this.boundRoute.set(target.id);
      if (this.embedded()) return;
      if (documents.length > 1) {
        void this.router.navigate(['/layouts']);
        return;
      }
      void this.router.navigate(['/layouts', target.id], { replaceUrl: true });
    } catch {
      this.loadError.set("Can't save the layout.");
    } finally {
      this.saving.set(false);
    }
  }

  private hydrate(layout: LayoutDocument): void {
    this.name.set(layout.name);
    this.pageType.set(layout.pageType);
    this.metadataName.set(layout.metadataName);
    this.body.set(structuredClone(layout.body));
    this.pendingSeed.set(false);
    if (layout.body.kind === 'wizard') {
      this.selectedPageId.set(layout.body.pages[0]?.id ?? null);
      this.selectedBoxId.set(layout.body.pages[0]?.boxes[0]?.id ?? null);
    }
  }

  private patchList(mutator: (body: ListLayoutBody) => void): void {
    this.body.update((body) => {
      if (body.kind !== 'list') return body;
      const next = structuredClone(body);
      mutator(next);
      return next;
    });
    this.saved.set(false);
    this.viewNotice.set('');
  }

  private patchFilter(id: string, patch: Partial<CustomFilter>): void {
    this.patchList((body) => {
      const filter = (body.filters ?? []).find((item) => item.id === id);
      if (!filter) return;
      Object.assign(filter, patch);
    });
  }

  private patchCondition(filterId: string, conditionId: string, patch: Partial<ColumnCondition>): void {
    this.patchList((body) => {
      const filter = (body.filters ?? []).find((item) => item.id === filterId);
      const condition = filter?.conditions.find((item) => item.id === conditionId);
      if (!condition) return;
      Object.assign(condition, patch);
    });
  }

  private patchWizard(mutator: (body: WizardLayoutBody) => void): void {
    this.body.update((body) => {
      if (body.kind !== 'wizard') return body;
      const next = structuredClone(body);
      mutator(next);
      return next;
    });
    this.saved.set(false);
    this.viewNotice.set('');
  }
}

function emptyCondition(): ColumnCondition {
  return { id: crypto.randomUUID(), fieldName: '', suffix: '', source: 'dynamic', value: '' };
}

function emptyFilter(): CustomFilter {
  return {
    id: crypto.randomUUID(),
    label: '',
    type: 'string',
    mode: 'columns',
    conditions: [emptyCondition()],
    name: '',
    suffix: '',
  };
}

function freshDrafts(table: string, only?: PageKind): LayoutDraft[] {
  const kinds: PageKind[] = ['list', 'edit', 'view'];
  return kinds.map((kind) => ({
    kind,
    enabled: only ? kind === only : true,
    name: table ? `${table} ${kind === 'list' ? 'list' : kind}` : '',
  }));
}
