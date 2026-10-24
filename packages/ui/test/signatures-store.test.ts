import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SIGNATURE_WIDTH, type SignatureArt, type StampAnnot } from '@pagewright/core';
import { AppStore, MAX_SAVED_SIGNATURES, SIGNATURE_INKS, type SavedSignature, type SignatureMaker } from '../src/store';
import { file, setup } from './store-helpers';

const BLACK = SIGNATURE_INKS[0]!.color;
const BLUE = SIGNATURE_INKS[1]!.color;

const fakeArt = (n: number): SignatureArt => ({ w: 20 * n, h: 40, mode: 'fill', paths: [['M', 0, 0], ['L', 20 * n, 0], ['L', 20 * n, 40], ['Z']] });

/** Draws a rectangle 20 wide per character; '#' is a character no style can draw. */
const makeMaker = (): SignatureMaker & { make: ReturnType<typeof vi.fn> } => ({
  fonts: [{ id: 'script', label: 'Script' }, { id: 'neat', label: 'Neat' }],
  make: vi.fn(async (text: string, fontId: string) => {
    if (fontId === 'broken') throw new Error('font failed to load');
    const clean = text.trim();
    if (!clean) throw new Error('There is nothing to draw: try a name with letters in it.');
    return { art: fakeArt(clean.length), missing: [...new Set([...clean].filter((c) => c === '#'))] };
  }),
});

const saved = (id: string, over: Partial<SavedSignature> = {}): SavedSignature => ({
  id, name: id, art: fakeArt(3), color: BLACK, createdAt: '2026-01-01T00:00:00Z', ...over,
});

/** A store with a secure store we can inspect, and optionally some signatures already saved from an earlier session. */
async function ready(opts: { stored?: unknown; maker?: SignatureMaker | null; secureSetFails?: boolean } = {}) {
  const t = setup();
  const platform = t.platform as unknown as { secure: { get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> } };
  platform.secure.get.mockImplementation(async (k: string) => (k === 'signatures' ? opts.stored : t.secrets.get(k)));
  const writes: unknown[] = [];
  platform.secure.set.mockImplementation(async (k: string, v: unknown) => {
    if (opts.secureSetFails) throw new Error('quota');
    if (k === 'signatures') writes.push(JSON.parse(JSON.stringify(v)));
  });
  const maker = opts.maker === null ? undefined : (opts.maker ?? makeMaker());
  let n = 0;
  const store = new AppStore({ renderer: (t.renderer), writer: t.writer, platform: t.platform, signatureMaker: maker, newId: () => `id${++n}` });
  await store.addFiles([file('a.pdf')]);
  const pageId = store.getSnapshot().doc.pages[0]!.id;
  const sigs = () => store.getSnapshot().ui.signatures;
  const stamps = () => (store.getSnapshot().doc.annotations[pageId] ?? []).filter((a): a is StampAnnot => a.type === 'stamp');
  return { store, maker, writes, pageId, sigs, stamps };
}

describe('loading saved signatures', () => {
  it('brings back what was saved in an earlier session', async () => {
    const { store, sigs } = await ready({ stored: [saved('a'), saved('b')] });
    await vi.waitFor(() => expect(sigs()).toHaveLength(2));
    expect(sigs().map((s) => s.id)).toEqual(['a', 'b']);
    expect(store.getSnapshot().ui.signatureDialog).toBe(false);
  });

  it('keeps only entries that are safe to use, dropping damaged or hand-edited ones', async () => {
    const good = saved('good');
    const stored = [
      good,
      { ...saved('no-art'), art: undefined },
      { ...saved('bad-art'), art: { w: 10, h: 10, mode: 'fill', paths: [['L', 1, 1]] } },
      { ...saved('bad-colour'), color: { r: 5, g: 0, b: 0, a: 1 } },
      { ...saved('bad-id'), id: 7 },
      null,
      'nonsense',
    ];
    const { sigs } = await ready({ stored });
    await vi.waitFor(() => expect(sigs()).toHaveLength(1));
    expect(sigs()[0]!.id).toBe('good');
  });

  it('ignores storage that is not a list, and caps the list length', async () => {
    const a = await ready({ stored: { not: 'a list' } });
    await sleep();
    expect(a.sigs()).toEqual([]);
    const many = Array.from({ length: MAX_SAVED_SIGNATURES + 10 }, (_, i) => saved(`s${i}`));
    const b = await ready({ stored: many });
    await vi.waitFor(() => expect(b.sigs()).toHaveLength(MAX_SAVED_SIGNATURES));
  });
});
const sleep = () => new Promise((r) => setTimeout(r, 20));

