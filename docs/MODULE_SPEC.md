# PDF App: Module Specification (v1)

Scope: Tier 1 (document structure) and Tier 2 (annotate and mark up).
Stack: TypeScript, PDF.js (render), pdf-lib fork (write), optional qpdf-wasm, Electron, Capacitor.

## 1. Goals and non-goals

**Goals**
- One TypeScript codebase for web, desktop (Electron), mobile (Capacitor).
- Non-destructive editing: sources are never modified; output is produced on save.
- Annotations written as real PDF annotations with appearance streams, so other viewers show them and they can be removed.
- Platform code isolated behind adapters so the shell (Electron/Tauri/Capacitor) is replaceable.

**Non-goals (v1)**
- Editing existing page text/images/layout.
- Cryptographic (PAdES) signatures. Visual signatures only.
- Editing annotations created by other tools. They can be selected, read (with their comment threads) and deleted, but not changed.
- Preserving bookmarks/outlines on merge.
- Saving encrypted PDFs (view only).
- Forms (AcroForm) editing.

## 2. Repository layout

pnpm workspaces monorepo. Dependency direction is strictly downward; `core` imports nothing platform- or DOM-related.

```
packages/
  core/          pure TS: model, commands, geometry, policies        (no DOM, no Node APIs)
  engine/        PdfRenderer (PDF.js), PdfWriter, AnnotationWriter    (browser + worker safe)
  platform/      adapter interfaces + web impl
  ui/            framework UI (React or Svelte), depends on core, engine, platform
apps/
  web/           Vite app, entry point
  desktop/       Electron shell, platform-electron impl
  mobile/        Capacitor shell, platform-capacitor impl
tests/
  corpus/        sample PDFs (see section 11)
  roundtrip/     automated open-edit-save-reopen tests
```

Rule: `core` and `engine` must not import from `platform`, `ui`, or `apps`. Enforce with an ESLint import-boundaries rule.

## 3. Core data model (`packages/core`)

