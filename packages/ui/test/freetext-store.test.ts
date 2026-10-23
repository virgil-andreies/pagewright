import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_WIDTH, freeTextHeight, type FreeTextAnnot } from '@pagewright/core';
import type { AppStore } from '../src/store';
import { file, setup } from './store-helpers';

async function ready() {
  const t = setup();
  await t.store.addFiles([file('a.pdf')]);
  const [p1, p2] = t.store.getSnapshot().doc.pages.map((p) => p.id) as [string, string];
  const texts = (pageId = p1) => (t.store.getSnapshot().doc.annotations[pageId] ?? []).filter((a): a is FreeTextAnnot => a.type === 'freetext');
  return { ...t, p1, p2, texts };
}

/** Type `text` into a new box at (x, y) and finish. */
function typeBox(store: AppStore, pageId: string, text: string, at = { x: 40, y: 200 }) {
  store.beginText(pageId, at);
  store.setEditText(text);
  store.commitText();
}

describe('creating text', () => {
  it('puts a box with the typed text at the click, hanging down from it, and selects it', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'Hello world');
    const [a] = texts();
    expect(texts()).toHaveLength(1);
    expect(a).toMatchObject({ text: 'Hello world', fontSize: 12, fontFamily: 'sans', origin: 'app' });
    expect(a!.rect.x).toBe(40);
    expect(a!.rect.w).toBe(DEFAULT_TEXT_WIDTH);
    expect(a!.rect.y + a!.rect.h).toBeCloseTo(200); // the click is the upper-left corner
    expect(a!.rect.h).toBeCloseTo(freeTextHeight(1, 12));
    expect(store.getSnapshot().ui.textEdit).toBeUndefined();
    expect(store.getSnapshot().ui.selectedAnnot).toEqual({ pageId: p1, id: a!.id });
  });

  it('wraps long text into a taller box', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'The quick brown fox jumps over the lazy dog and runs away over the hill');
    expect(texts()[0]!.rect.h).toBeGreaterThan(freeTextHeight(2, 12));
  });

  it('keeps explicit line breaks', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'one\ntwo\nthree');
    expect(texts()[0]!.rect.h).toBeCloseTo(freeTextHeight(3, 12));
  });

  it('adds nothing for empty or blank text', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, '   \n  ');
    typeBox(store, p1, '');
    expect(texts()).toHaveLength(0);
    expect(store.getSnapshot().ui.textEdit).toBeUndefined();
  });

  it('drops trailing whitespace but keeps leading and inner spaces', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, '  indented   text \n\n');
    expect(texts()[0]!.text).toBe('  indented   text');
  });

  it('is one undo step', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'x');
    store.undo();
    expect(texts()).toHaveLength(0);
  });

  it('cancelling drops the draft', async () => {
    const { store, p1, texts } = await ready();
    store.beginText(p1, { x: 1, y: 1 });
    store.setEditText('never saved');
    store.cancelText();
    expect(store.getSnapshot().ui.textEdit).toBeUndefined();
    expect(texts()).toHaveLength(0);
  });

  it('uses the current font, size and colour', async () => {
    const { store, p1, texts } = await ready();
    store.setDrawStyle({ fontFamily: 'mono', fontSize: 18, color: { r: 0, g: 0, b: 1, a: 1 } });
    typeBox(store, p1, 'styled');
    expect(texts()[0]).toMatchObject({ fontFamily: 'mono', fontSize: 18, color: { b: 1 } });
  });
});

describe('characters the built-in fonts cannot show', () => {
  it('are replaced by ? in what is stored, with a one-time notice', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'Привет мир');
    expect(texts()[0]!.text).toBe('?????? ???');
    const notices = store.getSnapshot().ui.notices.filter((n) => /replaced with/.test(n));
    expect(notices).toHaveLength(1);
    typeBox(store, p1, '日本語', { x: 40, y: 100 });
    expect(store.getSnapshot().ui.notices.filter((n) => /replaced with/.test(n))).toHaveLength(1); // once per session
  });

  it('leave accented and typographic characters alone', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'Crème brûlée — “5 €”');
    expect(texts()[0]!.text).toBe('Crème brûlée — “5 €”');
    expect(store.getSnapshot().ui.notices.some((n) => /replaced with/.test(n))).toBe(false);
  });
});

