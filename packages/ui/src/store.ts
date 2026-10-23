import {
  History, describeError, addAnnotation, blobSource, memorySource, addSource, deletePages, duplicatePages, emptyDocument, preflight, removeAnnotation, reorderPages, rotatePages, selectPages,
  type AnnotId, type AppError, type Command, type PageId, type Quad, type SourceDoc, type SourceId, type WorkingDocument,
} from '@pagewright/core';
import { AppFailure, defaultSaveOpts, detectSignature, type PdfRenderer, type PdfWriter, type Progress, type RenderDoc } from '@pagewright/engine';
import type { PickedFile, Platform } from '@pagewright/platform';

export type MarkupType = 'highlight' | 'underline' | 'strikeout';
export type ToolId = 'select' | MarkupType;

const MARKUP_COLOR: Record<MarkupType, { r: number; g: number; b: number; a: number }> = {
  highlight: { r: 1, g: 0.9, b: 0, a: 1 },
  underline: { r: 0.1, g: 0.3, b: 0.9, a: 1 },
  strikeout: { r: 0.9, g: 0.1, b: 0.1, a: 1 },
};

/** UI-only state: not undoable and not part of the document (spec section 10). */
export interface UiState {
  zoom: number;
  activeTool: ToolId;
  selection: ReadonlySet<PageId>;
  /** Anchor for shift-click range selection. */
  anchor?: PageId;
  currentPage: number;
  /** The annotation the user clicked (Delete removes it). */
  selectedAnnot?: { pageId: PageId; id: AnnotId };
  busy?: string;
  progress?: Progress;
  error?: AppError | { code: 'Message'; message: string };
  /** Set while a password-protected file waits for the user. */
  passwordPrompt?: { fileName: string; wrong: boolean };
  /** Set when saving needs an explicit OK (signed sources). */
  saveWarning?: AppError;
  notices: readonly string[];
}

export interface Snapshot {
  doc: WorkingDocument;
  ui: UiState;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
}

export interface StoreDeps {
  renderer: PdfRenderer;
  writer: PdfWriter;
  platform: Platform;
  /** Defaults to crypto.randomUUID. */
  newId?: () => string;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;

export class AppStore {
  readonly history = new History(emptyDocument());
  private ui: UiState = { zoom: 1, activeTool: 'select', selection: new Set(), currentPage: 0, notices: [] };
  private snap!: Snapshot;
  private listeners = new Set<() => void>();
  private renderDocs = new Map<SourceId, RenderDoc>();
  private shownNotices = new Set<string>();
  private readonly newId: () => string;
  author = 'You';

  constructor(private readonly deps: StoreDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.rebuild();
    this.history.subscribe(() => {
      this.pruneSelection();
      this.emit();
    });
  }

  // ---- React integration -------------------------------------------------------------

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = (): Snapshot => this.snap;

  getRenderDoc(sourceId: SourceId): RenderDoc | undefined {
    return this.renderDocs.get(sourceId);
  }

  get platform(): Platform {
    return this.deps.platform;
  }

  // ---- Opening -----------------------------------------------------------------------

  async addFiles(files: readonly PickedFile[]): Promise<void> {
    for (const file of files) await this.addFile(file);
  }

  private async addFile(file: PickedFile): Promise<void> {
    this.patch({ busy: `Opening ${file.name}`, error: undefined });
    try {
      // Prefer a disk-backed Blob so the file is never held whole in memory, and prefer a private snapshot of
      // it so saving over the original cannot break later lazy reads.
      const blob = file.snapshot ? await file.snapshot() : file.blob;
      const data = blob ? blobSource(blob) : memorySource(await file.read());
      const id = this.newId();
      const base: SourceDoc = {
        id, name: file.name, data, pageCount: 0, isEncrypted: false, hasDigitalSignature: await detectSignature(data),
      };
      let password: string | undefined;
      let rd: RenderDoc | undefined;
      for (;;) {
        try {
          rd = await this.deps.renderer.open(base, password);
          break;
        } catch (e) {
          const err = e instanceof AppFailure ? e.error : undefined;
          if (err?.code !== 'PasswordRequired' && err?.code !== 'WrongPassword') throw e;
          base.isEncrypted = true;
          password = await this.askPassword(file, err.code === 'WrongPassword');
          if (password === undefined) return; // user cancelled
        }
      }
      const source: SourceDoc = { ...base, pageCount: rd.pageCount };
      this.renderDocs.set(id, rd);
      this.history.execute(addSource(source, undefined, this.newId));
      // Opening is lazy and always fine; saving needs far more memory. Say so now, not at Save.
      const tooBig = preflight(this.history.current, { memoryBudgetMB: this.deps.platform.device.memoryBudgetMB }).errors.find(
        (e) => e.code === 'OutOfMemoryRisk',
      );
      if (tooBig) this.notice(describeError(tooBig).message);
      if (source.isEncrypted) this.notice(`"${file.name}" is encrypted: you can view it, but it cannot be saved yet.`);
      if (this.history.current.pages.length === source.pageCount) this.patch({ currentPage: 0 });
    } catch (e) {
      this.fail(e);
    } finally {
      this.patch({ busy: undefined });
    }
  }

