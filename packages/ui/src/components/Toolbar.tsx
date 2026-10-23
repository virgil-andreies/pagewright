import { useSnapshot, useUi } from '../react';
import type { ToolId } from '../store';

const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'highlight', label: 'Highlight', key: 'H' },
  { id: 'underline', label: 'Underline', key: 'U' },
  { id: 'strikeout', label: 'Strikeout', key: 'S' },
];

export function Toolbar() {
  const { store } = useUi();
  const { doc, ui, canUndo, canRedo, undoLabel, redoLabel } = useSnapshot();
  const hasPages = doc.pages.length > 0;
  const hasSel = ui.selection.size > 0;
  const busy = !!ui.busy;

  const open = async () => store.addFiles(await store.platform.fs.pickFiles({ multiple: true, accept: ['.pdf', 'application/pdf'] }));

  return (
    <div className="toolbar" role="toolbar" aria-label="Main">
      <div className="group">
        <button onClick={() => void open()} disabled={busy}>Open</button>
        <button onClick={() => void store.save()} disabled={!hasPages || busy} className="primary">Save</button>
      </div>
      <div className="group">
        <button onClick={() => store.undo()} disabled={!canUndo} title={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Undo'}>Undo</button>
        <button onClick={() => store.redo()} disabled={!canRedo} title={redoLabel ? `Redo ${redoLabel} (Ctrl+Y)` : 'Redo'}>Redo</button>
      </div>
      <div className="group" aria-label="Page actions">
        <button onClick={() => store.rotatePages(-90)} disabled={!hasSel} title="Rotate left">⟲</button>
        <button onClick={() => store.rotatePages(90)} disabled={!hasSel} title="Rotate right">⟳</button>
        <button onClick={() => store.duplicatePages()} disabled={!hasSel}>Duplicate</button>
        <button onClick={() => store.deletePages()} disabled={!hasSel}>Delete</button>
        <button onClick={() => void store.extract()} disabled={!hasSel || busy}>Extract</button>
      </div>
      <div className="group" role="radiogroup" aria-label="Tool">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            role="radio"
            aria-checked={ui.activeTool === t.id}
            className={ui.activeTool === t.id ? 'active' : ''}
            onClick={() => store.setTool(t.id)}
            disabled={!hasPages}
            title={`${t.label} (${t.key})`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="group zoom">
        <button onClick={() => store.setZoom(ui.zoom / 1.25)} disabled={!hasPages} aria-label="Zoom out">−</button>
        <button onClick={() => store.setZoom(1)} disabled={!hasPages} aria-label="Reset zoom">{Math.round(ui.zoom * 100)}%</button>
        <button onClick={() => store.setZoom(ui.zoom * 1.25)} disabled={!hasPages} aria-label="Zoom in">+</button>
      </div>
      <div className="status" aria-live="polite">
        {ui.busy ? (
          <>
            {`${ui.busy}${ui.progress ? ` ${ui.progress.phase} ${ui.progress.done}/${ui.progress.total}` : '…'}`}{' '}
            {(ui.busy === 'Saving' || ui.busy === 'Extracting') && <button onClick={() => store.cancelSave()}>Cancel</button>}
          </>
        ) : hasPages
            ? `Page ${ui.currentPage + 1} of ${doc.pages.length}${doc.dirty ? ' • unsaved changes' : ''}`
            : ''}
      </div>
    </div>
  );
}
