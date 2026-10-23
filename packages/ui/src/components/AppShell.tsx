import { useEffect, useMemo, type ReactNode } from 'react';
import { RenderQueue } from '@pagewright/engine';
import { UiContext, useSnapshot } from '../react';
import type { AppStore, ToolId } from '../store';
import { CommentsPanel } from './CommentsPanel';
import { Dialogs } from './Dialogs';
import { PageGrid } from './PageGrid';
import { Toolbar } from './Toolbar';
import { Viewer } from './Viewer';
import '../styles.css';

export function PagewrightProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  const value = useMemo(() => ({ store, queue: new RenderQueue({ concurrency: 2 }) }), [store]);
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

const TOOL_KEYS: Record<string, ToolId> = {
  v: 'select', h: 'highlight', u: 'underline', s: 'strikeout', p: 'ink', r: 'rect', e: 'ellipse', l: 'line', a: 'arrow', n: 'note', t: 'text',
};

function useShortcuts(store: AppStore) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') (e.preventDefault(), e.shiftKey ? store.redo() : store.undo());
      else if (mod && k === 'y') (e.preventDefault(), store.redo());
      else if (mod && k === 'a') (e.preventDefault(), store.selectAll());
      else if (mod && k === 's') (e.preventDefault(), void store.save());
      else if (mod && k === 'o') {
        e.preventDefault();
        void store.platform.fs.pickFiles({ multiple: true, accept: ['.pdf', 'application/pdf'] }).then((f) => store.addFiles(f));
      } else if (!mod && (k === 'delete' || k === 'backspace')) {
        if (store.getSnapshot().ui.selectedAnnot) store.deleteSelectedAnnotation();
        else store.deletePages();
      } else if (!mod && k === 'enter' && store.getSnapshot().ui.selectedAnnot) {
        // Enter on a selected text box edits it.
        const sel = store.getSnapshot().ui.selectedAnnot!;
        if (store.getSnapshot().doc.annotations[sel.pageId]?.some((a) => a.id === sel.id && a.type === 'freetext')) {
          e.preventDefault();
          store.editText(sel.pageId, sel.id);
        }
      } else if (k === 'escape') {
        store.selectAnnotation(undefined);
        store.clearSelection();
      } else if (!mod && k === 'c' && store.getSnapshot().doc.pages.length > 0) store.toggleComments();
      else if (!mod && TOOL_KEYS[k] && store.getSnapshot().doc.pages.length > 0) store.setTool(TOOL_KEYS[k]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store]);
}

function Shell({ store }: { store: AppStore }) {
  useShortcuts(store);
  const commentsOpen = useSnapshot().ui.commentsOpen;
  // Files opened via the OS or drag-and-drop.
  useEffect(() => store.platform.fs.onOpenRequest((files) => void store.addFiles(files)), [store]);

  return (
    <div className="app-shell">
      <Toolbar />
      <div className="body">
        <aside className="sidebar" aria-label="Pages">
          <PageGrid />
        </aside>
        <main className="main">
          <Viewer />
        </main>
        {commentsOpen && <CommentsPanel />}
      </div>
      <Dialogs />
    </div>
  );
}

export function AppShell({ store }: { store: AppStore }) {
  return (
    <PagewrightProvider store={store}>
      <Shell store={store} />
    </PagewrightProvider>
  );
}
