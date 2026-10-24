import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STAMP, DEFAULT_STAMP_WIDTH, MIN_STAMP_WIDTH, STAMP_PRESETS, boldTextWidth, changeStampPreset, isSupported, newStampRect,
  resizeStamp, stampHandles, stampLayout, stampPreset, stampScale, translateAnnotation, annotationBounds, type StampAnnot,
} from '../src';

const stamp = (name = 'Approved', rect = { x: 100, y: 200, w: 150, h: 40 }): StampAnnot => ({
  type: 'stamp', id: 's', pageId: 'p', author: '', createdAt: '', modifiedAt: '', color: { r: 0, g: 0.5, b: 0, a: 1 }, opacity: 1, origin: 'app',
  rect, payload: { kind: 'preset', name },
});

describe('preset stamps', () => {
  it('have unique names and labels the standard fonts can draw', () => {
    const names = STAMP_PRESETS.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    for (const p of STAMP_PRESETS) {
      expect([...p.label].every((ch) => isSupported(ch)), p.label).toBe(true);
      expect(p.label).toBe(p.label.toUpperCase()); // the layout assumes capitals (no descenders)
      expect(p.color.a).toBe(1);
    }
  });

  it('can be found by name, and an unknown name is not a preset', () => {
    expect(stampPreset('Draft')?.label).toBe('DRAFT');
    expect(stampPreset('Nope')).toBeUndefined();
    expect(DEFAULT_STAMP).toBe(STAMP_PRESETS[0]);
  });
});

describe('bold text width', () => {
  it('uses Helvetica-Bold advances', () => {
    expect(boldTextWidth(' ', 1000)).toBe(278);
    expect(boldTextWidth('A', 1000)).toBe(722); // bold A is wider than regular A (667)
    expect(boldTextWidth('AB', 10)).toBeCloseTo(boldTextWidth('A', 10) + boldTextWidth('B', 10), 9);
    expect(boldTextWidth('?', 10)).toBe(boldTextWidth('Ω', 10)); // what cannot be drawn counts as ?
  });
});

describe('stampLayout', () => {
  it('fits the label with padding, inside the frame, on a positive baseline', () => {
    for (const p of STAMP_PRESETS) {
      const l = stampLayout(p.label);
      expect(l.textX + l.textWidth).toBeLessThan(l.w);
      expect(l.baseline).toBeLessThan(l.h);
      expect(l.baseline).toBeGreaterThan(l.fontSize * 0.7);
      expect(l.w).toBeGreaterThan(l.h); // wider than tall
    }
  });

  it('is wider for longer labels and the same height for all', () => {
    const short = stampLayout('VOID');
    const long = stampLayout('CONFIDENTIAL');
    expect(long.w).toBeGreaterThan(short.w);
    expect(long.h).toBe(short.h);
  });

  it('centres the text: equal padding left and right', () => {
    const l = stampLayout('FINAL');
    expect(l.w - (l.textX + l.textWidth)).toBeCloseTo(l.textX, 9);
  });
});

describe('stampScale', () => {
  const l = stampLayout('DRAFT');
  it('is 1 at natural size and follows the rectangle', () => {
    expect(stampScale(l, { x: 0, y: 0, w: l.w, h: l.h })).toBeCloseTo(1);
    expect(stampScale(l, { x: 0, y: 0, w: l.w * 2, h: l.h * 2 })).toBeCloseTo(2);
  });
  it('takes the smaller fit when the rectangle has other proportions, so nothing is clipped', () => {
    expect(stampScale(l, { x: 0, y: 0, w: l.w * 3, h: l.h * 2 })).toBeCloseTo(2);
    expect(stampScale(l, { x: 0, y: 0, w: l.w * 2, h: l.h * 5 })).toBeCloseTo(2);
  });
});

describe('newStampRect', () => {
  it('is the default width, in the preset’s own proportions, centred on the point', () => {
    const preset = stampPreset('Confidential')!;
    const r = newStampRect(preset, { x: 300, y: 400 });
    const l = stampLayout(preset.label);
    expect(r.w).toBe(DEFAULT_STAMP_WIDTH);
    expect(r.h).toBeCloseTo((DEFAULT_STAMP_WIDTH * l.h) / l.w);
    expect(r.x + r.w / 2).toBeCloseTo(300);
    expect(r.y + r.h / 2).toBeCloseTo(400);
  });
});

