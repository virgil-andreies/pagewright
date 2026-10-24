import type { ButtonHTMLAttributes, ReactNode } from 'react';
import {
  Copy, Ellipse, FileDown, FolderOpen, Highlighter, MessageSquare, MousePointer2, MoveUpRight, PenLine, RectangleHorizontal, Redo2,
  RotateCcw, RotateCw, Save, Signature, Slash, Stamp, StickyNote, Strikethrough, Trash, Type, Underline, Undo2, ZoomIn, ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import { FONT_SIZES, STAMP_PRESETS, type FontFamily, type RGBA } from '@pagewright/core';
import { listThreads } from '../comments';
import { applySelectionMarkup, hasSelection } from '../selection';
import { useSnapshot, useUi } from '../react';
import type { ToolId } from '../store';

interface Tool { id: ToolId; label: string; key: string; icon: LucideIcon }

/** The tools, in groups with a caption each. Icons are Lucide's (ISC licence), drawn in the text colour. */
const TOOL_GROUPS: { name: string; tools: Tool[] }[] = [
  { name: 'Select', tools: [{ id: 'select', label: 'Select', key: 'V', icon: MousePointer2 }] },
  {
    name: 'Mark text',
    tools: [
      { id: 'highlight', label: 'Highlight', key: 'H', icon: Highlighter },
      { id: 'underline', label: 'Underline', key: 'U', icon: Underline },
      { id: 'strikeout', label: 'Strikeout', key: 'S', icon: Strikethrough },
    ],
  },
  {
    name: 'Draw',
    tools: [
      { id: 'ink', label: 'Pen', key: 'P', icon: PenLine },
      { id: 'rect', label: 'Rectangle', key: 'R', icon: RectangleHorizontal },
      { id: 'ellipse', label: 'Ellipse', key: 'E', icon: Ellipse },
      { id: 'line', label: 'Line', key: 'L', icon: Slash },
      { id: 'arrow', label: 'Arrow', key: 'A', icon: MoveUpRight },
    ],
  },
  {
    name: 'Add',
    tools: [
      { id: 'note', label: 'Note', key: 'N', icon: StickyNote },
      { id: 'text', label: 'Text', key: 'T', icon: Type },
      { id: 'stamp', label: 'Stamp', key: 'K', icon: Stamp },
      { id: 'signature', label: 'Sign', key: 'G', icon: Signature },
    ],
  },
];

const ICON = { size: 20, strokeWidth: 1.8, 'aria-hidden': true } as const;

/**
 * A button shown as an icon only. Its name (what screen readers say, and what tests find it by) is `label`;
 * `tip` is the tooltip, which can say more, such as the shortcut.
 */
function IconButton({ icon: Icon, label, tip, ...rest }: { icon: LucideIcon; label: string; tip?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`icon tip ${rest.className ?? ''}`.trim()} aria-label={label} data-tip={tip ?? label}>
      <Icon {...ICON} />
    </button>
  );
}