  private askPassword(file: PickedFile, wrong: boolean): Promise<string | undefined> {
    return new Promise((resolve) => {
      this.passwordResolver = resolve;
      this.patch({ passwordPrompt: { fileName: file.name, wrong } });
    });
  }

  private passwordResolver?: (pw: string | undefined) => void;

  submitPassword(password: string): void {
    this.settlePassword(password);
  }

  cancelPassword(): void {
    this.settlePassword(undefined);
  }

  private settlePassword(pw: string | undefined): void {
    const r = this.passwordResolver;
    this.passwordResolver = undefined;
    this.patch({ passwordPrompt: undefined });
    r?.(pw);
  }

  // ---- Page operations (Tier 1) -----------------------------------------------------

  execute(cmd: Command): void {
    this.history.execute(cmd);
  }

  undo(): void { this.history.undo(); }
  redo(): void { this.history.redo(); }

  private targets(ids?: readonly PageId[]): PageId[] {
    return ids ? [...ids] : [...this.ui.selection];
  }

  deletePages(ids?: readonly PageId[]): void {
    const t = this.targets(ids);
    if (t.length) this.history.execute(deletePages(t));
  }

  rotatePages(delta: 90 | -90 | 180, ids?: readonly PageId[]): void {
    const t = this.targets(ids);
    if (t.length) this.history.execute(rotatePages(t, delta));
  }

  duplicatePages(ids?: readonly PageId[]): void {
    const t = this.targets(ids);
    if (t.length) this.history.execute(duplicatePages(t, this.newId));
  }

  /** Moves `ids` (default: selection) so they start at `toIndex` among the remaining pages. */
  movePages(toIndex: number, ids?: readonly PageId[]): void {
    const t = this.targets(ids);
    if (t.length) this.history.execute(reorderPages(t, toIndex));
  }

  // ---- Annotations (Tier 2) ---------------------------------------------------------

  addMarkup(type: MarkupType, pageId: PageId, quads: Quad[]): AnnotId | undefined {
    if (quads.length === 0) return undefined;
    const now = new Date().toISOString();
    const id = this.newId();
    this.history.execute(
      addAnnotation({
        type, id, pageId, author: this.author, createdAt: now, modifiedAt: now,
        color: MARKUP_COLOR[type], opacity: type === 'highlight' ? 0.5 : 1, origin: 'app', quads,
      }),
    );
    return id;
  }

  selectAnnotation(sel: { pageId: PageId; id: AnnotId } | undefined): void {
    this.patch({ selectedAnnot: sel });
  }

  deleteSelectedAnnotation(): void {
    const sel = this.ui.selectedAnnot;
    if (!sel) return;
    this.patch({ selectedAnnot: undefined });
    this.history.execute(removeAnnotation(sel.pageId, sel.id));
  }

  // ---- UI state ----------------------------------------------------------------------

  /** Click = replace, ctrl/cmd = toggle, shift = range from the anchor. */
  selectPage(id: PageId, mode: 'replace' | 'toggle' | 'range' = 'replace'): void {
    const pages = this.history.current.pages;
    let sel = new Set(this.ui.selection);
    let anchor = this.ui.anchor;
    if (mode === 'range' && anchor && pages.some((p) => p.id === anchor)) {
      const a = pages.findIndex((p) => p.id === anchor);
      const b = pages.findIndex((p) => p.id === id);
      sel = new Set(pages.slice(Math.min(a, b), Math.max(a, b) + 1).map((p) => p.id));
    } else if (mode === 'toggle') {
      sel.has(id) ? sel.delete(id) : sel.add(id);
      anchor = id;
    } else {
      sel = new Set([id]);
      anchor = id;
    }
    this.patch({ selection: sel, anchor, currentPage: Math.max(0, pages.findIndex((p) => p.id === id)) });
  }

  selectAll(): void {
    this.patch({ selection: new Set(this.history.current.pages.map((p) => p.id)) });
  }

  clearSelection(): void {
    this.patch({ selection: new Set(), anchor: undefined });
  }

  setCurrentPage(index: number): void {
    const max = Math.max(0, this.history.current.pages.length - 1);
    this.patch({ currentPage: Math.max(0, Math.min(index, max)) });
  }

  setZoom(zoom: number): void {
    this.patch({ zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) });
  }

  setTool(tool: ToolId): void {
    this.patch({ activeTool: tool });
  }

  dismissError(): void {
    this.patch({ error: undefined });
  }

