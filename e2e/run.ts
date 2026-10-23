// Real-browser checks. `pnpm e2e` (needs Chrome or Edge; set CHROME_PATH if it is somewhere unusual).
// Pass a scenario name to run just that one, e.g. `pnpm e2e text`. Screenshots go to out/e2e/.
// These use the real mouse and keyboard, real focus and layout, and a real file chooser and download: the
// things jsdom cannot reproduce, which is where the bugs that unit tests miss tend to live.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } from '@cantoo/pdf-lib';
import {
  SHOTS, check, chooseTool, clickButton, clickOnPage, count, doubleClickOnPage, dragOnPage, failureCount, openPdf, sleep, start, waitForDownload,
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

const scenarios: Record<string, (s: Session) => Promise<void>> = {
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
    check('the original annotations are kept and the five new ones added', after.length === startCount + 5, `${startCount} -> ${after.length}: ${after.join(',')}`);
    for (const t of ['FreeText', 'Square', 'Ink', 'Line']) check(`the saved page has a ${t} annotation`, after.includes(t));
    const annots = saved.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const contents = annots.asArray().map((_, i) => {
      const c = annots.lookup(i, PDFDict).lookup(PDFName.of('Contents'));
      return c instanceof PDFHexString ? c.decodeText() : '';
    });
    check('the text box and note texts are in the file', contents.includes('Saved text box') && contents.includes('Saved note'), JSON.stringify(contents));
    await s.page.screenshot({ path: resolve(SHOTS, 'saved.png') });
  },
};

const wanted = process.argv[2];
const session = await start();
try {
  for (const [name, run] of Object.entries(scenarios)) {
    if (wanted && wanted !== name) continue;
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
