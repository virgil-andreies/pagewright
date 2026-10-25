import { describe, expect, it, vi } from 'vitest';
import type { Platform } from '@pagewright/platform';
import { AppStore } from '../src/store';
import { DEFAULT_RECENT_COLORS, DEFAULT_TOOL_STYLES, PALETTE, STYLES_KEY, colorName, readSavedStyles } from '../src/tool-style';
import { file, setup } from './store-helpers';

const named = (n: string) => PALETTE.find((p) => p.name === n)!.color;
const flush = () => new Promise((r) => setTimeout(r, 0));

/**
 * Opens the app on a device whose storage is `disk` (a plain map, as IndexedDB would keep it between sessions).
 * `setFails` makes every write fail, like a full or blocked storage.
 */
async function open(disk: Map<string, unknown>, opts: { setFails?: boolean } = {}) {
  const t = setup();
  const platform = t.platform as unknown as { secure: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } };
  platform.secure.get.mockImplementation(async (k: string) => disk.get(k));
  platform.secure.set.mockImplementation(async (k: string, v: unknown) => {
    if (opts.setFails) throw new Error('quota');
    disk.set(k, JSON.parse(JSON.stringify(v)));
  });
  const store = new AppStore({ renderer: t.renderer, writer: t.writer, platform: t.platform as Platform });
  await store.addFiles([file('a.pdf')]);
  await flush();
  const style = (tool: Parameters<AppStore['setTool']>[0]) => {
    store.setTool(tool);
    const { drawStyle } = store.getSnapshot().ui;
    return { color: colorName(drawStyle.color), width: drawStyle.width };
  };
  return { store, style };
}

describe('styles are kept on the device', () => {
  it('come back after the app is closed and opened again', async () => {
    const disk = new Map<string, unknown>();
    const first = await open(disk);
    first.store.setTool('ink');
    first.store.chooseColor(named('Purple'));
    first.store.setDrawStyle({ width: 6 });
    first.store.setTool('highlight');
    first.store.chooseColor(named('Green'));
    first.store.setTool('text');
    first.store.setDrawStyle({ fontFamily: 'serif', fontSize: 18 });

    const again = await open(disk);
    expect(again.style('ink')).toEqual({ color: 'Purple', width: 6 });
    expect(again.style('highlight').color).toBe('Green');
    expect(again.style('rect')).toEqual({ color: 'Red', width: 2 }); // never changed: still the default
    expect(again.store.getSnapshot().ui.recentColors.map(colorName)).toEqual(['Yellow', 'Red', 'Blue']);
    expect(again.store.getSnapshot().ui.drawStyle).toMatchObject({ fontFamily: 'serif', fontSize: 18 });
  });

  it('start from the defaults on a new device', async () => {
    const { store, style } = await open(new Map());
    expect(style('ink')).toEqual({ color: 'Red', width: 2 });
    expect(store.getSnapshot().ui.recentColors).toEqual(DEFAULT_RECENT_COLORS);
  });

  it('are not overwritten by a late load when something was changed already', async () => {
    const disk = new Map<string, unknown>([[STYLES_KEY, { toolStyles: { ink: { color: named('Brown'), width: 8 } }, recentColors: [] }]]);
    const t = setup();
    let release!: () => void;
    const platform = t.platform as unknown as { secure: { get: ReturnType<typeof vi.fn> } };
    platform.secure.get.mockImplementation((k: string) => new Promise((r) => (release = () => r(disk.get(k)))));
    const store = new AppStore({ renderer: t.renderer, writer: t.writer, platform: t.platform as Platform });
    store.setTool('ink');
    store.chooseColor(named('Teal')); // before storage has answered
    release();
    await flush();
    expect(colorName(store.getSnapshot().ui.drawStyle.color)).toBe('Teal');
  });

  it('still work when the device will not keep them', async () => {
    const { store, style } = await open(new Map(), { setFails: true });
    store.setTool('ink');
    expect(() => store.chooseColor(named('Pink'))).not.toThrow();
    await flush();
    expect(style('ink').color).toBe('Pink');
    expect(store.getSnapshot().ui.notices).toEqual([]); // nothing worth interrupting anyone for
  });

  it('restyling a selection keeps the recent colours, not the tool’s style', async () => {
    const disk = new Map<string, unknown>();
    const { store } = await open(disk);
    const pageId = store.getSnapshot().doc.pages[0]!.id;
    store.setTool('rect');
    const id = store.addShape(pageId, 'rect', { x: 10, y: 10 }, { x: 50, y: 50 });
    store.setTool('select');
    store.selectAnnotation({ pageId, id });
    store.chooseColor(named('Indigo'));
    const saved = readSavedStyles(disk.get(STYLES_KEY))!;
    expect(saved.toolStyles.rect?.color ?? DEFAULT_TOOL_STYLES.rect.color).toEqual(DEFAULT_TOOL_STYLES.rect.color);
    expect(saved.recentColors.map(colorName)[0]).toBe('Red');
  });
});

describe('readSavedStyles', () => {
  it('keeps only what can be used', () => {
    const saved = readSavedStyles({
      toolStyles: {
        ink: { color: { r: 0.5, g: 0.5, b: 0.5, a: 1 }, width: 3 },
        rect: { color: { r: 2, g: 0, b: 0, a: 1 }, width: 3 }, // not a colour
        line: { color: { r: 0, g: 0, b: 0, a: 1 }, width: 400 }, // far too thick
        stamp: { color: { r: 0, g: 0, b: 0, a: 1 }, width: 2 }, // not a styled tool
      },
      recentColors: [{ r: 0, g: 0, b: 1, a: 1 }, 'red', null],
      fontFamily: 'comic',
      fontSize: 18,
    })!;
    expect(Object.keys(saved.toolStyles)).toEqual(['ink']);
    expect(saved.recentColors).toHaveLength(1);
    expect(saved.fontFamily).toBeUndefined();
    expect(saved.fontSize).toBe(18);
  });

  it('ignores anything that is not saved styles at all', () => {
    for (const junk of [undefined, null, 42, 'x', []]) expect(readSavedStyles(junk)?.toolStyles ?? {}).toEqual({});
  });
});
