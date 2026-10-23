import type { RGBA } from '@pagewright/core';
import { listThreads } from '../comments';
import { useSnapshot, useUi } from '../react';
import type { ToolId } from '../store';

const TOOLS: { id: ToolId; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'highlight', label: 'Highlight', key: 'H' },
  { id: 'underline', label: 'Underline', key: 'U' },
  { id: 'strikeout', label: 'Strikeout', key: 'S' },
  { id: 'ink', label: 'Pen', key: 'P' },
  { id: 'rect', label: 'Rectangle', key: 'R' },
  { id: 'ellipse', label: 'Ellipse', key: 'E' },
  { id: 'line', label: 'Line', key: 'L' },
  { id: 'arrow', label: 'Arrow', key: 'A' },
  { id: 'note', label: 'Note', key: 'N' },
];

export const SWATCHES: { name: string; color: RGBA }[] = [
  { name: 'Red', color: { r: 0.86, g: 0.15, b: 0.15, a: 1 } },
  { name: 'Blue', color: { r: 0.15, g: 0.4, b: 0.9, a: 1 } },
  { name: 'Green', color: { r: 0.1, g: 0.6, b: 0.3, a: 1 } },
  { name: 'Orange', color: { r: 0.95, g: 0.55, b: 0.1, a: 1 } },
  { name: 'Black', color: { r: 0.1, g: 0.1, b: 0.1, a: 1 } },
];
export const WIDTHS = [1, 2, 4, 8];

const sameColor = (a: RGBA, b: RGBA) => a.r === b.r && a.g === b.g && a.b === b.b;
const DRAWING: readonly string[] = ['ink', 'rect', 'ellipse', 'line', 'arrow'];

/** Colour and line width. Shown while a drawing tool is active or an ink/shape annotation is selected. */
function StyleControls() {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const sel = ui.selectedAnnot && doc.annotations[ui.selectedAnnot.pageId]?.find((a) => a.id === ui.selectedAnnot!.id);
  const styled = sel && (sel.type === 'ink' || sel.type === 'shape') ? sel : undefined;
  if (!styled && !DRAWING.includes(ui.activeTool)) return null;
  const current = styled ?? ui.drawStyle;

  return (
    <div className="group style" aria-label="Line style">
      {SWATCHES.map((s) => (
        <button
          key={s.name}
          className="swatch"
          style={{ background: `rgb(${s.color.r * 255} ${s.color.g * 255} ${s.color.b * 255})` }}
          aria-label={s.name}
          aria-pressed={sameColor(current.color, s.color)}
          onClick={() => store.setDrawStyle({ color: s.color })}
        />
      ))}
      {WIDTHS.map((w) => (
        <button key={w} aria-label={`Width ${w}`} aria-pressed={current.width === w} onClick={() => store.setDrawStyle({ width: w })}>
          {w}
        </button>
      ))}
    </div>
  );
}

export function Toolbar() {
  const { store } = useUi();
  const { doc, ui, canUndo, canRedo, undoLabel, redoLabel } = useSnapshot();
  const hasPages = doc.pages.length > 0;
  const hasSel = ui.selection.size > 0;
  const busy = !!ui.busy;
  const threadCount = listThreads(doc).length;

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
      <StyleControls />
      <div className="group">
        <button aria-pressed={ui.commentsOpen} className={ui.commentsOpen ? 'active' : ''} onClick={() => store.toggleComments()} disabled={!hasPages} title="Comments (C)">
          Comments{threadCount > 0 ? ` (${threadCount})` : ''}
        </button>
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
