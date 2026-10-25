// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Annotation, FreeTextAnnot, InkAnnot, ShapeAnnot, SourceAnnotation } from '@pagewright/core';
import { DEFAULT_TOOL_STYLES, PALETTE, THICKNESS_STEPS, colorName, fromHex, nextRecent, thicknessStep, toHex } from '../src/tool-style';
import { setup } from './helpers';

/** Fake pages are 200 x 300 pt, shown at 96/72 px per point. */
const S = 96 / 72;
const px = (x: number, y: number) => ({ clientX: x * S, clientY: (300 - y) * S });
const named = (n: string) => PALETTE.find((p) => p.name === n)!.color;

async function ready(original: (pageIndex: number) => SourceAnnotation[] = () => []) {
  const t = setup(3, original);
  await t.open();
  const svg = await waitFor(() => {
    const el = document.querySelector<SVGSVGElement>('svg.overlay');
    if (!el) throw new Error('overlay not mounted');
    return el;
  });
  const host = svg.parentElement!;
  const pageId = t.store.getSnapshot().doc.pages[0]!.id;
  const annots = () => (t.store.getSnapshot().doc.annotations[pageId] ?? []) as Annotation[];
  const tool = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
  const drag = (pts: [number, number][]) => {
    fireEvent.pointerDown(host, { button: 0, pointerId: 1, ...px(...pts[0]!) });
    for (const p of pts.slice(1)) fireEvent.pointerMove(host, { pointerId: 1, ...px(...p) });
    fireEvent.pointerUp(host, { pointerId: 1, ...px(...pts[pts.length - 1]!) });
  };
  const colourButton = () => screen.getByRole('button', { name: /^Colour: / }) as HTMLButtonElement;
  const palette = () => screen.queryByRole('dialog', { name: 'Colours' });
  const pick = (name: string) => {
    fireEvent.click(colourButton());
    fireEvent.click(within(palette()!).getByRole('button', { name }));
  };
  const slider = () => screen.getByRole('slider', { name: 'Thickness' }) as HTMLInputElement;
  const setThickness = (pt: number) => fireEvent.change(slider(), { target: { value: String(THICKNESS_STEPS.indexOf(pt)) } });
  const recent = () => screen.queryAllByRole('button', { name: /^Recent colour: / }).map((b) => b.getAttribute('aria-label')!.replace('Recent colour: ', ''));
  return { ...t, pageId, annots, tool, drag, colourButton, palette, pick, slider, setThickness, recent };
}

describe('each tool keeps its own colour and thickness', () => {
  it('starts each tool with its own default', async () => {
    const t = await ready();
    t.tool('Highlight');
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Yellow');
    t.tool('Underline');
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Blue');
    t.tool('Pen');
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Red');
    expect(t.slider().getAttribute('aria-valuetext')).toBe('2 pt');
  });

  it('remembers what was set for a tool while others are used', async () => {
    const t = await ready();
    t.tool('Pen');
    t.pick('Purple');
    t.setThickness(6);
    t.tool('Rectangle');
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Red');
    expect(t.slider().getAttribute('aria-valuetext')).toBe('2 pt');
    t.tool('Pen');
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Purple');
    expect(t.slider().getAttribute('aria-valuetext')).toBe('6 pt');
    t.drag([[20, 200], [60, 220], [100, 200]]);
    const ink = t.annots()[0] as InkAnnot;
    expect(ink.color).toEqual(named('Purple'));
    expect(ink.width).toBe(6);
  });

  it('also when tools are switched with the keyboard', async () => {
    const t = await ready();
    t.tool('Ellipse');
    t.pick('Teal');
    fireEvent.keyDown(window, { key: 'r' });
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Red');
    fireEvent.keyDown(window, { key: 'e' });
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Teal');
  });

  it('marks text in the markup tool’s own colour', async () => {
    const t = await ready();
    t.tool('Highlight');
    t.pick('Green');
    const quad = { p1: { x: 10, y: 20 }, p2: { x: 50, y: 20 }, p3: { x: 10, y: 10 }, p4: { x: 50, y: 10 } };
    act(() => void t.store.addMarkup('highlight', t.pageId, [quad]));
    act(() => void t.store.addMarkup('underline', t.pageId, [quad]));
    const [h, u] = t.annots();
    expect(h!.color).toEqual(named('Green'));
    expect(u!.color).toEqual(DEFAULT_TOOL_STYLES.underline.color); // the underline tool kept its own
  });

  it('places notes in the note tool’s colour', async () => {
    const t = await ready();
    t.tool('Note');
    t.pick('Orange');
    act(() => t.store.beginNote(t.pageId, { x: 20, y: 200 }));
    act(() => void t.store.saveDraftNote('Hello'));
    expect(t.annots()[0]!.color).toEqual(named('Orange'));
  });
});