  // ---- Saving ------------------------------------------------------------------------

  /**
   * Returns true when a file was written. Signed sources need `confirmed` (see `ui.saveWarning`).
   * Order matters: the save dialog opens first, while the user's click is still fresh, and the slow
   * work happens afterwards.
   */
  async save(confirmed = false): Promise<boolean> {
    const doc = this.history.current;
    if (doc.pages.length === 0) return false;
    const pre = preflight(doc, { memoryBudgetMB: this.deps.platform.device.memoryBudgetMB });
    if (pre.errors[0]) {
      this.patch({ error: pre.errors[0] });
      return false;
    }
    if (pre.warnings[0] && !confirmed) {
      this.patch({ saveWarning: pre.warnings[0] });
      return false;
    }
    this.patch({ saveWarning: undefined, error: undefined });
    const first = Object.values(doc.sources)[0]?.name ?? 'document.pdf';
    const ok = await this.writeOut(doc, first.replace(/\.pdf$/i, '') + '-edited.pdf', 'Saving');
    if (ok) {
      this.history.markSaved();
      for (const n of pre.notices) this.notice(NOTICE_TEXT[n]);
    }
    return ok;
  }

  cancelSaveWarning(): void {
    this.patch({ saveWarning: undefined });
  }

  /** Extract: save only the given pages as a new file. */
  async extract(ids?: readonly PageId[]): Promise<boolean> {
    const t = this.targets(ids);
    if (!t.length) return false;
    this.patch({ error: undefined });
    return this.writeOut(selectPages(this.history.current, t), 'extract.pdf', 'Extracting');
  }

  /** Aborts a running save/extract (the save worker is terminated). */
  cancelSave(): void {
    this.saveAbort?.abort();
  }

  private saveAbort?: AbortController;

  private async writeOut(doc: WorkingDocument, fileName: string, label: string): Promise<boolean> {
    if (this.saveAbort) return false; // one at a time
    const ac = (this.saveAbort = new AbortController());
    try {
      const target = await this.deps.platform.fs.openSaveTarget(fileName);
      if (!target) return false; // the user cancelled the dialog: nothing has been done yet
      this.patch({ busy: label, progress: undefined });
      const bytes = await this.deps.writer.save(doc, { ...defaultSaveOpts }, (progress) => this.patch({ progress }), ac.signal);
      const result = await target.write(bytes);
      if (!result.saved) return false;
      if (result.viaDownload) {
        this.notice(`The browser would not write to the chosen file, so "${result.name}" was saved to your downloads folder instead. Close any program that has the original open to overwrite it.`);
      }
      return true;
    } catch (e) {
      if (!(e instanceof Error && e.name === 'AbortError')) this.fail(e); // cancelling is not an error
      return false;
    } finally {
      this.saveAbort = undefined;
      this.patch({ busy: undefined, progress: undefined });
    }
  }

  // ---- Internals ---------------------------------------------------------------------

  /** Notices are shown once per session (spec section 11). */
  private notice(text: string): void {
    if (this.shownNotices.has(text)) return;
    this.shownNotices.add(text);
    this.patch({ notices: [...this.ui.notices, text] });
  }

  dismissNotice(text: string): void {
    this.patch({ notices: this.ui.notices.filter((n) => n !== text) });
  }

  private fail(e: unknown): void {
    this.patch({
      error: e instanceof AppFailure ? e.error : { code: 'Message', message: e instanceof Error ? e.message : String(e) },
    });
  }

  private pruneSelection(): void {
    const ids = new Set(this.history.current.pages.map((p) => p.id));
    const kept = [...this.ui.selection].filter((id) => ids.has(id));
    const patch: Partial<UiState> = {};
    if (kept.length !== this.ui.selection.size) patch.selection = new Set(kept);
    const max = Math.max(0, ids.size - 1);
    if (this.ui.currentPage > max) patch.currentPage = max;
    const sa = this.ui.selectedAnnot;
    if (sa && !this.history.current.annotations[sa.pageId]?.some((a) => a.id === sa.id)) patch.selectedAnnot = undefined;
    this.ui = { ...this.ui, ...patch };
  }

  private patch(p: Partial<UiState>): void {
    this.ui = { ...this.ui, ...p };
    this.emit();
  }

  private rebuild(): void {
    const h = this.history;
    this.snap = {
      doc: h.current, ui: this.ui, canUndo: h.canUndo, canRedo: h.canRedo,
      undoLabel: h.undoLabel, redoLabel: h.redoLabel,
    };
  }

  private emit(): void {
    this.rebuild();
    for (const fn of this.listeners) fn();
  }
}

const NOTICE_TEXT = {
  OutlinesDropped: 'Bookmarks from merged files are not kept.',
  SignaturesInvalidated: 'Existing digital signatures are no longer valid in the saved file.',
} as const;
