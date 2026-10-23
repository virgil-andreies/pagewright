import type { Annotation, PageId, WorkingDocument } from '@pagewright/core';

/** One conversation: an annotation that carries a comment, or a note (which exists to carry one). */
export interface Thread {
  pageId: PageId;
  /** 0-based position of the page in the document. */
  pageIndex: number;
  annot: Annotation;
}

/** Threads in reading order: page by page, and within a page in the order they were added. */
export function listThreads(doc: WorkingDocument): Thread[] {
  const threads: Thread[] = [];
  doc.pages.forEach((page, pageIndex) => {
    for (const annot of doc.annotations[page.id] ?? []) {
      if (annot.type === 'note' || annot.comment) threads.push({ pageId: page.id, pageIndex, annot });
    }
  });
  return threads;
}

const NAMES: Record<string, string> = {
  highlight: 'Highlight', underline: 'Underline', strikeout: 'Strikeout', ink: 'Drawing', note: 'Note',
  freetext: 'Text', stamp: 'Stamp', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Line', arrow: 'Arrow',
};

/** What to call an annotation in the UI. */
export function annotationName(a: Annotation): string {
  return NAMES[a.type === 'shape' ? a.shape : a.type] ?? 'Annotation';
}
