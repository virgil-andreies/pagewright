import type { ImageLoader, StampImage } from './image-loader';
import { DEFAULT_RECENT_COLORS, DEFAULT_TOOL_STYLES, STYLES_KEY, hasFill, isStyledTool, nextRecent, readSavedStyles, type SavedStyles, type StyledTool, type ToolStyle } from './tool-style';
import {
  isSignatureArt, strokesToArt, MAX_IMAGE_FILE_BYTES, newImageStampRect, newSignatureRect, DEFAULT_STAMP, batch, changeStampPreset, newStampRect, stampPreset as findStampPreset, idsToRemove, importedAnnotations, isImportedId, pdfIdOf, removeImportedAnnotations, DEFAULT_FONT_SIZE, DEFAULT_TEXT_WIDTH, History, NOTE_FILL, fitFreeText, sanitizeText, describeError, addAnnotation, normalizeRect, pointsBounds, updateAnnotation, blobSource, memorySource, addSource, deletePages, duplicatePages, emptyDocument, preflight, removeAnnotation, reorderPages, rotatePages, selectPages,
  type Annotation, type AnnotComment, type AnnotId, type SignatureArt, type SourceAnnotation, type StampAnnot, type FontFamily, type FreeTextAnnot, type AppError, type Command, type PageId, type Point, type Quad, type RGBA, type ShapeAnnot, type SourceDoc, type SourceId, type WorkingDocument,
} from '@pagewright/core';
import { AppFailure, defaultSaveOpts, detectSignature, type PdfRenderer, type PdfWriter, type Progress, type RenderDoc } from '@pagewright/engine';
import type { PickedFile, Platform } from '@pagewright/platform';

export type MarkupType = 'highlight' | 'underline' | 'strikeout';
export type ShapeTool = 'rect' | 'ellipse' | 'line' | 'arrow';
export type ToolId = 'select' | MarkupType | 'ink' | ShapeTool | 'note' | 'text' | 'stamp' | 'signature';

/** Stroke and fill for the drawing tools. Changing it also restyles the selected ink or shape. */
export interface DrawStyle {
  color: RGBA;
  width: number;
  /** Free text only. */
  fontSize: number;
  fontFamily: FontFamily;
  /** Rectangles and ellipses only. */
  fill?: RGBA;
  /** 0.1 to 1: how opaque the whole annotation is. */
  opacity: number;
}

export const DEFAULT_DRAW_STYLE: DrawStyle = {
  color: { r: 0.86, g: 0.15, b: 0.15, a: 1 }, width: 2, fontSize: DEFAULT_FONT_SIZE, fontFamily: 'sans', opacity: 1,
};

/** A text box being typed. For a new box `id` is unset and it becomes an annotation only once it has text. */
export interface TextEdit {
  pageId: PageId;
  id?: AnnotId;
  /** Upper-left corner of the box, PDF user space. */
  position: Point;
  width: number;
  /** What has been typed so far. Kept here, not in the text box, so nothing is lost when focus moves. */
  text: string;
}


/** UI-only state: not undoable and not part of the document (spec section 10). */
export interface UiState {
  zoom: number;
  activeTool: ToolId;
  /** The style the drawing code uses now: the active tool's colour and thickness, plus font and fill. */
  drawStyle: DrawStyle;
  /** Each tool's own colour and thickness, kept while you switch tools. */
  toolStyles: Readonly<Record<StyledTool, ToolStyle>>;
  /** The last few colours replaced by another, shared by all tools, newest first. */
  recentColors: readonly RGBA[];
  /** Which preset stamp the Stamp tool places next (a name from STAMP_PRESETS). */
  stampPreset: string;
  /** A picture the Stamp tool places instead of the preset, once one has been chosen. */
  stampImage?: StampImage & { name: string };
  /** A picture is being read and prepared. */
  stampImageLoading?: boolean;
  /** Signatures saved on this device (see SecureStore), newest last. */
  signatures: readonly SavedSignature[];
  signatureDialog: boolean;
  /** The saved signature the Signature tool places next. */
  activeSignature?: string;
  commentsOpen: boolean;
  textEdit?: TextEdit;
  /** A note being placed: it becomes an annotation only once it has text (so nothing empty is left behind). */
  draftNote?: { pageId: PageId; position: Point };
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
  /**
   * The annotations that were already in each page's source file, minus the ones the user deleted, in the editor's
   * own types (all with `origin: 'imported'`). They are selectable, but PDF.js draws them, not us.
   */
  imported: Readonly<Record<PageId, readonly Annotation[]>>;
  ui: UiState;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
}

