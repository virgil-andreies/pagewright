// Real-browser checks. `pnpm e2e` (needs Chrome or Edge; set CHROME_PATH if it is somewhere unusual).
// Pass a scenario name to run just that one, e.g. `pnpm e2e text`. Screenshots go to out/e2e/.
// These use the real mouse and keyboard, real focus and layout, and a real file chooser and download: the
// things jsdom cannot reproduce, which is where the bugs that unit tests miss tend to live.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from '@cantoo/pdf-lib';
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
    check('the saved page lost the highlight, the note and its two replies', !subtypes.includes('Highlight') && subtypes.length === 3, subtypes.join(','));
    check('and kept the underline, strikeout and the other note', subtypes.includes('Underline') && subtypes.includes('StrikeOut') && strings.includes('The speech-bubble icon.'));
    check('nothing of the deleted comments is left anywhere in the file', !strings.some((t) => /Highlight with a comment|A note with a short thread|Agreed, and here is a reply|And a second reply/.test(t)), JSON.stringify(strings));
    check('the other pages are untouched', saved.getPageCount() === 5);
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
