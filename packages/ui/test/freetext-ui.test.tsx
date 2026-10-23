// @vitest-environment jsdom
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_WIDTH, freeTextHeight, type Annotation, type FreeTextAnnot } from '@pagewright/core';
import { setup } from './helpers';

/** Fake pages are 200 x 300 pt, shown at 96/72 px per point. */
const S = 96 / 72;
const px = (x: number, y: number) => ({ clientX: x * S, clientY: (300 - y) * S });

async function ready() {
  const t = setup();
  await t.open();
  const svg = await waitFor(() => {
    const el = document.querySelector<SVGSVGElement>('svg.overlay');
    if (!el) throw new Error('overlay not mounted');
    return el;
  });
  const pageId = t.store.getSnapshot().doc.pages[0]!.id;
  const annots = () => (t.store.getSnapshot().doc.annotations[pageId] ?? []) as Annotation[];
  const texts = () => annots().filter((a): a is FreeTextAnnot => a.type === 'freetext');
  const tool = (name: string) => fireEvent.click(screen.getByRole('radio', { name }));
  const click = (x: number, y: number) => {
    fireEvent.pointerDown(svg, { button: 0, pointerId: 1, ...px(x, y) });
    fireEvent.pointerUp(svg, { pointerId: 1, ...px(x, y) });
  };
  const box = () => screen.getByLabelText('Text') as HTMLTextAreaElement;
  const type = (value: string) => fireEvent.change(box(), { target: { value } });
  /** Place a text box with the Text tool and type into it, then commit with Ctrl+Enter. */
  const addText = (x: number, y: number, value: string) => {
    tool('Text');
    click(x, y);
    type(value);
    fireEvent.keyDown(box(), { key: 'Enter', ctrlKey: true });
  };
  return { ...t, svg, pageId, annots, texts, tool, click, box, type, addText };
}

describe('typing a new text box', () => {
  it('opens an empty text box at the click, in the chosen font', async () => {
    const t = await ready();
    t.tool('Text');
    t.click(40, 200);
    expect(t.box().value).toBe('');
    expect(document.activeElement).toBe(t.box());
    expect(t.box().style.left).toBe(`${40 * S}px`);
    expect(t.box().style.top).toBe(`${100 * S}px`);
    expect(t.box().style.width).toBe(`${DEFAULT_TEXT_WIDTH * S}px`);
    expect(t.box().style.fontFamily).toMatch(/Helvetica/);
    expect(t.texts()).toHaveLength(0);
  });

  it('commits with Ctrl+Enter and shows the text on the page', async () => {
    const t = await ready();
    t.addText(40, 200, 'Hello world');
    expect(screen.queryByLabelText('Text')).toBeNull();
    const [a] = t.texts();
    expect(a).toMatchObject({ text: 'Hello world', fontFamily: 'sans', fontSize: 12 });
    const view = t.svg.querySelector(`[data-annot-id="${a!.id}"]`)!;
    expect([...view.querySelectorAll('text')].map((x) => x.textContent)).toEqual(['Hello world']);
    expect(t.store.getSnapshot().ui.selectedAnnot?.id).toBe(a!.id);
  });

  it('commits when the box loses focus', async () => {
    const t = await ready();
    t.tool('Text');
    t.click(40, 200);
    t.type('typed then clicked away');
    fireEvent.blur(t.box());
    expect(t.texts().map((a) => a.text)).toEqual(['typed then clicked away']);
  });

  it('keeps line breaks and wraps at the box width exactly as the saved page will', async () => {
    const t = await ready();
    t.addText(20, 250, 'first line\nThe quick brown fox jumps over the lazy dog');
    const a = t.texts()[0]!;
    const lines = [...t.svg.querySelectorAll(`[data-annot-id="${a.id}"] text`)].map((x) => x.textContent);
    expect(lines[0]).toBe('first line');
    expect(lines.length).toBeGreaterThan(2); // the second paragraph wrapped
    expect(lines.slice(1).join(' ')).toBe('The quick brown fox jumps over the lazy dog');
    expect(a.rect.h).toBeCloseTo(freeTextHeight(lines.length, 12));
  });

  it('creates nothing for empty text, and Escape cancels', async () => {
    const t = await ready();
    t.tool('Text');
    t.click(40, 200);
    fireEvent.blur(t.box());
    expect(t.texts()).toHaveLength(0);
    t.click(40, 200);
    t.type('abandoned');
    fireEvent.keyDown(t.box(), { key: 'Escape' });
    expect(screen.queryByLabelText('Text')).toBeNull();
    expect(t.texts()).toHaveLength(0);
  });

  it('does not treat shortcut letters typed into the box as tool changes', async () => {
    const t = await ready();
    t.tool('Text');
    t.click(40, 200);
    for (const key of ['p', 'r', 'v', 'Delete']) fireEvent.keyDown(t.box(), { key });
    expect(t.store.getSnapshot().ui.activeTool).toBe('text');
  });

  it('clicking elsewhere finishes the box and starts another, without losing or mixing text', async () => {
    const t = await ready();
    t.tool('Text');
    t.click(40, 250);
    t.type('first');
    t.click(40, 100); // pointer-down on the page: commits "first", starts a new box
    expect(t.texts().map((a) => a.text)).toEqual(['first']);
    expect(t.box().value).toBe('');
    fireEvent.blur(t.box()); // and the late blur of the old box does nothing harmful
    expect(t.texts()).toHaveLength(1);
  });

  it('clicking the page with another tool while typing commits the text', async () => {
    const t = await ready();
    t.tool('Text');
    t.click(40, 200);
    t.type('finish me');
    fireEvent.keyDown(window, { key: 'v' }); // the Select shortcut, pressed outside the text box
    t.click(150, 40); // pointer-down on empty page: no blur event is needed
    expect(t.texts().map((a) => a.text)).toEqual(['finish me']);
    expect(screen.queryByLabelText('Text')).toBeNull();
  });

  it('warns while typing characters the built-in fonts cannot show, and stores ? for them', async () => {
    const t = await ready();
    t.tool('Text');
    t.click(40, 200);
    t.type('Привет');
    expect(screen.getByText(/6 characters can’t be saved/)).toBeTruthy();
    fireEvent.keyDown(t.box(), { key: 'Enter', ctrlKey: true });
    expect(t.texts()[0]!.text).toBe('??????');
    expect(screen.queryByText(/can’t be saved/)).toBeNull();
    expect(t.store.getSnapshot().ui.notices.some((n) => /replaced with/.test(n))).toBe(true);
  });

  it('T selects the Text tool', async () => {
    const t = await ready();
    fireEvent.keyDown(window, { key: 't' });
    expect(t.store.getSnapshot().ui.activeTool).toBe('text');
  });
});

