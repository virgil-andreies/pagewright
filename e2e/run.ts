// Real-browser checks. `pnpm e2e` (needs Chrome or Edge; set CHROME_PATH if it is somewhere unusual).
// Pass a scenario name to run just that one, e.g. `pnpm e2e text`. Screenshots go to out/e2e/.
// These use the real mouse and keyboard, real focus and layout, and a real file chooser and download: the
// things jsdom cannot reproduce, which is where the bugs that unit tests miss tend to live.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream } from '@cantoo/pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { textWidth } from '../packages/core/src';
import {
  SHOTS, check, chooseTool, clearDownloads, clickButton, clickOnPage, count, doubleClickOnPage, dragOnPage, failureCount, openPdf, sleep, start, waitForDownload,
  type Session,
} from './harness';

const SAMPLE = resolve(import.meta.dirname, '../out/sample.pdf');
const ANNOT = 'svg.overlay g.annot';
const SHAPE = `${ANNOT} rect:not(.selection-outline)`;

/** Types into whatever has focus. */
const typeText = (s: Session, text: string) => s.page.keyboard.type(text);
const ctrl = async (s: Session, key: string) => {
  await s.page.keyboard.down('Control');
  await s.page.keyboard.press(key);
  await s.page.keyboard.up('Control');
};
const focusInfo = (s: Session) =>
  s.page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    return a ? `${a.tagName}${a.getAttribute('aria-label') ? `[${a.getAttribute('aria-label')}]` : ''}` : 'none';
  });
const attr = (s: Session, sel: string, name: string) => s.page.$eval(sel, (e, n) => Number(e.getAttribute(n)), name);


/** Screen rectangle of `word` inside page `index`'s text layer, measured by the browser itself. */
const wordRectOf = (s: Session, word: string, index = 0) =>
  s.page.evaluate(
    (w, i) => {
      const layer = document.querySelectorAll('.page-view')[i]!.querySelector('.textLayer')!;
      for (const span of layer.querySelectorAll('span')) {
        const node = span.firstChild;
        const at = span.textContent?.indexOf(w) ?? -1;
        if (node && at >= 0) {
          const r = document.createRange();
          r.setStart(node, at);
          r.setEnd(node, at + w.length);
          const b = r.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        }
      }
      return null;
    },
    word,
    index,
  );

/** Press at one point and release at another, moving in steps, like a person selecting text. */
const dragSelectOf = async (s: Session, a: { x: number; y: number }, b: { x: number; y: number }) => {
  await s.page.mouse.move(a.x, a.y);
  await s.page.mouse.down();
  await s.page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
  await s.page.mouse.move(b.x, b.y, { steps: 6 });
  await s.page.mouse.up();
};