describe('changeStampPreset', () => {
  it('keeps the centre and height and takes the new stamp’s proportions and colour', () => {
    const before = stamp('Approved', { x: 100, y: 200, w: 150, h: 40 });
    const after = changeStampPreset(before, stampPreset('Confidential')!);
    expect(after.payload).toEqual({ kind: 'preset', name: 'Confidential' });
    expect(after.color).toEqual(stampPreset('Confidential')!.color);
    expect(after.rect.h).toBe(40);
    expect(after.rect.y).toBe(200);
    expect(after.rect.x + after.rect.w / 2).toBeCloseTo(175);
    const l = stampLayout('CONFIDENTIAL');
    expect(after.rect.w / after.rect.h).toBeCloseTo(l.w / l.h);
  });
  it('does not change anything else', () => {
    const a = stamp();
    expect(changeStampPreset(a, stampPreset('Void')!)).toMatchObject({ id: 's', pageId: 'p', origin: 'app', opacity: 1 });
  });
});

describe('resizing a stamp', () => {
  const aspect = (r: { w: number; h: number }) => r.w / r.h;
  const base = stamp('Approved', { x: 100, y: 200, w: 150, h: 40 });

  it('offers four corner handles', () => {
    expect(stampHandles(base).map((h) => h.id).sort()).toEqual(['ne', 'nw', 'se', 'sw']);
    expect(stampHandles(base).find((h) => h.id === 'ne')!.at).toEqual({ x: 250, y: 240 });
  });

  it.each([
    ['ne', { x: 400, y: 300 }, { x: 100, y: 200 }],
    ['nw', { x: 20, y: 300 }, { x: 250, y: 200 }],
    ['se', { x: 400, y: 100 }, { x: 100, y: 240 }],
    ['sw', { x: 20, y: 100 }, { x: 250, y: 240 }],
  ] as const)('dragging %s grows it and keeps the opposite corner and the proportions', (handle, to, fixed) => {
    const r = resizeStamp(base, handle, to).rect;
    expect(aspect(r)).toBeCloseTo(aspect(base.rect), 6);
    expect(r.w).toBeGreaterThan(base.rect.w);
    // the opposite corner has not moved
    const corners = [
      { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h },
    ];
    expect(corners.some((c) => Math.abs(c.x - fixed.x) < 1e-6 && Math.abs(c.y - fixed.y) < 1e-6), JSON.stringify(r)).toBe(true);
  });

  it('shrinks when the corner is dragged inwards', () => {
    const r = resizeStamp(base, 'ne', { x: 175, y: 220 }).rect;
    expect(r.w).toBeLessThan(base.rect.w);
    expect(r.x).toBe(100);
    expect(r.y).toBe(200);
  });

  it('follows the larger of the horizontal and vertical pull', () => {
    const wide = resizeStamp(base, 'ne', { x: 400, y: 241 }).rect;
    expect(wide.w).toBeCloseTo(300);
    const tall = resizeStamp(base, 'ne', { x: 251, y: 400 }).rect;
    expect(tall.h).toBeCloseTo(200);
  });

  it('never gets smaller than the minimum', () => {
    const r = resizeStamp(base, 'ne', { x: 101, y: 201 }).rect;
    expect(r.w).toBe(MIN_STAMP_WIDTH);
    expect(aspect(r)).toBeCloseTo(aspect(base.rect), 6);
  });

  it('does not collapse when dragged exactly onto the opposite corner', () => {
    const r = resizeStamp(base, 'ne', { x: 100, y: 200 }).rect;
    expect(r.w).toBe(MIN_STAMP_WIDTH);
    expect(Number.isFinite(r.x) && Number.isFinite(r.h)).toBe(true);
  });

  it('can be dragged past the opposite corner, flipping to the other side', () => {
    const r = resizeStamp(base, 'ne', { x: 0, y: 100 }).rect;
    expect(r.x + r.w).toBeCloseTo(100); // now to the left of the old left edge
    expect(r.y + r.h).toBeCloseTo(200);
  });
});

describe('moving a stamp', () => {
  it('uses its rectangle for bounds and translation', () => {
    const a = stamp();
    expect(annotationBounds(a)).toEqual(a.rect);
    expect((translateAnnotation(a, 5, -5)).rect).toEqual({ x: 105, y: 195, w: 150, h: 40 });
  });
});