describe('editing existing text', () => {
  it('opens on double-click in the Select tool, with the text and the same position', async () => {
    const t = await ready();
    t.addText(40, 200, 'edit me');
    t.tool('Select');
    fireEvent.doubleClick(t.svg, px(60, 195));
    expect(t.box().value).toBe('edit me');
    expect(t.box().style.left).toBe(`${40 * S}px`);
    // the finished text is hidden while the live box is shown
    expect(t.svg.querySelector(`[data-annot-id="${t.texts()[0]!.id}"]`)).toBeNull();
  });

  it('commits the new text as one undo step', async () => {
    const t = await ready();
    t.addText(40, 200, 'before');
    t.tool('Select');
    fireEvent.doubleClick(t.svg, px(60, 195));
    t.type('after');
    fireEvent.blur(t.box());
    expect(t.texts()[0]!.text).toBe('after');
    t.store.undo();
    expect(t.texts()[0]!.text).toBe('before');
  });

  it('opens with Enter when the box is selected', async () => {
    const t = await ready();
    t.addText(40, 200, 'enter key');
    t.tool('Select');
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(t.box().value).toBe('enter key');
  });

  it('clicking existing text with the Text tool edits it instead of adding a second box', async () => {
    const t = await ready();
    t.addText(40, 200, 'only one');
    t.click(60, 195);
    expect(t.box().value).toBe('only one');
    fireEvent.keyDown(t.box(), { key: 'Escape' });
    expect(t.texts()).toHaveLength(1);
  });

  it('deleting all the text deletes the box', async () => {
    const t = await ready();
    t.addText(40, 200, 'temporary');
    t.tool('Select');
    fireEvent.doubleClick(t.svg, px(60, 195));
    t.type('');
    fireEvent.blur(t.box());
    expect(t.texts()).toHaveLength(0);
  });
});

