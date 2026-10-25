import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ChevronDown, Copy, EllipsisVertical, FileDown, FolderOpen, MessageSquare, MoveHorizontal, Redo2, RotateCcw, RotateCw, Save, Trash, Undo2, X, ZoomIn,
  ZoomOut, type LucideIcon,
} from 'lucide-react';
import type { RGBA } from '@pagewright/core';
import { listThreads } from '../comments';
import { useSnapshot, useUi } from '../react';
import { ColourControl, FillControl, OpacityControl, ThicknessControl } from './StyleOptions';
import { FontControls, ICON, IconButton, SignatureControls, StampControls, TOOL_GROUPS, usePickTool, useToolOptions } from './Toolbar';

/** Screens this narrow get the phone layout: a slim top bar, and the tools and their options at the bottom. */
export const PHONE_QUERY = '(max-width: 720px)';

/** Whether a media query matches, kept up to date. False where there is no `matchMedia` (tests, old browsers). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window.matchMedia !== 'function') return () => {};
      const m = window.matchMedia(query);
      m.addEventListener('change', onChange);
      return () => m.removeEventListener('change', onChange);
    },
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}

const css = (c: RGBA) => `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)})`;

/**
 * The phone's top bar: only what is used now and then (open, save, undo, redo, comments), and More for the rest,
 * so it fits on one line.
 */
export function PhoneTopBar() {
  const { store } = useUi();
  const { doc, ui, imported, canUndo, canRedo, undoLabel, redoLabel } = useSnapshot();
  const [more, setMore] = useState(false);
  const hasPages = doc.pages.length > 0;
  const busy = !!ui.busy;
  const threads = listThreads(doc, imported).length;
  const open = async () => store.addFiles(await store.platform.fs.pickFiles({ multiple: true, accept: ['.pdf', 'application/pdf'] }));
  return (
    <div className="toolbar phone-top" role="toolbar" aria-label="Main">
      <IconButton icon={FolderOpen} label="Open" onClick={() => void open()} disabled={busy} />
      <button onClick={() => void store.save()} disabled={!hasPages || busy} className="with-icon primary">
        <Save {...ICON} />
        Save
      </button>
      <span className="phone-divider" aria-hidden="true" />
      <IconButton icon={Undo2} label="Undo" tip={undoLabel ? `Undo ${undoLabel}` : 'Undo'} onClick={() => store.undo()} disabled={!canUndo} />
      <IconButton icon={Redo2} label="Redo" tip={redoLabel ? `Redo ${redoLabel}` : 'Redo'} onClick={() => store.redo()} disabled={!canRedo} />
      <span className="phone-spacer" />
      <button
        className={ui.commentsOpen ? 'icon active' : 'icon'}
        aria-label={threads > 0 ? `Comments (${threads})` : 'Comments'}
        aria-pressed={ui.commentsOpen}
        onClick={() => store.toggleComments()}
        disabled={!hasPages}
      >
        <MessageSquare {...ICON} />
        {threads > 0 && <span className="badge corner" aria-hidden="true">{threads}</span>}
      </button>
      <IconButton icon={EllipsisVertical} label="More" aria-haspopup="dialog" aria-expanded={more} onClick={() => setMore(true)} />
      {more && <MoreSheet onClose={() => setMore(false)} />}
    </div>
  );
}

/** The actions that do not fit the phone's top bar, in a panel that slides up from the bottom. */
function MoreSheet({ onClose }: { onClose: () => void }) {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const panel = useRef<HTMLDivElement>(null);
  const hasPages = doc.pages.length > 0;
  const busy = !!ui.busy;
  // Picking pages in the strip is fiddly on a phone: with none selected, the actions apply to the page on screen.
  const current = doc.pages[ui.currentPage]?.id;
  const targets = ui.selection.size > 0 ? [...ui.selection] : current ? [current] : [];
  const none = targets.length === 0;
  const caption = ui.selection.size > 1 ? `${ui.selection.size} selected pages` : ui.selection.size === 1 ? 'Selected page' : 'This page';
  useEffect(() => panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus(), []);
  const run = (fn: () => void) => () => (fn(), onClose());
  const row = (icon: LucideIcon, label: string, fn: () => void, disabled: boolean, danger = false) => {
    const Icon = icon;
    return (
      <button key={label} className={danger ? 'sheet-row danger' : 'sheet-row'} onClick={run(fn)} disabled={disabled}>
        <Icon {...ICON} />
        {label}
      </button>
    );
  };
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panel}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="More"
        onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}
      >
        <div className="sheet-head">
          <span className="sheet-status">
            {hasPages ? `Page ${ui.currentPage + 1} of ${doc.pages.length}${doc.dirty ? ' · unsaved changes' : ''}` : 'No document open'}
          </span>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <div className="sheet-section" role="group" aria-label={caption}>
          <span className="sheet-caption">{caption}</span>
          {row(RotateCcw, 'Rotate left', () => store.rotatePages(-90, targets), none)}
          {row(RotateCw, 'Rotate right', () => store.rotatePages(90, targets), none)}
          {row(Copy, 'Duplicate', () => store.duplicatePages(targets), none)}
          {row(FileDown, 'Extract to a new PDF', () => void store.extract(targets), none || busy)}
          {row(Trash, 'Delete', () => store.deletePages(targets), none, true)}
        </div>
        <div className="sheet-section" role="group" aria-label="Zoom">
          <span className="sheet-caption">Zoom</span>
          <div className="sheet-zoom">
            <IconButton icon={ZoomOut} label="Zoom out" onClick={() => store.setZoom(ui.zoom / 1.25)} disabled={!hasPages} />
            <button onClick={() => store.setZoom(1)} disabled={!hasPages} aria-label="Reset zoom" className="zoom-level">{Math.round(ui.zoom * 100)}%</button>
            <IconButton icon={ZoomIn} label="Zoom in" onClick={() => store.setZoom(ui.zoom * 1.25)} disabled={!hasPages} />
            <button className={ui.zoomMode === 'fit' ? 'with-icon active' : 'with-icon'} aria-pressed={ui.zoomMode === 'fit'} onClick={() => store.fitWidth()} disabled={!hasPages}>
              <MoveHorizontal {...ICON} />
              Fit width
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The phone's bottom dock, within reach of a thumb: the tool's options on one row (wrapping if they must; that only
 * moves the bottom edge of the page view, never what is under the finger), and the tools below, scrolling sideways.
 * The page number floats just above it.
 */