/** A signature kept on this device for reuse. The artwork is plain vector data, so nothing else is needed to draw it. */
export interface SavedSignature {
  id: string;
  /** What was typed, for the list. */
  name: string;
  art: SignatureArt;
  color: RGBA;
  createdAt: string;
}

/** Turns typed text into signature artwork (the engine's `createSignatureMaker`). */
export interface SignatureMaker {
  fonts: readonly { id: string; label: string }[];
  make(text: string, fontId: string): Promise<{ art: SignatureArt; missing: string[] }>;
}

/** Ink colours offered for a new signature. */
export const SIGNATURE_INKS: readonly { name: string; color: RGBA }[] = [
  { name: 'Black', color: { r: 0.08, g: 0.08, b: 0.1, a: 1 } },
  { name: 'Blue', color: { r: 0.05, g: 0.15, b: 0.6, a: 1 } },
  { name: 'Dark red', color: { r: 0.55, g: 0.08, b: 0.08, a: 1 } },
];

/** How many signatures may be kept. Stops storage growing without bound. */
export const MAX_SAVED_SIGNATURES = 30;
const SIGNATURES_KEY = 'signatures';

const VISUAL_SIGNATURE_NOTICE =
  'A visual signature only shows your signature on the page. It is not a digital signature and does not prove who signed.';

/** A draw style with `fill: undefined` has no fill at all (so `'fill' in style` stays an honest test). */
function withoutEmptyFill<T extends { fill?: RGBA }>(style: T): T {
  if ('fill' in style && style.fill === undefined) {
    const { fill: _none, ...rest } = style;
    return rest as T;
  }
  return style;
}

/** What comes back from storage may be old, damaged or edited by hand: keep only entries we can safely use. */
function validSignatures(stored: unknown): SavedSignature[] {
  if (!Array.isArray(stored)) return [];
  const num = (n: unknown) => typeof n === 'number' && n >= 0 && n <= 1;
  return stored
    .filter((s): s is SavedSignature => {
      const x = s as Partial<SavedSignature> | null;
      return !!x && typeof x.id === 'string' && typeof x.name === 'string' && typeof x.createdAt === 'string' && isSignatureArt(x.art)
        && !!x.color && num(x.color.r) && num(x.color.g) && num(x.color.b) && num(x.color.a);
    })
    .slice(0, MAX_SAVED_SIGNATURES);
}

export interface StoreDeps {
  /** Prepares pictures for image stamps (see `browserImageLoader`). Without it, image stamps cannot be added. */
  imageLoader?: ImageLoader;
  /** Needed to create typed signatures. Without it, only already-saved ones can be used. */
  signatureMaker?: SignatureMaker;
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
  private ui: UiState = { zoom: 1, activeTool: 'select', drawStyle: DEFAULT_DRAW_STYLE, toolStyles: DEFAULT_TOOL_STYLES, recentColors: DEFAULT_RECENT_COLORS, stampPreset: DEFAULT_STAMP.name, signatures: [], signatureDialog: false, commentsOpen: false, selection: new Set(), currentPage: 0, notices: [] };
  private snap!: Snapshot;
  private listeners = new Set<() => void>();
  private renderDocs = new Map<SourceId, RenderDoc>();
  private shownNotices = new Set<string>();
  private readonly newId: () => string;
  author = 'You';

  constructor(private readonly deps: StoreDeps) {
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.rebuild();
    // The author name lives in secure storage; load it without delaying start-up.
    void deps.platform.secure?.get<string>('author').then((name) => {
      if (name) {
        this.author = name;
        this.emit();
      }
    });
    // Each tool's colour and thickness, the recent colours and the text font, as they were left last time.
    void deps.platform.secure?.get<unknown>(STYLES_KEY).then((stored) => this.restoreStyles(readSavedStyles(stored)), () => {});
    void deps.platform.secure?.get<unknown>(SIGNATURES_KEY).then((stored) => {
      const signatures = validSignatures(stored);
      if (signatures.length > 0) this.patch({ signatures });
    });
    this.history.subscribe(() => {
      this.pruneSelection();
      this.emit();
    });
  }

  /** Set once a style is changed in this session, so styles loaded late from storage never overwrite it. */
  private stylesChanged = false;