describe('moving and resizing text', () => {
  const dragFrom = (t: Awaited<ReturnType<typeof ready>>, from: [number, number], to: [number, number], target?: Element) => {
    fireEvent.pointerDown(target ?? t.svg, { button: 0, pointerId: 1, ...px(...from) });
    fireEvent.pointerMove(t.svg, { pointerId: 1, ...px(...to) });
    fireEvent.pointerUp(t.svg, { pointerId: 1, ...px(...to) });
  };

  it('moves by dragging the text, as one undo step', async () => {
    const t = await ready();
    t.addText(40, 200, 'move me');
    t.tool('Select');
    const before = { ...t.texts()[0]!.rect };
    dragFrom(t, [60, 195], [90, 160]);
    const after = t.texts()[0]!.rect;
    expect(after.x).toBeCloseTo(before.x + 30);
    expect(after.y).toBeCloseTo(before.y - 35);
    expect(after.w).toBeCloseTo(before.w);
    t.store.undo();
    expect(t.texts()[0]!.rect).toEqual(before);
  });

  it('offers handles on the left and right edges only', async () => {
    const t = await ready();
    t.addText(40, 200, 'handles');
    t.tool('Select');
    expect([...t.svg.querySelectorAll('[data-handle]')].map((h) => h.getAttribute('data-handle'))).toEqual(['w', 'e']);
  });

  it('resizes the width from the right handle and the height follows the wrapped text', async () => {
    const t = await ready();
    t.addText(20, 250, 'The quick brown fox jumps over the lazy dog again');
    t.tool('Select');
    const before = t.texts()[0]!.rect;
    const right = before.x + before.w;
    const mid = before.y + before.h / 2;
    dragFrom(t, [right, mid], [right - 70, mid], t.svg.querySelector('[data-handle="e"]')!);
    const after = t.texts()[0]!.rect;
    expect(after.x).toBeCloseTo(before.x);
    expect(after.w).toBeCloseTo(before.w - 70);
    expect(after.h).toBeGreaterThan(before.h); // narrower -> more lines
    expect(after.y + after.h).toBeCloseTo(before.y + before.h); // top edge fixed
    t.store.undo();
    expect(t.texts()[0]!.rect.w).toBeCloseTo(before.w);
  });

  it('resizes from the left handle keeping the right edge', async () => {
    const t = await ready();
    t.addText(60, 250, 'left handle');
    t.tool('Select');
    const before = t.texts()[0]!.rect;
    dragFrom(t, [before.x, before.y + before.h / 2], [before.x - 30, before.y + before.h / 2], t.svg.querySelector('[data-handle="w"]')!);
    const after = t.texts()[0]!.rect;
    expect(after.x).toBeCloseTo(before.x - 30);
    expect(after.x + after.w).toBeCloseTo(before.x + before.w);
  });
});

describe('text style controls', () => {
  it('appear for the Text tool and offer fonts and sizes instead of line widths', async () => {
    const t = await ready();
    t.tool('Text');
    expect(screen.getByLabelText('Font Sans')).toBeTruthy();
    expect(screen.getByLabelText('Font size')).toBeTruthy();
    expect(screen.queryByLabelText('Width 4')).toBeNull();
    t.tool('Rectangle');
    expect(screen.queryByLabelText('Font Sans')).toBeNull();
    expect(screen.getByLabelText('Width 4')).toBeTruthy();
  });

  it('start the next text box in the chosen font, size and colour', async () => {
    const t = await ready();
    t.tool('Text');
    fireEvent.click(screen.getByLabelText('Font Serif'));
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '24' } });
    fireEvent.click(screen.getByLabelText('Blue'));
    t.click(30, 250);
    expect(t.box().style.fontFamily).toMatch(/Times/);
    expect(t.box().style.fontSize).toBe(`${24 * S}px`);
    t.type('big blue serif');
    fireEvent.keyDown(t.box(), { key: 'Enter', ctrlKey: true });
    expect(t.texts()[0]).toMatchObject({ fontFamily: 'serif', fontSize: 24, color: { r: 0.15, g: 0.4, b: 0.9 } });
  });

  it('restyle the selected box, re-wrapping it', async () => {
    const t = await ready();
    t.addText(20, 250, 'Some words that wrap at this width');
    t.tool('Select');
    const before = t.texts()[0]!.rect.h;
    fireEvent.change(screen.getByLabelText('Font size'), { target: { value: '24' } });
    expect(t.texts()[0]!.fontSize).toBe(24);
    expect(t.texts()[0]!.rect.h).toBeGreaterThan(before);
    fireEvent.click(screen.getByLabelText('Font Mono'));
    expect(t.texts()[0]!.fontFamily).toBe('mono');
    expect(screen.getByLabelText('Font Mono').getAttribute('aria-pressed')).toBe('true');
  });

  it('are shown for a selected text box even in the Select tool', async () => {
    const t = await ready();
    t.addText(20, 250, 'x');
    t.tool('Select');
    expect(screen.getByLabelText('Font Sans')).toBeTruthy();
  });
});

describe('text on rotated pages', () => {
  it('turns the text and its editor with the page', async () => {
    const t = await ready();
    t.addText(40, 200, 'rotate with the page');
    t.store.rotatePages(90, [t.pageId]);
    await waitFor(() => {
      const g = t.annots().length && document.querySelector(`[data-annot-id="${t.texts()[0]!.id}"] g`);
      expect(g && g.getAttribute('transform')).toMatch(/rotate\(90\)/);
    });
    t.tool('Select');
    const svg = document.querySelector<SVGSVGElement>('svg.overlay')!;
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(svg).toBeTruthy();
    expect(t.box().style.transform).toBe('rotate(90deg)');
  });
});

describe('comments panel', () => {
  it('does not offer a separate comment for text boxes (their text is their content)', async () => {
    const t = await ready();
    t.addText(40, 200, 'no comment box');
    fireEvent.keyDown(window, { key: 'c' });
    expect(t.store.getSnapshot().ui.selectedAnnot).toBeDefined();
    expect(screen.queryByRole('heading', { name: /Comment on this/ })).toBeNull();
  });
});
