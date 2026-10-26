# Pagewright

A PDF app for organising pages and marking up documents. It runs in the browser today, and is built so that desktop (Electron) and mobile (Capacitor) shells can wrap the same code later.

> **Status: early development.** The web app works end to end (open, edit, save), but there is no release, and the desktop and mobile shells are not started. See [Roadmap](#roadmap).

## What it does

**Pages**
- Open one or more PDFs and merge them
- Reorder (drag), rotate, duplicate, delete and extract pages, with undo and redo
- Large files open lazily from disk instead of being loaded into memory

**Marking up**
- Select and copy the document's own text
- Highlight, underline and strike out exactly the text you select
- Each tool keeps its own colour, thickness, fill (rectangles and ellipses) and transparency, also after closing the app
- Pen, rectangle, ellipse, line and arrow; text boxes in sans, serif or mono, in Western and Central European languages, Cyrillic, Greek and Vietnamese (a box in another alphabet embeds only the letters it uses)
- Preset stamps (Approved, Draft, Confidential and more), movable and resizable
- Typed visual signatures in four handwriting styles, or drawn by hand with a mouse, finger or pen, kept on your device and saved as vector shapes so they look the same in every viewer (they are pictures of a name, not digital signatures)
- Image stamps from PNG or JPEG pictures (a logo, a scanned signature): turned upright, scaled down to a sensible size, and transparency kept
- Notes and comments, with replies and a comments panel
- On a phone: a slim top bar, and the tools and their options at the bottom, within reach of a thumb
- Annotations that were already in a PDF can be selected, read and deleted (not edited)

**Saving**
- Your edits are saved as real PDF annotations with appearance streams, so other viewers (Acrobat, Preview, Chrome and so on) show them and you can remove them there
- The original files are never modified; the saved copy is written in a worker so the page stays responsive

## Run it

You need [Node.js](https://nodejs.org) and [pnpm](https://pnpm.io). It is developed with Node 24 and pnpm 12.

```
pnpm install
pnpm dev          # then open the address it prints
```

Then use **Open** (or drop a PDF on the window). `pnpm sample` writes `out/sample.pdf`, a small file with annotations of every kind, which is handy for trying things out.

## Test it

```
pnpm test         # unit tests for every package
pnpm typecheck
pnpm e2e          # real-browser checks (see below)
```

`pnpm e2e` builds the app, opens it in the Chrome or Edge installed on your machine (set `CHROME_PATH` if it is somewhere unusual), and drives it with a real mouse, keyboard, file chooser and download. It exists because some bugs only appear with real focus and pointer behaviour, which unit tests cannot reproduce. Screenshots are written to `out/e2e/`.

Other scripts:

| Command | What it does |
|---|---|
| `pnpm sample` | Writes `out/sample.pdf` for checking how other viewers display our annotations |
| `pnpm make-large` | Writes a ~300 MB scanned-style PDF to `out/` for memory testing |
| `pnpm bench-large <file>` | Measures open, edit and save time and memory on a big PDF |
| `pnpm gen-font-data` | Regenerates the font metrics in `packages/core` from pdf-lib |

## How it is organised

A pnpm workspace. Each layer only depends on the ones above it in this list.

| Package | Contents |
|---|---|
| `packages/core` | The document model, commands with undo/redo, page and annotation geometry, text layout, save-time checks. Pure TypeScript: no DOM, no Node APIs |
| `packages/engine` | PDF.js rendering, the pdf-lib writer and its worker, annotation appearance streams, the render queue |
| `packages/platform` | Interfaces for files, sharing and storage, with the web implementation |
| `packages/ui` | The React app: store, viewer, tools, comments panel |
| `apps/web` | The Vite app that wires it together |
| `e2e` | The real-browser checks |

The design, the data model and the decisions behind them are in [docs/MODULE_SPEC.md](docs/MODULE_SPEC.md).

## Known limits

- **Text boxes cannot show Chinese, Japanese, Korean, Arabic, Hebrew, Indic scripts or emoji**: those are replaced by `?`, with a warning while you type.
- **Saving needs about 4.5 times the size of the source files in memory.** Larger documents can still be opened, viewed and marked up, but saving is refused with an explanation, rather than risking a crashed tab. Phones allow roughly 200 to 270 MB of source files.
- **Encrypted PDFs** can be viewed but not saved. **Digitally signed PDFs** can be edited, but saving invalidates their signatures (you are asked first).
- Scanned pages have no text to select.

## Roadmap

- Redaction (select text or an area, then apply: the content is truly removed and the rest stays searchable), planned together with text editing, since both rewrite page content
- Editing the document's own text (PDFs with real text, not scans): replace a line in a matching font, with the old text truly removed from the file. A major future improvement; it starts with a feasibility test on real sample PDFs
- Electron shell (desktop) and Capacitor shell (mobile)
- Checking the saved annotations in more viewers (Acrobat and macOS Preview are checked; still to do: iOS, Firefox, Foxit, Android)

## Acknowledgements

Built on [PDF.js](https://mozilla.github.io/pdf.js/) for rendering and [pdf-lib](https://pdf-lib.js.org/) (the maintained [@cantoo fork](https://github.com/cantoo-scribe/pdf-lib)) for writing. Typed signatures and text in other alphabets use [fontkit](https://github.com/foliojs/fontkit) (the [@cantoo fork](https://www.npmjs.com/package/@cantoo/fontkit)), the handwriting fonts Great Vibes, Dancing Script, Caveat and Sacramento, and Noto Sans, Noto Serif and Noto Sans Mono (all SIL Open Font License) from [Fontsource](https://fontsource.org). Toolbar icons are [Lucide](https://lucide.dev) (ISC License).
