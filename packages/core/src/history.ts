import type { WorkingDocument } from './model';

export interface Command {
  readonly label: string;
  apply(doc: WorkingDocument): WorkingDocument;
  /** Returns the command that restores `before`. */
  invert(before: WorkingDocument): Command;
}

/** Generic inverse: jump back to a previous snapshot. Snapshots are immutable and share structure. */
export function restoreTo(before: WorkingDocument, label: string): Command {
  return {
    label,
    apply: () => ({ ...before, dirty: true }),
    invert: () => {
      throw new Error('restoreTo commands are not themselves inverted');
    },
  };
}

/** A step in the history: the command, its inverse, and the document it produced (redo restores exactly that). */
interface Entry { cmd: Command; undo: Command; after: WorkingDocument }

/** Whether two documents hold the same content (their parts are immutable, so the same parts mean the same content). */
function sameContent(a: WorkingDocument, b: WorkingDocument): boolean {
  return a.sources === b.sources && a.pages === b.pages && a.annotations === b.annotations
    && a.removedImported === b.removedImported && a.metadata === b.metadata;
}

export class History {
  private doc: WorkingDocument;
  /** The document as it was when last saved or opened: it has unsaved changes exactly when it differs from this. */
  private clean: WorkingDocument;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<() => void>();

  constructor(initial: WorkingDocument) {
    this.doc = initial;
    this.clean = initial;
  }

  /** `doc`, with `dirty` saying whether it differs from the clean point (so undoing back to it is not a change). */
  private settle(doc: WorkingDocument): WorkingDocument {
    const dirty = !sameContent(doc, this.clean);
    return doc.dirty === dirty ? doc : { ...doc, dirty };
  }

  get current(): WorkingDocument { return this.doc; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | undefined { return this.undoStack.at(-1)?.cmd.label; }
  get redoLabel(): string | undefined { return this.redoStack.at(-1)?.cmd.label; }

  execute(cmd: Command): void {
    const before = this.doc;
    const next = cmd.apply(before);
    if (next === before) return; // no-op commands leave no history entry
    this.undoStack.push({ cmd, undo: cmd.invert(before), after: next });
    this.redoStack = [];
    this.doc = this.settle(next);
    this.emit();
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.doc = this.settle(entry.undo.apply(this.doc));
    this.redoStack.push(entry);
    this.emit();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    // The same document as before the undo, not a fresh one: documents are immutable and history is linear, so it
    // is still valid, and it is recognised as the saved one if it was.
    this.doc = this.settle(entry.after);
    this.undoStack.push(entry);
    this.emit();
  }

  /**
   * Makes the current document the clean point: no unsaved changes now, and undoing or redoing back to it later
   * means none again. Call after a successful save, and after opening a file into an empty window.
   */
  markSaved(): void {
    this.doc = { ...this.doc, dirty: false };
    this.clean = this.doc;
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