describe('editing text', () => {
  it('changes the text, re-fits the height, and undoes', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'short');
    const a = texts()[0]!;
    store.editText(p1, a.id);
    expect(store.getSnapshot().ui.textEdit).toMatchObject({ id: a.id, text: 'short', width: a.rect.w, position: { x: a.rect.x, y: a.rect.y + a.rect.h } });
    store.setEditText('one\ntwo\nthree');
    store.commitText();
    const b = texts()[0]!;
    expect(b.text).toBe('one\ntwo\nthree');
    expect(b.rect.h).toBeCloseTo(freeTextHeight(3, 12));
    expect(b.rect.y + b.rect.h).toBeCloseTo(a.rect.y + a.rect.h); // top edge stays
    store.undo();
    expect(texts()[0]!.text).toBe('short');
  });

  it('makes no undo step when the text is unchanged', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'same');
    const before = store.getSnapshot().doc;
    store.editText(p1, texts()[0]!.id);
    store.commitText();
    expect(store.getSnapshot().doc).toBe(before);
  });

  it('deletes the box when its text is cleared, and undo brings it back', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'bye');
    store.editText(p1, texts()[0]!.id);
    store.setEditText('');
    store.commitText();
    expect(texts()).toHaveLength(0);
    expect(store.getSnapshot().ui.selectedAnnot).toBeUndefined();
    store.undo();
    expect(texts()[0]!.text).toBe('bye');
  });

  it('only edits text boxes made here, not other annotations', async () => {
    const { store, p1 } = await ready();
    const id = store.addMarkup('highlight', p1, [{ p1: { x: 0, y: 10 }, p2: { x: 10, y: 10 }, p3: { x: 0, y: 0 }, p4: { x: 10, y: 0 } }])!;
    store.editText(p1, id);
    expect(store.getSnapshot().ui.textEdit).toBeUndefined();
    store.editText(p1, 'missing');
    expect(store.getSnapshot().ui.textEdit).toBeUndefined();
  });
});

describe('switching between boxes', () => {
  it('starting a new box commits the one being typed', async () => {
    const { store, p1, texts } = await ready();
    store.beginText(p1, { x: 40, y: 200 });
    store.setEditText('first');
    store.beginText(p1, { x: 40, y: 100 });
    expect(texts().map((t) => t.text)).toEqual(['first']);
    expect(store.getSnapshot().ui.textEdit).toMatchObject({ text: '', position: { x: 40, y: 100 } });
  });

  it('editing another box commits the one being typed', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'one', { x: 40, y: 200 });
    typeBox(store, p1, 'two', { x: 40, y: 100 });
    const [one, two] = texts();
    store.editText(p1, one!.id);
    store.setEditText('ONE');
    store.editText(p1, two!.id);
    expect(texts().map((t) => t.text)).toEqual(['ONE', 'two']);
  });

  it('a late blur from a replaced text box cannot commit the new one', async () => {
    const { store, p1, texts } = await ready();
    store.beginText(p1, { x: 40, y: 200 });
    store.setEditText('old');
    const stale = store.getSnapshot().ui.textEdit!;
    store.beginText(p1, { x: 40, y: 100 }); // commits "old", starts the new box
    store.setEditText('new, still being typed');
    store.commitText(stale); // the old box's blur arrives late
    expect(store.getSnapshot().ui.textEdit?.text).toBe('new, still being typed');
    expect(texts().map((t) => t.text)).toEqual(['old']);
  });

  it('a stale commit for the same position but another box is ignored too', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'a');
    const a = texts()[0]!;
    store.editText(p1, a.id);
    const stale = store.getSnapshot().ui.textEdit!;
    store.commitText();
    store.beginText(p1, { x: 5, y: 5 });
    store.setEditText('b');
    store.commitText(stale);
    expect(store.getSnapshot().ui.textEdit?.text).toBe('b');
  });
});

describe('restyling text', () => {
  it('changes the font of the selected box, re-fits it, and undoes', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'iiiiiiii '.repeat(12).trim()); // narrow letters: few lines in Helvetica, many in Courier
    const before = texts()[0]!;
    store.setDrawStyle({ fontFamily: 'mono' });
    const after = texts()[0]!;
    expect(after.fontFamily).toBe('mono');
    expect(after.rect.h).not.toBe(before.rect.h); // monospace wraps differently
    expect(after.rect.y + after.rect.h).toBeCloseTo(before.rect.y + before.rect.h);
    store.undo();
    expect(texts()[0]!.fontFamily).toBe('sans');
  });

  it('changes size and colour of the selected box', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'size me');
    store.setDrawStyle({ fontSize: 36 });
    expect(texts()[0]!.fontSize).toBe(36);
    expect(texts()[0]!.rect.h).toBeCloseTo(freeTextHeight(1, 36));
    store.setDrawStyle({ color: { r: 0, g: 0.5, b: 0, a: 1 } });
    expect(texts()[0]!.color).toMatchObject({ g: 0.5 });
  });

  it('does not touch a box that is not selected', async () => {
    const { store, p1, texts } = await ready();
    typeBox(store, p1, 'leave me');
    store.selectAnnotation(undefined);
    store.setDrawStyle({ fontFamily: 'serif' });
    expect(texts()[0]!.fontFamily).toBe('sans');
  });
});
