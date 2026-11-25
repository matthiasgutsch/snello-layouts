import { NgComponentOutlet, NgTemplateOutlet } from '@angular/common';
import { HttpClient, httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, HostListener, inject, input, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, ParamMap, Router, RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { logicalFieldType, staticOptions } from '../core/field-types';
import { customFilterFields, filterFormFields, wizardFields } from '../core/layout-formly';
import {
  coerceModel,
  customFilterKey,
  customFilterParams,
  customFilterText,
  filterParams,
  orderedColumns,
  modelFieldNames,
  placementNames,
  searchFieldsForList,
  serializeModel,
} from '../core/layout-shape';
import { FieldDefinition, Metadata } from '../core/models';
import { LayoutStore } from '../core/layout-store';
import { MetadataCatalog } from '../core/metadata-catalog';
import { SnelloApi, dataFields, joinKeyName, joinLabelName, joinSelect } from '../core/snello-api';
import { ApiPanelState } from '../core/api-panel-state';
import { ToastService } from '../core/toast';
import { humanLabel, isUuid, relationMark, rowsOf, splitCsv } from '../formly/kit';
import { FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { ButtonDirective } from '@openng/optimus-ui/button';
import { CheckboxModule } from '@openng/optimus-ui/checkbox';
import { SelectButton } from '@openng/optimus-ui/selectbutton';
import { FormlyModule } from '@ngx-formly/core';
import { Paginator, PaginatorState } from '@openng/optimus-ui/paginator';
import { ListValue, linkedLabelKey } from './list-value';
import { Icon } from '../icon';
import { MetaIcon } from '../meta-icon';
import { PageBar } from '../page-bar';

const MENU_FIELD = new Set(['select', 'multiselect', 'join', 'lookup', 'multijoin', 'multilookup']);
const LINKED = new Set(['join', 'lookup', 'multijoin', 'multilookup', 'select', 'multiselect']);
const COLUMN_KEY = 'snello.list.columns.';
const PAGE_SIZES = [10, 20, 50];
const listRevision = signal(0);

interface LabelBatch {
  table: string;
  key: string;
  select: string;
  labelNames: string[];
  ids: string[];
}

interface DockWindow {
  key: string;
  mode: 'view' | 'edit';
  record: string;
  minimized: boolean;
}

@Component({
  selector: 'app-layout-play',
  imports: [ButtonDirective, SelectButton, NgTemplateOutlet, RouterLink, FormsModule, ReactiveFormsModule, FormlyModule, CheckboxModule, Icon, MetaIcon, PageBar, Paginator, ListValue, NgComponentOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './layout-play.component.html',
  host: {
    '[class.play-embedded]': 'embedded()',
    '[class.with-dock]': 'minimizedWindows().length > 0',
  },
})
export class LayoutPlayComponent {
  private readonly api = inject(SnelloApi);
  private readonly http = inject(HttpClient);
  private readonly store = inject(LayoutStore);
  readonly metadatas = inject(MetadataCatalog);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly query = toSignal(this.route.queryParamMap);
  readonly id = input.required<string>();
  readonly embedded = input(false);
  readonly rowKey = input('');
  readonly onRecordKey = input<((id: string) => void) | undefined>(undefined);
  readonly onClosed = input<(() => void) | undefined>(undefined);
  readonly entryOutlet = LayoutPlayComponent;
  readonly layout = computed(() => this.store.find(this.id()));
  readonly layoutsReady = this.store.ready;
  readonly layoutsError = this.store.error;
  readonly filtersOpen = signal(false);
  readonly columnsOpen = signal(false);
  readonly chosenFields = signal<string[] | null>(null);
  readonly appliedFilters = signal<{ name: string; label: string; value: string }[]>([]);
  readonly filterModel: Record<string, unknown> = {};
  readonly step = signal(0);
  readonly pageStart = signal(listPageStart(this.route.snapshot.queryParamMap));
  readonly pageSize = signal(listPageSize(this.route.snapshot.queryParamMap));
  readonly pageSizes = PAGE_SIZES;
  readonly total = signal(0);
  readonly sortField = signal<string | null>(null);
  readonly sortDir = signal<'asc' | 'desc'>('asc');
  readonly recordKey = signal('');
  readonly filterParams = signal<Record<string, string>>({});
  private readonly appliedValue = signal<Record<string, unknown>>({});
  readonly result = signal<Record<string, unknown> | null>(null);
  readonly saving = signal(false);
  readonly saved = signal(false);
  readonly saveError = signal('');
  readonly deleteAsk = signal(false);
  readonly linkedLabels = signal<Record<string, string>>({});
  readonly labelsLoading = signal(false);
  private labelTicket = 0;
  readonly formTick = signal(0);
  readonly model: Record<string, unknown> = {};
  readonly filterForm = computed(() => {
    this.formTick();
    return new FormGroup({});
  });
  readonly entryForm = computed(() => {
    this.formTick();
    return new FormGroup({});
  });

  readonly fieldResource = httpResource<FieldDefinition[]>(() => {
    const name = this.layout()?.metadataName;
    return name ? this.api.fieldsRequest(name) : undefined;
  }, {
    defaultValue: [],
    parse: dataFields,
  });

  readonly definitions = computed(() => {
    const status = this.fieldResource.status();
    if (status !== 'resolved' && status !== 'local') return [];
    return this.fieldResource.value();
  });

  readonly metadataResource = httpResource<Metadata | null>(() => {
    const name = this.layout()?.metadataName;
    return name ? this.api.metadataRequest(name) : undefined;
  }, {
    defaultValue: null,
    parse: (value) => (Array.isArray(value) ? ((value[0] as Metadata | undefined) ?? null) : null),
  });

  readonly columnChoices = computed(() => {
    const layout = this.layout();
    if (!layout || layout.body.kind !== 'list') return [];
    return orderedColumns(layout.body);
  });

  readonly columns = computed(() => {
    const choices = this.columnChoices();
    const chosen = this.chosenFields();
    if (!chosen) return choices.filter((column) => column.visible);
    const allowed = new Set(chosen);
    return choices.filter((column) => allowed.has(column.fieldName));
  });

  readonly createLayout = computed(() => this.operations().find((item) => item.pageType === 'edit') ?? null);
  readonly windows = signal<DockWindow[]>([]);
  private windowsList = '';
  readonly activeKey = signal('');
  readonly minimizedWindows = computed(() => this.windows().filter((win) => win.minimized));
  readonly openWindows = computed(() => this.windows().filter((win) => !win.minimized));

  readonly operations = computed(() => {
    const layout = this.layout();
    if (!layout || layout.pageType !== 'list') return [];
    const rank = (kind: string) => (kind === 'edit' ? 0 : 1);
    return this.store.all()
      .filter((item) => item.metadataName === layout.metadataName && item.id !== layout.id && (item.pageType === 'edit' || item.pageType === 'view'))
      .sort((left, right) => rank(left.pageType) - rank(right.pageType) || left.name.localeCompare(right.name, 'it'));
  });

  readonly customFilters = computed(() => {
    const layout = this.layout();
    if (!layout || layout.body.kind !== 'list') return [];
    return layout.body.filters ?? [];
  });

  readonly searchDefinitions = computed(() => {
    const layout = this.layout();
    if (!layout || layout.body.kind !== 'list') return [];
    const enabled = new Set(this.columns().map((column) => column.fieldName));
    return searchFieldsForList(layout.body, this.definitions()).filter((field) => enabled.has(searchColumn(field.name ?? '')));
  });

  readonly filterFields = computed(() => [...filterFormFields(this.searchDefinitions()), ...customFilterFields(this.customFilters())]);

  readonly entryFields = computed(() => {
    const layout = this.layout();
    if (!layout || layout.body.kind !== 'wizard') return [];
    return wizardFields(layout.body, this.definitions(), this.step(), layout.pageType === 'view' ? 'view' : 'edit', {
      tableName: layout.metadataName,
      recordKey: this.recordKey(),
    });
  });

  readonly pageCount = computed(() => {
    const layout = this.layout();
    return layout?.body.kind === 'wizard' ? layout.body.pages.length : 0;
  });

  readonly pageTitles = computed(() => {
    const layout = this.layout();
    return layout?.body.kind === 'wizard' ? layout.body.pages.map((page, index) => page.title || `Step ${index + 1}`) : [];
  });

  readonly pageTitle = computed(() => {
    const layout = this.layout();
    if (!layout || layout.body.kind !== 'wizard') return '';
    return layout.body.pages[this.step()]?.title ?? '';
  });

  readonly rows = httpResource<Record<string, unknown>[]>(() => {
    listRevision();
    const layout = this.layout();
    if (!layout || layout.body.kind !== 'list') return undefined;
    const params: Record<string, string | number | boolean> = {
      _start: this.pageStart(),
      _limit: this.pageSize(),
      ...this.filterParams(),
    };
    const sort = this.sortField();
    if (sort) params['_sort'] = `${sort}:${this.sortDir()}`;
    // ask for the columns the list shows: without select_fields snello answers only the table's own list columns
    // (metadata select_fields), and every other column of the layout stays "—"
    const shown = this.columns().map((column) => column.fieldName).filter((name) => !!name);
    if (shown.length) params['select_fields'] = [...new Set(['uuid', ...shown])].join(',');
    return this.api.recordsRequest(layout.metadataName, params);
  }, {
    defaultValue: [],
    parse: (value) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : []),
  });

  readonly labelBatches = computed((): LabelBatch[] => {
    const status = this.rows.status();
    if (status !== 'resolved' && status !== 'local' && status !== 'reloading') return [];
    const rows = this.rows.value();
    const groups = new Map<string, LabelBatch>();
    for (const column of this.columns()) {
      const field = this.definitions().find((item) => item.name === column.fieldName);
      if (!field?.name || !field.join_table_name) continue;
      if (!LINKED.has(logicalFieldType(field))) continue;
      const key = joinKeyName(field);
      const groupKey = `${field.join_table_name}:${key}`;
      let group = groups.get(groupKey);
      if (!group) {
        group = { table: field.join_table_name, key, select: '', labelNames: [], ids: [] };
        groups.set(groupKey, group);
      }
      const label = joinLabelName(field);
      if (!group.labelNames.includes(label)) group.labelNames.push(label);
      const select = new Set(group.select.split(',').map((part) => part.trim()).filter((part) => part.length > 0));
      for (const part of joinSelect(field).split(',')) {
        const name = part.trim();
        if (name) select.add(name);
      }
      group.select = [...select].join(',');
      for (const row of rows) {
        for (const id of splitCsv(row[field.name])) group.ids.push(id);
      }
    }
    return [...groups.values()]
      .map((group) => ({ ...group, ids: [...new Set(group.ids)] }))
      .filter((group) => group.ids.length > 0);
  });

  readonly record = httpResource<Record<string, unknown> | null>(() => {
    const layout = this.layout();
    const key = this.recordKey();
    if (!layout || layout.pageType === 'list' || !key) return undefined;
    return this.api.recordRequest(layout.metadataName, key);
  }, {
    defaultValue: null,
    parse: (value) => (value && typeof value === 'object' ? (value as Record<string, unknown>) : null),
  });

  readonly resultText = computed(() => JSON.stringify(this.result(), null, 2));

  constructor() {
    if (!this.embedded() && !this.route.snapshot.queryParamMap.has('view') && this.router.url.startsWith('/data/')) {
      void this.router.navigate([], { queryParams: { view: this.storedView }, queryParamsHandling: 'merge', replaceUrl: true });
    }
    effect(() => {
      if (this.embedded()) return;
      const layout = this.layout();
      if (!layout || layout.pageType === 'list') return;
      const list = this.store.all().find((item) => item.metadataName === layout.metadataName && item.pageType === 'list');
      if (!list) return;
      const record = this.query()?.get('record') ?? '';
      const queryParams = layout.pageType === 'view'
        ? { viewId: record || null, modId: null, side: null, row: null, record: null }
        : { modId: record, viewId: null, side: null, row: null, record: null };
      untracked(() => {
        void this.router.navigate([this.openedAt(), list.id], {
          queryParams,
          replaceUrl: true,
        });
      });
    });

    effect(() => {
      const id = this.id();
      const record = this.embedded() ? this.rowKey() : this.routeRecord();
      untracked(() => {
        if (this.saved() && record === this.recordKey()) return;
        const listId = !this.embedded() && this.layout()?.pageType === 'list' ? id : '';
        if (listId !== this.windowsList) {
          this.windowsList = listId;
          if (listId) {
            this.windows.set([]);
            this.activeKey.set('');
          }
        }
        this.step.set(0);
        this.total.set(0);
        this.sortField.set(null);
        this.sortDir.set('asc');
        this.chosenFields.set(readListColumns(id));
        this.columnsOpen.set(false);
        this.appliedValue.set({});
        this.filterParams.set({});
        this.appliedFilters.set([]);
        this.filtersOpen.set(false);
        this.clearFilterModel();
        this.recordKey.set(record);
        this.result.set(null);
        this.saved.set(false);
        this.saveError.set('');
        this.deleteAsk.set(false);
        this.replaceModel({});
        this.formTick.update((value) => value + 1);
      });
    });

    effect(() => {
      const key = this.recordKey();
      const status = this.record.status();
      const data = status === 'resolved' || status === 'local' ? this.record.value() : null;
      const layout = this.layout();
      const fieldsReady = this.fieldResource.status() === 'resolved' || this.fieldResource.status() === 'local';
      if (!key || !data || !layout || layout.body.kind !== 'wizard') return;
      const fields = fieldsReady ? this.fieldResource.value() : [];
      untracked(() => {
        this.replaceModel(coerceModel(data, fields, modelFieldNames(layout.body)));
        this.result.set(null);
        this.formTick.update((value) => value + 1);
      });
    });

    effect(() => {
      if (this.embedded() || this.layout()?.pageType !== 'list') return;
      const fields = this.searchDefinitions();
      const customs = this.customFilters();
      untracked(() => {
        const value = this.appliedValue();
        const params = { ...filterParams(fields, value), ...customFilterParams(customs, value) };
        if (sameParams(this.filterParams(), params)) return;
        this.filterParams.set(params);
        void this.publishFilters(value);
      });
    });

    effect(() => {
      if (this.embedded() || this.layout()?.pageType !== 'list') return;
      const params = this.query();
      const size = listPageSize(params);
      const start = listPageStart(params);
      untracked(() => {
        if (this.pageSize() !== size) this.pageSize.set(size);
        if (this.pageStart() !== start) this.pageStart.set(start);
      });
    });

    effect(() => {
      const status = this.rows.status();
      if (status !== 'resolved' && status !== 'local' && status !== 'reloading') return;
      const raw = this.rows.headers()?.get('x-total-count');
      if (raw == null || raw === '') return;
      const count = Number(raw);
      if (Number.isFinite(count)) this.total.set(count);
    });

    effect(() => {
      const batches = this.labelBatches();
      const ticket = ++this.labelTicket;
      if (batches.length === 0) {
        untracked(() => {
          this.linkedLabels.set({});
          this.labelsLoading.set(false);
        });
        return;
      }
      untracked(() => {
        this.linkedLabels.set({});
        this.labelsLoading.set(true);
      });
      void this.loadLabels(batches, ticket);
    });

    effect(() => {
      if (this.embedded() || this.layout()?.pageType !== 'list') return;
      const params = this.query();
      const viewId = params?.get('viewId') ?? '';
      const hasMod = params?.has('modId') ?? false;
      if (!viewId && !hasMod) return;
      const modId = params?.get('modId') ?? '';
      untracked(() => this.consumeRouteWindow(viewId, hasMod, modId));
    });

    effect(() => {
      if (this.embedded() || this.layout()?.pageType !== 'list') return;
      const params = this.query();
      const id = params?.get('id') ?? '';
      const mode = params?.get('mode') === 'edit' ? 'edit' : 'view';
      if (!id && !(params?.get('mode') === 'edit')) return;
      untracked(() => {
        const open = this.windows().some((win) => win.mode === mode && win.record === id);
        if (!open) this.openWindow(mode, id);
      });
    });

    effect(() => {
      if (this.embedded() || this.layout()?.pageType !== 'list') return;
      const list = this.windows().filter((win) => !win.minimized);
      const active = list.find((win) => win.key === this.activeKey()) ?? list.at(-1);
      untracked(() => {
        const params = this.query();
        const id = active?.record || null;
        const mode = active ? active.mode : null;
        if ((params?.get('id') ?? null) === id && (params?.get('mode') ?? null) === mode) return;
        void this.router.navigate([], {
          queryParams: { id, mode },
          queryParamsHandling: 'merge',
          replaceUrl: !active || (params?.get('id') ?? '') === '',
        });
      });
    });
  }

  private readonly storedView: 'list' | 'split' = localStorage.getItem('data-view') === 'split' ? 'split' : 'list';
  readonly view = computed<'list' | 'split'>(() => {
    if (this.embedded()) return 'list';
    const value = this.query()?.get('view');
    return value === 'split' || value === 'list' ? value : this.storedView;
  });
  readonly viewOptions = [
    { label: 'List', value: 'list', icon: 'list' },
    { label: 'Split', value: 'split', icon: 'columns' },
  ];

  setView(view: 'list' | 'split' | null): void {
    if (!view) return;
    localStorage.setItem('data-view', view);
    void this.router.navigate([], { queryParams: { view }, queryParamsHandling: 'merge' });
  }

  /** Width of the docked record pane in split view; null keeps the default 2/3. */
  readonly dockWidth = signal<number | null>(Number(localStorage.getItem('data-dock-width')) || null);

  private clampDock(width: number, split: HTMLElement): number {
    return Math.round(Math.min(split.getBoundingClientRect().width - 240, Math.max(320, width)));
  }

  private saveDock(): void {
    const width = this.dockWidth();
    if (width) localStorage.setItem('data-dock-width', String(width));
    else localStorage.removeItem('data-dock-width');
  }

  startDockResize(event: PointerEvent, split: HTMLElement): void {
    event.preventDefault();
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const right = split.getBoundingClientRect().right;
    const move = (moveEvent: PointerEvent) => this.dockWidth.set(this.clampDock(right - moveEvent.clientX, split));
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
      this.saveDock();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  dockResizeKey(event: KeyboardEvent, split: HTMLElement): void {
    const step = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
    if (!step) return;
    event.preventDefault();
    const current = this.dockWidth() ?? (split.getBoundingClientRect().width * 2) / 3;
    this.dockWidth.set(this.clampDock(current + step, split));
    this.saveDock();
  }

  resetDock(): void {
    this.dockWidth.set(null);
    this.saveDock();
  }

  /** What a record card shows: an image, a title column and a few more columns. */
  readonly cardParts = computed(() => {
    const names = this.columns().map((column) => column.fieldName);
    const image = names.find((name) => this.isImage(name)) ?? null;
    const plain = names.filter((name) => !this.isImage(name) && !this.isRelation(name));
    return { image, title: plain[0] ?? '', meta: plain.slice(1, 2) };
  });

  isSelected(row: Record<string, unknown>): boolean {
    const id = this.recordId(row);
    return this.view() === 'split' && this.windows().some((win) => win.record === id);
  }

  /** In the split view a row click shows the record in the docked pane. */
  selectRow(row: Record<string, unknown>): void {
    if (this.view() !== 'split') return;
    const modes = this.operations().map((operation) => operation.pageType);
    const mode = modes.includes('edit') ? 'edit' : modes.includes('view') ? 'view' : '';
    if (mode) this.openWindow(mode, this.recordId(row));
  }

  openWindow(mode: string, record: string): void {
    if (mode !== 'view' && mode !== 'edit') return;
    const same = this.windows().find((win) => win.mode === mode && win.record === record);
    if (same) {
      this.restore(same.key);
      return;
    }
    const key = crypto.randomUUID();
    if (this.view() === 'split') this.windows.set([]);
    this.windows.update((list) => [...list, { key, mode, record, minimized: false }]);
    this.activeKey.set(key);
  }

  windowLayout(win: DockWindow) {
    return this.operations().find((item) => item.pageType === win.mode) ?? null;
  }

  windowTitle(win: DockWindow): string {
    if (!win.record) return 'new';
    return win.record;
  }

  windowInputs(win: DockWindow): Record<string, unknown> {
    return {
      id: this.windowLayout(win)?.id ?? '',
      embedded: true,
      rowKey: win.record,
      onRecordKey: (id: string) => this.retargetWindow(win.key, id),
      onClosed: () => this.closeWindow(win.key),
    };
  }

  focusWindow(key: string): void {
    this.activeKey.set(key);
  }

  minimize(key: string): void {
    this.windows.update((list) => list.map((win) => (win.key === key ? { ...win, minimized: true } : win)));
  }

  restore(key: string): void {
    this.windows.update((list) => list.map((win) => (win.key === key ? { ...win, minimized: false } : win)));
    this.activeKey.set(key);
    queueMicrotask(() => window.dispatchEvent(new Event('resize')));
  }

  closeWindow(key: string): void {
    this.windows.update((list) => list.filter((win) => win.key !== key));
    if (this.activeKey() === key) this.activeKey.set(this.openWindows().at(-1)?.key ?? '');
  }

  @HostListener('document:keydown.escape')
  closeSideOnEscape(): void {
    if (this.embedded()) return;
    const open = this.openWindows();
    const active = open.find((win) => win.key === this.activeKey()) ?? open.at(-1);
    if (active) this.closeWindow(active.key);
  }

  applyFilters(): void {
    const value = this.filterForm().getRawValue() as Record<string, unknown>;
    this.writeFilterModel(value);
    this.appliedValue.set(value);
    this.filterParams.set(this.currentParams(value));
    this.filtersOpen.set(false);
    this.publishPage(0);
    void this.publishFilters(value);
  }

  clearFilters(): void {
    const form = this.filterForm();
    for (const key of Object.keys(this.filterModel)) this.filterModel[key] = null;
    for (const name of Object.keys(form.controls)) form.get(name)?.reset(null);
    this.clearFilterModel();
    this.appliedValue.set({});
    this.filterParams.set({});
    this.appliedFilters.set([]);
    this.publishPage(0);
  }

  private async publishFilters(value: Record<string, unknown>): Promise<void> {
    const chips = await this.chips(value);
    this.appliedFilters.set(chips);
  }

  private chipLabel(field: FieldDefinition): string {
    const label = field.label || field.name || '';
    const logical = logicalFieldType(field);
    const dated = logical === 'date' || logical === 'datetime' || logical === 'time';
    if (!dated) return label;
    if (field.search_condition === 'gte') return `${label} ≥`;
    if (field.search_condition === 'lte') return `${label} ≤`;
    return label;
  }

  private async chips(value: Record<string, unknown>): Promise<{ name: string; label: string; value: string }[]> {
    const chips: { name: string; label: string; value: string }[] = [];
    for (const field of this.searchDefinitions()) {
      const name = field.name;
      if (!name) continue;
      const raw = value[name];
      if (field.search_condition === 'boolean') {
        if (raw == null || raw === '') continue;
        const on = raw === true || raw === 1 || raw === '1' || raw === 'true';
        const off = raw === false || raw === 0 || raw === '0' || raw === 'false';
        if (!on && !off) continue;
        chips.push({ name, label: field.label || name, value: on ? 'yes' : 'no' });
        continue;
      }
      if (raw == null || raw === '' || raw === false) continue;
      const text = await this.readableValue(field, raw);
      if (!text) continue;
      chips.push({ name, label: this.chipLabel(field), value: text });
    }
    for (const filter of this.customFilters()) {
      const text = customFilterText(filter, value[customFilterKey(filter)]);
      if (!text) continue;
      chips.push({ name: customFilterKey(filter), label: filter.label || filter.name || 'Filter', value: text });
    }
    return chips;
  }

  private currentParams(value: Record<string, unknown>): Record<string, string> {
    return { ...filterParams(this.searchDefinitions(), value), ...customFilterParams(this.customFilters(), value) };
  }

  private async readableValue(field: FieldDefinition, raw: unknown): Promise<string> {
    const logical = logicalFieldType(field);
    const visible = this.visibleChoice(field.name ?? '');
    const stored = Array.isArray(raw) ? raw.map((item) => String(item)).join(', ') : String(raw);
    if ((logical === 'select' || logical === 'multiselect') && visible && !visible.split(',').every((item) => isUuid(item.trim()))) return visible;
    if (logical === 'realtionships') return this.relationshipText(raw);
    if (visible && visible !== stored && visible !== 'No value') return visible;
    if (MENU_FIELD.has(logical)) {
      const labels = await this.choiceLabels(field, raw);
      if (labels) return labels;
    }
    if (raw === true) return 'yes';
    if (Array.isArray(raw)) return raw.map((item) => String(item)).filter((item) => item.length > 0).join(', ');
    return stored;
  }

  private visibleChoice(name: string): string {
    const root = document.querySelector('formly-form.filter-grid');
    const control = root?.querySelector(`[id*="_${CSS.escape(name)}_"]`);
    if (control instanceof HTMLSelectElement) {
      return [...control.selectedOptions]
        .map((option) => option.text.trim())
        .filter((text) => text.length > 0 && text !== '—')
        .join(', ');
    }
    if (control instanceof HTMLInputElement) return control.value.trim();
    const text = control?.closest('formly-field')?.querySelector('p.readonly')?.textContent?.trim() ?? '';
    return text === 'No value' || text === '—' ? '' : text;
  }

  private async relationshipText(raw: unknown): Promise<string> {
    const labels: string[] = [];
    for (const token of splitCsv(raw)) {
      const [table, id] = token.split(':');
      if (!table) continue;
      const metadata = this.metadatas.find(table);
      const title = metadata?.description || table;
      if (!id) {
        labels.push(title);
        continue;
      }
      try {
        const row = await firstValueFrom(
          this.http.get<Record<string, unknown>>(`${this.api.records}/${encodeURIComponent(table)}/${encodeURIComponent(id)}`),
        );
        const text = humanLabel(row, [metadata?.table_key_addition ?? '']);
        labels.push(text ? `${title}: ${text}` : title);
      } catch {
        labels.push(title);
      }
    }
    return labels.join(', ');
  }

  private async choiceLabels(field: FieldDefinition, raw: unknown): Promise<string> {
    const ids = splitCsv(raw);
    if (ids.length === 0) return '';
    if (!field.join_table_name) {
      const labels = new Map(staticOptions(field).map((option) => [option.value, option.label]));
      return ids.map((id) => labels.get(id) ?? id).join(', ');
    }
    const request = this.api.recordsByKeys(field.join_table_name, joinKeyName(field), ids, joinSelect(field));
    if (!request) return '';
    try {
      const params: Record<string, string> = {};
      for (const [key, value] of Object.entries(request.params ?? {})) params[key] = String(value);
      const rows = rowsOf(await firstValueFrom(this.http.get(request.url, { params })));
      const key = joinKeyName(field);
      const label = joinLabelName(field);
      const found = new Map(rows.map((row) => [String(row[key] ?? ''), humanLabel(row, [label])]));
      return ids.map((id) => found.get(id) || '').filter((item) => item.length > 0).join(', ');
    } catch {
      return '';
    }
  }

  private writeFilterModel(value: Record<string, unknown>): void {
    this.clearFilterModel();
    Object.assign(this.filterModel, value);
  }

  private clearFilterModel(): void {
    for (const key of Object.keys(this.filterModel)) delete this.filterModel[key];
  }

  readonly menuRow = signal('');

  toggleRowMenu(event: Event, row: Record<string, unknown>): void {
    event.stopPropagation();
    const id = this.recordId(row);
    this.menuRow.set(this.menuRow() === id ? '' : id);
  }

  async duplicateRow(row: Record<string, unknown>): Promise<void> {
    this.menuRow.set('');
    const key = this.currentMetadata()?.table_key || 'uuid';
    const copy: Record<string, unknown> = { ...row };
    delete copy[key];
    delete copy['uuid'];
    delete copy['creation_date'];
    try {
      await firstValueFrom(this.http.post(this.recordUrl(), copy));
      listRevision.update((value) => value + 1);
      this.toasts.show('Record duplicated.');
    } catch {
      this.toasts.show("Can't duplicate the record.");
    }
  }

  async deleteRow(row: Record<string, unknown>): Promise<void> {
    this.menuRow.set('');
    const id = this.recordId(row);
    if (!id || !window.confirm('Delete this record?')) return;
    try {
      await firstValueFrom(this.http.delete(this.recordUrl(id), { responseType: 'text' }));
      listRevision.update((value) => value + 1);
      this.windows.update((list) => list.filter((win) => win.record !== id));
      this.toasts.show('Record deleted.');
    } catch {
      this.toasts.show("Can't delete the record.");
    }
  }

  @HostListener('document:click', ['$event'])
  closeColumnPop(event: MouseEvent): void {
    this.menuRow.set('');
    const target = event.target;
    if (target instanceof Element && target.closest('.column-pop, .columns-toggle')) return;
    this.columnsOpen.set(false);
  }

  toggleColumns(): void {
    this.columnsOpen.update((open) => !open);
  }

  columnOn(name: string): boolean {
    const chosen = this.chosenFields();
    if (!chosen) return this.columnChoices().some((column) => column.fieldName === name && column.visible);
    return chosen.includes(name);
  }

  toggleColumn(name: string): void {
    const current = this.chosenFields() ?? this.columns().map((column) => column.fieldName);
    const next = current.includes(name) ? current.filter((item) => item !== name) : [...current, name];
    this.rememberColumns(next);
  }

  selectAllColumns(): void {
    this.rememberColumns(this.columnChoices().map((column) => column.fieldName));
  }

  clearColumns(): void {
    this.rememberColumns([]);
  }

  openedAt(): '/data' | '/play' {
    return this.router.url.split('?')[0].startsWith('/data') ? '/data' : '/play';
  }

  changePage(event: PaginatorState): void {
    const start = event.first ?? 0;
    const size = event.rows ?? this.pageSize();
    if (start === this.pageStart() && size === this.pageSize()) return;
    this.publishPage(start, size);
  }

  sortBy(name: string): void {
    if (this.sortField() === name) {
      this.sortDir.set(this.sortDir() === 'asc' ? 'desc' : 'asc');
    } else {
      this.sortField.set(name);
      this.sortDir.set('asc');
    }
    this.publishPage(0);
  }

  private publishPage(start: number, size = this.pageSize()): void {
    const safeSize = PAGE_SIZES.includes(size) ? size : 10;
    const page = Math.floor(Math.max(0, start) / safeSize) + 1;
    this.pageSize.set(safeSize);
    this.pageStart.set((page - 1) * safeSize);
    if (this.embedded() || this.layout()?.pageType !== 'list') return;
    const nextPage = page > 1 ? String(page) : null;
    const nextSize = safeSize === 10 ? null : String(safeSize);
    const params = this.query();
    if ((params?.get('page') ?? null) === nextPage && (params?.get('size') ?? null) === nextSize) return;
    void this.router.navigate([], {
      queryParams: { page: nextPage, size: nextSize },
      queryParamsHandling: 'merge',
    });
  }

  ariaSort(name: string): 'ascending' | 'descending' | 'none' {
    if (this.sortField() !== name) return 'none';
    return this.sortDir() === 'asc' ? 'ascending' : 'descending';
  }

  previousStep(): void {
    if (this.pageCount() <= 1 || this.step() === 0) return;
    this.step.update((value) => Math.max(0, value - 1));
  }

  /** Going back is free; going forward moves one validated step at a time. */
  goToStep(target: number): void {
    if (target < 0 || target >= this.pageCount()) return;
    if (target <= this.step()) {
      this.step.set(target);
      return;
    }
    while (this.step() < target) {
      const before = this.step();
      this.nextStep();
      if (this.step() === before) break;
    }
  }

  nextStep(): void {
    if (this.layout()?.pageType !== 'view' && !this.touchCurrent()) return;
    this.step.update((value) => Math.min(this.pageCount() - 1, value + 1));
  }

  showSource(): void {
    const layout = this.layout();
    if (!layout || layout.body.kind !== 'wizard' || this.openedAt() !== '/data') return;
    if (this.result()) {
      this.result.set(null);
      return;
    }
    if (layout.pageType !== 'view') this.touchAll();
    this.result.set(this.outgoingPayload());
    queueMicrotask(() => document.querySelector('.drawer pre.code, .wizard pre.code')?.scrollIntoView({ block: 'nearest' }));
  }

  cancelEdit(): void {
    const tell = this.onClosed();
    if (tell) tell();
  }

  askDelete(): void {
    this.deleteAsk.set(true);
  }

  cancelDelete(): void {
    this.deleteAsk.set(false);
  }

  private readonly toasts = inject(ToastService);
  private readonly apiPanel = inject(ApiPanelState);

  /** Opens the API reference on the call that lists these records, with the current paging, sort and filters. */
  openApi(): void {
    const layout = this.layout();
    if (!layout) return;
    const query: Record<string, string> = { _start: String(this.pageStart()), _limit: String(this.pageSize()) };
    for (const [name, value] of Object.entries(this.filterParams())) query[name] = String(value);
    const sort = this.sortField();
    if (sort) query['_sort'] = `${sort}:${this.sortDir()}`;
    this.apiPanel.show({ id: 'get /api/{table}', path: { table: layout.metadataName }, query });
  }

  async saveRecord(): Promise<void> {
    const layout = this.layout();
    if (!layout || layout.pageType !== 'edit' || this.openedAt() !== '/data' || this.saving()) return;
    this.saved.set(false);
    this.saveError.set('');
    if (!this.readyToSave()) {
      this.saveError.set('Fill in the required fields (highlighted) before saving.');
      return;
    }
    const id = this.recordKey();
    const payload = this.outgoingPayload();
    this.saving.set(true);
    try {
      const saved = id
        ? await firstValueFrom(this.http.put<Record<string, unknown>>(this.recordUrl(id), payload))
        : await firstValueFrom(this.http.post<Record<string, unknown>>(this.recordUrl(), payload));
      listRevision.update((value) => value + 1);
      this.saved.set(true);
      this.toasts.show(id ? 'Record updated.' : 'Record created.');
      const nextId = this.savedId(saved);
      if (!id && nextId) {
        this.recordKey.set(nextId);
        const tell = this.onRecordKey();
        if (tell) tell(nextId);
        else {
          void this.router.navigate([], {
            queryParams: { modId: nextId, viewId: null, side: null, row: null, record: null },
            queryParamsHandling: 'merge',
          });
        }
      } else if (id) {
        this.record.reload();
      }
    } catch {
      this.saveError.set("Can't save the record.");
    } finally {
      this.saving.set(false);
    }
  }

  async confirmDelete(): Promise<void> {
    const id = this.recordKey();
    if (!id || this.saving()) return;
    this.saving.set(true);
    this.saveError.set('');
    this.saved.set(false);
    try {
      await firstValueFrom(this.http.delete(this.recordUrl(id), { responseType: 'text' }));
      listRevision.update((value) => value + 1);
      this.toasts.show('Record deleted.');
      this.deleteAsk.set(false);
      const tell = this.onClosed();
      if (tell) tell();
      else {
        void this.router.navigate([], {
          queryParams: { viewId: null, modId: null, side: null, row: null, record: null },
          queryParamsHandling: 'merge',
        });
      }
    } catch {
      this.saveError.set("Can't delete the record.");
    } finally {
      this.saving.set(false);
    }
  }

  submit(): void {
    this.showSource();
  }

  fieldLabel(name: string): string {
    return this.definition(name)?.label || name;
  }

  definition(name: string): FieldDefinition | null {
    return this.definitions().find((field) => field.name === name) ?? null;
  }

  isImage(name: string): boolean {
    return this.logical(name) === 'image';
  }

  imageUrl(value: unknown): string | null {
    if (typeof value !== 'string' || value.trim().length < 8) return null;
    return this.api.documentUrl(value.trim());
  }

  isRelation(name: string): boolean {
    return this.logical(name) === 'realtionships';
  }

  relationMarks(value: unknown): { token: string; name: string; letter: string }[] {
    return splitCsv(value).map((token) => ({ token, ...relationMark(token) }));
  }

  private consumeRouteWindow(viewId: string, hasMod: boolean, modId: string): void {
    if (viewId) this.openWindow('view', viewId);
    if (hasMod) {
      if (!modId) this.openWindow('edit', '');
      else {
        const draft = this.windows().find((win) => win.mode === 'edit' && win.record === '');
        if (draft) this.retargetWindow(draft.key, modId);
        else this.openWindow('edit', modId);
      }
    }
    void this.router.navigate([], {
      queryParams: { viewId: null, modId: null, side: null, row: null, record: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private retargetWindow(key: string, record: string): void {
    this.windows.update((list) => list.map((win) => (win.key === key ? { ...win, record } : win)));
  }

  private routeRecord(): string {
    const layout = this.layout();
    if (!layout || layout.pageType === 'list') return '';
    return this.query()?.get('record') ?? '';
  }

  recordId(row: Record<string, unknown>): string {
    const metadata = this.currentMetadata();
    const key = metadata?.table_key || 'uuid';
    return String(row[key] ?? row['uuid'] ?? '');
  }

  operationIcon(kind: string): string {
    return kind === 'view' ? 'info' : 'pencil';
  }

  private async loadLabels(batches: LabelBatch[], ticket: number): Promise<void> {
    try {
      const parts = await Promise.all(batches.map((batch) => this.fetchLabels(batch)));
      if (ticket !== this.labelTicket) return;
      const labels: Record<string, string> = {};
      for (const part of parts) Object.assign(labels, part);
      this.linkedLabels.set(labels);
      this.labelsLoading.set(false);
    } catch {
      if (ticket !== this.labelTicket) return;
      this.labelsLoading.set(false);
    }
  }

  private async fetchLabels(batch: LabelBatch): Promise<Record<string, string>> {
    const request = this.api.recordsByKeys(batch.table, batch.key, batch.ids, batch.select);
    if (!request?.params) return {};
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.params)) params[key] = String(value);
    const rows = rowsOf(await firstValueFrom(this.http.get(request.url, { params })));
    const labels: Record<string, string> = {};
    for (const row of rows) {
      const id = String(row[batch.key] ?? '');
      if (!id) continue;
      for (const name of batch.labelNames) {
        const text = row[name];
        labels[linkedLabelKey(batch.table, name, id)] = text == null || text === '' ? '—' : String(text);
      }
    }
    return labels;
  }

  private logical(name: string): string {
    const field = this.definitions().find((item) => item.name === name);
    return field ? logicalFieldType(field) : '';
  }

  private rememberColumns(names: string[]): void {
    this.chosenFields.set(names);
    const id = this.layout()?.id;
    if (id) sessionStorage.setItem(`${COLUMN_KEY}${id}`, JSON.stringify(names));
  }

  private currentMetadata(): Metadata | null {
    const status = this.metadataResource.status();
    if (status !== 'resolved' && status !== 'local') return null;
    return this.metadataResource.value();
  }

  private readyToSave(): boolean {
    const layout = this.layout();
    if (!layout || layout.body.kind !== 'wizard') return false;
    this.touchAll();
    const form = this.entryForm();
    let invalidStep: number | null = form.invalid ? this.step() : null;
    for (let index = 0; index < layout.body.pages.length; index += 1) {
      const page = layout.body.pages[index];
      if (!page) continue;
      for (const box of page.boxes) {
        for (const field of box.fields) {
          if (!field.required) continue;
          const control = form.get(field.fieldName);
          const missing = control ? control.invalid : isEmptyRecordValue(this.model[field.fieldName]);
          if (missing && invalidStep == null) invalidStep = index;
        }
      }
    }
    if (invalidStep == null) return true;
    this.step.set(invalidStep);
    return false;
  }

  private recordUrl(id?: string): string {
    const table = encodeURIComponent(this.layout()?.metadataName ?? '');
    const base = `${this.api.records}/${table}`;
    return id ? `${base}/${encodeURIComponent(id)}` : base;
  }

  private savedId(saved: Record<string, unknown> | null | undefined): string {
    const key = this.currentMetadata()?.table_key || 'uuid';
    const value = saved?.[key] ?? saved?.['uuid'];
    return value == null || value === '' ? '' : String(value);
  }

  private touchCurrent(): boolean {
    return this.touch(this.currentNames());
  }

  private touchAll(): boolean {
    const layout = this.layout();
    if (!layout) return false;
    return this.touch(placementNames(layout.body));
  }

  private touch(names: string[]): boolean {
    const form = this.entryForm();
    let valid = true;
    for (const name of names) {
      const control = form.get(name);
      control?.markAsTouched();
      control?.updateValueAndValidity();
      if (control?.invalid) valid = false;
    }
    return valid;
  }

  private currentNames(): string[] {
    const layout = this.layout();
    if (!layout || layout.body.kind !== 'wizard') return [];
    const page = layout.body.pages[this.step()];
    return page ? page.boxes.flatMap((box) => box.fields.map((field) => field.fieldName)) : [];
  }

  private outgoingPayload(): Record<string, unknown> {
    const layout = this.layout();
    if (!layout || layout.body.kind !== 'wizard') return {};
    const edited = serializeModel(this.model, this.definitions(), placementNames(layout.body));
    for (const key of Object.keys(edited)) {
      if (edited[key] === undefined) edited[key] = null;
    }
    const stored = this.storedRecord();
    return stored ? { ...stored, ...edited } : edited;
  }

  private storedRecord(): Record<string, unknown> | null {
    if (!this.recordKey()) return null;
    const status = this.record.status();
    if (status !== 'resolved' && status !== 'local') return null;
    const value = this.record.value();
    return value && typeof value === 'object' ? value : null;
  }

  private replaceModel(next: Record<string, unknown>): void {
    for (const key of Object.keys(this.model)) delete this.model[key];
    Object.assign(this.model, next);
  }
}

function isEmptyRecordValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function listPageSize(params: ParamMap | null | undefined): number {
  const size = Number(params?.get('size'));
  return PAGE_SIZES.includes(size) ? size : 10;
}

function listPageStart(params: ParamMap | null | undefined): number {
  const page = Number(params?.get('page'));
  if (!Number.isFinite(page) || page < 2) return 0;
  return (Math.floor(page) - 1) * listPageSize(params);
}

function searchColumn(name: string): string {
  return name.replace(/__(min|max)$/, '');
}

function sameParams(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function readListColumns(id: string): string[] | null {
  const raw = sessionStorage.getItem(`${COLUMN_KEY}${id}`);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null;
  } catch {
    return null;
  }
}