  private restoreStyles(saved: SavedStyles | undefined): void {
    if (!saved || this.stylesChanged) return;
    const toolStyles = { ...this.ui.toolStyles, ...saved.toolStyles };
    const tool = this.ui.activeTool;
    const own = isStyledTool(tool) ? toolStyles[tool] : undefined;
    this.patch({
      toolStyles,
      ...(saved.recentColors.length > 0 ? { recentColors: saved.recentColors } : {}),
      drawStyle: {
        ...this.ui.drawStyle,
        ...(own ? withoutEmptyFill({ ...this.ui.drawStyle, color: own.color, width: own.width, opacity: own.opacity, fill: own.fill }) : {}),
        ...(saved.fontFamily ? { fontFamily: saved.fontFamily } : {}),
        ...(saved.fontSize ? { fontSize: saved.fontSize } : {}),
      },
    });
  }

  /** Keeps the styles on this device for next time. Losing them is harmless, so a failure is not reported. */
  private saveStyles(): void {
    this.stylesChanged = true;
    const saved: SavedStyles = {
      toolStyles: this.ui.toolStyles, recentColors: [...this.ui.recentColors],
      fontFamily: this.ui.drawStyle.fontFamily, fontSize: this.ui.drawStyle.fontSize,
    };
    Promise.resolve(this.deps.platform.secure?.set(STYLES_KEY, saved)).catch(() => {});
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
      // A file opened into an empty window is the document as it is on disk: nothing to save yet. A file added to
      // pages already open is a change (a merge) that no file holds until it is saved.
      const firstFile = this.history.current.pages.length === 0;
      this.history.execute(addSource(source, undefined, this.newId));
      if (firstFile) this.history.markSaved();
      void this.loadSourceAnnotations(id, source.pageCount);
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
        color: this.ui.toolStyles[type].color, opacity: this.ui.toolStyles[type].opacity, origin: 'app', quads,
      }),
    );
    return id;
  }

  /** One ink annotation made of the given strokes (already simplified by the caller). */
  addInk(pageId: PageId, strokes: Point[][]): AnnotId | undefined {
    const kept = strokes.filter((s) => s.length > 0);
    if (kept.length === 0) return undefined;
    const { color, width, opacity } = this.ui.drawStyle;
    return this.addDrawn({ type: 'ink', pageId, strokes: kept, width, color, opacity } as const);
  }

  /** A shape dragged from corner/end `a` to `b`, in PDF user space. */
  addShape(pageId: PageId, shape: ShapeTool, a: Point, b: Point): AnnotId {
    const { color, width, fill, opacity } = this.ui.drawStyle;
    const isLine = shape === 'line' || shape === 'arrow';
    const rect = isLine ? pointsBounds([a, b]) : normalizeRect(a, b);
    return this.addDrawn({
      type: 'shape', pageId, shape, rect, ...(isLine ? { line: [a, b] as [Point, Point] } : {}),
      width, color, opacity, ...(!isLine && fill ? { fill } : {}),
    } as const);
  }

  private addDrawn(partial: { type: 'ink' | 'shape' | 'note' | 'freetext' | 'stamp'; pageId: PageId; color: RGBA } & Record<string, unknown>): AnnotId {
    const now = new Date().toISOString();
    const id = this.newId();
    this.history.execute(
      addAnnotation({ id, author: this.author, createdAt: now, modifiedAt: now, opacity: 1, origin: 'app', ...partial } as Annotation),
    );
    return id;
  }

  /** Replaces an annotation (after a move, resize or restyle). One command, so one undo step. */
  updateAnnotation(next: Annotation): void {
    this.history.execute(updateAnnotation({ ...next, modifiedAt: new Date().toISOString() }));
  }

  // ---- Stamps ----------------------------------------------------------------------------------

  /**
   * Places the chosen preset stamp centred on `center`. It becomes the selection and the tool goes back to Select,
   * so it can be moved or resized straight away.
   */
  addStamp(pageId: PageId, center: Point): AnnotId | undefined {
    const image = this.ui.stampImage;
    if (image) {
      const id = this.addDrawn({
        type: 'stamp', pageId, color: { r: 0, g: 0, b: 0, a: 1 }, rect: newImageStampRect(image.width, image.height, center),
        payload: { kind: 'image', mime: image.mime, bytes: image.bytes },
      });
      this.patch({ activeTool: 'select', selectedAnnot: { pageId, id } });
      return id;
    }
    const preset = findStampPreset(this.ui.stampPreset) ?? DEFAULT_STAMP;
    const id = this.addDrawn({
      type: 'stamp', pageId, color: preset.color, rect: newStampRect(preset, center), payload: { kind: 'preset', name: preset.name },
    });
    this.patch({ activeTool: 'select', selectedAnnot: { pageId, id } });
    return id;
  }

  /** Chooses the preset for the next stamp, and changes the selected stamp to it if one is selected. */
  setStampPreset(name: string): void {
    const preset = findStampPreset(name);
    if (!preset) return;
    this.patch({ stampPreset: preset.name, stampImage: undefined });
    const sel = this.ui.selectedAnnot;
    const a = sel && this.history.current.annotations[sel.pageId]?.find((x) => x.id === sel.id);
    if (a?.type === 'stamp' && a.origin === 'app' && a.payload.kind === 'preset' && a.payload.name !== preset.name) {
      this.updateAnnotation(changeStampPreset(a as StampAnnot, preset));
    }
  }

  get canAddImages(): boolean {
    return !!this.deps.imageLoader;
  }

  /**
   * Asks for a PNG or JPEG picture and makes it what the Stamp tool places next. The picture is checked and
   * prepared first (turned upright, scaled down), so what is placed is what will be saved.
   */
  async chooseStampImage(): Promise<void> {
    const loader = this.deps.imageLoader;
    if (!loader) return this.fail(new Error('Image stamps are not available here.'));
    const [file] = await this.platform.fs.pickFiles({ multiple: false, accept: ['.png', '.jpg', '.jpeg', 'image/png', 'image/jpeg'] });
    if (!file) return;
    if (file.size > MAX_IMAGE_FILE_BYTES) {
      return this.fail(new Error(`This picture is too large (${Math.round(file.size / 1048576)} MB). Pictures up to ${MAX_IMAGE_FILE_BYTES / 1048576} MB can be used.`));
    }
    this.patch({ stampImageLoading: true });
    try {
      const image = await loader(await file.read());
      this.patch({ stampImage: { ...image, name: file.name }, activeTool: 'stamp' });
    } catch (e) {
      this.fail(e);
    } finally {
      this.patch({ stampImageLoading: false });
    }
  }

  // ---- Signatures --------------------------------------------------------------------------------

  openSignatures(open = true): void {
    this.patch({ signatureDialog: open });
  }

  get signatureMaker(): SignatureMaker | undefined {
    return this.deps.signatureMaker;
  }

  /** The artwork for some typed text, without saving anything: for previews. Rejects with a readable message. */
  previewSignature(text: string, fontId: string): Promise<{ art: SignatureArt; missing: string[] }> {
    if (!this.deps.signatureMaker) return Promise.reject(new Error('Typed signatures are not available here.'));
    return this.deps.signatureMaker.make(text, fontId);
  }

  /** Makes a signature from typed text in the chosen style and colour, and keeps it on this device. */
  async createSignature(text: string, fontId: string, color: RGBA): Promise<SavedSignature> {
    if (this.ui.signatures.length >= MAX_SAVED_SIGNATURES) {
      throw new Error(`You can keep up to ${MAX_SAVED_SIGNATURES} signatures. Delete one to make room.`);
    }
    const { art } = await this.previewSignature(text, fontId);
    const saved: SavedSignature = { id: this.newId(), name: text.trim().replace(/\s+/g, ' '), art, color, createdAt: new Date().toISOString() };
    await this.saveSignatures([...this.ui.signatures, saved]);
    return saved;
  }

  /** Keeps a hand-drawn signature (pen strokes in pad units) under the given name. */
  async createDrawnSignature(name: string, strokes: readonly (readonly Point[])[], color: RGBA): Promise<SavedSignature> {
    if (this.ui.signatures.length >= MAX_SAVED_SIGNATURES) {
      throw new Error(`You can keep up to ${MAX_SAVED_SIGNATURES} signatures. Delete one to make room.`);
    }
    const art = strokesToArt(strokes);
    if (!art) throw new Error('Draw your signature first, or it is too complex to keep. Try a simpler one.');
    const saved: SavedSignature = { id: this.newId(), name: name.trim().replace(/\s+/g, ' ') || 'Drawn signature', art, color, createdAt: new Date().toISOString() };
    await this.saveSignatures([...this.ui.signatures, saved]);
    return saved;
  }

  async deleteSignature(id: string): Promise<void> {
    if (this.ui.activeSignature === id) this.patch({ activeSignature: undefined });
    await this.saveSignatures(this.ui.signatures.filter((s) => s.id !== id));
  }

  /** The state changes at once; writing it to storage may fail, and then the person is told. */
  private async saveSignatures(signatures: readonly SavedSignature[]): Promise<void> {
    this.patch({ signatures });
    try {
      await this.deps.platform.secure?.set(SIGNATURES_KEY, signatures);
    } catch {
      this.notice('Your signatures could not be saved on this device, so they will be gone when you close the app.');
    }
  }

  /** Chooses the signature to place, switches to the Signature tool and closes the dialog. */
  useSignature(id: string): void {
    if (!this.ui.signatures.some((s) => s.id === id)) return;
    this.patch({ activeSignature: id, activeTool: 'signature', signatureDialog: false });
  }

  /**
   * Places the chosen signature centred on `center`, then selects it with the Select tool so it can be moved or
   * resized. With no signature chosen it opens the dialog instead.
   */
  addSignature(pageId: PageId, center: Point): AnnotId | undefined {
    const sig = this.ui.signatures.find((s) => s.id === this.ui.activeSignature);
    if (!sig) {
      this.patch({ signatureDialog: true });
      return undefined;
    }
    const id = this.addDrawn({
      type: 'stamp', pageId, color: sig.color, rect: newSignatureRect(sig.art, center), payload: { kind: 'signature', art: sig.art },
    });
    this.patch({ activeTool: 'select', selectedAnnot: { pageId, id } });
    this.notice(VISUAL_SIGNATURE_NOTICE);
    return id;
  }

  // ---- Free text -----------------------------------------------------------------------

  /** Start typing a new text box whose upper-left corner is `position`. */
  beginText(pageId: PageId, position: Point): void {
    this.commitText(); // finish whatever was being typed first
    this.patch({ textEdit: { pageId, position, width: DEFAULT_TEXT_WIDTH, text: '' }, selectedAnnot: undefined });
  }

  /** Edit the text of an existing text box. */
  editText(pageId: PageId, id: AnnotId): void {
    const a = this.history.current.annotations[pageId]?.find((x) => x.id === id);
    if (a?.type !== 'freetext' || a.origin !== 'app') return;
    this.commitText();
    this.patch({
      textEdit: { pageId, id, position: { x: a.rect.x, y: a.rect.y + a.rect.h }, width: a.rect.w, text: a.text },
      selectedAnnot: { pageId, id },
    });
  }

  /** Called on every keystroke. */
  setEditText(text: string): void {
    if (this.ui.textEdit) this.patch({ textEdit: { ...this.ui.textEdit, text } });
  }

  cancelText(): void {
    this.patch({ textEdit: undefined });
  }

  /**
   * Finishes the text being typed. The text is normalised first, so what is stored is exactly what is drawn
   * and saved. A new box with no text is simply dropped; clearing an existing box deletes it.
   */
  commitText(expected?: TextEdit): void {
    const edit = this.ui.textEdit;
    // A late blur from a text box that has already been replaced must not commit the new one.
    if (!edit || (expected && expected.id !== edit.id) || (expected && expected.position !== edit.position)) return;
    this.patch({ textEdit: undefined });
    const { text, replaced } = sanitizeText(edit.text);
    if (replaced > 0) {
      this.notice('Some characters (such as Chinese, Arabic or emoji) cannot be shown in text boxes and were replaced with "?".');
    }
    const body = text.trim() === '' ? '' : text.replace(/\s+$/, '');

    if (edit.id) {
      const a = this.history.current.annotations[edit.pageId]?.find((x) => x.id === edit.id);
      if (a?.type !== 'freetext') return;
      if (body === '') this.deleteAnnotation(edit.pageId, a.id);
      else if (body !== a.text) this.updateAnnotation(fitFreeText({ ...a, text: body }));
      return;
    }
    if (body === '') return;
    const { color, fontSize, fontFamily } = this.ui.drawStyle;
    const box: FreeTextAnnot = {
      type: 'freetext', id: '', pageId: edit.pageId, author: '', createdAt: '', modifiedAt: '', opacity: 1, origin: 'app',
      color, text: body, fontSize, fontFamily,
      rect: { x: edit.position.x, y: edit.position.y, w: edit.width, h: 0 },
    };
    const fitted = fitFreeText(box);
    // addDrawn supplies the id, author and timestamps.
    const { id: _id, author: _author, createdAt: _created, modifiedAt: _modified, opacity: _opacity, origin: _origin, ...fields } = fitted;
    const id = this.addDrawn(fields);
    this.patch({ selectedAnnot: { pageId: edit.pageId, id } });
  }

  /**
   * The selected annotation, when it is one of ours whose style can be changed here (not a stamp or signature,
   * which keep their own colours, and not one that came with the PDF).
   */
  restylable(): Exclude<Annotation, StampAnnot> | undefined {
    const sel = this.ui.selectedAnnot;
    const a = sel && this.history.current.annotations[sel.pageId]?.find((x) => x.id === sel.id);
    return a && a.origin === 'app' && a.type !== 'stamp' ? a : undefined;
  }

  /**
   * Changes a style. With an annotation selected, it restyles that annotation only (as one undo step), changing just
   * what `patch` names. Otherwise it is the style of what the active tool makes next, which that tool remembers.
   */
  setDrawStyle(patch: Partial<DrawStyle>): void {
    const a = this.restylable();
    if (a) return this.restyle(a, patch);
    const style: DrawStyle = { ...this.ui.drawStyle, ...patch };
    if ('fill' in patch && patch.fill === undefined) delete style.fill;
    const tool = this.ui.activeTool;
    const remember = isStyledTool(tool) && ('color' in patch || 'width' in patch || 'opacity' in patch || 'fill' in patch);
    const own: ToolStyle | undefined = remember
      ? { color: style.color, width: style.width, opacity: style.opacity, ...(hasFill(tool) && style.fill ? { fill: style.fill } : {}) }
      : undefined;
    this.patch({
      drawStyle: style,
      ...(own ? { toolStyles: { ...this.ui.toolStyles, [tool as StyledTool]: own } } : {}),
    });
    this.saveStyles();
  }

  private restyle(a: Exclude<Annotation, StampAnnot>, patch: Partial<DrawStyle>): void {
    const color = patch.color ?? a.color;
    switch (a.type) {
      case 'freetext': {
        const next = fitFreeText({ ...a, color, fontSize: patch.fontSize ?? a.fontSize, fontFamily: patch.fontFamily ?? a.fontFamily, opacity: patch.opacity ?? a.opacity });
        if (next !== a && JSON.stringify(next) !== JSON.stringify(a)) this.updateAnnotation(next);
        return;
      }
      case 'ink':
        if (color !== a.color || (patch.width !== undefined && patch.width !== a.width) || (patch.opacity !== undefined && patch.opacity !== a.opacity)) {
          this.updateAnnotation({ ...a, color, width: patch.width ?? a.width, opacity: patch.opacity ?? a.opacity });
        }
        return;
      case 'shape': {
        const next: ShapeAnnot = { ...a, color, width: patch.width ?? a.width, opacity: patch.opacity ?? a.opacity };
        if ('fill' in patch) {
          if (patch.fill && !a.line) next.fill = patch.fill;
          else delete next.fill;
        }
        this.updateAnnotation(next);
        return;
      }
      case 'note':
        // A note's icon has a colour and nothing else to change here.
        if (patch.color) this.updateAnnotation({ ...a, color: patch.color });
        return;
      default:
        // Highlights, underlines and strikeouts: colour and transparency.
        if (patch.color || patch.opacity !== undefined) this.updateAnnotation({ ...a, color: patch.color ?? a.color, opacity: patch.opacity ?? a.opacity });
    }
  }

  /**
   * Chooses a colour from the palette, the recent colours or the custom picker. The colour it replaces joins the
   * recent ones, so switching back is one click.
   */
  chooseColor(color: RGBA): void {
    const previous = this.restylable()?.color ?? this.ui.drawStyle.color;
    this.patch({ recentColors: nextRecent(this.ui.recentColors, previous, color) });
    this.setDrawStyle({ color });
    this.saveStyles(); // (restyling a selection changes the recent colours too)
  }

  // ---- Notes and comments ------------------------------------------------------------

  /** Start a note at `position` (its upper-left corner, PDF user space). Saved by `saveDraftNote`. */
  beginNote(pageId: PageId, position: Point): void {
    this.patch({ draftNote: { pageId, position }, commentsOpen: true, selectedAnnot: undefined });
  }

  cancelDraftNote(): void {
    this.patch({ draftNote: undefined });
  }

  /** Turns the draft into a note carrying `text`. Empty text creates nothing. */
  saveDraftNote(text: string): AnnotId | undefined {
    const draft = this.ui.draftNote;
    const body = text.trim();
    if (!draft || !body) return undefined;
    const id = this.addDrawn({
      type: 'note', pageId: draft.pageId, position: draft.position, icon: 'note', color: this.ui.toolStyles.note.color,
      comment: { text: body, replies: [] },
    });
    this.patch({ draftNote: undefined, selectedAnnot: { pageId: draft.pageId, id } });
    return id;
  }

  /** Sets (or, when empty, clears) the comment on any annotation. Replies are kept while there is text. */
  setComment(pageId: PageId, annotId: AnnotId, text: string): void {
    this.changeComment(pageId, annotId, (c) => {
      const body = text.trim();
      if (!body) return undefined;
      if (c?.text === body) return c; // unchanged: no update, no undo step
      return { text: body, replies: c?.replies ?? [] };
    });
  }

  /** Removes the comment and its replies. (A note is deleted as a whole instead.) */
  removeComment(pageId: PageId, annotId: AnnotId): void {
    this.changeComment(pageId, annotId, () => undefined);
  }

  addReply(pageId: PageId, annotId: AnnotId, text: string): void {
    const body = text.trim();
    if (!body) return;
    const reply = { id: this.newId(), author: this.author, createdAt: new Date().toISOString(), text: body };
    this.changeComment(pageId, annotId, (c) => (c ? { ...c, replies: [...c.replies, reply] } : c));
  }

  editReply(pageId: PageId, annotId: AnnotId, replyId: string, text: string): void {
    const body = text.trim();
    if (!body) return;
    this.changeComment(pageId, annotId, (c) => c && { ...c, replies: c.replies.map((r) => (r.id === replyId ? { ...r, text: body } : r)) });
  }

  deleteReply(pageId: PageId, annotId: AnnotId, replyId: string): void {
    this.changeComment(pageId, annotId, (c) => c && { ...c, replies: c.replies.filter((r) => r.id !== replyId) });
  }

  /** Removes one annotation (comments and replies go with it). */
  deleteAnnotation(pageId: PageId, annotId: AnnotId): void {
    if (isImportedId(annotId)) return this.deleteImported(pageId, annotId);
    if (this.ui.selectedAnnot?.id === annotId) this.patch({ selectedAnnot: undefined });
    this.history.execute(removeAnnotation(pageId, annotId));
  }

  private changeComment(pageId: PageId, annotId: AnnotId, change: (c: AnnotComment | undefined) => AnnotComment | undefined): void {
    const a = this.history.current.annotations[pageId]?.find((x) => x.id === annotId);
    if (!a) return;
    const comment = change(a.comment);
    if (comment === a.comment) return;
    const { comment: _old, ...rest } = a;
    this.updateAnnotation((comment ? { ...rest, comment } : rest) as Annotation);
  }

  toggleComments(open = !this.ui.commentsOpen): void {
    this.patch({ commentsOpen: open });
  }

  /** The name shown on new comments and replies. Remembered across sessions. */
  setAuthor(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || trimmed === this.author) return;
    this.author = trimmed;
    void this.deps.platform.secure?.set('author', trimmed);
    this.emit();
  }

  getAuthor(): string {
    return this.author;
  }

  /** One markup per page for a selection that may span several pages, as a single undo step. */
  addMarkups(type: MarkupType, marks: readonly { pageId: PageId; quads: Quad[] }[]): AnnotId[] {
    const now = new Date().toISOString();
    const made = marks
      .filter((m) => m.quads.length > 0)
      .map((m) => ({
        pageId: m.pageId,
        annot: {
          type, id: this.newId(), pageId: m.pageId, author: this.author, createdAt: now, modifiedAt: now,
          color: this.ui.toolStyles[type].color, opacity: this.ui.toolStyles[type].opacity, origin: 'app' as const, quads: m.quads,
        },
      }));
    if (made.length === 0) return [];
    this.history.execute(batch(type === 'highlight' ? 'Highlight text' : type === 'underline' ? 'Underline text' : 'Strike out text', made.map((x) => addAnnotation(x.annot))));
    return made.map((x) => x.annot.id);
  }

  selectAnnotation(sel: { pageId: PageId; id: AnnotId } | undefined): void {
    this.patch({ selectedAnnot: sel });
  }

  deleteSelectedAnnotation(): void {
    const sel = this.ui.selectedAnnot;
    if (!sel) return;
    if (isImportedId(sel.id)) return this.deleteImported(sel.pageId, sel.id);
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
    // The Signature tool needs a signature to place: if none is chosen yet, offer the dialog to make or pick one.
    const needsChoice = tool === 'signature' && !this.ui.signatures.some((s) => s.id === this.ui.activeSignature);
    // A tool draws with its own colour and thickness, as it was last set.
    const own = isStyledTool(tool) ? this.ui.toolStyles[tool] : undefined;
    const drawn: Partial<DrawStyle> = own ? { color: own.color, width: own.width, opacity: own.opacity, fill: own.fill } : {};
    // Choosing another tool lets go of the selected annotation, so the options box shows that tool's style again
    // (and a colour picked for it cannot restyle an annotation chosen earlier).
    const keepSelection = tool === 'select' || tool === this.ui.activeTool;
    this.patch({
      activeTool: tool,
      ...(keepSelection ? {} : { selectedAnnot: undefined }),
      ...(needsChoice ? { signatureDialog: true } : {}),
      ...(own ? { drawStyle: withoutEmptyFill({ ...this.ui.drawStyle, ...drawn }) } : {}),
    });
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
    if (sa) {
      const stillThere = isImportedId(sa.id)
        ? this.importedView()[sa.pageId]?.some((a) => a.id === sa.id)
        : this.history.current.annotations[sa.pageId]?.some((a) => a.id === sa.id);
      if (!stillThere) patch.selectedAnnot = undefined;
    }
    this.ui = { ...this.ui, ...patch };
  }

  private patch(p: Partial<UiState>): void {
    this.ui = { ...this.ui, ...p };
    this.emit();
  }

  private rebuild(): void {
    const h = this.history;
    this.snap = {
      doc: h.current, imported: this.importedView(), ui: this.ui, canUndo: h.canUndo, canRedo: h.canRedo,
      undoLabel: h.undoLabel, redoLabel: h.redoLabel,
    };
  }

  // ---- Annotations that came with the source files -------------------------------------------------

  /** Raw annotations per source, per source page index. Facts about the files, so not part of the undo history. */
  private sourceAnnots = new Map<SourceId, Map<number, SourceAnnotation[]>>();
  private sourceAnnotsVersion = 0;
  private importedCache?: { pages: unknown; removed: unknown; version: number; value: Record<PageId, readonly Annotation[]> };

  /** Reads every page's annotations in the background, a page at a time so the UI is never held up. */
  private async loadSourceAnnotations(sourceId: SourceId, pageCount: number): Promise<void> {
    const rd = this.renderDocs.get(sourceId);
    if (!rd) return;
    const perPage = new Map<number, SourceAnnotation[]>();
    this.sourceAnnots.set(sourceId, perPage);
    for (let i = 0; i < pageCount; i++) {
      try {
        const list = await rd.getSourceAnnotations(i);
        if (list.length > 0) perPage.set(i, list);
      } catch {
        /* a page whose annotations cannot be read simply shows none */
      }
      if (i % 10 === 9 || i === pageCount - 1) {
        this.sourceAnnotsVersion++;
        this.emit();
      }
    }
  }

  private importedView(): Record<PageId, readonly Annotation[]> {
    const doc = this.history.current;
    const c = this.importedCache;
    if (c && c.pages === doc.pages && c.removed === doc.removedImported && c.version === this.sourceAnnotsVersion) return c.value;
    const value: Record<PageId, readonly Annotation[]> = {};
    for (const page of doc.pages) {
      const raw = this.sourceAnnots.get(page.sourceId)?.get(page.sourceIndex);
      if (!raw?.length) continue;
      const gone = new Set(doc.removedImported[page.id] ?? []);
      const list = importedAnnotations(raw.filter((a) => !gone.has(a.id)), page.id);
      if (list.length > 0) value[page.id] = list;
    }
    this.importedCache = { pages: doc.pages, removed: doc.removedImported, version: this.sourceAnnotsVersion, value };
    return value;
  }

  /** Deletes an original annotation and the replies under it. They stay in the source file and are left out on save. */
  private deleteImported(pageId: PageId, annotId: AnnotId): void {
    const page = this.history.current.pages.find((p) => p.id === pageId);
    const raw = page && this.sourceAnnots.get(page.sourceId)?.get(page.sourceIndex);
    if (!raw || !this.importedView()[pageId]?.some((a) => a.id === annotId)) return; // not there (or already deleted)
    if (this.ui.selectedAnnot?.id === annotId) this.patch({ selectedAnnot: undefined });
    this.history.execute(removeImportedAnnotations(pageId, idsToRemove(raw, annotId)));
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
