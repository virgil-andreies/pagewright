import type { Point, Rect, RGBA, StampAnnot } from './annotations';
import { WIDTHS } from './font-data';
import { winAnsiByte } from './text-layout';

/**
 * Preset stamps: a bold word or two in a rounded frame, like the standard stamps in Acrobat. They are drawn from
 * vectors and Helvetica-Bold (which every viewer has), so they stay sharp at any size and need no image.
 */
export interface StampPreset {
  /** Stored in the annotation and written as the PDF stamp's /Name. */
  name: string;
  /** What the stamp says. Capitals only: the layout relies on them having no descenders. */
  label: string;
  color: RGBA;
}

const green: RGBA = { r: 0.1, g: 0.52, b: 0.24, a: 1 };
const red: RGBA = { r: 0.8, g: 0.12, b: 0.12, a: 1 };
const blue: RGBA = { r: 0.12, g: 0.3, b: 0.75, a: 1 };

export const STAMP_PRESETS: readonly StampPreset[] = [
  { name: 'Approved', label: 'APPROVED', color: green },
  { name: 'NotApproved', label: 'NOT APPROVED', color: red },
  { name: 'Draft', label: 'DRAFT', color: blue },
  { name: 'Final', label: 'FINAL', color: green },
  { name: 'Completed', label: 'COMPLETED', color: green },
  { name: 'Confidential', label: 'CONFIDENTIAL', color: red },
  { name: 'ForComment', label: 'FOR COMMENT', color: blue },
  { name: 'Void', label: 'VOID', color: red },
];

export const DEFAULT_STAMP = STAMP_PRESETS[0]!;

export function stampPreset(name: string): StampPreset | undefined {
  return STAMP_PRESETS.find((p) => p.name === name);
}

/** Width of `text` in Helvetica-Bold, in points. */
export function boldTextWidth(text: string, size: number): number {
  const table = WIDTHS.sansBold as Record<number, number>;
  let units = 0;
  for (const ch of text) units += table[winAnsiByte(ch) ?? winAnsiByte('?')!]!;
  return (units * size) / 1000;
}

/**
 * A stamp's artwork at its natural size, in its own units: origin at the top-left corner, y growing down. The
 * editor and the saved PDF both draw from this, then scale it to the stamp's rectangle.
 */
export interface StampLayout {
  w: number;
  h: number;
  fontSize: number;
  /** Stroke width of the frame. */
  border: number;
  radius: number;
  /** Where the text starts, and its baseline measured down from the top. */
  textX: number;
  baseline: number;
  textWidth: number;
}

const FONT = 24;
/** Height of a Helvetica capital as a fraction of the font size. */
const CAP_HEIGHT = 0.72;

export function stampLayout(label: string): StampLayout {
  const textWidth = boldTextWidth(label, FONT);
  const padX = FONT * 0.55;
  const padY = FONT * 0.3;
  return {
    w: textWidth + 2 * padX,
    h: 2 * padY + CAP_HEIGHT * FONT,
    fontSize: FONT,
    border: 2,
    radius: FONT * 0.25,
    textX: padX,
    baseline: padY + CAP_HEIGHT * FONT,
    textWidth,
  };
}

/** How much a stamp's artwork is enlarged to fill `rect`. The artwork keeps its proportions, so the smaller fit wins. */
export function stampScale(layout: StampLayout, rect: Rect): number {
  return Math.min(rect.w / layout.w, rect.h / layout.h);
}

export const DEFAULT_STAMP_WIDTH = 150;

/** A new stamp's rectangle: the default width, the preset's own proportions, centred on `center`. */
export function newStampRect(preset: StampPreset, center: Point, width = DEFAULT_STAMP_WIDTH): Rect {
  const l = stampLayout(preset.label);
  const h = (width * l.h) / l.w;
  return { x: center.x - width / 2, y: center.y - h / 2, w: width, h };
}

/** A different preset in the place of the current one: same centre and height, the new stamp's proportions. */
export function changeStampPreset(a: StampAnnot, preset: StampPreset): StampAnnot {
  const l = stampLayout(preset.label);
  const w = (a.rect.h * l.w) / l.h;
  const cx = a.rect.x + a.rect.w / 2;
  return { ...a, color: preset.color, payload: { kind: 'preset', name: preset.name }, rect: { x: cx - w / 2, y: a.rect.y, w, h: a.rect.h } };
}

export type StampHandle = 'nw' | 'ne' | 'sw' | 'se';

export function stampHandles(a: StampAnnot): { id: StampHandle; at: Point }[] {
  const { x, y, w, h } = a.rect;
  return [
    { id: 'nw', at: { x, y: y + h } },
    { id: 'ne', at: { x: x + w, y: y + h } },
    { id: 'sw', at: { x, y } },
    { id: 'se', at: { x: x + w, y } },
  ];
}

export const MIN_STAMP_WIDTH = 30;

/**
 * Drags one corner to `to`, with the opposite corner fixed. The stamp keeps its proportions, growing or shrinking
 * to follow the pointer as closely as it can.
 */
export function resizeStamp(a: StampAnnot, handle: StampHandle, to: Point): StampAnnot {
  const { x, y, w, h } = a.rect;
  const anchor: Point = { x: handle === 'nw' || handle === 'sw' ? x + w : x, y: handle === 'sw' || handle === 'se' ? y + h : y };
  const dx = to.x - anchor.x;
  const dy = to.y - anchor.y;
  // Which way the stamp extends from the anchor: toward the pointer, or keep the current side if it is exactly on it.
  const sx = dx === 0 ? (handle === 'nw' || handle === 'sw' ? -1 : 1) : Math.sign(dx);
  const sy = dy === 0 ? (handle === 'nw' || handle === 'ne' ? 1 : -1) : Math.sign(dy);
  const aspect = w / h;
  const scale = Math.max(Math.abs(dx) / w, Math.abs(dy) / h);
  const nw = Math.max(MIN_STAMP_WIDTH, w * scale);
  const nh = nw / aspect;
  return { ...a, rect: { x: sx > 0 ? anchor.x : anchor.x - nw, y: sy > 0 ? anchor.y : anchor.y - nh, w: nw, h: nh } };
}
