import type { Annotation } from '../annotations';
import { restoreTo, type Command } from '../history';
import {
  defaultIdGen,
  normalizeRotation,
  type DocMetadata,
  type IdGen,
  type PageId,
  type PageRef,
  type SourceDoc,
  type WorkingDocument,
  type AnnotId,
} from '../model';

function command(label: string, apply: (d: WorkingDocument) => WorkingDocument): Command {
  return {
    label,
    apply: (d) => {
      const next = apply(d);
      return next === d ? d : { ...next, dirty: true };
    },
    invert: (before) => restoreTo(before, `Undo ${label}`),
  };
}

function pick(doc: WorkingDocument, ids: readonly PageId[]): Set<PageId> {
  const known = new Set(doc.pages.map((p) => p.id));
  return new Set(ids.filter((id) => known.has(id)));
}

// ---- Tier 1: structure ----------------------------------------------------

/** Moves the given pages (keeping their relative order) so they start at `toIndex` of the remaining pages. */
export function reorderPages(ids: readonly PageId[], toIndex: number): Command {
  return command('Reorder pages', (d) => {
    const sel = pick(d, ids);
    if (sel.size === 0) return d;
    const moving = d.pages.filter((p) => sel.has(p.id));
    const rest = d.pages.filter((p) => !sel.has(p.id));
    const at = Math.max(0, Math.min(toIndex, rest.length));
    const pages = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
    return pages.every((p, i) => p === d.pages[i]) ? d : { ...d, pages };
  });
}

export function deletePages(ids: readonly PageId[]): Command {
  return command('Delete pages', (d) => {
    const sel = pick(d, ids);
    if (sel.size === 0) return d;
    const annotations = { ...d.annotations };
    for (const id of sel) delete annotations[id];
    return { ...d, pages: d.pages.filter((p) => !sel.has(p.id)), annotations };
  });
}

/** Inserts a copy of each selected page directly after it, cloning its annotations with fresh ids. */
export function duplicatePages(ids: readonly PageId[], newId: IdGen = defaultIdGen): Command {
  return command('Duplicate pages', (d) => {
    const sel = pick(d, ids);
    if (sel.size === 0) return d;
    const annotations: Record<PageId, readonly Annotation[]> = { ...d.annotations };
    const pages: PageRef[] = [];
    for (const p of d.pages) {
      pages.push(p);
      if (!sel.has(p.id)) continue;
      const copyId = newId();
      pages.push({ ...p, id: copyId });
      const src = d.annotations[p.id];
      if (src?.length) {
        annotations[copyId] = src.map((a) => ({ ...a, id: newId(), pageId: copyId }));
      }
    }
    return { ...d, pages, annotations };
  });
}

export function rotatePages(ids: readonly PageId[], deltaDegrees: number): Command {
  return command('Rotate pages', (d) => {
    const sel = pick(d, ids);
    if (sel.size === 0 || normalizeRotation(deltaDegrees) === 0) return d;
    return {
      ...d,
      pages: d.pages.map((p) =>
        sel.has(p.id) ? { ...p, rotation: normalizeRotation(p.rotation + deltaDegrees) } : p,
      ),
    };
  });
}

/** Merge: registers a new source and inserts all its pages at `atIndex` (default: end). */
export function addSource(source: SourceDoc, atIndex?: number, newId: IdGen = defaultIdGen): Command {
  return command('Add document', (d) => {
    if (d.sources[source.id]) return d;
    const added: PageRef[] = Array.from({ length: source.pageCount }, (_, i) => ({
      id: newId(),
      sourceId: source.id,
      sourceIndex: i,
      rotation: 0,
    }));
    const at = atIndex === undefined ? d.pages.length : Math.max(0, Math.min(atIndex, d.pages.length));
    return {
      ...d,
      sources: { ...d.sources, [source.id]: source },
      pages: [...d.pages.slice(0, at), ...added, ...d.pages.slice(at)],
    };
  });
}

export function setMetadata(patch: Partial<DocMetadata>): Command {
  return command('Edit properties', (d) => {
    const changed = (Object.keys(patch) as (keyof DocMetadata)[]).some((k) => patch[k] !== d.metadata[k]);
    return changed ? { ...d, metadata: { ...d.metadata, ...patch } } : d;
  });
}

// ---- Tier 2: annotations --------------------------------------------------

export function addAnnotation(annot: Annotation): Command {
  return command('Add annotation', (d) => {
    if (!d.pages.some((p) => p.id === annot.pageId)) return d;
    const list = d.annotations[annot.pageId] ?? [];
    if (list.some((a) => a.id === annot.id)) return d;
    return { ...d, annotations: { ...d.annotations, [annot.pageId]: [...list, annot] } };
  });
}

export function updateAnnotation(annot: Annotation): Command {
  return command('Edit annotation', (d) => {
    const list = d.annotations[annot.pageId];
    if (!list?.some((a) => a.id === annot.id)) return d;
    return {
      ...d,
      annotations: {
        ...d.annotations,
        [annot.pageId]: list.map((a) => (a.id === annot.id ? annot : a)),
      },
    };
  });
}

export function removeAnnotation(pageId: PageId, annotId: AnnotId): Command {
  return command('Remove annotation', (d) => {
    const list = d.annotations[pageId];
    if (!list?.some((a) => a.id === annotId)) return d;
    return { ...d, annotations: { ...d.annotations, [pageId]: list.filter((a) => a.id !== annotId) } };
  });
}

/** Moves an annotation to `toIndex` in its page's list (insertion order = z-order). */
export function reorderAnnotation(pageId: PageId, annotId: AnnotId, toIndex: number): Command {
  return command('Reorder annotation', (d) => {
    const list = d.annotations[pageId];
    const from = list?.findIndex((a) => a.id === annotId) ?? -1;
    if (!list || from < 0) return d;
    const to = Math.max(0, Math.min(list.length - 1, toIndex));
    if (to === from) return d;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    return { ...d, annotations: { ...d.annotations, [pageId]: next } };
  });
}

// ---- Read-only exports ----------------------------------------------------

/** Extract / split: a view of the document restricted to `ids`, in document order. Save it as usual. */
export function selectPages(doc: WorkingDocument, ids: readonly PageId[]): WorkingDocument {
  const sel = pick(doc, ids);
  const pages = doc.pages.filter((p) => sel.has(p.id));
  const usedSources = new Set(pages.map((p) => p.sourceId));
  return {
    ...doc,
    pages,
    sources: Object.fromEntries(Object.entries(doc.sources).filter(([id]) => usedSources.has(id))),
    annotations: Object.fromEntries(Object.entries(doc.annotations).filter(([id]) => sel.has(id))),
  };
}

/** Split into consecutive chunks of `size` pages. */
export function splitEvery(doc: WorkingDocument, size: number): WorkingDocument[] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be a positive integer');
  const out: WorkingDocument[] = [];
  for (let i = 0; i < doc.pages.length; i += size) {
    out.push(selectPages(doc, doc.pages.slice(i, i + size).map((p) => p.id)));
  }
  return out;
}
