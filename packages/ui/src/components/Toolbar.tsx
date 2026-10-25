import type { ButtonHTMLAttributes, ReactNode } from 'react';
import {
  Copy, Ellipse, FileDown, FolderOpen, Highlighter, MessageSquare, MousePointer2, MoveUpRight, PenLine, RectangleHorizontal, Redo2,
  RotateCcw, RotateCw, Save, Signature, Slash, Stamp, StickyNote, Strikethrough, Trash, Type, Underline, Undo2, ZoomIn, ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import { FONT_SIZES, STAMP_PRESETS, type FontFamily } from '@pagewright/core';
import { listThreads } from '../comments';
import { applySelectionMarkup, hasSelection } from '../selection';
import { useSnapshot, useUi } from '../react';
import type { ToolId } from '../store';
import { hasThickness, isStyledTool } from '../tool-style';
import { ColourControl, ThicknessControl } from './StyleOptions';

interface Tool { id: ToolId; label: string; key: string; icon: LucideIcon }

/** The tools, in groups with a caption each. Icons are Lucide's (ISC licence), drawn in the text colour. */
export const TOOL_GROUPS: { name: string; tools: Tool[] }[] = [
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

export const ICON = { size: 20, strokeWidth: 1.8, 'aria-hidden': true } as const;

/**
 * A button shown as an icon only. Its name (what screen readers say, and what tests find it by) is `label`;
 * `tip` is the tooltip, which can say more, such as the shortcut.
 */
export function IconButton({ icon: Icon, label, tip, ...rest }: { icon: LucideIcon; label: string; tip?: string } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`icon tip ${rest.className ?? ''}`.trim()} aria-label={label} data-tip={tip ?? label}>
      <Icon {...ICON} />
    </button>
  );
}

/** A button with an icon before its text. */
export function LabelButton({ icon: Icon, children, ...rest }: { icon: LucideIcon; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`with-icon ${rest.className ?? ''}`.trim()}>
      <Icon {...ICON} />
      {children}
    </button>
  );
}

const FAMILIES: { id: FontFamily; label: string }[] = [
  { id: 'sans', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' },
];

/** Which stamp the Stamp tool places, and, with a stamp selected, which one it is. */
/** The select's value for a chosen picture: not a preset name, which are plain words. */
const IMAGE_OPTION = ':picture';

export function StampControls() {
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
export function SignatureControls() {
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
 * What the options show: the selected annotation's style if there is one (ours, or one that came with the PDF),
 * else the active tool's, with which controls apply and a hint when they do not. Shared by the desktop toolbar and
 * the phone dock.
 */
export function useToolOptions() {
  const { doc, ui, imported } = useSnapshot();
  const hasPages = doc.pages.length > 0;
  const at = ui.selectedAnnot;
  const sel = at && (doc.annotations[at.pageId]?.find((a) => a.id === at.id) ?? imported[at.pageId]?.find((a) => a.id === at.id));
  const editable = sel && sel.origin === 'app' && sel.type !== 'stamp';
  const tool = ui.activeTool;
  const color = sel && sel.type !== 'stamp' ? sel.color : ui.drawStyle.color;
  const lined = sel && (sel.type === 'ink' || sel.type === 'shape') ? sel : undefined;
  const width = lined ? lined.width : ui.drawStyle.width;
  const colourOn = hasPages && (sel ? !!editable : isStyledTool(tool));
  const thicknessOn = hasPages && (sel ? !!editable && !!lined : hasThickness(tool));
  const textual = !!(sel ? editable && sel.type === 'freetext' : tool === 'text');
  const font = sel?.type === 'freetext' ? sel : ui.drawStyle;
  const hint = sel
    ? sel.origin === 'imported'
      ? 'This came with the PDF: it can be selected, read and deleted, but not restyled.'
      : undefined
    : tool === 'select'
      ? 'Select an annotation to change its colour or thickness.'
      : tool === 'note'
        ? 'Click the page where the note should go.'
        : tool === 'highlight' || tool === 'underline' || tool === 'strikeout'
          ? 'Drag across the document’s text to mark it.'
          : undefined;
  return { hasPages, color, width, colourOn, thicknessOn, textual, font, hint, recent: ui.recentColors };
}

/** The font and size of the selected text box, or of the next one. */
export function FontControls({ font }: { font: { fontFamily: FontFamily; fontSize: number } }) {
  const { store } = useUi();
  return (
    <div className="group" role="group" aria-label="Font">
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
    </div>
  );
}

/** Chooses a tool; a markup tool chosen while text is selected marks that text straight away. */
export function usePickTool() {
  const { store, pages } = useUi();
  return (id: ToolId) => {
    store.setTool(id);
    if ((id === 'highlight' || id === 'underline' || id === 'strikeout') && hasSelection()) applySelectionMarkup(store, pages, id);
  };
}

/**
 * What the selected annotation, or else the active tool, looks like. It always starts with Colour and
 * Thickness, in the same place for every tool, greyed out where they do not apply, so nothing moves when you switch
 * tools; then the tool's own controls. Changing them also restyles the selection.
 */
function ToolOptions() {
  const { store } = useUi();
  const o = useToolOptions();

  // Three rows of fixed height (colour, thickness, then the tool's own controls or a hint), so selecting something
  // or switching tools never changes the toolbar's height: the page under it must not move between two clicks.
  return (
    <div className="tool-options">
      <div className="group style" role="group" aria-label="Line style">
        <div className={o.colourOn ? 'option-row' : 'option-row off'} title={o.colourOn ? undefined : o.hint}>
          <ColourControl color={o.color} recent={o.recent} disabled={!o.colourOn} onChoose={(c) => store.chooseColor(c)} />
        </div>
        <div className={o.thicknessOn ? 'option-row' : 'option-row off'} title={o.thicknessOn ? undefined : o.hint}>
          <ThicknessControl width={o.width} color={o.color} disabled={!o.thicknessOn} onChange={(w) => store.setDrawStyle({ width: w })} />
        </div>
      </div>
      <div className="option-row extra">
        {o.textual && <FontControls font={o.font} />}
        <StampControls />
        <SignatureControls />
        {o.hint && o.hasPages && <span className="options-hint" title={o.hint}>{o.hint}</span>}
      </div>
    </div>
  );
}

export function Toolbar() {
  const { store } = useUi();
  const { doc, ui, imported, canUndo, canRedo, undoLabel, redoLabel } = useSnapshot();
  const hasPages = doc.pages.length > 0;
  const hasSel = ui.selection.size > 0;
  const busy = !!ui.busy;
  const threadCount = listThreads(doc, imported).length;

  const open = async () => store.addFiles(await store.platform.fs.pickFiles({ multiple: true, accept: ['.pdf', 'application/pdf'] }));
  const pick = usePickTool();

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
        <ToolOptions />
      </div>
    </div>
  );
}
