import { vi } from 'vitest';
import { AppFailure, type PdfRenderer, type PdfWriter, type RenderDoc } from '@pagewright/engine';
import type { PickedFile, Platform } from '@pagewright/platform';
import { AppStore } from '../src/store';

export function file(name: string, content = 'x'): PickedFile {
  const bytes = new TextEncoder().encode(content);
  return { name, size: bytes.length, read: async () => bytes };
}

export function fakeDoc(sourceId: string, pageCount: number): RenderDoc {
  return {
    sourceId, pageCount, destroy() {}, renderPage: async () => {}, getTextContent: async () => [],
    getExistingAnnotations: async () => [],
    getPageInfo: async () => ({
      width: 100, height: 100, rotation: 0, mediaBox: { x: 0, y: 0, w: 100, h: 100 }, cropBox: { x: 0, y: 0, w: 100, h: 100 }, userUnit: 1,
    }),
  };
}

export interface SetupOpts {
  pages?: Record<string, number>;
  password?: string;
  budgetMB?: number;
  /** Pre-seeds the remembered author name, as if set in an earlier session. */
  author?: string;
}

/** An AppStore wired to fakes: a renderer that opens anything, a writer that returns 3 bytes, an in-memory platform. */
export function setup(opts: SetupOpts = {}) {
  const secrets = new Map<string, unknown>(opts.author ? [['author', opts.author]] : []);
  const saved: { name: string; bytes: Uint8Array }[] = [];
  const events: string[] = [];
  const renderer: PdfRenderer = {
    open: vi.fn(async (source, password) => {
      if (opts.password && password !== opts.password) {
        throw new AppFailure(password === undefined ? { code: 'PasswordRequired', sourceId: source.id } : { code: 'WrongPassword' });
      }
      return fakeDoc(source.id, opts.pages?.[source.name] ?? 3);
    }),
  };
  const writer: PdfWriter = { save: vi.fn(async () => (events.push('write'), new Uint8Array([1, 2, 3]))) };
  const platform = {
    fs: {
      openSaveTarget: vi.fn(async (name: string) => {
        events.push(`dialog ${name}`);
        return { write: async (bytes: Uint8Array) => (saved.push({ name, bytes }), { saved: true as const, name }) };
      }),
    },
    device: { platform: 'web', memoryBudgetMB: opts.budgetMB ?? 1000 },
    secure: {
      get: vi.fn(async (k: string) => secrets.get(k)),
      set: vi.fn(async (k: string, v: unknown) => void secrets.set(k, v)),
    },
  } as unknown as Platform;
  let n = 0;
  const store = new AppStore({ renderer, writer, platform, newId: () => `id${++n}` });
  return { store, renderer, writer, platform, saved, events, secrets };
}
