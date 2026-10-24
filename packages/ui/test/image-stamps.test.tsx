// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_STAMP_BOX, MAX_IMAGE_FILE_BYTES, newImageStampRect, sniffImage, type Annotation, type StampAnnot } from '@pagewright/core';
import type { PickedFile } from '@pagewright/platform';
import type { ImageLoader, StampImage } from '../src';
import { setup } from './helpers';

/** Fake pages are 200 x 300 pt, shown at 96/72 px per point. */
const S = 96 / 72;
const px = (x: number, y: number) => ({ clientX: x * S, clientY: (300 - y) * S });

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const picked = (name: string, bytes = PNG, size = bytes.length): PickedFile => ({ name, size, read: vi.fn(async () => bytes) });

/** Pretends to prepare the picture: a 400 x 100 PNG, unless the bytes are not a picture at all. */
function fakeLoader(result: Partial<StampImage> = {}) {
  return vi.fn<ImageLoader>(async (bytes) => {
    if (!sniffImage(bytes)) throw new Error('Only PNG and JPEG pictures can be used as stamps.');
    return { mime: 'image/png', bytes: new Uint8Array([9, 9]), width: 400, height: 100, ...result };
  });
}

async function ready(loader: ImageLoader | null = fakeLoader()) {
  const t = setup(3, () => [], undefined, loader ?? undefined);
  await t.open();
  const svg = await waitFor(() => {
    const el = document.querySelector<SVGSVGElement>('svg.overlay');
    if (!el) throw new Error('overlay not mounted');
    return el;
  });
  const host = svg.parentElement!;
  const pageId = t.store.getSnapshot().doc.pages[0]!.id;
  const stamps = () => ((t.store.getSnapshot().doc.annotations[pageId] ?? []) as Annotation[]).filter((a): a is StampAnnot => a.type === 'stamp');
  const press = (x: number, y: number) => {
    fireEvent.pointerDown(host, { button: 0, pointerId: 1, ...px(x, y) });
    fireEvent.pointerUp(host, { pointerId: 1, ...px(x, y) });
  };
  const stampTool = () => fireEvent.click(screen.getByRole('radio', { name: 'Stamp' }));
  const pictureButton = () => screen.queryByRole('button', { name: /Picture…|Preparing…/ }) as HTMLButtonElement | null;
  const choose = async (file: PickedFile) => {
    t.pickNext([file]);
    fireEvent.click(pictureButton()!);
    await waitFor(() => expect(t.store.getSnapshot().ui.stampImageLoading).toBeFalsy());
  };
  const picker = () => screen.getByLabelText('Stamp type') as HTMLSelectElement;
  const error = () => (t.store.getSnapshot().ui.error as { message?: string } | undefined)?.message;
  return { ...t, host, pageId, stamps, press, stampTool, pictureButton, choose, picker, error };
}

