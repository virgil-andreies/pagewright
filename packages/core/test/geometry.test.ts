import { describe, expect, it } from 'vitest';
import {
  displaySize,
  pdfToViewport,
  quadBounds,
  rectToQuad,
  viewportToPdf,
  type PageGeometry,
  type Rotation,
} from '../src';

const rotations: Rotation[] = [0, 90, 180, 270];

function geo(intrinsic: Rotation, extra: Rotation, cropBox = { x: 0, y: 0, w: 200, h: 100 }): PageGeometry {
  return { cropBox, intrinsicRotation: intrinsic, extraRotation: extra, userUnit: 1 };
}

describe('geometry', () => {
  it('maps the PDF bottom-left corner correctly for each rotation', () => {
    const corner = { x: 0, y: 0 }; // bottom-left in unrotated space, page 200x100
    expect(pdfToViewport(geo(0, 0), 1, corner)).toEqual({ x: 0, y: 100 });   // bottom-left
    expect(pdfToViewport(geo(0, 90), 1, corner)).toEqual({ x: 0, y: 0 });    // moves to top-left
    expect(pdfToViewport(geo(0, 180), 1, corner)).toEqual({ x: 200, y: 0 }); // top-right
    expect(pdfToViewport(geo(0, 270), 1, corner)).toEqual({ x: 100, y: 200 }); // bottom-right
  });

  it('accounts for a non-zero CropBox origin', () => {
    const g = geo(0, 0, { x: 50, y: 20, w: 200, h: 100 });
    expect(pdfToViewport(g, 2, { x: 50, y: 120 })).toEqual({ x: 0, y: 0 }); // top-left of the crop box
    expect(pdfToViewport(g, 2, { x: 250, y: 20 })).toEqual({ x: 400, y: 200 });
  });

  it('adds intrinsic and extra rotation', () => {
    const p = { x: 30, y: 40 };
    expect(pdfToViewport(geo(90, 90), 1.5, p)).toEqual(pdfToViewport(geo(180, 0), 1.5, p));
    expect(pdfToViewport(geo(270, 180), 1.5, p)).toEqual(pdfToViewport(geo(0, 90), 1.5, p));
  });

  it('swaps display size for 90/270', () => {
    expect(displaySize(geo(0, 0))).toEqual({ w: 200, h: 100 });
    expect(displaySize(geo(90, 0))).toEqual({ w: 100, h: 200 });
    expect(displaySize(geo(90, 90))).toEqual({ w: 200, h: 100 });
  });

  it('round-trips viewport <-> pdf for random points, boxes, scales and rotations', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let i = 0; i < 500; i++) {
      const g = geo(rotations[Math.floor(rnd() * 4)]!, rotations[Math.floor(rnd() * 4)]!, {
        x: rnd() * 100 - 50,
        y: rnd() * 100 - 50,
        w: 50 + rnd() * 700,
        h: 50 + rnd() * 700,
      });
      const scale = 0.25 + rnd() * 4;
      const p = { x: g.cropBox.x + rnd() * g.cropBox.w, y: g.cropBox.y + rnd() * g.cropBox.h };
      const back = viewportToPdf(g, scale, pdfToViewport(g, scale, p));
      expect(back.x).toBeCloseTo(p.x, 6);
      expect(back.y).toBeCloseTo(p.y, 6);
    }
  });

  it('keeps points inside the displayed page bounds', () => {
    for (const r of rotations) {
      const g = geo(0, r);
      const { w, h } = displaySize(g);
      for (const p of [{ x: 0, y: 0 }, { x: 200, y: 100 }, { x: 200, y: 0 }, { x: 0, y: 100 }]) {
        const v = pdfToViewport(g, 1, p);
        expect(v.x).toBeGreaterThanOrEqual(0);
        expect(v.x).toBeLessThanOrEqual(w);
        expect(v.y).toBeGreaterThanOrEqual(0);
        expect(v.y).toBeLessThanOrEqual(h);
      }
    }
  });

  it('builds quads in QuadPoints order and recovers bounds', () => {
    const r = { x: 10, y: 20, w: 30, h: 40 };
    const q = rectToQuad(r);
    expect(q.p1).toEqual({ x: 10, y: 60 });
    expect(q.p4).toEqual({ x: 40, y: 20 });
    expect(quadBounds(q)).toEqual(r);
  });
});
