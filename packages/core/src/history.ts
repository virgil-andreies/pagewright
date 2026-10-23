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

interface Entry { cmd: Command; undo: Command }

export class History {
  private doc: WorkingDocument;
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private listeners = new Set<() => void>();

  constructor(initial: WorkingDocument) {
    this.doc = initial;
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
    this.undoStack.push({ cmd, undo: cmd.invert(before) });
    this.redoStack = [];
    this.doc = next;
    this.emit();
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.doc = entry.undo.apply(this.doc);
    this.redoStack.push(entry);
    this.emit();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.doc = entry.cmd.apply(this.doc);
    this.undoStack.push(entry);
    this.emit();
  }

  /** Call after a successful save. */
  markSaved(): void {
    this.doc = { ...this.doc, dirty: false };
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