// jsdom has no blob URLs; the stamp's picture is shown through one.
let urls: string[] = [];
beforeEach(() => {
  urls = [];
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:test/${++n}`);
  URL.revokeObjectURL = vi.fn((u: string) => void urls.push(u));
});

describe('newImageStampRect', () => {
  it('is one point per pixel for a small picture, centred on the click', () => {
    expect(newImageStampRect(80, 40, { x: 100, y: 100 })).toEqual({ x: 60, y: 80, w: 80, h: 40 });
  });
  it('fits a large picture in the stamp box, keeping its proportions', () => {
    const r = newImageStampRect(4000, 1000, { x: 0, y: 0 });
    expect(r.w).toBe(IMAGE_STAMP_BOX);
    expect(r.h).toBe(IMAGE_STAMP_BOX / 4);
    const tall = newImageStampRect(1000, 4000, { x: 0, y: 0 });
    expect(tall.h).toBe(IMAGE_STAMP_BOX);
    expect(tall.w).toBe(IMAGE_STAMP_BOX / 4);
  });
  it('is never too small to grab', () => {
    const r = newImageStampRect(4, 2, { x: 0, y: 0 });
    expect(r.w).toBe(30);
    expect(r.h).toBe(15);
  });
});

describe('sniffImage', () => {
  it('knows PNG and JPEG by their first bytes, whatever the file is called', () => {
    expect(sniffImage(PNG)).toBe('image/png');
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBeUndefined();
    expect(sniffImage(new Uint8Array())).toBeUndefined();
  });
});

describe('choosing a picture for the Stamp tool', () => {
  it('offers Picture… with the Stamp tool, when the app can prepare pictures', async () => {
    const t = await ready();
    expect(t.pictureButton()).toBeNull();
    t.stampTool();
    expect(t.pictureButton()).toBeTruthy();
  });

  it('does not offer it when the app cannot prepare pictures', async () => {
    const t = await ready(null);
    t.stampTool();
    expect(t.pictureButton()).toBeNull();
  });

  it('asks only for PNG and JPEG files, one at a time', async () => {
    const t = await ready();
    t.stampTool();
    await t.choose(picked('logo.png'));
    expect(t.platform.fs.pickFiles).toHaveBeenLastCalledWith({ multiple: false, accept: ['.png', '.jpg', '.jpeg', 'image/png', 'image/jpeg'] });
  });

  it('shows the chosen picture as the stamp to place', async () => {
    const t = await ready();
    t.stampTool();
    await t.choose(picked('logo.png'));
    expect(t.picker().selectedOptions[0]!.textContent).toBe('Picture: logo.png');
    expect(t.store.getSnapshot().ui.activeTool).toBe('stamp');
  });

  it('places the prepared picture centred on the click, selected, at its proportions', async () => {
    const loader = fakeLoader();
    const t = await ready(loader);
    t.stampTool();
    await t.choose(picked('logo.png'));
    expect(loader).toHaveBeenCalledWith(PNG);
    t.press(100, 150);
    const [st] = t.stamps();
    expect(st!.payload).toEqual({ kind: 'image', mime: 'image/png', bytes: new Uint8Array([9, 9]) }); // what the loader made, not the file
    const want = newImageStampRect(400, 100, { x: 100, y: 150 });
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(st!.rect[k]).toBeCloseTo(want[k], 6);
    expect(t.store.getSnapshot().ui).toMatchObject({ activeTool: 'select', selectedAnnot: { pageId: t.pageId, id: st!.id } });
  });

  it('draws it on the page from the picture, and lets go of the picture when it is removed', async () => {
    const t = await ready();
    t.stampTool();
    await t.choose(picked('logo.png'));
    t.press(100, 150);
    const img = await waitFor(() => {
      const el = document.querySelector('svg.overlay image');
      if (!el) throw new Error('not drawn');
      return el;
    });
    const url = img.getAttribute('href')!;
    expect(url).toMatch(/^blob:/);
    expect(Number(img.getAttribute('width'))).toBeCloseTo(IMAGE_STAMP_BOX); // in points, scaled by the group
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(document.querySelector('svg.overlay image')).toBeNull());
    expect(urls).toContain(url);
  });

  it('keeps placing the same picture until a preset is chosen again', async () => {
    const t = await ready();
    t.stampTool();
    await t.choose(picked('logo.png'));
    t.press(100, 150);
    t.stampTool();
    t.press(100, 60);
    expect(t.stamps().map((s) => s.payload.kind)).toEqual(['image', 'image']);
    const bytesOf = (st: StampAnnot) => (st.payload.kind === 'image' ? st.payload.bytes : undefined);
    expect(bytesOf(t.stamps()[0]!)).toBe(bytesOf(t.stamps()[1]!)); // one picture, shared
    t.stampTool();
    fireEvent.change(t.picker(), { target: { value: 'Draft' } });
    expect(t.picker().textContent).not.toContain('Picture:');
    t.press(100, 250);
    expect(t.stamps()[2]!.payload).toEqual({ kind: 'preset', name: 'Draft' });
  });

  it('says why a file cannot be used, and keeps the current stamp', async () => {
    const t = await ready();
    t.stampTool();
    await t.choose(picked('notes.png', new TextEncoder().encode('hello')));
    expect(t.error()).toBe('Only PNG and JPEG pictures can be used as stamps.');
    expect(t.store.getSnapshot().ui.stampImage).toBeUndefined();
    t.press(100, 150);
    expect(t.stamps()[0]!.payload.kind).toBe('preset');
  });

  it('refuses a huge file before reading it', async () => {
    const loader = fakeLoader();
    const t = await ready(loader);
    t.stampTool();
    const file = picked('huge.jpg', PNG, MAX_IMAGE_FILE_BYTES + 1);
    await t.choose(file);
    expect(t.error()).toMatch(/too large/);
    expect(file.read).not.toHaveBeenCalled();
    expect(loader).not.toHaveBeenCalled();
  });

  it('does nothing when the picker is cancelled', async () => {
    const loader = fakeLoader();
    const t = await ready(loader);
    t.stampTool();
    t.pickNext([]);
    fireEvent.click(t.pictureButton()!);
    await act(async () => {});
    expect(loader).not.toHaveBeenCalled();
    expect(t.error()).toBeUndefined();
  });

  it('shows that it is busy while the picture is prepared, and cannot be pressed twice', async () => {
    let finish!: (img: StampImage) => void;
    const loader = vi.fn<ImageLoader>(() => new Promise((r) => (finish = r)));
    const t = await ready(loader);
    t.stampTool();
    t.pickNext([picked('big.jpg')]);
    fireEvent.click(t.pictureButton()!);
    await waitFor(() => expect(t.pictureButton()!.textContent).toBe('Preparing…'));
    expect(t.pictureButton()!.disabled).toBe(true);
    await act(async () => finish({ mime: 'image/jpeg', bytes: new Uint8Array([1]), width: 10, height: 10 }));
    await waitFor(() => expect(t.pictureButton()!.textContent).toBe('Picture…'));
    expect(t.picker().selectedOptions[0]!.textContent).toBe('Picture: big.jpg');
  });

  it('can be moved, resized keeping its proportions, and undone like any stamp', async () => {
    const t = await ready();
    t.stampTool();
    await t.choose(picked('logo.png'));
    t.press(100, 150);
    const before = t.stamps()[0]!.rect;
    const handle = await waitFor(() => {
      const h = document.querySelector('svg.overlay [data-handle="se"]');
      if (!h) throw new Error('no handles');
      return h;
    });
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, ...px(before.x + before.w, before.y) });
    fireEvent.pointerMove(t.host, { pointerId: 1, ...px(before.x + before.w + 40, before.y - 40) });
    fireEvent.pointerUp(t.host, { pointerId: 1, ...px(before.x + before.w + 40, before.y - 40) });
    const after = t.stamps()[0]!.rect;
    expect(after.w).toBeGreaterThan(before.w);
    expect(after.w / after.h).toBeCloseTo(before.w / before.h);
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    expect(t.stamps()[0]!.rect).toEqual(before);
  });
});
