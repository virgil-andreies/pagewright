import { describe, expect, it } from 'vitest';
import { NOTE_SIZE, noteIcon, type IconShape } from '../src';

const pointsOf = (s: IconShape) =>
  s.kind === 'rect' ? [{ x: s.x, y: s.y }, { x: s.x + s.w, y: s.y + s.h }] : s.kind === 'polygon' ? s.points : [s.from, s.to];

describe('noteIcon', () => {
  it.each(['note', 'comment'] as const)('keeps the %s icon inside its box', (icon) => {
    const shapes = noteIcon(icon);
    expect(shapes.length).toBeGreaterThan(1);
    for (const p of shapes.flatMap(pointsOf)) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(NOTE_SIZE);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(NOTE_SIZE);
    }
  });

  it('starts with the filled body so details draw on top of it', () => {
    for (const icon of ['note', 'comment'] as const) expect(noteIcon(icon)[0]).toMatchObject({ kind: 'rect', fill: true });
  });

  it('gives the two icons different pictures', () => {
    expect(noteIcon('note')).not.toEqual(noteIcon('comment'));
  });
});
