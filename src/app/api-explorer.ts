import { HttpClient, HttpErrorResponse, httpResource } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import Keycloak from 'keycloak-js';
import { ButtonDirective } from '@openng/optimus-ui/button';
import { ApiPanelState, ApiRequestPreset } from './core/api-panel-state';
import { logicalFieldType } from './core/field-types';
import { FieldDefinition } from './core/models';
import { SnelloApi, dataFields } from './core/snello-api';
import { ApiOperation, ApiParam, parseSpec } from './core/openapi';
import { QUERY_CONDITIONS } from './core/query-conditions';
import { RUNTIME_CONFIG } from './core/runtime-config';
import { ToastService } from './core/toast';
import { Icon } from './icon';

interface ApiResult {
  status: number;
  ok: boolean;
  ms: number;
  body: string;
}

/**
 * API reference built from the live OpenAPI document (`<api origin>/openapi`).
 * Lists every endpoint, shows parameters, a sample body and a ready-to-copy curl call,
 * and lets you try GET requests with your own login. Used by the /api page and the slide-over.
 */
@Component({
  selector: 'app-api-explorer',
  imports: [Icon, ButtonDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="api" [class.compact]="compact()" [class.show-detail]="view() === 'detail'">
      <nav class="api-nav" aria-label="Endpoints">
        <input class="api-search" type="search" placeholder="Search endpoints…" aria-label="Search endpoints" [value]="query()" (input)="query.set($any($event.target).value)" />
        <button type="button" class="api-item api-guide" [class.sel]="selectedId() === 'guide'" (click)="select('guide')">
          <app-icon name="book" /> Getting started
        </button>
        @if (spec.isLoading()) {
          <p class="muted api-note">Loading the API description…</p>
        }
        @if (spec.error()) {
          <p class="muted api-note">Could not read {{ origin }}/openapi.</p>
        }
        @for (group of groups(); track group.tag) {
          <section class="api-group">
            <button type="button" class="api-group-head" [attr.aria-expanded]="isOpen(group.tag)" (click)="toggleGroup(group.tag)">
              <span>{{ group.tag }}</span>
              <span class="api-count">{{ group.operations.length }}</span>
            </button>
            @if (isOpen(group.tag)) {
              @for (op of group.operations; track op.id) {
                <button type="button" class="api-item" [class.sel]="selectedId() === op.id" [attr.title]="op.summary" (click)="select(op.id)">
                  <span class="method" [class]="'method m-' + op.method.toLowerCase()">{{ op.method }}</span>
                  <span class="api-path">{{ op.path }}</span>
                </button>
              }
            }
          </section>
        }
      </nav>

      <div class="api-detail">
        @if (compact()) {
          <button type="button" pButton [text]="true" severity="secondary" size="small" class="api-back" (click)="view.set('list')">
            <app-icon name="back" /> All endpoints
          </button>
        }

        @if (selected(); as op) {
          <header class="api-head">
            <span [class]="'method m-' + op.method.toLowerCase()">{{ op.method }}</span>
            <code class="api-fullpath">{{ op.path }}</code>
          </header>
          <p class="api-summary">{{ op.summary }} <span class="muted">· {{ op.tag }}</span></p>
          @if (op.description) {
            <p class="muted api-desc">{{ op.description }}</p>
          }

          @if (hasTable(op)) {
            <label class="api-table-pick">
              <span>Table</span>
              <input [value]="activeTable()" placeholder="metadata table, e.g. brands" aria-label="Table" (input)="setTable($event)" />
            </label>
            @if (activeTable()) {
              <a class="api-openapi" [href]="openApiFile()" target="_blank" rel="noopener" title="OpenAPI 3 document of this table: typed fields and every filter, for Swagger UI, Postman or a client generator">
                <app-icon name="book" /> OpenAPI file of {{ activeTable() }}
              </a>
            }
          }

          <div class="api-tabs" role="tablist">
            <button type="button" role="tab" [attr.aria-selected]="tab() === 'docs'" [class.on]="tab() === 'docs'" (click)="tab.set('docs')"><app-icon name="book" /> Documentation</button>
            <button type="button" role="tab" [attr.aria-selected]="tab() === 'try'" [class.on]="tab() === 'try'" (click)="tab.set('try')"><app-icon name="send" /> Try it</button>
          </div>

          @if (tab() === 'docs') {
          @if (hasTable(op)) {
            @if (activeTable()) {
              <h3>Fields of <code>{{ activeTable() }}</code></h3>
              @if (fieldsRes.isLoading()) {
                <p class="muted api-note">Loading the fields…</p>
              } @else if (tableFields().length) {
                <table class="api-table">
                  <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Filter examples</th></tr></thead>
                  <tbody>
                    @for (field of tableFields(); track field.name) {
                      <tr>
                        <td><code>{{ field.name }}</code>@if (field.label && field.label !== field.name) { <div class="muted api-label">{{ field.label }}</div> }</td>
                        <td>{{ field.type }}</td>
                        <td>@if (field.required) { <b class="req">yes</b> } @else { <span class="muted">no</span> }</td>
                        <td class="api-examples">
                          @for (example of filterExamples(field); track example) {
                            <code>{{ example }}</code>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
                <p class="muted api-note">Combine filters with <code>&amp;</code>, for example <code>{{ filterExamples(tableFields()[0])[0] }}&amp;_limit=10&amp;_sort={{ tableFields()[0].name }}:asc</code>.</p>
              } @else {
                <p class="muted api-note">No fields found for this table.</p>
              }
            }
          }

          @if (op.parameters.length) {
            <h3>Parameters</h3>
            <table class="api-table">
              <thead><tr><th>Name</th><th>In</th><th>Type</th><th></th></tr></thead>
              <tbody>
                @for (param of op.parameters; track param.in + param.name) {
                  <tr>
                    <td><code>{{ param.name }}</code>@if (param.required) { <b class="req" title="Required">*</b> }</td>
                    <td>{{ param.in }}</td>
                    <td>{{ param.type }}</td>
                    <td class="muted">{{ param.description }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }

          @if (body(); as bodyText) {
            <h3>Request body <span class="muted">{{ op.bodyType }}</span></h3>
            <pre class="code api-code">{{ bodyText }}</pre>
          }

          @if (op.responses.length) {
            <h3>Responses</h3>
            <ul class="api-responses">
              @for (response of op.responses; track response.code) {
                <li><b>{{ response.code }}</b> <span class="muted">{{ response.description }}</span></li>
              }
            </ul>
          }

          } @else {
          <h3>cURL</h3>
          <div class="api-codewrap">
            <pre class="code api-code">{{ curl() }}</pre>
            <button type="button" class="icon-btn api-copy" aria-label="Copy" title="Copy" (click)="copy(curl())"><app-icon name="clone" /></button>
          </div>

          @if (op.method === 'GET') {
            <h3>Try it</h3>
            <p class="muted api-note">Sends a GET with your login. Other methods are shown as curl only, so nothing is changed from here.</p>
            <div class="api-try">
              @for (param of tryRows(); track param.in + param.name) {
                <label>
                  <span><code>{{ param.name }}</code> <span class="muted">{{ param.in }}</span>@if (param.required) { <b class="req">*</b> }</span>
                  <input [value]="value(param)" [placeholder]="param.type" (input)="setValue(param, $event)" />
                </label>
              }
            </div>
            <div class="api-send">
              <button type="button" pButton severity="contrast" size="small" [disabled]="sending() || !canSend()" (click)="send()">
                <app-icon [name]="sending() ? 'loader' : 'send'" [class.spin]="sending()" /> Send
              </button>
              <code class="api-url">{{ url() }}</code>
            </div>
            @if (result(); as r) {
              <div class="api-result" [class.bad]="!r.ok">
                <header><b>{{ r.status || 'Error' }}</b> <span class="muted">{{ r.ms }} ms</span>
                  <button type="button" class="icon-btn" aria-label="Copy response" title="Copy" (click)="copy(r.body)"><app-icon name="clone" /></button>
                </header>
                <pre class="code api-code">{{ r.body }}</pre>
              </div>
            }
          }
          }
        } @else {
          <h2>Getting started</h2>
          <p class="muted api-lead">{{ parsed()?.title || 'Snello API' }} {{ parsed()?.version }}. The reference below is read live from the server.</p>

          <h3>Base URL</h3>
          <div class="api-codewrap">
            <pre class="code api-code">{{ base }}</pre>
            <button type="button" class="icon-btn api-copy" aria-label="Copy" title="Copy" (click)="copy(base)"><app-icon name="clone" /></button>
          </div>

          <h3>Authentication</h3>
          <p>Every call needs a Keycloak bearer token in the <code>Authorization</code> header. This app already sends yours.</p>
          <button type="button" pButton [text]="true" severity="secondary" size="small" (click)="copyToken()"><app-icon name="clone" /> Copy my token</button>

          <h3>Read records</h3>
          <div class="api-codewrap">
            <pre class="code api-code">{{ listExample }}</pre>
            <button type="button" class="icon-btn api-copy" aria-label="Copy" title="Copy" (click)="copy(listExample)"><app-icon name="clone" /></button>
          </div>

          <h3>Pagination and sorting</h3>
          <table class="api-table">
            <thead><tr><th>Parameter</th><th>Description</th><th>Example</th></tr></thead>
            <tbody>
              @for (row of paging; track row.name) {
                <tr><td><code>{{ row.name }}</code></td><td>{{ row.text }}</td><td><code>{{ row.example }}</code></td></tr>
              }
            </tbody>
          </table>

          <h3>Filter suffixes</h3>
          <p class="muted">Append a suffix to the field name. Each one becomes a condition in the SQL <code>WHERE</code> clause.</p>
          @for (group of filterGroups; track group.title) {
            <h4 class="api-sub">{{ group.title }}</h4>
            @if (group.note) {
              <p class="muted api-note">{{ group.note }}</p>
            }
            <table class="api-table">
              <thead><tr><th>Suffix</th><th>SQL</th><th>Description</th><th>Example</th></tr></thead>
              <tbody>
                @for (item of group.items; track item.suffix) {
                  <tr>
                    <td><code>{{ item.suffix || '(none)' }}</code></td>
                    <td class="muted"><code>{{ item.sql }}</code></td>
                    <td>{{ item.label }}@if (item.notes) { <span class="muted"> · {{ item.notes }}</span> }</td>
                    <td><code>{{ exampleFor(item.suffix, item.needsValue) }}</code></td>
                  </tr>
                }
              </tbody>
            </table>
          }

          <h3>Create, update, delete</h3>
          <div class="api-codewrap">
            <pre class="code api-code">{{ writeExample }}</pre>
            <button type="button" class="icon-btn api-copy" aria-label="Copy" title="Copy" (click)="copy(writeExample)"><app-icon name="clone" /></button>
          </div>
        }
      </div>
    </div>
  `,
})
export class ApiExplorer {
  readonly compact = input(false);

  private readonly config = inject(RUNTIME_CONFIG);
  private readonly http = inject(HttpClient);
  private readonly keycloak = inject(Keycloak);
  private readonly toasts = inject(ToastService);
  private readonly panel = inject(ApiPanelState);
  private readonly snello = inject(SnelloApi);

  readonly origin = new URL(this.config.api_service_path).origin;
  readonly base = this.config.api_service_path.replace(/\/$/, '');
  readonly conditions = QUERY_CONDITIONS;
  readonly listExample = `curl '${this.base}/<table>?_start=0&_limit=10&_sort=creation_date:desc&name_containss=wave' \\\n  -H 'Authorization: Bearer $TOKEN'`;
  readonly writeExample = [
    `# create`,
    `curl -X POST '${this.base}/<table>' -H 'Authorization: Bearer $TOKEN' \\`,
    `  -H 'Content-Type: application/json' -d '{"name":"New"}'`,
    ``,
    `# update`,
    `curl -X PUT '${this.base}/<table>/<uuid>' -H 'Authorization: Bearer $TOKEN' \\`,
    `  -H 'Content-Type: application/json' -d '{"name":"Renamed"}'`,
    ``,
    `# delete`,
    `curl -X DELETE '${this.base}/<table>/<uuid>' -H 'Authorization: Bearer $TOKEN'`,
  ].join('\n');

  readonly spec = httpResource<unknown>(() => `${this.origin}/openapi`);
  readonly parsed = computed(() => {
    const value = this.spec.value();
    return value ? parseSpec(value) : null;
  });

  readonly query = signal('');
  readonly selectedId = signal('guide');
  readonly view = signal<'list' | 'detail'>('list');
  readonly tab = signal<'docs' | 'try'>('docs');
  private readonly closed = signal<ReadonlySet<string>>(new Set());
  private readonly values = signal<Record<string, string>>({});
  readonly result = signal<ApiResult | null>(null);
  readonly sending = signal(false);

  readonly groups = computed(() => {
    const text = this.query().trim().toLowerCase();
    const groups = new Map<string, ApiOperation[]>();
    for (const op of this.parsed()?.operations ?? []) {
      if (text && !`${op.method} ${op.path} ${op.summary} ${op.tag}`.toLowerCase().includes(text)) continue;
      groups.set(op.tag, [...(groups.get(op.tag) ?? []), op]);
    }
    return [...groups].map(([tag, operations]) => ({ tag, operations }));
  });

  readonly selected = computed(() => this.parsed()?.operations.find((op) => op.id === this.selectedId()) ?? null);
  /** Extra query parameters a page asked for that the spec does not list (filters like `name_containss`). */
  private readonly extras = signal<ApiParam[]>([]);
  readonly tryParams = computed(() => [...(this.selected()?.parameters ?? []).filter((param) => param.in !== 'header'), ...this.extras()]);

  constructor() {
    effect(() => {
      const request = this.panel.request();
      if (!request || !this.parsed()) return;
      untracked(() => this.applyRequest(request));
    });
  }

  private applyRequest(request: ApiRequestPreset): void {
    const op = this.parsed()?.operations.find((item) => item.id === request.id);
    if (!op) return;
    const known = new Set(op.parameters.map((param) => `${param.in}:${param.name}`));
    this.extras.set(
      Object.keys(request.query)
        .filter((name) => !known.has(`query:${name}`))
        .map((name) => ({ name, in: 'query' as const, required: false, type: 'string', description: 'Filter' })),
    );
    this.selectedId.set(op.id);
    this.view.set('detail');
    this.tab.set('docs');
    this.result.set(null);
    const next: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.path)) next[`${op.id}|path:${name}`] = value;
    for (const [name, value] of Object.entries(request.query)) next[`${op.id}|query:${name}`] = value;
    this.values.update((current) => ({ ...current, ...next }));
    this.panel.request.set(null);
  }

  readonly url = computed(() => {
    const op = this.selected();
    if (!op) return '';
    let path = op.path;
    const search = new URLSearchParams();
    for (const param of this.tryParams()) {
      const value = this.values()[this.key(param)]?.trim() ?? '';
      if (param.in === 'path') path = path.replace(`{${param.name}}`, value ? encodeURIComponent(value) : `<${param.name}>`);
      else if (value) search.set(param.name, value);
    }
    const query = search.toString();
    return `${this.origin}${path}${query ? `?${query}` : ''}`;
  });

  readonly paging = [
    { name: '_limit', text: 'Maximum number of records to return', example: '_limit=10' },
    { name: '_start', text: 'Offset (zero-based) of the first record', example: '_start=20' },
    { name: '_sort', text: 'Sort field and direction (field:asc or field:desc)', example: '_sort=creation_date:desc' },
    { name: 'select_fields', text: 'Comma-separated fields to include in the response', example: 'select_fields=uuid,name' },
  ];

  readonly filterGroups = [
    { title: 'Equality', note: 'No suffix needed: the plain field name matches the exact value.', suffixes: [''] },
    { title: 'Comparison', note: '', suffixes: ['_ne', '_lt', '_lte', '_gt', '_gte'] },
    { title: 'LIKE / pattern matching', note: '_rlike and _llike refer to where the % wildcard goes.', suffixes: ['_contains', '_like', '_ilike', '_containss', '_rlike', '_llike', '_ncontains'] },
    { title: 'IN list', note: '', suffixes: ['_in'] },
    { title: 'NULL and empty checks', note: 'These need no value: the parameter name alone is enough.', suffixes: ['_nn', '_inn', '_nie', '_ie'] },
  ].map((group) => ({ ...group, items: QUERY_CONDITIONS.filter((item) => group.suffixes.includes(item.suffix)) }));

  exampleFor(suffix: string, needsValue: boolean): string {
    return `field${suffix}${needsValue ? '=value' : ''}`;
  }

  /** A few suffixes that make sense for a field's type, written as ready-to-use query parameters. */
  filterExamples(field: { name: string; type: string }): string[] {
    const name = field.name;
    const sample = sampleText(field.type);
    switch (field.type) {
      case 'number':
      case 'decimal':
        return [`${name}=${sample}`, `${name}_gte=${sample}`, `${name}_lt=${sample}`, `${name}_in=1,2,3`];
      case 'date':
      case 'datetime':
      case 'time':
        return [`${name}_gte=${sample}`, `${name}_lte=${sample}`, `${name}_nn`];
      case 'boolean':
      case 'passivation':
        return [`${name}=true`, `${name}=false`];
      case 'select':
      case 'multiselect':
      case 'join':
      case 'lookup':
      case 'tags':
        return [`${name}=${sample}`, `${name}_in=a,b`, `${name}_nn`];
      case 'image':
      case 'media':
        return [`${name}_nn`, `${name}_inn`];
      default:
        return [`${name}=${sample}`, `${name}_containss=${sample}`, `${name}_rlike=${sample}`, `${name}_nn`];
    }
  }

  hasTable(op: ApiOperation): boolean {
    return op.path.includes('{table}');
  }

  readonly activeTable = computed(() => {
    const op = this.selected();
    return op && this.hasTable(op) ? (this.values()[`${op.id}|path:table`]?.trim() ?? '') : '';
  });

  /** Per-table OpenAPI document generated by snello from the metadata (GET /openapi/data/{table}). */
  openApiFile(): string {
    return `${this.origin}/openapi/data/${encodeURIComponent(this.activeTable())}`;
  }

  setTable(event: Event): void {
    const op = this.selected();
    if (!op) return;
    const text = (event.target as HTMLInputElement).value;
    this.values.update((current) => ({ ...current, [`${op.id}|path:table`]: text }));
  }

  readonly fieldsRes = httpResource<FieldDefinition[]>(() => {
    const table = this.activeTable();
    return table ? this.snello.fieldsRequest(table) : undefined;
  }, { defaultValue: [], parse: dataFields });

  readonly tableFields = computed(() =>
    this.fieldsRes
      .value()
      .filter((field) => !!field.name)
      .map((field) => ({ name: field.name as string, label: field.label ?? '', type: logicalFieldType(field), required: !!field.mandatory })),
  );

  /** Request body: the table's own fields when a table is chosen, else the schema sample. */
  readonly body = computed(() => {
    const op = this.selected();
    if (!op?.bodyExample) return '';
    const fields = this.tableFields().filter((field) => !['uuid', 'creation_date', 'lastupdate_date'].includes(field.name));
    if (!this.hasTable(op) || fields.length === 0) return op.bodyExample;
    const sample: Record<string, unknown> = {};
    for (const field of fields) sample[field.name] = sampleFor(field.type);
    return JSON.stringify(sample, null, 2);
  });

  readonly tryRows = computed(() => {
    const op = this.selected();
    return this.tryParams().filter((param) => !(op && this.hasTable(op) && param.name === 'table'));
  });

  readonly canSend = computed(() => this.tryParams().filter((param) => param.in === 'path').every((param) => !!this.values()[this.key(param)]?.trim()));

  readonly curl = computed(() => {
    const op = this.selected();
    if (!op) return '';
    const parts = [`curl -X ${op.method} '${this.url()}'`, `-H 'Authorization: Bearer $TOKEN'`];
    const body = this.body();
    if (body) {
      parts.push(`-H 'Content-Type: ${op.bodyType}'`);
      parts.push(`-d '${body.replace(/\s*\n\s*/g, ' ')}'`);
    }
    return parts.join(' \\\n  ');
  });

  select(id: string): void {
    this.tab.set('docs');
    this.extras.set([]);
    this.selectedId.set(id);
    this.view.set('detail');
    this.result.set(null);
  }

  isOpen(tag: string): boolean {
    return !!this.query().trim() || !this.closed().has(tag);
  }

  toggleGroup(tag: string): void {
    this.closed.update((set) => {
      const next = new Set(set);
      if (!next.delete(tag)) next.add(tag);
      return next;
    });
  }

  value(param: ApiParam): string {
    return this.values()[this.key(param)] ?? '';
  }

  setValue(param: ApiParam, event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.values.update((current) => ({ ...current, [this.key(param)]: text }));
  }

  private key(param: ApiParam): string {
    return `${this.selectedId()}|${param.in}:${param.name}`;
  }

  async send(): Promise<void> {
    if (this.sending() || !this.canSend()) return;
    this.sending.set(true);
    const started = performance.now();
    try {
      const response = await firstValueFrom(this.http.get(this.url(), { observe: 'response', responseType: 'text' }));
      this.result.set({ status: response.status, ok: true, ms: Math.round(performance.now() - started), body: pretty(response.body ?? '') });
    } catch (error) {
      const failure = error as HttpErrorResponse;
      this.result.set({
        status: failure.status,
        ok: false,
        ms: Math.round(performance.now() - started),
        body: pretty(typeof failure.error === 'string' ? failure.error : JSON.stringify(failure.error ?? failure.message)),
      });
    } finally {
      this.sending.set(false);
    }
  }

  copy(text: string): void {
    void navigator.clipboard.writeText(text).then(() => this.toasts.show('Copied.'));
  }

  copyToken(): void {
    const token = this.keycloak.token;
    if (!token) {
      this.toasts.show('No token available.');
      return;
    }
    void navigator.clipboard.writeText(token).then(() => this.toasts.show('Token copied.'));
  }
}

function pretty(text: string): string {
  const clipped = text.length > 20000 ? `${text.slice(0, 20000)}\n… (truncated)` : text;
  try {
    return text.length > 20000 ? clipped : JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return clipped;
  }
}

function sampleFor(type: string): unknown {
  if (['number', 'decimal'].includes(type)) return 0;
  if (['boolean', 'passivation'].includes(type)) return false;
  if (['multiselect', 'tags', 'multijoin', 'multilookup'].includes(type)) return [];
  if (type === 'date') return '2026-01-01';
  if (type === 'datetime') return '2026-01-01T00:00:00';
  if (type === 'time') return '12:00:00';
  return 'string';
}

function sampleText(type: string): string {
  if (['number', 'decimal'].includes(type)) return '10';
  if (type === 'date') return '2026-01-01';
  if (type === 'datetime') return '2026-01-01T00:00:00';
  if (type === 'time') return '12:00:00';
  return 'text';
}