describe('creating a signature', () => {
  it('draws the typed name, keeps it, and stores it on the device', async () => {
    const { store, sigs, writes } = await ready();
    const s = await store.createSignature('  Ada   Lovelace ', 'script', BLUE);
    expect(s).toMatchObject({ name: 'Ada Lovelace', color: BLUE });
    expect(s.art.w).toBe(20 * 'Ada   Lovelace'.length); // the maker got the trimmed text
    expect(sigs().map((x) => x.id)).toEqual([s.id]);
    expect(writes.at(-1)).toEqual([JSON.parse(JSON.stringify(s))]);
  });

  it('adds to what is there, newest last', async () => {
    const { store, sigs } = await ready();
    await store.createSignature('Ada', 'script', BLACK);
    await store.createSignature('Bob', 'neat', BLUE);
    expect(sigs().map((s) => s.name)).toEqual(['Ada', 'Bob']);
  });

  it('keeps nothing and says why when the drawing fails', async () => {
    const { store, sigs, writes } = await ready();
    await expect(store.createSignature('Ada', 'broken', BLACK)).rejects.toThrow('font failed to load');
    await expect(store.createSignature('   ', 'script', BLACK)).rejects.toThrow(/nothing to draw/);
    expect(sigs()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('cannot create typed signatures when the app has no maker', async () => {
    const { store } = await ready({ maker: null });
    await expect(store.createSignature('Ada', 'script', BLACK)).rejects.toThrow(/not available/);
  });

  it('stops at the limit instead of growing without bound', async () => {
    const { store, sigs } = await ready({ stored: Array.from({ length: MAX_SAVED_SIGNATURES }, (_, i) => saved(`s${i}`)) });
    await vi.waitFor(() => expect(sigs()).toHaveLength(MAX_SAVED_SIGNATURES));
    await expect(store.createSignature('One more', 'script', BLACK)).rejects.toThrow(/up to 30/);
    expect(sigs()).toHaveLength(MAX_SAVED_SIGNATURES);
  });

  it('previews without saving anything, and reports characters a style cannot draw', async () => {
    const { store, sigs, writes } = await ready();
    const p = await store.previewSignature('Ada #', 'script');
    expect(p.missing).toEqual(['#']);
    expect(sigs()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('tells the person when it could not be written to storage, but still lets them use it this session', async () => {
    const { store, sigs } = await ready({ secureSetFails: true });
    await store.createSignature('Ada', 'script', BLACK);
    expect(sigs()).toHaveLength(1);
    expect(store.getSnapshot().ui.notices.some((n) => /could not be saved on this device/.test(n))).toBe(true);
  });
});

describe('deleting a signature', () => {
  it('removes it from the list and from storage', async () => {
    const { store, sigs, writes } = await ready();
    const a = await store.createSignature('Ada', 'script', BLACK);
    const b = await store.createSignature('Bob', 'script', BLACK);
    await store.deleteSignature(a.id);
    expect(sigs().map((s) => s.id)).toEqual([b.id]);
    expect((writes.at(-1) as SavedSignature[]).map((s) => s.id)).toEqual([b.id]);
  });

  it('forgets it as the signature to place', async () => {
    const { store } = await ready();
    const a = await store.createSignature('Ada', 'script', BLACK);
    store.useSignature(a.id);
    await store.deleteSignature(a.id);
    expect(store.getSnapshot().ui.activeSignature).toBeUndefined();
  });

  it('leaves signatures already placed on the page alone', async () => {
    const { store, pageId, stamps } = await ready();
    const a = await store.createSignature('Ada', 'script', BLACK);
    store.useSignature(a.id);
    store.addSignature(pageId, { x: 100, y: 100 });
    await store.deleteSignature(a.id);
    expect(stamps()).toHaveLength(1);
    expect(stamps()[0]!.payload.kind).toBe('signature');
  });

  it('does nothing for an unknown id', async () => {
    const { store, sigs } = await ready();
    await store.createSignature('Ada', 'script', BLACK);
    await store.deleteSignature('nope');
    expect(sigs()).toHaveLength(1);
  });
});

describe('choosing and placing a signature', () => {
  it('using one selects the Signature tool and closes the dialog', async () => {
    const { store } = await ready();
    const a = await store.createSignature('Ada', 'script', BLACK);
    store.openSignatures();
    expect(store.getSnapshot().ui.signatureDialog).toBe(true);
    store.useSignature(a.id);
    expect(store.getSnapshot().ui).toMatchObject({ activeTool: 'signature', activeSignature: a.id, signatureDialog: false });
  });

  it('ignores a signature that does not exist', async () => {
    const { store } = await ready();
    store.useSignature('ghost');
    expect(store.getSnapshot().ui.activeTool).toBe('select');
    expect(store.getSnapshot().ui.activeSignature).toBeUndefined();
  });

  it('places it centred on the click, at the default width, in its ink, selected, with the Select tool back', async () => {
    const { store, pageId, stamps } = await ready();
    const a = await store.createSignature('Ada Lovelace', 'script', BLUE);
    store.useSignature(a.id);
    const id = store.addSignature(pageId, { x: 120, y: 80 })!;
    const [st] = stamps();
    expect(st!.id).toBe(id);
    expect(st!.payload).toEqual({ kind: 'signature', art: a.art });
    expect(st!.color).toEqual(BLUE);
    expect(st!.rect.w).toBe(DEFAULT_SIGNATURE_WIDTH);
    expect(st!.rect.h).toBeCloseTo((DEFAULT_SIGNATURE_WIDTH * a.art.h) / a.art.w);
    expect(st!.rect.x + st!.rect.w / 2).toBeCloseTo(120);
    expect(st!.rect.y + st!.rect.h / 2).toBeCloseTo(80);
    expect(store.getSnapshot().ui.selectedAnnot).toEqual({ pageId, id });
    expect(store.getSnapshot().ui.activeTool).toBe('select');
  });

  it('is one undo step', async () => {
    const { store, pageId, stamps } = await ready();
    const a = await store.createSignature('Ada', 'script', BLACK);
    store.useSignature(a.id);
    store.addSignature(pageId, { x: 100, y: 100 });
    store.undo();
    expect(stamps()).toHaveLength(0);
  });

  it('copies the artwork, so what is on the page does not change if the saved one is later replaced', async () => {
    const { store, pageId, stamps } = await ready();
    const a = await store.createSignature('Ada', 'script', BLACK);
    store.useSignature(a.id);
    store.addSignature(pageId, { x: 100, y: 100 });
    await store.deleteSignature(a.id);
    const b = await store.createSignature('Different', 'script', BLACK);
    expect(stamps()[0]!.payload).toEqual({ kind: 'signature', art: a.art });
    expect(b.art).not.toEqual(a.art);
  });

  it('opens the dialog instead when none is chosen', async () => {
    const { store, pageId, stamps } = await ready();
    expect(store.addSignature(pageId, { x: 100, y: 100 })).toBeUndefined();
    expect(store.getSnapshot().ui.signatureDialog).toBe(true);
    expect(stamps()).toHaveLength(0);
  });

  it('says once per session that this is not a digital signature', async () => {
    const { store, pageId } = await ready();
    const a = await store.createSignature('Ada', 'script', BLACK);
    store.useSignature(a.id);
    store.addSignature(pageId, { x: 100, y: 100 });
    store.useSignature(a.id);
    store.addSignature(pageId, { x: 100, y: 200 });
    const notes = store.getSnapshot().ui.notices.filter((n) => /not a digital signature/.test(n));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/does not prove who signed/);
  });

  it('can be moved, resized and given a comment like any stamp', async () => {
    const { store, pageId, stamps } = await ready();
    const a = await store.createSignature('Ada', 'script', BLACK);
    store.useSignature(a.id);
    const id = store.addSignature(pageId, { x: 100, y: 100 })!;
    store.setComment(pageId, id, 'Signed on behalf of the board');
    expect(stamps()[0]!.comment?.text).toBe('Signed on behalf of the board');
  });
});

describe('creating a drawn signature', () => {
  const stroke = [{ x: 10, y: 10 }, { x: 40, y: 30 }, { x: 80, y: 12 }];

  it('keeps the pen strokes as stroke-mode artwork, under the given name', async () => {
    const { store, sigs, writes } = await ready({ maker: null }); // drawing needs no fonts
    const s = await store.createDrawnSignature('  My   mark ', [stroke], BLUE);
    expect(s).toMatchObject({ name: 'My mark', color: BLUE });
    expect(s.art.mode).toBe('stroke');
    expect(sigs().map((x) => x.id)).toEqual([s.id]);
    expect(writes.at(-1)).toEqual([JSON.parse(JSON.stringify(s))]);
  });

  it('gives an unnamed one a name', async () => {
    const { store } = await ready();
    expect((await store.createDrawnSignature('  ', [stroke], BLACK)).name).toBe('Drawn signature');
  });

  it('keeps nothing and says why when nothing was drawn', async () => {
    const { store, sigs, writes } = await ready();
    await expect(store.createDrawnSignature('x', [], BLACK)).rejects.toThrow(/Draw your signature/);
    expect(sigs()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it('stops at the limit', async () => {
    const { store, sigs } = await ready({ stored: Array.from({ length: MAX_SAVED_SIGNATURES }, (_, i) => saved(`s${i}`)) });
    await vi.waitFor(() => expect(sigs()).toHaveLength(MAX_SAVED_SIGNATURES));
    await expect(store.createDrawnSignature('x', [stroke], BLACK)).rejects.toThrow(/up to/);
  });

  it('can be placed on the page like any other', async () => {
    const { store, pageId, stamps } = await ready();
    const s = await store.createDrawnSignature('x', [stroke], BLACK);
    store.useSignature(s.id);
    store.addSignature(pageId, { x: 100, y: 100 });
    expect(stamps()[0]!.payload).toEqual({ kind: 'signature', art: s.art });
  });
});