/** A button with an icon before its text. */
function LabelButton({ icon: Icon, children, ...rest }: { icon: LucideIcon; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`with-icon ${rest.className ?? ''}`.trim()}>
      <Icon {...ICON} />
      {children}
    </button>
  );
}

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
const FAMILIES: { id: FontFamily; label: string }[] = [
  { id: 'sans', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' },
];

/** Which stamp the Stamp tool places, and, with a stamp selected, which one it is. */
/** The select's value for a chosen picture: not a preset name, which are plain words. */
const IMAGE_OPTION = ':picture';

function StampControls() {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const sel = ui.selectedAnnot && doc.annotations[ui.selectedAnnot.pageId]?.find((a) => a.id === ui.selectedAnnot!.id);
  const stamp = sel?.type === 'stamp' && sel.origin === 'app' && sel.payload.kind === 'preset' ? sel : undefined;
  if (!stamp && ui.activeTool !== 'stamp') return null;
  // A selected stamp shows (and changes) its own type; otherwise this is what the tool places next.
  const image = !stamp && ui.stampImage;
  const current = stamp?.payload.kind === 'preset' ? stamp.payload.name : image ? IMAGE_OPTION : ui.stampPreset;
  return (
    <div className="group" aria-label="Stamp">
      <select aria-label="Stamp type" value={current} onChange={(e) => e.target.value !== IMAGE_OPTION && store.setStampPreset(e.target.value)}>
        {STAMP_PRESETS.map((p) => (
          <option key={p.name} value={p.name}>{p.label}</option>
        ))}
        {image && <option value={IMAGE_OPTION}>Picture: {image.name}</option>}
      </select>
      {!stamp && store.canAddImages && (
        <button onClick={() => void store.chooseStampImage()} disabled={ui.stampImageLoading} title="Use a PNG or JPEG picture as a stamp">
          {ui.stampImageLoading ? 'Preparing…' : 'Picture…'}
        </button>
      )}
    </div>
  );
}

/** Which saved signature the Sign tool places, and a way to make or remove them. */
function SignatureControls() {
  const { store } = useUi();
  const { ui } = useSnapshot();
  if (ui.activeTool !== 'signature') return null;
  return (
    <div className="group" aria-label="Signature">
      {ui.signatures.length > 0 && (
        <select aria-label="Signature" value={ui.activeSignature ?? ''} onChange={(e) => store.useSignature(e.target.value)}>
          {ui.activeSignature === undefined && <option value="">Choose…</option>}
          {ui.signatures.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      )}
      <button onClick={() => store.openSignatures()}>Signatures…</button>
    </div>
  );
}

/**
 * Colour and line width (or, for text, font and size). Shown while a drawing or text tool is active, or when
 * an ink, shape or text annotation is selected. Changing it also restyles the selection.
 */
function StyleControls() {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const sel = ui.selectedAnnot && doc.annotations[ui.selectedAnnot.pageId]?.find((a) => a.id === ui.selectedAnnot!.id);
  const styled = sel && (sel.type === 'ink' || sel.type === 'shape' || sel.type === 'freetext') ? sel : undefined;
  const textual = styled ? styled.type === 'freetext' : ui.activeTool === 'text';
  if (!styled && !DRAWING.includes(ui.activeTool) && ui.activeTool !== 'text') return null;
  const current = styled ?? ui.drawStyle;
  const font = styled?.type === 'freetext' ? styled : ui.drawStyle;

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
      {textual
        ? (
          <>
            {FAMILIES.map((f) => (
              <button key={f.id} aria-label={`Font ${f.label}`} aria-pressed={font.fontFamily === f.id} onClick={() => store.setDrawStyle({ fontFamily: f.id })}>
                {f.label}
              </button>
            ))}
            <select aria-label="Font size" value={font.fontSize} onChange={(e) => store.setDrawStyle({ fontSize: Number(e.target.value) })}>
              {[...FONT_SIZES, ...(FONT_SIZES.includes(font.fontSize as never) ? [] : [font.fontSize])].sort((a, b) => a - b).map((s) => (
                <option key={s} value={s}>{s} pt</option>
              ))}
            </select>
          </>
        )
        : WIDTHS.map((w) => (
          <button key={w} aria-label={`Width ${w}`} aria-pressed={'width' in current && current.width === w} onClick={() => store.setDrawStyle({ width: w })}>
            {w}
          </button>
        ))}
    </div>
  );
}

export function Toolbar() {
  const { store, pages } = useUi();
  const { doc, ui, imported, canUndo, canRedo, undoLabel, redoLabel } = useSnapshot();
  const hasPages = doc.pages.length > 0;
  const hasSel = ui.selection.size > 0;
  const busy = !!ui.busy;
  const threadCount = listThreads(doc, imported).length;

  const open = async () => store.addFiles(await store.platform.fs.pickFiles({ multiple: true, accept: ['.pdf', 'application/pdf'] }));
  const pick = (id: ToolId) => {
    store.setTool(id);
    // Choosing a markup tool while text is selected marks that selection straight away.
    if ((id === 'highlight' || id === 'underline' || id === 'strikeout') && hasSelection()) applySelectionMarkup(store, pages, id);
  };

  return (
    <div className="toolbar" role="toolbar" aria-label="Main">
      <div className="toolbar-row">
        <div className="group">
          <LabelButton icon={FolderOpen} onClick={() => void open()} disabled={busy}>Open</LabelButton>
          <LabelButton icon={Save} onClick={() => void store.save()} disabled={!hasPages || busy} className="primary">Save</LabelButton>
        </div>
        <div className="group">
          <IconButton icon={Undo2} label="Undo" tip={undoLabel ? `Undo ${undoLabel} (Ctrl+Z)` : 'Undo (Ctrl+Z)'} onClick={() => store.undo()} disabled={!canUndo} />
          <IconButton icon={Redo2} label="Redo" tip={redoLabel ? `Redo ${redoLabel} (Ctrl+Y)` : 'Redo (Ctrl+Y)'} onClick={() => store.redo()} disabled={!canRedo} />
        </div>
        <div className="group" role="group" aria-label="Page actions">
          <span className="caption" aria-hidden="true">Pages</span>
          <IconButton icon={RotateCcw} label="Rotate left" onClick={() => store.rotatePages(-90)} disabled={!hasSel} />
          <IconButton icon={RotateCw} label="Rotate right" onClick={() => store.rotatePages(90)} disabled={!hasSel} />
          <IconButton icon={Copy} label="Duplicate" onClick={() => store.duplicatePages()} disabled={!hasSel} />
          <IconButton icon={FileDown} label="Extract" tip="Extract to a new PDF" onClick={() => void store.extract()} disabled={!hasSel || busy} />
          <IconButton icon={Trash} label="Delete" tip="Delete (Del)" onClick={() => store.deletePages()} disabled={!hasSel} />
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
        <div className="group zoom">
          <IconButton icon={ZoomOut} label="Zoom out" onClick={() => store.setZoom(ui.zoom / 1.25)} disabled={!hasPages} />
          <button onClick={() => store.setZoom(1)} disabled={!hasPages} aria-label="Reset zoom" className="zoom-level">{Math.round(ui.zoom * 100)}%</button>
          <IconButton icon={ZoomIn} label="Zoom in" onClick={() => store.setZoom(ui.zoom * 1.25)} disabled={!hasPages} />
        </div>
        <LabelButton
          icon={MessageSquare}
          aria-label={threadCount > 0 ? `Comments (${threadCount})` : 'Comments'}
          aria-pressed={ui.commentsOpen}
          className={ui.commentsOpen ? 'active' : ''}
          onClick={() => store.toggleComments()}
          disabled={!hasPages}
          title="Comments (C)"
        >
          <span className="label">Comments</span>
          {threadCount > 0 && <span className="badge" aria-hidden="true">{threadCount}</span>}
        </LabelButton>
      </div>
      <div className="toolbar-row tools-row">
        <div className="tool-groups" role="radiogroup" aria-label="Tool">
          {TOOL_GROUPS.map((g) => (
            <div key={g.name} className="tool-group" role="group" aria-label={g.name}>
              <div className="tiles">
                {g.tools.map(({ id, label, key, icon: Icon }) => (
                  <button
                    key={id}
                    role="radio"
                    aria-label={label}
                    aria-checked={ui.activeTool === id}
                    className={ui.activeTool === id ? 'tile active' : 'tile'}
                    onClick={() => pick(id)}
                    disabled={!hasPages}
                    title={`${label} (${key})`}
                  >
                    <span className="key" aria-hidden="true">{key}</span>
                    <Icon size={22} strokeWidth={1.8} aria-hidden />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <span className="caption" aria-hidden="true">{g.name}</span>
            </div>
          ))}
        </div>
        <div className="tool-options">
          <StyleControls />
          <StampControls />
          <SignatureControls />
        </div>
      </div>
    </div>
  );
}
