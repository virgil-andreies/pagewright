import { useRef, useState } from 'react';
import { PAD_HEIGHT, PAD_PEN_WIDTH, PAD_WIDTH, type Point, type RGBA } from '@pagewright/core';

const css = (c: RGBA) => `rgb(${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)})`;
const line = (pts: readonly Point[]) => (pts.length === 1 ? `M${pts[0]!.x} ${pts[0]!.y}l0.01 0` : 'M' + pts.map((p) => `${p.x} ${p.y}`).join('L'));

export type Strokes = readonly (readonly Point[])[];

/**
 * A pad to sign on with a mouse, finger or pen. The strokes are reported in pad units (`PAD_WIDTH` x `PAD_HEIGHT`)
 * whatever size the pad is shown at. The gesture lives in a ref, not state, because a fast pen can produce several
 * events before React redraws.
 */
export function DrawPad({ strokes, onChange, color }: { strokes: Strokes; onChange: (s: Strokes) => void; color: RGBA }) {
  const svg = useRef<SVGSVGElement>(null);
  const current = useRef<{ id: number; done: Strokes; points: Point[] } | null>(null);
  const [, redraw] = useState(0);

  const toPad = (e: { clientX: number; clientY: number }): Point => {
    const r = svg.current!.getBoundingClientRect();
    const sx = r.width > 0 ? PAD_WIDTH / r.width : 1;
    const sy = r.height > 0 ? PAD_HEIGHT / r.height : 1;
    return { x: Math.round((e.clientX - r.left) * sx * 10) / 10, y: Math.round((e.clientY - r.top) * sy * 10) / 10 };
  };

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0 || current.current) return;
    e.preventDefault();
    try {
      svg.current?.setPointerCapture?.(e.pointerId);
    } catch {
      /* the pointer is already gone: the gesture will simply end at the next event */
    }
    current.current = { id: e.pointerId, done: strokes, points: [toPad(e)] };
    redraw((n) => n + 1);
  };
  const move = (e: React.PointerEvent) => {
    const g = current.current;
    if (!g || g.id !== e.pointerId) return;
    // Browsers batch fast pointer movement: use every sample, not just the last.
    const native = e.nativeEvent as PointerEvent;
    const samples = typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents() : [];
    for (const s of samples.length > 0 ? samples : [e]) g.points.push(toPad(s));
    redraw((n) => n + 1);
  };
  const end = (e: React.PointerEvent) => {
    const g = current.current;
    if (!g || g.id !== e.pointerId) return;
    current.current = null;
    onChange([...g.done, g.points]);
  };
  const cancel = (e: React.PointerEvent) => {
    if (current.current?.id === e.pointerId) {
      current.current = null;
      redraw((n) => n + 1);
    }
  };

  const live = current.current?.points;
  return (
    <div className="draw-pad">
      <svg
        ref={svg}
        className="draw-surface"
        viewBox={`0 0 ${PAD_WIDTH} ${PAD_HEIGHT}`}
        role="img"
        aria-label="Signature pad"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={cancel}
      >
        <line x1="16" y1={PAD_HEIGHT - 36} x2={PAD_WIDTH - 16} y2={PAD_HEIGHT - 36} className="draw-baseline" />
        {[...strokes, ...(live ? [live] : [])].map((s, i) => (
          <path key={i} d={line(s)} fill="none" stroke={css(color)} strokeWidth={PAD_PEN_WIDTH} strokeLinecap="round" strokeLinejoin="round" />
        ))}
      </svg>
      {strokes.length === 0 && !live && <span className="draw-hint">Sign here</span>}
    </div>
  );
}