export function PhoneDock() {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const o = useToolOptions();
  const pick = usePickTool();
  // Which slider is open above the dock, if any.
  const [pop, setPop] = useState<'thickness' | 'opacity'>();
  const thickBox = useRef<HTMLDivElement>(null);
  const opacityBox = useRef<HTMLDivElement>(null);
  const hasPages = doc.pages.length > 0;
  const showThick = pop === 'thickness' && o.thicknessOn;
  const showOpacity = pop === 'opacity' && o.opacityOn;
  // A slider closes when the page (or anything else) is touched, so it never covers what is being drawn.
  useEffect(() => {
    if (!showThick && !showOpacity) return;
    const box = showThick ? thickBox : opacityBox;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setPop(undefined);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [showThick, showOpacity]);
  const toggle = (which: 'thickness' | 'opacity') => setPop(pop === which ? undefined : which);
  return (
    <div className="phone-dock">
      <PagePill />
      <div className="phone-options" role="group" aria-label="Line style">
        <div className={o.colourOn ? 'chip-wrap' : 'chip-wrap off'}>
          <ColourControl color={o.color} recent={o.recent} disabled={!o.colourOn} onChoose={(c) => store.chooseColor(c)} />
        </div>
        <div className={o.thicknessOn ? 'chip-wrap' : 'chip-wrap off'} ref={thickBox}>
          <button className="chip" aria-label={`Thickness: ${o.width} pt`} aria-expanded={showThick} disabled={!o.thicknessOn} onClick={() => toggle('thickness')}>
            <svg width="26" height="16" viewBox="0 0 26 16" aria-hidden="true">
              <line x1="3" y1="8" x2="23" y2="8" stroke={css(o.color)} strokeWidth={Math.min(Math.max(o.width, 1), 6)} strokeLinecap="round" />
            </svg>
            {o.width} pt
            <ChevronDown size={14} strokeWidth={2} aria-hidden />
          </button>
          {showThick && (
            <div className="thickness-pop" role="dialog" aria-label="Thickness" onKeyDown={(e) => e.key === 'Escape' && setPop(undefined)}>
              <ThicknessControl width={o.width} color={o.color} disabled={false} onChange={(w) => store.setDrawStyle({ width: w })} />
            </div>
          )}
        </div>
        {o.fillOn && <FillControl fill={o.fill} onChoose={(c) => store.setDrawStyle({ fill: c })} />}
        {o.opacityOn && (
          <div className="chip-wrap" ref={opacityBox}>
            <button className="chip" aria-label={`Opacity: ${Math.round(o.opacity * 100)}%`} aria-expanded={showOpacity} onClick={() => toggle('opacity')}>
              <span className="opacity-swatch" style={{ background: css(o.color), opacity: o.opacity }} aria-hidden="true" />
              {Math.round(o.opacity * 100)}%
              <ChevronDown size={14} strokeWidth={2} aria-hidden />
            </button>
            {showOpacity && (
              <div className="thickness-pop" role="dialog" aria-label="Opacity" onKeyDown={(e) => e.key === 'Escape' && setPop(undefined)}>
                <OpacityControl opacity={o.opacity} onChange={(v) => store.setDrawStyle({ opacity: v })} />
              </div>
            )}
          </div>
        )}
        {o.textual && <FontControls font={o.font} />}
        <StampControls />
        <SignatureControls />
      </div>
      <div className="phone-tools" role="radiogroup" aria-label="Tool">
        {TOOL_GROUPS.flatMap((g) => g.tools).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="radio"
            aria-label={label}
            aria-checked={ui.activeTool === id}
            className={ui.activeTool === id ? 'tile active' : 'tile'}
            onClick={() => (setPop(undefined), pick(id))}
            disabled={!hasPages}
          >
            <Icon size={22} strokeWidth={1.8} aria-hidden />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** "3 / 12" over the page, with a dot while there are unsaved changes; saving and its Cancel show here too. */
function PagePill() {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  if (doc.pages.length === 0 && !ui.busy) return null;
  return (
    <div className="page-pill" aria-live="polite">
      {ui.busy ? (
        <>
          {`${ui.busy}${ui.progress ? ` ${ui.progress.done}/${ui.progress.total}` : '…'}`}
          {(ui.busy === 'Saving' || ui.busy === 'Extracting') && <button onClick={() => store.cancelSave()}>Cancel</button>}
        </>
      ) : (
        <>
          <span>{`${ui.currentPage + 1} / ${doc.pages.length}`}</span>
          {doc.dirty && <span className="unsaved-dot" role="img" aria-label="unsaved changes" />}
        </>
      )}
    </div>
  );
}
