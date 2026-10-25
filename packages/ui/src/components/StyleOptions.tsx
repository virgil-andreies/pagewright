import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { RGBA } from '@pagewright/core';
import { PALETTE, THICKNESS_STEPS, colorName, fromHex, sameColor, thicknessStep, toHex } from '../tool-style';

const css = (c: RGBA) => `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)})`;

/**
 * Calls `onCommit` on the native `change` event: when a drag on a slider or colour picker ends, not on every move.
 * Returns a callback ref, so it attaches whenever the input appears (the custom picker only exists while the palette
 * is open).
 */
function useCommit(onCommit: (value: string) => void) {
  const latest = useRef(onCommit);
  latest.current = onCommit;
  const detach = useRef<() => void>(undefined);
  return useCallback((el: HTMLInputElement | null) => {
    detach.current?.();
    detach.current = undefined;
    if (!el) return;
    const handler = () => latest.current(el.value);
    el.addEventListener('change', handler);
    detach.current = () => el.removeEventListener('change', handler);
  }, []);
}

/**
 * The colour: a button showing the current one, which opens the palette and a custom picker, and the recent colours
 * beside it, one click each.
 */
export function ColourControl({ color, recent, disabled, onChoose }: { color: RGBA; recent: readonly RGBA[]; disabled: boolean; onChoose: (c: RGBA) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const shown = open && !disabled;
  const custom = useCommit((v) => {
    const c = fromHex(v);
    if (c) choose(c);
  });

  // Close when the person clicks anywhere else.
  useEffect(() => {
    if (!shown) return;
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [shown]);

  const choose = (c: RGBA) => {
    setOpen(false);
    if (!sameColor(c, color)) onChoose(c);
  };
  const others = recent.filter((c) => !sameColor(c, color));

  return (
    <div className="colour-control" ref={box} onKeyDown={(e) => e.key === 'Escape' && shown && (e.stopPropagation(), setOpen(false))}>
      <span className="option-label">Colour</span>
      <button
        className="swatch-button"
        aria-label={`Colour: ${colorName(color)}`}
        aria-haspopup="dialog"
        aria-expanded={shown}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <span className="swatch-dot" style={{ background: css(color) }} />
        <ChevronDown size={14} strokeWidth={2} aria-hidden />
      </button>
      {others.map((c) => (
        <button key={toHex(c)} className="swatch-dot-button" aria-label={`Recent colour: ${colorName(c) === 'Custom' ? toHex(c) : colorName(c)}`} disabled={disabled} onClick={() => choose(c)}>
          <span className="swatch-dot" style={{ background: css(c) }} />
        </button>
      ))}
      {shown && (
        <div className="palette" role="dialog" aria-label="Colours">
          <div className="palette-grid">
            {PALETTE.map((p) => (
              <button key={p.name} className="swatch-dot-button" aria-label={p.name} aria-pressed={sameColor(p.color, color)} onClick={() => choose(p.color)}>
                <span className="swatch-dot" style={{ background: css(p.color) }} />
              </button>
            ))}
          </div>
          <label className="palette-custom">
            Custom colour
            <input ref={custom} type="color" defaultValue={toHex(color)} />
          </label>
        </div>
      )}
    </div>
  );
}

/**
 * The thickness: a slider through fixed steps (fine from 0.5 to 4 pt), with a preview line and the value. While it is
 * dragged only the preview changes; the thickness is applied when it is let go, so a restyle is one undo step.
 */
export function ThicknessControl({ width, color, disabled, onChange }: { width: number; color: RGBA; disabled: boolean; onChange: (w: number) => void }) {
  const id = useId();
  const [dragging, setDragging] = useState<number>();
  const step = dragging ?? thicknessStep(width);
  const shown = THICKNESS_STEPS[step]!;
  const slider = useCommit((v) => {
    setDragging(undefined);
    const w = THICKNESS_STEPS[Number(v)];
    if (w !== undefined && w !== width) onChange(w);
  });
  const label = `${shown} pt`;
  return (
    <div className="thickness-control">
      <label className="option-label" htmlFor={id}>Thickness</label>
      <input
        ref={slider}
        id={id}
        type="range"
        min={0}
        max={THICKNESS_STEPS.length - 1}
        step={1}
        value={step}
        aria-valuetext={label}
        disabled={disabled}
        // Moving shows the new thickness; letting go (the native change event, above) applies it.
        onInput={(e) => setDragging(Number(e.currentTarget.value))}
        onChange={() => {}}
      />
      <svg width="40" height="24" viewBox="0 0 40 24" aria-hidden="true">
        <line x1="6" y1="12" x2="34" y2="12" stroke={css(color)} strokeWidth={Math.min(shown, 12)} strokeLinecap="round" />
      </svg>
      <span className="thickness-value">{label}</span>
    </div>
  );
}