All geometry is stored in **PDF user space** (points, origin bottom-left of the page's unrotated MediaBox/CropBox, see section 6).

```ts
export type SourceId = string;   // uuid per opened PDF
export type PageId = string;     // uuid per page instance in the working doc
export type AnnotId = string;    // uuid; also written to the PDF /NM entry

export interface SourceDoc {
  id: SourceId;
  name: string;
  data: SourceData;              // never mutated; { kind: 'memory', bytes } or { kind: 'blob', blob }.
                                 // Opened files are blob-backed (disk, not memory) and read by byte range.
                                 // The platform copies them to private storage (OPFS) first, so saving over
                                 // the original cannot break later lazy reads.
  pageCount: number;
  isEncrypted: boolean;
  hasDigitalSignature: boolean;
  password?: string;             // memory only, never persisted
}

export interface PageRef {
  id: PageId;
  sourceId: SourceId;
  sourceIndex: number;           // 0-based page index in the source
  rotation: 0 | 90 | 180 | 270;  // delta applied on top of the source /Rotate
}

export interface DocMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string[];
}

export interface WorkingDocument {
  sources: Record<SourceId, SourceDoc>;
  pages: PageRef[];                              // ordered; deleted pages are removed
  annotations: Record<PageId, Annotation[]>;     // insertion order = z-order
  removedImported: Record<PageId, string[]>;     // ids (PDF.js, e.g. "20R") of the source page's own annotations the user deleted
  metadata: DocMetadata;
  dirty: boolean;
}
```

### 3.1 Annotations

```ts
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }
export interface Quad { p1: Point; p2: Point; p3: Point; p4: Point } // PDF QuadPoints order

export interface RGBA { r: number; g: number; b: number; a: number } // 0..1

interface AnnotBase {
  id: AnnotId;
  pageId: PageId;
  author: string;
  createdAt: string;             // ISO 8601
  modifiedAt: string;
  color: RGBA;
  opacity: number;
  comment?: AnnotComment;        // any annotation may carry a comment
  origin: 'app' | 'imported';    // 'imported' => read-only in v1
}

export interface AnnotComment {
  text: string;
  replies: { id: string; author: string; createdAt: string; text: string }[];
}

export type Annotation =
  | HighlightAnnot | UnderlineAnnot | StrikeoutAnnot
  | InkAnnot | ShapeAnnot | NoteAnnot | FreeTextAnnot | StampAnnot;

export interface TextMarkupAnnot extends AnnotBase {
  quads: Quad[];
}
export interface HighlightAnnot extends TextMarkupAnnot { type: 'highlight' }
export interface UnderlineAnnot extends TextMarkupAnnot { type: 'underline' }
export interface StrikeoutAnnot extends TextMarkupAnnot { type: 'strikeout' }

export interface InkAnnot extends AnnotBase {
  type: 'ink';
  strokes: Point[][];            // simplified polylines
  width: number;                 // points
}

export interface ShapeAnnot extends AnnotBase {
  type: 'shape';
  shape: 'rect' | 'ellipse' | 'line' | 'arrow';
  rect: Rect;                    // for line/arrow: bounding rect
  line?: [Point, Point];
  width: number;
  fill?: RGBA;
}

export interface NoteAnnot extends AnnotBase {        // sticky note => /Text
  type: 'note';
  position: Point;
  icon: 'note' | 'comment';
}

export interface FreeTextAnnot extends AnnotBase {    // typed text on page => /FreeText
  type: 'freetext';
  rect: Rect;
  text: string;
  fontSize: number;
  fontFamily: 'sans' | 'serif' | 'mono';
}

export interface StampAnnot extends AnnotBase {       // stamps and visual signatures => /Stamp
  type: 'stamp';
  rect: Rect;
  kind: 'preset' | 'signature-drawn' | 'signature-typed' | 'image';
  payload:
    | { kind: 'preset'; name: string }
    | { kind: 'signature-drawn'; strokes: Point[][] }
    | { kind: 'signature-typed'; text: string; font: string }
    | { kind: 'image'; mime: 'image/png' | 'image/jpeg'; bytes: Uint8Array };
}
```

## 4. Commands and history (`packages/core`)

Every mutation is a command applied to `WorkingDocument`. Commands are pure and invertible.

```ts
export interface Command {
  readonly label: string;                       // for UI: "Rotate page", etc.
  apply(doc: WorkingDocument): WorkingDocument; // returns a new immutable snapshot
  invert(before: WorkingDocument): Command;     // returns the undo command
}

export class History {
  execute(cmd: Command): void;
  undo(): void;
  redo(): void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  subscribe(fn: () => void): () => void;
}
```

**Tier 1 commands**: `ReorderPages`, `DeletePages`, `DuplicatePages` (clones page refs and their annotations with new ids), `RotatePages`, `AddSource` (merge: appends pages from a new source at an index), `SetMetadata`.
**Extract / split** are not commands. They are read-only exports: `selectPages(doc, pageIds) -> WorkingDocument`, then a normal save.
**Tier 2 commands**: `AddAnnotation`, `UpdateAnnotation`, `RemoveAnnotation`, `ReorderAnnotation`.

Coalescing: continuous gestures (drag, ink stroke, resize) emit one command on pointer-up, not per move.

## 5. Engine interfaces (`packages/engine`)

### 5.1 Renderer

```ts
export interface PdfRenderer {
  open(source: SourceDoc): Promise<RenderDoc>;   // may throw PasswordRequired
}

export interface RenderDoc {
  readonly sourceId: SourceId;
  getPageInfo(index: number): Promise<PageInfo>;
  renderPage(index: number, opts: RenderOpts, signal?: AbortSignal): Promise<RenderResult>;
  getTextContent(index: number): Promise<TextRun[]>;     // raw text runs (search, later)
  renderTextLayer(index: number, opts: TextLayerOpts, signal?: AbortSignal): Promise<void>; // selectable text over the page
  getExistingAnnotations(index: number): Promise<ImportedAnnotMeta[]>;
  getSourceAnnotations(index: number): Promise<SourceAnnotation[]>;  // the page's own annotations, in detail, for select/read/delete
  destroy(): void;
}

export interface PageInfo {
  width: number; height: number;       // points, after /Rotate
  rotation: 0 | 90 | 180 | 270;        // intrinsic /Rotate of the source page
  mediaBox: Rect; cropBox: Rect;
  userUnit: number;
}

export interface RenderOpts {
  scale: number;
  extraRotation: 0 | 90 | 180 | 270;   // PageRef.rotation
  withAnnotations: 'none' | 'source';  // never render our own via PDF.js; we draw an overlay
  hideAnnotations?: string[];          // source annotation ids to leave out of the picture (the deleted ones)
  target: HTMLCanvasElement | OffscreenCanvas;
}

export interface TextRun {
  text: string;
  quad: Quad;                          // PDF user space
  charBoxes?: Rect[];                  // for precise selection
}
```

Rendering rules:
- Thumbnails and full pages share one `RenderQueue` with priorities (visible > near > thumbnails), cancellation via `AbortSignal`, and canvas pooling.
- Pages outside the viewport window (current +/- 2) release their canvases.
- Our own annotations are drawn by the UI overlay (SVG/canvas), not by PDF.js, so editing is instant and independent of the PDF.

### 5.2 Writer

```ts
export interface PdfWriter {
  save(doc: WorkingDocument, opts: SaveOpts, onProgress?: (p: Progress) => void): Promise<Uint8Array>;
}

export interface SaveOpts {
  flattenAnnotations: boolean;     // default false
  useObjectStreams: boolean;       // default true
  producer: string;
}

export type Progress = { phase: 'copy' | 'annotate' | 'serialize'; done: number; total: number };
```

### 5.3 Annotation writer

```ts
export interface AnnotationWriter {
  /** Adds `annot` to the pdf-lib page as a real annotation with /AP and /NM = annot.id. */
  write(ctx: WriteContext, pageIndex: number, annot: Annotation): void;
}

export interface AppearanceBuilder {
  /** Returns a Form XObject stream (bbox, matrix, resources, content). */
  build(ctx: WriteContext, annot: Annotation): AppearanceStream;
}
```

Annotation mapping:

| Model type | PDF subtype | Appearance notes |
|---|---|---|
| highlight | /Highlight | Multiply blend via ExtGState; fill quads |
| underline | /Underline | line at bottom edge of each quad |
| strikeout | /StrikeOut | line through quad mid-height |
| ink | /Ink | `/InkList`, round caps and joins |
| shape rect/ellipse | /Square, /Circle | stroke and optional fill |
| shape line/arrow | /Line | `/LE` for arrow end |
| note | /Text | standard icon drawn in AP |
| freetext | /FreeText | standard PDF font (Helvetica, Times or Courier, WinAnsi); wrapped text in AP; `/C` left out (it would be drawn as a background); `/Contents` is the text |
| stamp | /Stamp | image XObject or vector paths in AP |

**Annotations that came with the source file.** They are drawn by PDF.js in the page image and are never re-drawn or re-written by us. To let the user select, read and delete them, `getSourceAnnotations` reports each one in detail (read in the background after opening) and `importedAnnotations` maps it to our types with `origin: 'imported'`: replies are folded into the parent's comment thread; links, form fields and popups are not selectable. Deleting one records its id, and its replies' ids, in `WorkingDocument.removedImported` for that page instance (so a duplicated page has its own set; the command is undoable). On screen the deleted annotations are left out of the page image with PDF.js's `operationsFilter`, which skips the operations between that annotation's `beginAnnotation(id)` and `endAnnotation`. On save, `copyPageWithout` takes them (plus their popups and replies) out of the *source page's* `/Annots` before the page is copied, so nothing of them, including comment text, reaches the output.

Common entries on every annotation: `/Rect`, `/F` (print flag = 4), `/NM` (annot id), `/T` (author), `/M`, `/CreationDate`, `/C`, `/CA`, `/Contents` (comment text). Replies are `/Text` annotations with `/IRT` pointing at the parent and `/RT /R`.

## 6. Coordinate system (`packages/core/geometry`)

One module, heavily unit-tested. Everything else calls it.

```ts
export interface PageGeometry {
  cropBox: Rect;          // origin may be non-zero
  intrinsicRotation: 0 | 90 | 180 | 270;
  extraRotation: 0 | 90 | 180 | 270;
  userUnit: number;
}

export function viewportToPdf(g: PageGeometry, scale: number, p: Point): Point;
export function pdfToViewport(g: PageGeometry, scale: number, p: Point): Point;
export function rectToQuad(r: Rect): Quad;
export function transformQuad(q: Quad, m: Matrix): Quad;
```

Rules:
- Stored coordinates are in the page's **unrotated** user space relative to the CropBox origin plus its offset. Page rotation (intrinsic and extra) is applied only for display and when writing `/Rotate`.
- The writer sets `/Rotate = (intrinsic + extra) % 360`. Annotations need no change when pages rotate, which is why we store unrotated coordinates.
- Property tests: for random geometries, `viewportToPdf(pdfToViewport(p)) == p` within epsilon.

## 7. Save pipeline

```
save(doc):
  1. Preflight (core/policies): 
       - any signed source        -> require user confirmation (signatures invalidated)
       - any encrypted source     -> abort with EncryptedNotSupported
  2. Create output PDFDocument.
  3. For each source used: load once (pdf-lib), copyPages for the needed indices in order.
       Duplicated pages: copy once per occurrence (accept size bloat; dedupe in v1.1).
  4. Apply per-page rotation.
  5. For each page: write annotations (or draw them into content if flatten).
  6. Apply metadata. Set producer.
  7. Serialize (useObjectStreams).
  8. Verify: re-open output with PDF.js headless, check page count matches. Fail loudly otherwise.
```

Runs in a worker (`save.worker.ts`). Progress is reported per page. 

**Memory guard.** Opening and viewing are lazy and cheap. Saving is not: the pdf-lib pipeline loads every used source whole and builds the whole output, and measures about **4.5x the total size of the used sources** at its peak (299 MB scanned PDF: about 1.3 GB in Chrome, 1.5 GB in Node; deleting pages does not help because sources load whole). `preflight` therefore compares `SAVE_MEMORY_FACTOR x source size` with `DeviceInfo.memoryBudgetMB` (the most memory one save may use) and refuses with a message that names both numbers, instead of crashing the tab. The same check runs at open time, so a user learns at once that a document is view-and-markup only. Web budgets are derived from `navigator.deviceMemory`: 40% of it on desktop (clamped to 768 to 3072 MB), 30% on phones (512 to 1200 MB), which accepts roughly 360 MB of sources on a 4 GB desktop and 270 MB on a 4 GB phone.

**Known limit.** Phones cannot save sources above about 200 to 270 MB. Lifting this needs a page-copying writer that streams raw objects by byte range instead of loading the source (a custom writer, or qpdf-wasm, which is also memory-bound at about 2x).

## 8. Platform adapters (`packages/platform`)

```ts
export interface FileSystemAdapter {
  pickFiles(opts: { multiple: boolean; accept: string[] }): Promise<PickedFile[]>;
  saveFile(suggestedName: string, bytes: Uint8Array): Promise<SaveResult>;
  /** Called when the OS opens a file with the app ("Open with", drag onto icon, share target). */
  onOpenRequest(handler: (files: PickedFile[]) => void): () => void;
}

export interface PickedFile {
  name: string;
  size: number;
  read(): Promise<Uint8Array>;      // lazy
  handle?: unknown;                  // FileSystemFileHandle / path, for overwrite-in-place
}

export interface ShareAdapter { share(name: string, bytes: Uint8Array): Promise<void> }
export interface KeyValueStore { get<T>(k: string): Promise<T | undefined>; set(k: string, v: unknown): Promise<void> }
export interface SecureStore extends KeyValueStore {}   // signatures, author name
export interface DeviceInfo { platform: 'web' | 'desktop' | 'ios' | 'android'; memoryBudgetMB: number }
```

| Adapter | Web | Electron | Capacitor |
|---|---|---|---|
| FileSystem | File System Access API, fallback `<input>` + download | IPC to main process (`dialog`, `fs`), file associations | `@capawesome/capacitor-file-picker` + Filesystem; Share Target / document types in native config |
| Share | Web Share API / download | `shell.showItemInFolder` | `@capacitor/share` |
| SecureStore | IndexedDB | `safeStorage` | Keychain/Keystore plugin |

## 9. Workers

| Worker | Responsibility |
|---|---|
| `pdfjs.worker` | PDF.js standard worker (parse, render) |
| `save.worker` | the whole save pipeline (pdf-lib, qpdf-wasm) |
| `thumb.worker` | optional OffscreenCanvas thumbnail rendering |

Large byte arrays are transferred, not copied. Sources are held once in the main thread or a shared store. Workers receive transferable copies only when necessary.

## 10. UI modules (`packages/ui`)

- `AppShell`: toolbar, panels, responsive layout (desktop: sidebar + canvas; mobile: bottom sheet).
- `PageGrid`: virtualized thumbnails; drag-reorder (pointer events, touch-safe); multi-select; context actions.
- `Viewer`: continuous scroll, zoom/pinch, per-page layers: canvas -> text layer -> annotation overlay. The text layer is PDF.js's own, so selecting, double/triple-clicking and copying text is the browser's native selection. It takes the mouse only for the Select and text-markup tools (drawing, note and text tools need the click). A text-markup tool turns the selection into annotations when the mouse is released (or when the tool is chosen while text is selected): the browser's per-fragment rectangles are de-duplicated and merged into one quad per line, assigned to the page that contains them, and mapped to PDF space with that page's geometry; a selection spanning pages is one undo step.
- `AnnotationOverlay`: renders model annotations, handles tool input; one `Tool` class per annotation type:
  ```ts
  interface Tool {
    id: string;
    onPointerDown(e: ToolEvent): void;
    onPointerMove(e: ToolEvent): void;
    onPointerUp(e: ToolEvent): Command | null;   // commit via History
    cursor: string;
  }
  ```
- `CommentsPanel`, `SignatureManager` (create/store signatures), `MetadataDialog`, `MergeDialog`, `SaveDialog` (warnings, flatten option).
- State: a single store holding `History` + `WorkingDocument` + UI state. UI-only state (zoom, active tool, selection) is kept separate from the document and is not undoable.

## 11. Policies and errors (`packages/core/policies`)

```ts
export type AppError =
  | { code: 'PasswordRequired'; sourceId: SourceId }
  | { code: 'WrongPassword' }
  | { code: 'EncryptedNotSupported' }          // save/edit blocked in v1
  | { code: 'CorruptFile'; detail: string }
  | { code: 'OutOfMemoryRisk'; estimateMB: number }
  | { code: 'SignedDocumentWarning' }
  | { code: 'SaveVerificationFailed' };
```

Every error maps to a user-facing message and a recovery action. Non-fatal notices (outlines dropped on merge, signatures invalidated) are shown once per session.

## 12. Testing

**Unit (Vitest)**: geometry, commands and history, annotation model to PDF dictionary mapping, appearance stream content.
**Round-trip (Node + headless PDF.js)**: for each corpus file x each scenario (rotate, delete, reorder, merge, each annotation type): save, reopen, assert page count, rotation, annotation count, and that `/NM` ids survive.
**Corpus** (`tests/corpus`): scanned, 300 MB+, rotated pages, non-zero CropBox/MediaBox, UserUnit != 1, encrypted (owner and user passwords), digitally signed, form-heavy, CJK and RTL text, broken xref, pre-existing annotations from Acrobat/Preview.
**Visual regression**: render saved output with PDF.js and diff against golden images (tolerance for antialiasing).
**Manual viewer matrix** per release: Acrobat, macOS Preview, iOS Files/Quick Look, Chrome, Firefox, Foxit, one Android viewer. Checklist per annotation type: visible, correct position/rotation, removable, comment readable.
**Shell parity CI**: run the corpus round-trip in Electron and in WebView2/WKWebView (headless where possible) to keep the Tauri exit option open.

## 13. Milestones

**M0: Spike (1-2 weeks)**: gate for the whole project
- `core` model + `History`, `PageGrid` with reorder/delete/rotate, `AddSource` merge, save pipeline.
- One annotation (highlight) with a correct `/AP`; verify in the full viewer matrix.
- Evaluate PDF.js's built-in annotation editor vs. own overlay.
- Open a 300 MB scanned PDF on a mid-range iPhone and Android phone; measure memory and time.
- **Exit criteria**: highlight appears correctly in all matrix viewers; a 300 MB scanned file opens, scrolls and edits without a crash on desktop and phones, and saves on devices whose budget allows it (desktop: yes; phones: refused up front with a clear message, see the known limit in section 7); geometry tests pass on rotated and offset-CropBox pages.

**M1: Web v1**: Tier 1 complete; Tier 2: ink, shapes, notes/comments, freetext, stamps, signatures; policies and warnings; corpus round-trip CI.

**M2: Desktop**: Electron shell, file associations, overwrite-in-place, delta updates, installer signing.

**M3: Mobile**: Capacitor shell, share target / "Open in", memory tuning, touch/stylus polish, store submission.

**M4 (v1.1 candidates)**: Unicode free text (embed a font via fontkit and measure with it; v1 supports only the characters of the standard fonts, so Cyrillic, Greek, CJK and RTL text becomes `?`), encrypted save via qpdf-wasm, outline preservation on merge, editing imported annotations, page dedupe on duplicate, form filling.

## 14. Key risks and owners

| Risk | Mitigation | Checked in |
|---|---|---|
| Appearance streams render differently across viewers | Build `AppearanceBuilder` per type; viewer matrix | M0, every release |
| Mobile memory on large files | Workers, lazy render, memory guard, refuse early | M0, M3 |
| pdf-lib unmaintained | Use fork, pin version, isolate behind `PdfWriter`, qpdf-wasm fallback | M0 |
| Coordinate bugs on rotated/offset pages | Single geometry module + property tests + corpus | M0 |
| Users assume visual signatures are legally valid | Explicit UI labelling; PAdES deferred | M1 |
| Shell lock-in | `platform/` adapters only; shell parity CI | M2 |
