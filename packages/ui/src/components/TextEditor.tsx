import { useEffect, useRef } from 'react';
import {
  LINE_HEIGHT, TEXT_PADDING, effectiveRotation, pdfToViewport, sanitizeText,
  type FreeTextAnnot, type PageGeometry,
} from '@pagewright/core';
import { useSnapshot, useUi } from '../react';
import type { TextEdit } from '../store';
import { FONT_STACKS, rgb } from './AnnotationView';

/**
 * The text box while it is being typed in: a real <textarea> laid over the page at the box's position, in the
 * same font, size and colour it will have. The typed text lives in the store (not here), so clicking
 * elsewhere cannot lose it. Enter inserts a line break; Ctrl/Cmd+Enter or clicking away commits; Escape cancels.
 */
export function TextEditor({ edit, geometry, scale }: { edit: TextEdit; geometry: PageGeometry; scale: number }) {
  const { store } = useUi();
  const { doc, ui } = useSnapshot();
  const ref = useRef<HTMLTextAreaElement>(null);

  const existing = edit.id ? doc.annotations[edit.pageId]?.find((a): a is FreeTextAnnot => a.id === edit.id && a.type === 'freetext') : undefined;
  const { fontSize, fontFamily, color } = existing ?? ui.drawStyle;
  const anchor = pdfToViewport(geometry, scale, edit.position);
  const lost = sanitizeText(edit.text).replaced;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // Grow with the text, like the finished box will.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [edit.text, edit.width, scale, fontSize, fontFamily]);

  return (
    <>
      <textarea
        ref={ref}
        className="text-editor"
        aria-label="Text"
        value={edit.text}
        rows={1}
        spellCheck={false}
        onChange={(e) => store.setEditText(e.target.value)}
        onBlur={() => store.commitText(edit)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), store.cancelText());
          else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), store.commitText(edit));
        }}
        style={{
          left: anchor.x,
          top: anchor.y,
          width: edit.width * scale,
          padding: TEXT_PADDING * scale,
          fontSize: fontSize * scale,
          lineHeight: LINE_HEIGHT,
          fontFamily: FONT_STACKS[fontFamily],
          color: rgb(color),
          transform: `rotate(${effectiveRotation(geometry)}deg)`,
        }}
      />
      {lost > 0 && (
        <div className="text-editor-hint" role="status" style={{ left: anchor.x, top: anchor.y }}>
          {lost} character{lost === 1 ? '' : 's'} can’t be saved in the built-in fonts and will show as “?”
        </div>
      )}
    </>
  );
}