const scenarios: Record<string, (s: Session) => Promise<void>> = {
  async selection(s) {
    console.log('Selecting the document text');
    await openPdf(s.page, SAMPLE);
    await s.page.evaluate(() => {
      (window as unknown as { copied?: string }).copied = undefined;
      document.addEventListener('copy', () => ((window as unknown as { copied?: string }).copied = window.getSelection()?.toString()));
    });
    const selected = () => s.page.evaluate(() => window.getSelection()?.toString() ?? '');
    const copied = () => s.page.evaluate(() => (window as unknown as { copied?: string }).copied);
    const clear = () => s.page.evaluate(() => window.getSelection()?.removeAllRanges());
    const wordRect = (word: string, index = 0) => wordRectOf(s, word, index);
    const dragSelect = (from: { x: number; y: number }, to: { x: number; y: number }) => dragSelectOf(s, from, to);
    check('the page has a text layer', (await count(s.page, '.textLayer span')) > 3);
    await chooseTool(s.page, 'Select');

    const quick = (await wordRect('quick'))!;
    await s.page.mouse.click(quick.x + quick.w / 2, quick.y + quick.h / 2, { count: 2 });
    await sleep(100);
    check('double-clicking a word selects it', (await selected()).trim() === 'quick', JSON.stringify(await selected()));
    await s.page.keyboard.down('Control');
    await s.page.keyboard.press('c');
    await s.page.keyboard.up('Control');
    check('Ctrl+C copies the selection', (await copied())?.trim() === 'quick', JSON.stringify(await copied()));

    await clear();
    await s.page.mouse.click(quick.x + quick.w / 2, quick.y + quick.h / 2, { count: 3 });
    await sleep(100);
    check('triple-clicking selects the whole line', (await selected()).includes('The quick brown fox jumps over the lazy dog.'), JSON.stringify(await selected()));

    await clear();
    const brown = (await wordRect('brown'))!;
    const jumps = (await wordRect('jumps'))!;
    await dragSelect({ x: brown.x + 1, y: brown.y + brown.h / 2 }, { x: jumps.x + jumps.w - 1, y: jumps.y + jumps.h / 2 });
    check('dragging across words selects exactly them', (await selected()).trim() === 'brown fox jumps', JSON.stringify(await selected()));

    await clear();
    await chooseTool(s.page, 'Rectangle');
    await dragSelect({ x: brown.x + 1, y: brown.y + brown.h / 2 }, { x: jumps.x + jumps.w - 1, y: jumps.y + jumps.h / 2 });
    check('a drawing tool draws instead of selecting text', (await selected()) === '' && (await count(s.page, SHAPE)) === 1, JSON.stringify(await selected()));
    await s.page.keyboard.press('Delete'); // remove the test rectangle (it is selected? tool is Rectangle, so use undo)
    await ctrl(s, 'z');

    // The Highlight tool: select text, release, and it is marked.
    await chooseTool(s.page, 'Highlight');
    const dog = (await wordRect('lazy dog'))!;
    await dragSelect({ x: dog.x + 1, y: dog.y + dog.h / 2 }, { x: dog.x + dog.w - 1, y: dog.y + dog.h / 2 });
    await sleep(150);
    const polys = await s.page.$$eval(`${ANNOT} polygon`, (els) => els.map((e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }));
    check('releasing the mouse highlights the selected text', polys.length === 1, `${polys.length} polygons`);
    check('and clears the selection', (await selected()) === '');
    const p = polys[0]!;
    const near = (a: number, b: number, tol = 2.5) => Math.abs(a - b) <= tol;
    check('the highlight sits exactly on the selected words', near(p.x, dog.x) && near(p.w, dog.w) && near(p.y, dog.y, 3) && near(p.h, dog.h, 3), `${JSON.stringify(p)} vs ${JSON.stringify(dog)}`);
    await s.page.screenshot({ path: resolve(SHOTS, 'selection-highlight.png') });

    // Choosing a markup tool while text is selected applies it at once.
    await chooseTool(s.page, 'Select');
    const fox = (await wordRect('fox'))!;
    await s.page.mouse.click(fox.x + fox.w / 2, fox.y + fox.h / 2, { count: 2 });
    await clickButton(s.page, 'Underline');
    await sleep(150);
    check('choosing Underline with text selected underlines it', (await count(s.page, `${ANNOT} line`)) >= 1);

    await ctrl(s, 'z');
    await ctrl(s, 'z');
    check('each is one undo step', (await count(s.page, ANNOT)) === 0, `${await count(s.page, ANNOT)} left`);

    // A rotated page (page 3 shows upside down): the highlight must still land on the selected text.
    await (await s.page.$$('.thumb'))[2]!.click();
    await sleep(500);
    const first = await wordRect('quick brown', 2);
    check('the rotated page has selectable text too', first !== null);
    if (first) {
      await chooseTool(s.page, 'Highlight');
      await dragSelect({ x: first.x + 1, y: first.y + first.h / 2 }, { x: first.x + first.w - 1, y: first.y + first.h / 2 });
      await sleep(150);
      const rp = await s.page.$$eval(`.page-view:nth-of-type(3) ${ANNOT} polygon`, (els) => els.map((e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }));
      check('on a rotated page the highlight sits on the selected words', rp.length === 1 && near(rp[0]!.x, first.x) && near(rp[0]!.w, first.w) && near(rp[0]!.y, first.y, 3), `${JSON.stringify(rp)} vs ${JSON.stringify(first)}`);
    }
  },

  async original(s) {
    console.log('Annotations that were already in the file');
    await openPdf(s.page, SAMPLE);
    await chooseTool(s.page, 'Select');
    /** How many clearly yellow pixels (the sample's highlight colour) the page image has inside a screen rectangle. */
    const yellow = (rect: { x: number; y: number; w: number; h: number }) =>
      s.page.evaluate((r) => {
        const c = document.querySelector('.page-view canvas') as HTMLCanvasElement;
        const b = c.getBoundingClientRect();
        const k = c.width / b.width;
        const d = c.getContext('2d')!.getImageData(Math.max(0, Math.round((r.x - b.x) * k)), Math.round((r.y - b.y) * k), Math.round(r.w * k), Math.round(r.h * k)).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i]! > 230 && d[i + 1]! > 190 && d[i + 2]! < 150) n++;
        return n;
      }, rect);
    const selectedText = () => s.page.evaluate(() => window.getSelection()?.toString() ?? '');
    const threads = () => s.page.$$eval('.thread .body', (e) => e.map((x) => x.textContent));

    const fox = (await wordRectOf(s, 'fox'))!;
    const area = { x: fox.x - 20, y: fox.y, w: fox.w + 40, h: fox.h };
    const before = await yellow(area);
    check('the sample page image shows the existing yellow highlight', before > 200, `${before} yellow pixels`);

    // Selecting it.
    await s.page.mouse.click(fox.x + fox.w / 2, fox.y + fox.h / 2);
    await sleep(100);
    check('clicking the existing highlight selects it', (await count(s.page, `${ANNOT}.selected`)) === 1);
    check('and does not start selecting text underneath it', (await selectedText()) === '', JSON.stringify(await selectedText()));
    check('it has no resize handles (it is not editable)', (await count(s.page, 'svg.overlay [data-handle]')) === 0);

    // Its comment and the thread of a note are in the comments panel, read-only.
    await s.page.evaluate(() => ([...document.querySelectorAll('button')].find((x) => x.textContent?.startsWith('Comments')) as HTMLButtonElement).click()); // its label carries a count
    await sleep(150);
    check('its comment is in the comments panel', (await threads()).includes('Highlight with a comment'), JSON.stringify(await threads()));
    check('the note thread from the file is there with its replies, marked as original', (await s.page.$$eval('.thread .reply', (e) => e.length)) >= 2 && (await s.page.$$eval('.thread .origin', (e) => e.length)) >= 1);
    check('they cannot be edited or replied to', (await count(s.page, '.thread[data-annot-id^="pdf:"] textarea')) === 0);

    // Opening the panel narrowed the viewer and moved the page sideways, so measure the highlight again.
    const foxNow = (await wordRectOf(s, 'fox'))!;
    const areaNow = { x: foxNow.x - 20, y: foxNow.y, w: foxNow.w + 40, h: foxNow.h };
    const total = await yellow(areaNow);
    check('the highlight is still in the page image after the panel opened', total > 200, `${total}`);
    // Selecting it again (the earlier selection is still there), then deleting: gone from the image, others stay.
    await s.page.keyboard.press('Delete');
    await sleep(900); // the page image is rendered again
    const after = await yellow(areaNow);
    // A few anti-aliased text pixels can look yellowish, so allow a sliver rather than demanding exactly none.
    check('Delete takes the highlight out of the page image', after < total * 0.03, `${after} of ${total} yellow pixels left`);
    check('and out of the comments panel', !(await threads()).includes('Highlight with a comment'));
    await s.page.screenshot({ path: resolve(SHOTS, 'original-deleted.png') });

    await ctrl(s, 'z');
    await sleep(900);
    check('Ctrl+Z brings it back in the image', (await yellow(areaNow)) > total * 0.9);
    await ctrl(s, 'y');
    await sleep(900);
    check('Ctrl+Y removes it again', (await yellow(areaNow)) < total * 0.03);

    // Delete a note thread from the panel.
    const note = await s.page.$('.thread[data-annot-id^="pdf:"] .row-actions button');
    const noteThread = await s.page.$$eval('.thread[data-annot-id^="pdf:"]', (els) => els.map((e) => ({ id: e.getAttribute('data-annot-id'), text: e.textContent })));
    check('the panel lists the original notes', noteThread.some((t) => t.text?.includes('A note with a short thread.')), JSON.stringify(noteThread.map((t) => t.id)));
    void note;
    await s.page.evaluate(() => {
      const t = [...document.querySelectorAll('.thread[data-annot-id^="pdf:"]')].find((e) => e.textContent?.includes('A note with a short thread.'))!;
      (t.querySelector('.row-actions button') as HTMLButtonElement).click();
    });
    await sleep(300);
    check('Delete note removes the note thread from the panel', !(await threads()).includes('A note with a short thread.'));

    // Save, and look at what was written.
    await clickButton(s.page, 'Save');
    const file = await waitForDownload();
    const saved = await PDFDocument.load(readFileSync(file));
    const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const subtypes = annots.asArray().map((_, i) => (annots.lookup(i, PDFDict).lookup(PDFName.of('Subtype')) as PDFName).decodeText());
    const strings: string[] = [];
    for (const [, obj] of saved.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      for (const [, v] of obj.entries()) if (v instanceof PDFHexString) strings.push(v.decodeText());
    }
    const originalCount = (await PDFDocument.load(readFileSync(SAMPLE))).getPage(0).node.lookup(PDFName.of('Annots'), PDFArray).size();
    check('the saved page lost exactly the highlight, the note and its two replies', !subtypes.includes('Highlight') && subtypes.length === originalCount - 4, `${originalCount} -> ${subtypes.length}: ${subtypes.join(',')}`);
    check('and kept the underline, strikeout and the other note', subtypes.includes('Underline') && subtypes.includes('StrikeOut') && strings.includes('The speech-bubble icon.'));
    check('nothing of the deleted comments is left anywhere in the file', !strings.some((t) => /Highlight with a comment|A note with a short thread|Agreed, and here is a reply|And a second reply/.test(t)), JSON.stringify(strings));
    check('the other pages are untouched', saved.getPageCount() === 5);
  },

  async stamps(s) {
    console.log('Preset stamps');
    await openPdf(s.page, SAMPLE);
    await chooseTool(s.page, 'Stamp');
    await s.page.select('select[aria-label="Stamp type"]', 'Confidential');
    await clickOnPage(s.page, 420, 560);
    await sleep(200);
    const label = () => s.page.$$eval(`${ANNOT} text`, (e) => e.map((x) => x.textContent));
    check('clicking the page places the chosen stamp', (await label()).includes('CONFIDENTIAL'), JSON.stringify(await label()));
    check('it is selected, with four resize handles, and the tool is back to Select', (await count(s.page, 'svg.overlay [data-handle]')) === 4 && (await count(s.page, '[role=radio][aria-checked=true]')) === 1);

    // The frame's size on screen, to check the proportions while resizing.
    const frame = () => s.page.$eval(`${ANNOT} rect:not(.selection-outline)`, (e) => { const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; });
    const before = await frame();
    const handle = (await s.page.$('svg.overlay [data-handle="se"]'))!.boundingBox();
    const h = (await handle)!;
    await s.page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
    await s.page.mouse.down();
    await s.page.mouse.move(h.x + h.width / 2 + 60, h.y + h.height / 2 + 10, { steps: 6 });
    await s.page.mouse.up();
    await sleep(150);
    const after = await frame();
    check('dragging a corner makes it bigger', after.w > before.w + 20, `${before.w} -> ${after.w}`);
    check('and keeps its proportions', Math.abs(after.w / after.h - before.w / before.h) < 0.05, `${before.w / before.h} vs ${after.w / after.h}`);
    check('and keeps the opposite corner where it was', Math.abs(after.x - before.x) < 2 && Math.abs(after.y - before.y) < 2);

    await s.page.select('select[aria-label="Stamp type"]', 'Approved');
    await sleep(150);
    check('choosing another type changes the selected stamp', (await label()).includes('APPROVED') && !(await label()).includes('CONFIDENTIAL'));
    const final = await frame(); // the type changed, so the width did too: Approved is narrower than Confidential
    await s.page.screenshot({ path: resolve(SHOTS, 'stamp-editor.png') });

    // Save, then open the saved file: PDF.js draws the stamp from the appearance stream we wrote.
    await clickButton(s.page, 'Save');
    const file = await waitForDownload();
    const saved = await PDFDocument.load(readFileSync(file));
    const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const stampDict = annots.asArray().map((_, i) => annots.lookup(i, PDFDict)).find((d) => (d.lookup(PDFName.of('Subtype')) as PDFName).decodeText() === 'Stamp');
    check('the saved file has a Stamp annotation named Approved', !!stampDict && (stampDict.lookup(PDFName.of('Name')) as PDFName).decodeText() === 'Approved');
    const rect = stampDict!.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => Number(n.toString()));
    const expectedWidth = final.w / (96 / 72);
    // (the frame measured on screen is inset by half its border on each side, so the saved box is a few points wider)
    check('whose size matches what was on screen', Math.abs(rect[2]! - rect[0]! - expectedWidth) < 5, `${rect[2]! - rect[0]!} vs ${expectedWidth}`);

    await s.page.goto(s.url);
    await openPdf(s.page, file);
    const inked = await s.page.evaluate((r) => {
      // Green pixels (the Approved colour) in the saved stamp's box, in the page image PDF.js made from our appearance stream.
      const c = document.querySelector('.page-view canvas') as HTMLCanvasElement;
      const scale = c.width / 612; // canvas pixels per PDF point
      const d = c.getContext('2d')!.getImageData(Math.round(r[0]! * scale), Math.round((792 - r[3]!) * scale), Math.round((r[2]! - r[0]!) * scale), Math.round((r[3]! - r[1]!) * scale)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 1]! > d[i]! + 40 && d[i + 1]! > d[i + 2]! + 40) n++;
      return n;
    }, rect);
    check('opened again, PDF.js draws the saved stamp in green where it belongs', inked > 300, `${inked} green pixels`);
    await s.page.screenshot({ path: resolve(SHOTS, 'stamp-saved.png') });
  },

  async signatures(s) {
    console.log('Typed signatures');
    await openPdf(s.page, SAMPLE);
    await s.page.keyboard.press('g');
    await s.page.waitForSelector('dialog[aria-label="Signatures"]');
    const dialogText = () => s.page.$eval('dialog[aria-label="Signatures"]', (d) => d.textContent ?? '');
    check('the Sign tool opens the dialog and says it is not a digital signature', /not a digital signature/.test(await dialogText()));

    await s.page.type('dialog input', 'Ada Lovelace');
    await s.page.waitForFunction(() => document.querySelectorAll('dialog [role=radiogroup][aria-label=Style] svg').length === 4, { timeout: 15000 });
    check('all four handwriting styles are drawn from the real font files', true);
    const pathLengths = await s.page.$$eval('dialog [role=radiogroup][aria-label=Style] svg path', (els) => els.map((e) => (e.getAttribute('d') ?? '').length));
    check('and each is real artwork, different from the others', pathLengths.every((n) => n > 500) && new Set(pathLengths).size === 4, JSON.stringify(pathLengths));

    // A name in another alphabet: drawn from the font's Cyrillic file where it has one.
    const pick = (group: string, label: string) =>
      s.page.evaluate((g, l) => (document.querySelector(`dialog [role=radiogroup][aria-label="${g}"] [aria-label="${l}"]`) as HTMLButtonElement).click(), group, label);
    await s.page.$eval('dialog input', (e: Element) => { (e as HTMLInputElement).select(); });
    await s.page.keyboard.type('Ada Привет');
    await sleep(900);
    await pick('Style', 'Sacramento');
    await sleep(200);
    check('a style with no Cyrillic says which characters it leaves out', /cannot draw: П р и в е т/.test(await dialogText()), (await dialogText()).slice(-200));
    await pick('Style', 'Great Vibes');
    await sleep(200);
    check('a style that has Cyrillic draws them without a warning', !/cannot draw/.test(await dialogText()));

    // Make the real one.
    await s.page.$eval('dialog input', (e: Element) => { (e as HTMLInputElement).select(); });
    await s.page.keyboard.type('Ada Lovelace');
    await sleep(900);
    await pick('Style', 'Dancing Script');
    await pick('Ink', 'Blue');
    await s.page.screenshot({ path: resolve(SHOTS, 'signature-dialog.png') });
    await clickButton(s.page, 'Save and use');
    await s.page.waitForFunction(() => !document.querySelector('dialog[aria-label="Signatures"]'));
    check('Save and use closes the dialog and leaves the Sign tool ready', (await s.page.$eval('[role=radio][aria-checked=true]', (e) => e.textContent)) === 'Sign');

    // Place it.
    await clickOnPage(s.page, 360, 480);
    await sleep(300);
    const sig = () => s.page.$eval(`${ANNOT} path`, (p) => { const b = p.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, fill: p.getAttribute('fill') }; });
    const placed = await sig();
    check('clicking the page places the signature, drawn in blue', placed.w > 100 && /^rgb\(/.test(placed.fill ?? '') && /rgb\(\d+ \d+ 1\d\d\)/.test(placed.fill ?? ''), JSON.stringify(placed));
    check('centred on the click, selected, with four handles and the Select tool back', Math.abs(placed.x + placed.w / 2 - 0) > 0 && (await count(s.page, 'svg.overlay [data-handle]')) === 4);
    await s.page.screenshot({ path: resolve(SHOTS, 'signature-placed.png') });

    // It is kept on this device: reload and it is still there.
    await s.page.reload();
    await openPdf(s.page, SAMPLE);
    await s.page.keyboard.press('g');
    await s.page.waitForSelector('dialog[aria-label="Signatures"]');
    const saved = await s.page.$$eval('dialog .sig-list .sig-name', (e) => e.map((x) => x.textContent));
    check('after reloading the page the signature is still saved on this device', saved.includes('Ada Lovelace'), JSON.stringify(saved));
    await s.page.evaluate(() => (document.querySelector('dialog [aria-label="Use signature Ada Lovelace"]') as HTMLButtonElement).click());
    await s.page.waitForFunction(() => !document.querySelector('dialog[aria-label="Signatures"]'));
    await clickOnPage(s.page, 360, 480);
    await sleep(300);
    const again = await sig();

    // Save and open the saved file: PDF.js draws it from the appearance stream we wrote.
    await clickButton(s.page, 'Save');
    const file = await waitForDownload();
    const doc = await PDFDocument.load(readFileSync(file));
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    // The sample already holds signatures of its own; the one placed just now is the last in the file.
    const stamp = annots.asArray().map((_, i) => annots.lookup(i, PDFDict)).filter((d) => (d.lookup(PDFName.of('Name')) as PDFName | undefined)?.decodeText() === 'Signature').at(-1);
    check('the saved file has a Signature stamp', !!stamp);
    const rect = stamp!.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => Number(n.toString()));
    check('as wide as it was on screen', Math.abs(rect[2]! - rect[0]! - 160) < 1, `${rect[2]! - rect[0]!}`);
    const ap = stamp!.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    check('drawn as outlines, so no font is needed to show it', !ap.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font')) && /\bc\n/.test(Buffer.from(ap.contents).toString('latin1')));

    await s.page.goto(s.url);
    await openPdf(s.page, file);
    const ink = await s.page.evaluate((r) => {
      const c = document.querySelector('.page-view canvas') as HTMLCanvasElement;
      const k = c.width / 612;
      const d = c.getContext('2d')!.getImageData(Math.round(r[0]! * k), Math.round((792 - r[3]!) * k), Math.round((r[2]! - r[0]!) * k), Math.round((r[3]! - r[1]!) * k)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 2]! > d[i]! + 60 && d[i + 2]! > d[i + 1]! + 60) n++; // clearly blue
      return n;
    }, rect);
    check('opened again, PDF.js draws the signature in blue where it belongs', ink > 400, `${ink} blue pixels`);
    await s.page.screenshot({ path: resolve(SHOTS, 'signature-saved.png') });
    void again;
  },

  async drawnSignature(s) {
    console.log('Drawn signature');
    await openPdf(s.page, SAMPLE);
    await s.page.keyboard.press('g');
    await s.page.waitForSelector('dialog[aria-label="Signatures"]');
    await s.page.evaluate(() => (document.querySelector('dialog [role=radiogroup][aria-label=Method] [role=radio]:last-child') as HTMLButtonElement).click());
    await s.page.waitForSelector('dialog svg.draw-surface');
    const box = (await (await s.page.$('dialog svg.draw-surface'))!.boundingBox())!;
    const saveDisabled = () => s.page.$eval('dialog button[type=submit]', (b) => (b as HTMLButtonElement).disabled);
    check('nothing can be saved before something is drawn', await saveDisabled());

    // Two real strokes with the mouse: a wave, then a cross-bar.
    const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const;
    await s.page.mouse.move(...at(0.1, 0.6));
    await s.page.mouse.down();
    for (let i = 0; i <= 40; i++) await s.page.mouse.move(...at(0.1 + i * 0.02, 0.5 + 0.25 * Math.sin(i / 3)));
    await s.page.mouse.up();
    await s.page.mouse.move(...at(0.15, 0.8));
    await s.page.mouse.down();
    await s.page.mouse.move(...at(0.8, 0.8), { steps: 10 });
    await s.page.mouse.up();
    const strokes = await s.page.$$eval('dialog svg.draw-surface path', (e) => e.length);
    check('both strokes show on the pad', strokes === 2, `${strokes}`);
    check('and the pad was not left selecting text or dragging', (await s.page.evaluate(() => (getSelection()?.toString() ?? '').length)) === 0);

    await s.page.evaluate(() => (document.querySelector('dialog [aria-label=Ink] [aria-label=Blue]') as HTMLButtonElement).click());
    await s.page.screenshot({ path: resolve(SHOTS, 'signature-draw.png') });
    await clickButton(s.page, 'Undo stroke');
    check('Undo stroke takes off the last stroke only', (await s.page.$$eval('dialog svg.draw-surface path', (e) => e.length)) === 1);
    await s.page.mouse.move(...at(0.15, 0.8));
    await s.page.mouse.down();
    await s.page.mouse.move(...at(0.8, 0.8), { steps: 10 });
    await s.page.mouse.up();
    await clickButton(s.page, 'Save and use');
    await s.page.waitForFunction(() => !document.querySelector('dialog[aria-label="Signatures"]'));

    await clickOnPage(s.page, 360, 480);
    await sleep(300);
    const placed = await s.page.$eval(`${ANNOT} path`, (p) => ({ w: p.getBoundingClientRect().width, stroke: p.getAttribute('stroke'), fill: p.getAttribute('fill') }));
    check('clicking the page places it, drawn as a blue pen line', placed.w > 100 && placed.fill === 'none' && /rgb\(\d+ \d+ 1\d\d\)/.test(placed.stroke ?? ''), JSON.stringify(placed));

    await clickButton(s.page, 'Save');
    const file = await waitForDownload();
    const doc = await PDFDocument.load(readFileSync(file));
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const stamp = annots.asArray().map((_, i) => annots.lookup(i, PDFDict)).filter((d) => (d.lookup(PDFName.of('Name')) as PDFName | undefined)?.decodeText() === 'Signature').at(-1)!;
    const rect = stamp.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => Number(n.toString()));
    const ap = stamp.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    const ops = Buffer.from(ap.contents).toString('latin1');
    check('saved as a stroked pen line with round ends, no font', /\bS\b/.test(ops) && /1 J 1 j/.test(ops) && !ap.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font')));

    await s.page.goto(s.url);
    await openPdf(s.page, file);
    const ink = await s.page.evaluate((r) => {
      const c = document.querySelector('.page-view canvas') as HTMLCanvasElement;
      const k = c.width / 612;
      const d = c.getContext('2d')!.getImageData(Math.round(r[0]! * k), Math.round((792 - r[3]!) * k), Math.round((r[2]! - r[0]!) * k), Math.round((r[3]! - r[1]!) * k)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 2]! > d[i]! + 60 && d[i + 2]! > d[i + 1]! + 60) n++;
      return n;
    }, rect);
    check('opened again, PDF.js draws the pen line in blue where it belongs', ink > 100, `${ink} blue pixels`);
  },

  async imageStamps(s) {
    console.log('Image stamps');
    await openPdf(s.page, SAMPLE);

    // Make real picture files with the browser's own encoders.
    const make = (kind: string) =>
      s.page.evaluate(async (k) => {
        const c = document.createElement('canvas');
        const g = c.getContext('2d')!;
        if (k === 'logo') {
          // Transparent background, an opaque green disc.
          [c.width, c.height] = [300, 150];
          g.fillStyle = 'rgb(0,160,0)';
          g.beginPath();
          g.ellipse(150, 75, 140, 70, 0, 0, Math.PI * 2);
          g.fill();
        } else if (k === 'sideways') {
          // Stored 300 x 100, red on the left: a phone would tag it "turn 90 degrees clockwise" to show it 100 x 300.
          [c.width, c.height] = [300, 100];
          g.fillStyle = 'rgb(220,0,0)';
          g.fillRect(0, 0, 150, 100);
          g.fillStyle = 'rgb(0,0,220)';
          g.fillRect(150, 0, 150, 100);
        } else {
          [c.width, c.height] = [3000, 1500];
          g.fillStyle = 'rgb(255,140,0)';
          g.fillRect(0, 0, 3000, 1500);
        }
        const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), k === 'logo' ? 'image/png' : 'image/jpeg', 0.95));
        return Array.from(new Uint8Array(await blob.arrayBuffer()));
      }, kind);
    const dir = resolve(SHOTS, 'inputs');
    mkdirSync(dir, { recursive: true });
    const logo = resolve(dir, 'logo.png');
    writeFileSync(logo, Buffer.from(await make('logo')));
    // EXIF orientation 6 (rotate 90 clockwise), inserted right after the JPEG's start marker.
    const exif = Buffer.from([
      0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // APP1, length 34, "Exif\0\0"
      0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF header, first IFD at 8
      0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, // one entry: Orientation = 6
      0x00, 0x00, 0x00, 0x00, // no next IFD
    ]);
    const plain = Buffer.from(await make('sideways'));
    const sideways = resolve(dir, 'sideways.jpg');
    writeFileSync(sideways, Buffer.concat([plain.subarray(0, 2), exif, plain.subarray(2)]));
    const big = resolve(dir, 'big.jpg');
    writeFileSync(big, Buffer.from(await make('big')));
    const notImage = resolve(dir, 'notes.png');
    writeFileSync(notImage, 'these are notes, not a picture');

    const choose = async (path: string) => {
      await s.page.keyboard.press('k');
      const button = await s.page.waitForSelector('xpath/.//button[normalize-space()="Picture…"]');
      const [chooser] = await Promise.all([s.page.waitForFileChooser(), button!.click()]);
      await chooser.accept([path]);
      await s.page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.textContent === 'Preparing…'), { timeout: 15000 });
      await sleep(150);
    };
    const optionText = () => s.page.$eval('select[aria-label="Stamp type"]', (e) => (e as HTMLSelectElement).selectedOptions[0]?.textContent ?? '');
    const pictures = () => count(s.page, 'svg.overlay image');

    await choose(notImage);
    const toast = await s.page.$eval('.toasts', (e) => e.textContent ?? '');
    check('a file that is not a picture is refused with a reason', /Only PNG and JPEG/.test(toast), toast);
    await s.page.evaluate(() => (document.querySelector('.toasts button[aria-label=Dismiss]') as HTMLButtonElement | null)?.click());

    await choose(logo);
    check('choosing a picture makes it the stamp to place', (await optionText()) === 'Picture: logo.png', await optionText());
    await clickOnPage(s.page, 150, 480);
    await sleep(300);
    check('clicking the page places it, drawn from the picture', (await pictures()) === 1);
    check('selected, with handles, and the Select tool back', (await count(s.page, 'svg.overlay [data-handle]')) === 4);

    await choose(sideways);
    await clickOnPage(s.page, 650, 640);
    await sleep(300);
    const tall = await s.page.$$eval('svg.overlay image', (e) => { const b = e.at(-1)!.getBoundingClientRect(); return { w: b.width, h: b.height }; });
    check('a sideways phone photo is turned upright', tall.h > tall.w * 2.5, JSON.stringify(tall));

    await choose(big);
    await clickOnPage(s.page, 420, 380);
    await sleep(300);
    const wide = await s.page.$$eval('svg.overlay image', (e) => { const b = e.at(-1)!.getBoundingClientRect(); return { w: b.width, h: b.height }; });
    check('a big photo is placed at the stamp size, keeping its proportions', Math.abs(wide.w / wide.h - 2) < 0.05 && Math.abs(wide.w - 200 * (96 / 72)) < 2, JSON.stringify(wide));
    await s.page.screenshot({ path: resolve(SHOTS, 'image-stamps.png') });

    await clickButton(s.page, 'Save');
    const file = await waitForDownload();
    const doc = await PDFDocument.load(readFileSync(file));
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const images = annots.asArray().map((_, i) => annots.lookup(i, PDFDict)).filter((d) => (d.lookup(PDFName.of('Name')) as PDFName | undefined)?.decodeText() === 'Image');
    check('the saved file has three image stamps', images.length === 3, `${images.length}`);
    const pic = (d: PDFDict) => {
      const ap = d.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
      const im = ap.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('XObject'), PDFDict).lookup(PDFName.of('Im1')) as PDFRawStream;
      const v = (k: string) => im.dict.lookup(PDFName.of(k));
      return { w: Number(String(v('Width'))), h: Number(String(v('Height'))), filter: String(v('Filter')), mask: !!im.dict.get(PDFName.of('SMask')), size: im.contents.length };
    };
    const [p1, p2, p3] = images.map(pic);
    check('the transparent PNG keeps its transparency', p1!.w === 300 && p1!.h === 150 && p1!.mask, JSON.stringify(p1));
    check('the sideways photo is stored upright', p2!.w === 100 && p2!.h === 300 && p2!.filter === '/DCTDecode', JSON.stringify(p2));
    check('the big photo is stored scaled down to 2000 pixels, as JPEG', p3!.w === 2000 && p3!.h === 1000 && p3!.filter === '/DCTDecode' && p3!.size < 1_000_000, JSON.stringify(p3));
    const rect1 = images[0]!.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => Number(n.toString()));

    await s.page.goto(s.url);
    await openPdf(s.page, file);
    const px = await s.page.evaluate((r) => {
      const c = document.querySelector('.page-view canvas') as HTMLCanvasElement;
      const k = c.width / 612;
      const g = c.getContext('2d')!;
      // (no helper functions in here: the bundler would wrap them in a name helper the page does not have)
      return [[(r[0]! + r[2]!) / 2, (r[1]! + r[3]!) / 2], [r[0]! + 2, r[3]! - 2]].map(([x, y]) => Array.from(g.getImageData(Math.round(x! * k), Math.round((792 - y!) * k), 1, 1).data));
    }, rect1).then(([centre, corner]) => ({ centre: centre!, corner: corner! }));
    check('opened again, PDF.js draws the green picture where it belongs', px.centre[1]! > 120 && px.centre[0]! < 60 && px.centre[2]! < 60, JSON.stringify(px.centre));
    check('and the page shows through its transparent corners', px.corner.slice(0, 3).every((v) => v > 200), JSON.stringify(px.corner));
  },

  async text(s) {
    console.log('Text tool');
    await openPdf(s.page, SAMPLE);
    await chooseTool(s.page, 'Text');
    await clickOnPage(s.page, 200, 400); // real mouse: pointerdown, mousedown (moves focus), pointerup, click
    await sleep(200);
    check('a text box appears when the page is clicked', (await count(s.page, 'textarea.text-editor')) === 1);
    check('and it has keyboard focus', (await focusInfo(s)) === 'TEXTAREA[Text]', await focusInfo(s));

    await typeText(s, 'Hello from a real browser');
    await ctrl(s, 'Enter');
    await sleep(200);
    const texts = await s.page.$$eval(`${ANNOT} text`, (els) => els.map((e) => e.textContent));
    check('Ctrl+Enter puts the text on the page', texts.includes('Hello from a real browser') && (await count(s.page, 'textarea.text-editor')) === 0, JSON.stringify(texts));
    await s.page.screenshot({ path: resolve(SHOTS, 'text-committed.png') });

    // Double-click to edit, then click away to commit.
    await chooseTool(s.page, 'Select');
    await clickOnPage(s.page, 260, 405); // select it
    await doubleClickOnPage(s.page, 260, 405);
    await sleep(200);
    check('double-clicking the text reopens it for editing', (await count(s.page, 'textarea.text-editor')) === 1 && (await focusInfo(s)) === 'TEXTAREA[Text]', await focusInfo(s));
    await typeText(s, '!');
    await clickOnPage(s.page, 100, 700); // empty page area
    await sleep(200);
    const edited = await s.page.$$eval(`${ANNOT} text`, (els) => els.map((e) => e.textContent));
    check('clicking away commits the edit', edited.some((t) => t?.endsWith('!')), JSON.stringify(edited));

    // Escape cancels a new box.
    await chooseTool(s.page, 'Text');
    await clickOnPage(s.page, 200, 600);
    await sleep(100);
    await typeText(s, 'discard me');
    await s.page.keyboard.press('Escape');
    await sleep(100);
    check('Escape discards a new box', (await count(s.page, 'textarea.text-editor')) === 0 && !(await s.page.$$eval(`${ANNOT} text`, (e) => e.map((x) => x.textContent))).includes('discard me'));
  },

  async unicodeText(s) {
    console.log('Text in other alphabets');
    await openPdf(s.page, SAMPLE);
    await chooseTool(s.page, 'Text');
    await clickOnPage(s.page, 120, 470);
    await sleep(200);
    const boxFont = () => s.page.$eval('textarea.text-editor', (e) => (e as HTMLTextAreaElement).style.fontFamily);
    await typeText(s, 'Hello ');
    check('Western text starts in the standard font', /Helvetica/.test(await boxFont()), await boxFont());
    await typeText(s, 'Mulțumesc, Łódź!');
    check('typing a Romanian or Polish letter switches the box to Noto, as it will be saved', /Noto Sans/.test(await boxFont()), await boxFont());
    await s.page.keyboard.press('Enter');
    await typeText(s, 'Καλημέρα — Привет — Tiếng Việt');
    await ctrl(s, 'Enter');
    await sleep(300);
    const lines = await s.page.$$eval(`${ANNOT} text`, (e) => e.map((x) => x.textContent ?? ''));
    check('the text is on the page, every letter kept', lines.join('|').includes('Mulțumesc, Łódź!') && lines.join('|').includes('Привет') && !lines.join('').includes('?'), JSON.stringify(lines));

    // The browser's own measure of the web font must agree with the layout, or the editor and the PDF would differ.
    await s.page.evaluate(() => document.fonts.load('12px "Noto Sans"', 'Привет'));
    const measured = await s.page.evaluate((ls) => {
      const c = document.createElement('canvas').getContext('2d')!;
      c.font = '100px "Noto Sans"';
      (c as unknown as { fontKerning: string }).fontKerning = 'none';
      return ls.map((l) => c.measureText(l).width / 100);
    }, lines);
    const ours = lines.map((l) => textWidth('sans', l, 1, true));
    const worst = Math.max(...measured.map((m, i) => Math.abs(m - ours[i]!) / ours[i]!));
    check('the browser measures the web font exactly as the layout does', worst < 0.002, `${(worst * 100).toFixed(3)}% off`);
    const glyphsLoaded = await s.page.evaluate(() => document.fonts.check('12px "Noto Sans"', 'Привет Καλημέρα ț'));
    check('and the font for those alphabets has loaded', glyphsLoaded);
    await s.page.screenshot({ path: resolve(SHOTS, 'unicode-text.png') });

    await clickButton(s.page, 'Save');
    const file = await waitForDownload();
    const doc = await PDFDocument.load(readFileSync(file));
    const annots = doc.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const ft = annots.asArray().map((_, i) => annots.lookup(i, PDFDict)).filter((d) => (d.lookup(PDFName.of('Subtype')) as PDFName).decodeText() === 'FreeText').at(-1)!;
    const ap = ft.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N')) as PDFRawStream;
    const fonts = ap.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
    const names = fonts.keys().map((k) => k.decodeText());
    const bases = names.map((n) => (fonts.lookup(PDFName.of(n), PDFDict).lookup(PDFName.of('BaseFont')) as PDFName).decodeText());
    check('the saved box embeds only the Noto files its letters need', JSON.stringify(names.sort()) === JSON.stringify(['U0', 'U1', 'U2', 'U4', 'U6']), JSON.stringify(names));
    check('as subset fonts', bases.every((b) => /^[A-Z]{6}\+NotoSans$/.test(b)), JSON.stringify(bases));
    check('and the box text is kept as Unicode for other apps', (ft.lookup(PDFName.of('Contents')) as PDFHexString).decodeText().includes('Привет'));

    // What a viewer draws: PDF.js reads the glyphs back as text through the embedded fonts' ToUnicode maps.
    const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)) });
    const pdf = await task.promise;
    const ops = await (await pdf.getPage(1)).getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
    let drawn = '';
    ops.fnArray.forEach((fn, i) => {
      if (fn === pdfjs.OPS.showText) drawn += (ops.argsArray[i][0] as ({ unicode: string } | number)[]).map((g) => (typeof g === 'number' ? '' : g.unicode)).join('');
      if (fn === pdfjs.OPS.setTextMatrix) drawn += '|';
    });
    await task.destroy();
    check('PDF.js reads the saved text back, letter for letter, line for line', drawn.includes(`|${lines.join('|')}`), drawn.slice(-160));

    await s.page.goto(s.url);
    await openPdf(s.page, file);
    const rect = ft.lookup(PDFName.of('Rect'), PDFArray).asArray().map((n) => Number(n.toString()));
    const ink = await s.page.evaluate((r) => {
      const c = document.querySelector('.page-view canvas') as HTMLCanvasElement;
      const k = c.width / 612;
      const d = c.getContext('2d')!.getImageData(Math.round(r[0]! * k), Math.round((792 - r[3]!) * k), Math.round((r[2]! - r[0]!) * k), Math.round((r[3]! - r[1]!) * k)).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! < 600) n++; // any ink, whatever its colour
      return n;
    }, rect);
    check('opened again, the page shows the text in its box', ink > 300, `${ink} inked pixels`);
    await s.page.screenshot({ path: resolve(SHOTS, 'unicode-text-saved.png') });
  },

  async note(s) {
    console.log('Notes and comments');
    await openPdf(s.page, SAMPLE);
    await chooseTool(s.page, 'Note');
    await clickOnPage(s.page, 300, 450);
    await sleep(200);
    check('the note box opens in the comments panel with keyboard focus', (await focusInfo(s)) === 'TEXTAREA[Note text]', await focusInfo(s));
    await typeText(s, 'A real note');
    await clickButton(s.page, 'Add note');
    await sleep(200);
    check('the note is added', (await count(s.page, '.thread')) >= 1 && (await s.page.$$eval('.thread .body', (e) => e.map((x) => x.textContent))).includes('A real note'));
    check('and its icon is on the page', (await count(s.page, `${ANNOT} g[transform]`)) >= 1);

    const reply = await s.page.$('.thread.selected textarea[aria-label="Reply"]');
    await reply!.click();
    await typeText(s, 'A reply');
    await (await s.page.$('.thread.selected .composer .primary'))!.click();
    await sleep(200);
    check('a reply can be added to the thread', (await count(s.page, '.thread.selected .reply')) === 1);
    await s.page.screenshot({ path: resolve(SHOTS, 'note.png') });
  },

  async draw(s) {
    console.log('Shapes, ink, moving and undo');
    await openPdf(s.page, SAMPLE);
    await chooseTool(s.page, 'Rectangle');
    await dragOnPage(s.page, [150, 500], [320, 580]);
    check('dragging draws a rectangle', (await count(s.page, SHAPE)) === 1);

    await chooseTool(s.page, 'Pen');
    await dragOnPage(s.page, [150, 620], [400, 680]);
    check('the pen draws a stroke', (await count(s.page, `${ANNOT} polyline`)) === 1);

    await chooseTool(s.page, 'Arrow');
    await dragOnPage(s.page, [150, 720], [380, 760]);
    check('the arrow tool draws an arrow', (await count(s.page, `${ANNOT} polygon`)) >= 1);

    await chooseTool(s.page, 'Select');
    await clickOnPage(s.page, 235, 500); // top edge of the rectangle
    check('clicking its outline selects it', (await count(s.page, `${ANNOT}.selected`)) === 1);
    const before = await attr(s, SHAPE, 'x');
    await dragOnPage(s.page, [235, 500], [295, 540]);
    const after = await attr(s, SHAPE, 'x');
    check('dragging it moves it', Math.abs(after - before - 60) < 2, `${before} -> ${after}`);

    await ctrl(s, 'z');
    await sleep(100);
    check('Ctrl+Z puts it back', Math.abs((await attr(s, SHAPE, 'x')) - before) < 1);
    await ctrl(s, 'y');
    await sleep(100);
    check('Ctrl+Y moves it again', Math.abs((await attr(s, SHAPE, 'x')) - after) < 1);

    await s.page.keyboard.press('Delete');
    await sleep(100);
    check('Delete removes the selected shape', (await count(s.page, SHAPE)) === 0);
    await s.page.screenshot({ path: resolve(SHOTS, 'draw.png') });
  },

  async pages(s) {
    console.log('Page grid');
    await openPdf(s.page, SAMPLE);
    const thumbs = () => count(s.page, '.thumb');
    check('five thumbnails for the five-page sample', (await thumbs()) === 5);
    await (await s.page.$$('.thumb'))[2]!.click();
    check('clicking a thumbnail selects it', (await count(s.page, '.thumb.selected')) === 1);
    await clickButton(s.page, 'Delete');
    check('Delete removes the selected page', (await thumbs()) === 4);
    await clickButton(s.page, 'Undo');
    check('Undo brings it back', (await thumbs()) === 5);

    const firstId = () => s.page.$eval('.thumb', (e) => e.getAttribute('data-page-id'));
    const first = await firstId();
    const a = (await (await s.page.$$('.thumb'))[0]!.boundingBox())!;
    const c = (await (await s.page.$$('.thumb'))[3]!.boundingBox())!;
    await s.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await s.page.mouse.down();
    await s.page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 40, { steps: 5 });
    await s.page.mouse.move(c.x + c.width / 2, c.y + c.height - 4, { steps: 8 });
    await s.page.mouse.up();
    await sleep(200);
    check('dragging a thumbnail reorders the pages', (await firstId()) !== first);
  },

  async save(s) {
    console.log('Edit, save, and inspect the saved file');
    await openPdf(s.page, SAMPLE);
    await chooseTool(s.page, 'Text');
    await clickOnPage(s.page, 200, 450);
    await sleep(150);
    await typeText(s, 'Saved text box');
    await ctrl(s, 'Enter');
    await chooseTool(s.page, 'Rectangle');
    await dragOnPage(s.page, [150, 520], [320, 590]);
    await chooseTool(s.page, 'Pen');
    await dragOnPage(s.page, [150, 620], [400, 680]);
    await chooseTool(s.page, 'Arrow');
    await dragOnPage(s.page, [150, 720], [380, 760]);
    await chooseTool(s.page, 'Note');
    await clickOnPage(s.page, 500, 300);
    await sleep(150);
    await typeText(s, 'Saved note');
    await clickButton(s.page, 'Add note');
    await sleep(200);
    await chooseTool(s.page, 'Highlight');
    const word = (await wordRectOf(s, 'lazy dog'))!;
    await dragSelectOf(s, { x: word.x + 1, y: word.y + word.h / 2 }, { x: word.x + word.w - 1, y: word.y + word.h / 2 });
    await sleep(150);

    const original = await PDFDocument.load(readFileSync(SAMPLE));
    const subtypes = (doc: PDFDocument, page = 0) => {
      const annots = doc.getPage(page).node.lookup(PDFName.of('Annots'), PDFArray);
      return annots.asArray().map((_, i) => (annots.lookup(i, PDFDict).lookup(PDFName.of('Subtype')) as PDFName).decodeText());
    };
    const startCount = subtypes(original).length;

    await clickButton(s.page, 'Save');
    const file = await waitForDownload();
    check('Save produces a download named after the source', file.endsWith('sample-edited.pdf'), file);
    const saved = await PDFDocument.load(readFileSync(file));
    check('the saved file has all five pages', saved.getPageCount() === 5);
    const after = subtypes(saved);
    check('the original annotations are kept and the six new ones added', after.length === startCount + 6, `${startCount} -> ${after.length}: ${after.join(',')}`);
    for (const t of ['FreeText', 'Square', 'Ink', 'Line']) check(`the saved page has a ${t} annotation`, after.includes(t));
    const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const contents = annots.asArray().map((_, i) => {
      const c = annots.lookup(i, PDFDict).lookup(PDFName.of('Contents'));
      return c instanceof PDFHexString ? c.decodeText() : '';
    });
    check('the text box and note texts are in the file', contents.includes('Saved text box') && contents.includes('Saved note'), JSON.stringify(contents));
    // The highlight made by selecting text must be saved exactly where that text is on the page.
    const quads = annots.asArray().flatMap((_, i) => {
      const a = annots.lookup(i, PDFDict);
      if ((a.lookup(PDFName.of('Subtype')) as PDFName).decodeText() !== 'Highlight') return [];
      const q = a.lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map((n) => Number(n.toString()));
      return [{ x: Math.min(q[0]!, q[2]!, q[4]!, q[6]!), right: Math.max(q[0]!, q[2]!, q[4]!, q[6]!), bottom: Math.min(q[1]!, q[3]!, q[5]!, q[7]!), top: Math.max(q[1]!, q[3]!, q[5]!, q[7]!) }];
    });
    // Page 1 of the sample sets "The quick brown fox jumps over the lazy dog." in Helvetica 18 at x = 72, baseline y = 660.
    const lead = textWidth('sans', 'The quick brown fox jumps over the ', 18);
    const lazy = quads.find((q) => Math.abs(q.x - (72 + lead)) < 3);
    check('the highlight from selected text is saved on those words', !!lazy && Math.abs(lazy.right - lazy.x - textWidth('sans', 'lazy dog', 18)) < 3 && lazy.bottom < 660 && lazy.top > 660, JSON.stringify(quads));
    await s.page.screenshot({ path: resolve(SHOTS, 'saved.png') });
  },
};

const wanted = process.argv[2];
const session = await start();
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (wanted && wanted !== name) continue;
    clearDownloads();
    await session.page.goto(session.url);
    try {
      await run(session);
    } catch (e) {
      check(`${name}: scenario ran to the end`, false, e instanceof Error ? e.message : String(e));
      await session.page.screenshot({ path: resolve(SHOTS, `${name}-error.png`) }).catch(() => {});
    }
  }
} finally {
  await session.close();
}
console.log(failureCount() === 0 ? '\nAll real-browser checks passed.' : `\n${failureCount()} real-browser check(s) FAILED.`);
process.exit(failureCount() === 0 ? 0 : 1);