describe('the colour button and palette', () => {
  it('opens the palette with the current colour marked, and closes it after a choice', async () => {
    const t = await ready();
    t.tool('Pen');
    expect(t.palette()).toBeNull();
    fireEvent.click(t.colourButton());
    expect(t.colourButton().getAttribute('aria-expanded')).toBe('true');
    const p = t.palette()!;
    expect(within(p).getAllByRole('button')).toHaveLength(12);
    expect(within(p).getByRole('button', { name: 'Red' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(within(p).getByRole('button', { name: 'Indigo' }));
    expect(t.palette()).toBeNull();
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Indigo');
  });

  it('closes on Escape or a click elsewhere, changing nothing', async () => {
    const t = await ready();
    t.tool('Pen');
    fireEvent.click(t.colourButton());
    fireEvent.keyDown(t.palette()!, { key: 'Escape' });
    expect(t.palette()).toBeNull();
    fireEvent.click(t.colourButton());
    fireEvent.pointerDown(document.body);
    expect(t.palette()).toBeNull();
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Red');
  });

  it('takes any colour from the custom picker', async () => {
    const t = await ready();
    t.tool('Line');
    fireEvent.click(t.colourButton());
    fireEvent.change(within(t.palette()!).getByLabelText('Custom colour'), { target: { value: '#123456' } });
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Custom');
    t.drag([[20, 200], [120, 150]]);
    expect(toHex((t.annots()[0] as ShapeAnnot).color)).toBe('#123456');
  });

  it('offers the colours it replaced as recent ones, shared by all tools', async () => {
    const t = await ready();
    t.tool('Pen');
    expect(t.recent()).toEqual(['Blue', 'Black', 'Green']);
    t.pick('Purple');
    expect(t.recent()).toEqual(['Red', 'Blue', 'Black']);
    fireEvent.click(screen.getByRole('button', { name: 'Recent colour: Red' }));
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Red');
    expect(t.recent()).toEqual(['Purple', 'Blue', 'Black']);
    t.tool('Rectangle'); // Red too, so its own colour is left out of the list
    expect(t.recent()).toEqual(['Purple', 'Blue', 'Black']);
  });

  it('is greyed out, not hidden, for tools without a colour', async () => {
    const t = await ready();
    t.tool('Stamp');
    expect(t.colourButton().disabled).toBe(true);
    expect(screen.getAllByRole('button', { name: /^Recent colour: / }).every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
    expect(t.colourButton().closest('.option-row')!.className).toContain('off');
  });
});

describe('the thickness slider', () => {
  it('moves through fixed steps, fine at the thin end, and says the value in points', async () => {
    const t = await ready();
    t.tool('Pen');
    expect(Number(t.slider().max)).toBe(THICKNESS_STEPS.length - 1);
    for (const pt of [0.5, 0.75, 1.25, 3.5, 12]) {
      t.setThickness(pt);
      expect(t.slider().getAttribute('aria-valuetext')).toBe(`${pt} pt`);
      expect(screen.getByText(`${pt} pt`)).toBeTruthy();
    }
  });

  it('restyles the selection once, when it is let go, not on every move', async () => {
    const t = await ready();
    t.tool('Rectangle');
    t.drag([[20, 200], [120, 150]]);
    t.tool('Select');
    t.drag([[70, 200]]);
    const steps = () => t.store.history.canUndo && t.store.getSnapshot().undoLabel;
    const before = steps();
    for (const pt of [3, 4, 5, 6]) fireEvent.input(t.slider(), { target: { value: String(THICKNESS_STEPS.indexOf(pt)) } });
    expect(t.slider().getAttribute('aria-valuetext')).toBe('6 pt'); // the preview follows
    expect((t.annots()[0] as ShapeAnnot).width).toBe(2); // the shape does not, yet
    expect(steps()).toBe(before);
    fireEvent.change(t.slider(), { target: { value: String(THICKNESS_STEPS.indexOf(6)) } });
    expect((t.annots()[0] as ShapeAnnot).width).toBe(6);
    act(() => t.store.undo());
    expect((t.annots()[0] as ShapeAnnot).width).toBe(2); // one undo step for the whole drag
  });

  it('is greyed out for tools without a thickness', async () => {
    const t = await ready();
    for (const name of ['Highlight', 'Note', 'Text', 'Stamp', 'Sign', 'Select']) {
      t.tool(name);
      expect(t.slider().disabled, name).toBe(true);
      if (name === 'Sign') act(() => t.store.openSignatures(false));
    }
  });
});

describe('tool-style helpers', () => {
  it('places any thickness on the slider at the first step at least as thick', () => {
    expect(thicknessStep(0.5)).toBe(0);
    expect(thicknessStep(2)).toBe(THICKNESS_STEPS.indexOf(2));
    expect(thicknessStep(2.2)).toBe(THICKNESS_STEPS.indexOf(2.5));
    expect(thicknessStep(40)).toBe(THICKNESS_STEPS.length - 1);
  });

  it('keeps three recent colours, newest first, never the current one, never twice', () => {
    const [red, blue, black, green, pink] = ['Red', 'Blue', 'Black', 'Green', 'Pink'].map(named);
    expect(nextRecent([blue!, black!, green!], red!, pink!).map(colorName)).toEqual(['Red', 'Blue', 'Black']);
    expect(nextRecent([blue!, black!, green!], red!, blue!).map(colorName)).toEqual(['Red', 'Black', 'Green']);
    expect(nextRecent([blue!, black!, green!], red!, red!).map(colorName)).toEqual(['Blue', 'Black', 'Green']);
  });

  it('reads and writes hex colours', () => {
    expect(toHex(fromHex('#1a2B3c')!)).toBe('#1a2b3c');
    expect(fromHex('red')).toBeUndefined();
  });
});

describe('the options box follows the selected annotation', () => {
  const quad = { p1: { x: 10, y: 120 }, p2: { x: 90, y: 120 }, p3: { x: 10, y: 100 }, p4: { x: 90, y: 100 } };

  it('shows a selected highlight’s colour and changes it, as one undo step, without thickness', async () => {
    const t = await ready();
    t.tool('Select');
    let id = '';
    act(() => void (id = t.store.addMarkup('highlight', t.pageId, [quad])!));
    act(() => t.store.selectAnnotation({ pageId: t.pageId, id }));
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Yellow');
    expect(t.colourButton().disabled).toBe(false);
    expect(t.slider().disabled).toBe(true);
    t.pick('Green');
    expect(t.annots()[0]!.color).toEqual(named('Green'));
    expect(t.store.getSnapshot().undoLabel).toBe('Edit annotation');
    act(() => t.store.undo());
    expect(t.annots()[0]!.color).toEqual(DEFAULT_TOOL_STYLES.highlight.color);
  });

  it('changes a selected note’s colour', async () => {
    const t = await ready();
    t.tool('Note');
    act(() => t.store.beginNote(t.pageId, { x: 20, y: 200 }));
    act(() => void t.store.saveDraftNote('Hello')); // the new note is selected
    t.pick('Pink');
    expect(t.annots()[0]!.color).toEqual(named('Pink'));
  });

  it('restyles only the selection: the tool keeps its own style for what it draws next', async () => {
    const t = await ready();
    t.tool('Rectangle');
    t.drag([[20, 200], [120, 150]]);
    t.tool('Select');
    t.drag([[70, 200]]);
    t.pick('Blue');
    t.setThickness(8);
    expect((t.annots()[0] as ShapeAnnot)).toMatchObject({ color: named('Blue'), width: 8 });
    t.tool('Rectangle');
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Red');
    expect(t.slider().getAttribute('aria-valuetext')).toBe('2 pt');
    t.drag([[20, 120], [120, 60]]);
    expect((t.annots()[1] as ShapeAnnot)).toMatchObject({ color: named('Red'), width: 2 });
  });

  it('still adds the colour it replaced to the recent ones', async () => {
    const t = await ready();
    t.tool('Rectangle');
    t.drag([[20, 200], [120, 150]]);
    t.tool('Select');
    t.drag([[70, 200]]);
    t.pick('Teal');
    expect(t.recent()[0]).toBe('Red');
  });

  it('lets go of the selection when another tool is chosen', async () => {
    const t = await ready();
    t.tool('Rectangle');
    t.drag([[20, 200], [120, 150]]);
    t.tool('Select');
    t.drag([[70, 200]]);
    expect(t.store.getSnapshot().ui.selectedAnnot).toBeTruthy();
    t.tool('Pen');
    expect(t.store.getSnapshot().ui.selectedAnnot).toBeUndefined();
    t.pick('Brown'); // the pen's colour, not the rectangle's
    expect((t.annots()[0] as ShapeAnnot).color).toEqual(named('Red'));
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Brown');
  });

  it('changes only what was changed: a text box keeps its colour when its size changes', async () => {
    const t = await ready();
    t.tool('Text');
    t.pick('Blue');
    act(() => t.store.beginText(t.pageId, { x: 20, y: 250 }));
    act(() => t.store.setEditText('hello'));
    act(() => t.store.commitText(t.store.getSnapshot().ui.textEdit!));
    const box = () => t.annots()[0] as FreeTextAnnot;
    expect(box().color).toEqual(named('Blue'));
    act(() => t.store.selectAnnotation(undefined));
    t.pick('Green'); // the Text tool's colour for the next box
    act(() => t.store.selectAnnotation({ pageId: t.pageId, id: box().id }));
    expect(t.colourButton().getAttribute('aria-label')).toBe('Colour: Blue');
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '24' } });
    expect(box()).toMatchObject({ fontSize: 24, color: named('Blue') });
  });

  it('shows an annotation from the PDF greyed out, and says why', async () => {
    const t = await ready((i) => (i === 0 ? [{ id: '30R', subtype: 'Square', rect: { x: 30, y: 40, w: 80, h: 40 } }] : []));
    await waitFor(() => expect(t.store.getSnapshot().imported[t.pageId]?.length).toBe(1));
    t.tool('Select');
    act(() => t.store.selectAnnotation({ pageId: t.pageId, id: t.store.getSnapshot().imported[t.pageId]![0]!.id }));
    expect(t.colourButton().disabled).toBe(true);
    expect(t.slider().disabled).toBe(true);
    expect(screen.getByText(/came with the PDF/)).toBeTruthy();
  });

  it('greys out colour for a selected stamp, which keeps its own colours', async () => {
    const t = await ready();
    t.tool('Stamp');
    act(() => void t.store.addStamp(t.pageId, { x: 100, y: 150 })); // selected, with the Select tool
    expect(t.store.getSnapshot().ui.selectedAnnot).toBeTruthy();
    expect(t.colourButton().disabled).toBe(true);
  });
});
