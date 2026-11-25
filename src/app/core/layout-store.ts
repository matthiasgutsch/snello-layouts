import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { LayoutBody, LayoutDocument, PageKind } from './models';
import { SnelloApi } from './snello-api';

@Injectable({ providedIn: 'root' })
export class LayoutStore {
  private readonly http = inject(HttpClient);
  private readonly api = inject(SnelloApi);
  private readonly documents = signal<LayoutDocument[]>([]);
  readonly ready = signal(false);
  readonly error = signal('');
  readonly all = computed(() =>
    [...this.documents()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })),
  );

  constructor() {
    void this.reload();
  }

  find(id: string | null | undefined): LayoutDocument | null {
    if (!id) return null;
    return this.documents().find((item) => item.id === id) ?? null;
  }

  async reload(): Promise<void> {
    try {
      const remote = await this.fetchAll();
      this.documents.set(remote.map(englishDefaults));
      this.error.set('');
    } catch {
      this.documents.set([]);
      this.error.set(`Can't read layouts from ${this.api.apiHost}.`);
    } finally {
      this.ready.set(true);
    }
  }

  async save(document: LayoutDocument): Promise<LayoutDocument> {
    const exists = this.documents().some((item) => item.id === document.id);
    const saved = await this.write(document, exists);
    this.documents.update((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
    return saved;
  }

  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${this.api.layouts}/${encodeURIComponent(id)}`, { responseType: 'text' }));
    this.documents.update((current) => current.filter((item) => item.id !== id));
  }

  private async fetchAll(): Promise<LayoutDocument[]> {
    const value = await firstValueFrom(
      this.http.get<unknown>(this.api.layouts, { params: { _limit: '100000' } }),
    );
    const rows = Array.isArray(value) ? value : [];
    return rows.map(fromApi).filter((item): item is LayoutDocument => item !== null);
  }

  private async write(document: LayoutDocument, exists: boolean): Promise<LayoutDocument> {
    const url = this.api.layouts;
    const request = exists
      ? this.http.put<unknown>(`${url}/${encodeURIComponent(document.id)}`, toApi(document))
      : this.http.post<unknown>(url, toApi(document));
    return fromApi(await firstValueFrom(request)) ?? document;
  }
}

function toApi(document: LayoutDocument): Record<string, string> {
  return {
    uuid: document.id,
    name: document.name,
    page_type: document.pageType,
    metadata_uuid: document.metadataUuid,
    metadata_name: document.metadataName,
    json_data: JSON.stringify({ ...document.body, version: 1 }),
    updated_at: document.updatedAt,
  };
}

function fromApi(value: unknown): LayoutDocument | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = text(row['uuid']);
  const pageType = text(row['page_type']);
  if (!id || !isPageType(pageType)) return null;
  const body = parseBody(row['json_data'], pageType);
  if (!body) return null;
  return {
    id,
    name: text(row['name']) || id,
    metadataName: text(row['metadata_name']),
    metadataUuid: text(row['metadata_uuid']),
    pageType,
    updatedAt: text(row['updated_at']) || new Date().toISOString(),
    body,
  };
}

function parseBody(raw: unknown, pageType: PageKind): LayoutBody | null {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const body = value as LayoutBody;
  if (pageType === 'list' && body.kind === 'list' && Array.isArray(body.columns)) return body;
  if (pageType !== 'list' && body.kind === 'wizard' && Array.isArray(body.pages)) return body;
  return null;
}

function isPageType(value: string): value is PageKind {
  return value === 'list' || value === 'edit' || value === 'view';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function englishDefaults(document: LayoutDocument): LayoutDocument {
  const name = document.name.replace(/ lista$/, ' list');
  if (document.body.kind !== 'wizard') {
    return name === document.name ? document : { ...document, name };
  }
  let changed = name !== document.name;
  const pages = document.body.pages.map((page) => {
    const title = page.title.replace(/^Pagina (\d+)$/, 'Page $1');
    if (title !== page.title) changed = true;
    const boxes = page.boxes.map((box) => {
      const boxTitle = box.title === 'Dettaglio' ? 'Details' : box.title === 'Blocco' ? 'Block' : box.title;
      if (boxTitle !== box.title) changed = true;
      return boxTitle === box.title ? box : { ...box, title: boxTitle };
    });
    if (title === page.title && boxes.every((box, index) => box === page.boxes[index])) return page;
    return { ...page, title, boxes };
  });
  if (!changed) return document;
  return { ...document, name, body: { ...document.body, pages } };
}
