import { NOTE_FILL, type RGBA } from '@pagewright/core';
import type { MarkupType, ShapeTool, ToolId } from './store';

/** The tools that have a colour (and, some of them, a thickness) of their own. */
export type StyledTool = MarkupType | 'ink' | ShapeTool | 'note' | 'text';

export interface ToolStyle {
  color: RGBA;
  /** Line thickness in points; only used by the pen and the shapes. */
  width: number;
}

const rgb = (r: number, g: number, b: number): RGBA => ({ r, g, b, a: 1 });

/** The colours offered in the palette, in the order shown (two rows of six). */
export const PALETTE: readonly { name: string; color: RGBA }[] = [
  { name: 'Black', color: rgb(0.1, 0.1, 0.1) },
  { name: 'Grey', color: rgb(0.45, 0.47, 0.5) },
  { name: 'Red', color: rgb(0.86, 0.15, 0.15) },
  { name: 'Orange', color: rgb(0.95, 0.55, 0.1) },
  { name: 'Yellow', color: rgb(1, 0.9, 0) },
  { name: 'Green', color: rgb(0.1, 0.6, 0.3) },
  { name: 'Teal', color: rgb(0.05, 0.58, 0.53) },
  { name: 'Blue', color: rgb(0.15, 0.4, 0.9) },
  { name: 'Indigo', color: rgb(0.31, 0.27, 0.9) },
  { name: 'Purple', color: rgb(0.58, 0.2, 0.92) },
  { name: 'Pink', color: rgb(0.86, 0.15, 0.47) },
  { name: 'Brown', color: rgb(0.57, 0.3, 0.1) },
];

const named = (name: string) => PALETTE.find((p) => p.name === name)!.color;

/**
 * The thicknesses the slider moves through, in points: fine steps from 0.5 to 4 pt, where most pen work is,
 * then coarser up to 12 pt.
 */
export const THICKNESS_STEPS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12];

/** Where a thickness sits on the slider: the first step at least as thick (the last one if thicker than all). */
export function thicknessStep(width: number): number {
  const i = THICKNESS_STEPS.findIndex((w) => w >= width - 1e-9);
  return i === -1 ? THICKNESS_STEPS.length - 1 : i;
}

/** How each tool starts: highlights yellow, underlines blue, strikeouts red, notes their usual yellow, the rest red. */
export const DEFAULT_TOOL_STYLES: Readonly<Record<StyledTool, ToolStyle>> = {
  highlight: { color: named('Yellow'), width: 2 },
  underline: { color: named('Blue'), width: 2 },
  strikeout: { color: named('Red'), width: 2 },
  ink: { color: named('Red'), width: 2 },
  rect: { color: named('Red'), width: 2 },
  ellipse: { color: named('Red'), width: 2 },
  line: { color: named('Red'), width: 2 },
  arrow: { color: named('Red'), width: 2 },
  note: { color: NOTE_FILL, width: 2 },
  text: { color: named('Red'), width: 2 },
};

export const DEFAULT_RECENT_COLORS: readonly RGBA[] = [named('Blue'), named('Black'), named('Green')];
export const MAX_RECENT_COLORS = 3;

export function isStyledTool(tool: ToolId): tool is StyledTool {
  return tool in DEFAULT_TOOL_STYLES;
}

/** Whether a tool's thickness can be set (the pen and the shapes). */
export function hasThickness(tool: ToolId): boolean {
  return tool === 'ink' || tool === 'rect' || tool === 'ellipse' || tool === 'line' || tool === 'arrow';
}

const channel = (v: number) => Math.round(v * 255);

export function sameColor(a: RGBA, b: RGBA): boolean {
  return channel(a.r) === channel(b.r) && channel(a.g) === channel(b.g) && channel(a.b) === channel(b.b);
}

/** The palette's name for a colour, or "Custom" for any other. */
export function colorName(c: RGBA): string {
  return PALETTE.find((p) => sameColor(p.color, c))?.name ?? 'Custom';
}

export function toHex(c: RGBA): string {
  return `#${[c.r, c.g, c.b].map((v) => channel(v).toString(16).padStart(2, '0')).join('')}`;
}

export function fromHex(hex: string): RGBA | undefined {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return undefined;
  return { r: parseInt(m[1]!, 16) / 255, g: parseInt(m[2]!, 16) / 255, b: parseInt(m[3]!, 16) / 255, a: 1 };
}

/**
 * The recent colours after choosing `chosen` in place of `previous`: the colour being replaced goes to the front,
 * the chosen one leaves the list (it is now the current colour), and the list keeps its length.
 */
export function nextRecent(recent: readonly RGBA[], previous: RGBA, chosen: RGBA): RGBA[] {
  if (sameColor(previous, chosen)) return [...recent];
  return [previous, ...recent].filter((c, i, all) => !sameColor(c, chosen) && all.findIndex((d) => sameColor(c, d)) === i).slice(0, MAX_RECENT_COLORS);
}
