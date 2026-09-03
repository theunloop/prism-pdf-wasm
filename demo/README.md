# The demo

A single static page that opens a PDF, shows what is inside it, searches its text, previews and
reorganises its pages, pulls out its images, fonts and attachments, and writes the file back
out — with the engine running as WebAssembly in the tab. No server, no upload, and no third-party
request.

One document at a time, deliberately. Opening a file closes whatever was open first — there is
exactly one `release` path, used whether you replace a document or explicitly close it — which
keeps "the wasm heap is not the JavaScript heap" legible as *open or not*, not a count to audit.

```bash
npm run build      # dist/ and pkg/ — the demo copies both
npm run demo       # assembles _site/ and serves it on http://localhost:8080
npm run test:demo  # drives the assembled page in headless Chromium
```

`npm run demo` needs a built package and `npm ci` (the preview vendors pdf.js out of
`node_modules`); `npm run test:demo` also needs the shared corpus (`npm run corpus`) for its
fixtures, and skips with a message without it.

## How it is put together

Three files — `index.html`, `styles.css` and `app.js` — plus the package copied in verbatim by
`build/build-demo.sh`, and one PDF written by `build/make-sample.mjs`:

```
_site/
  index.html
  styles.css
  app.js
  sample/prism-sample.pdf   written at build time — see "The sample document"
  dist/index.web.js         imports ../pkg/web/prism_pdf.js
  pkg/web/prism_pdf.js      fetches prism_pdf_bg.wasm beside itself
  vendor/pdfjs/             not this package — see "Page pictures are pdf.js's"
```

That relative layout is load-bearing: the generated glue resolves the `.wasm` relative to itself,
which is exactly what `await init()` with no argument does for a consumer. Keeping it means the
demo exercises the same path a no-bundler user takes, rather than a path only this page has.

There is deliberately no bundler and no framework. What is being demonstrated is the published
package; a build step that transformed it on the way in would be demonstrating that instead.

## What is on the page

Eight panels, one per thing the read and write paths can do. Each opens with a **readout** — a
line stating which call ran, over how much, and how long it took, timed with `performance.now()`
around the call itself. A thin rule in the tab bar brackets one of them — Pages — because it is
the only tab that changes the document; everything either side of that rule only ever reads it.

| Panel | What it is | The API it is showing |
|---|---|---|
| Overview | Stats, `/Info`, recovery diagnostics, the XMP packet, and the whole read path as JSON | `pageCount`, `version`, `openReport`, `info`, `creationDate`, `xmp` |
| Pages | The editor and the viewer: drop, duplicate, reorder and turn pages on a grid of thumbnails, click one to see it full size, then export — and, at its foot, the same file written three ways | `extractPagesWithReport`, `rotatePage`, `save`, `saveCompact`, `savePacked` |
| Text | One page's text, in reading order or with the layout preserved | `pageText`, `pageTextPositioned`, `text` |
| Find | Every page extracted once, then searched | `pageText` |
| Structure | The outline as a tree, links, annotations with a body, form fields — and whether a `Sig` field is present, though not whether it still verifies | `outline`, `pageAnnotations`, `formFields` |
| Fonts | A live specimen of each embedded program, and what an unembedded one costs | `fonts` |
| Images | Raw samples decoded and drawn here; containers offered as files | `pageImages` |
| Files | Embedded files, decoded and saveable | `attachments` |

`merge` is not a panel of its own, and — with one document open at a time — it has no files to act
on either. It is still exercised, just not as a standalone feature: turning one copy of a page to
an angle none of its siblings share forces Pages to build one document per copy and `merge` them
back into the export (see below), so the call is demonstrated inside the one editing panel rather
than beside a file list that no longer exists.

Three of the panels are worth calling out, because they show something a table of metadata cannot.

**The font specimens are the engine's own bytes.** `font.embedded.program` goes straight into a
`FontFace`, with nothing parsing it in between, and the browser draws a line of text with it. If
the specimen renders, the program really is a working typeface — which is a stronger statement
than any field the panel could print. Type1 and bare CFF programs are legitimate in a PDF and no
browser will load either, so those say so instead of quietly falling back to a substitute face.

**Structure names a signature field without pretending to check it.** A `Sig` field in the form
fields table means the document was signed by someone; it does not mean the panel knows whether
that signature still holds. Verifying one needs a wall clock, and this binding runs in
WebAssembly, which has none — `SystemTime::now()` traps rather than returning a time (see
[`docs/wasm-constraints.md`](../docs/wasm-constraints.md)). That is an engine-level limit, not a
missing feature of this panel, so the panel says so in those terms rather than staying silent
about a `Sig` row nobody would otherwise think to ask about.

**Editing is one panel, and everything in it is visual — including looking at a page closely.**
There used to be a second, read-only tab for that: Preview, with its own pager and its own idea of
which page you were on, which frequently disagreed with the editor's. It is gone. Pages does both
jobs now, because they were never two features: a page range doing the same job as the grid would
have been a second way to edit, and a separate pager doing the same job as a thumbnail was a
second way to look. Every operation is something done to a page you can see — untick to drop it,
drag to move it, `⧉` to duplicate it, `↺ ↻` to turn it, click its thumbnail to open it full size
with its own zoom and pager. The one text field left is a *selector*: it ticks the pages you name
and then gets out of the way, which is what makes it useful on a five-hundred-page file and
harmless everywhere else.

The model behind it is a list of **slots**, not a list of pages. Slots carry their own identity so
one page can appear twice — which is exactly what `extractPages([0, 0])` means — and everything you
do to a card belongs to the slot: keeping it, moving it, turning it. Turning one copy turns one
copy.

**Which is why export has two paths.** `/Rotate` is a property of the page, so one page at two
angles cannot exist in a single document. When every copy of a page shares an angle, the pages that
need turning are turned on the source — each `rotatePage` a whole new document, so a second turn
reopens the first one's output — and a single `extractPages` takes the selection in order. When a
page appears twice at different angles, each kept slot is instead extracted from its own turned
document and the results are `merge`d in slot order. The second path is right rather than cheap: a
hundred slots are a few hundred engine calls, which is why the first one is kept and why the report
names the path that ran.

Nothing is spent until you press Export. The `TransformReport` printed afterwards is the engine's
answer, including the uncomfortable parts: both paths build a fresh object graph, so signatures and
the structure tree are **removed**, and the panel says so rather than leaving it to be discovered
by reopening the output.

## The sample document

`build/make-sample.mjs` writes `sample/prism-sample.pdf` at build time: four pages with an outline
that nests, a link that leaves the document and one that does not, two raw images in different
colour spaces, a form field with a value, an attached text file, an XMP packet and a full `/Info`
dictionary. The page offers it in one click, and fetches it only when asked.

It exists because a page whose every panel is empty until the visitor finds a PDF is a page most
visitors leave. It is *written* rather than copied for two reasons: nothing in the shared corpus is
a candidate — those fixtures are deliberately minimal, and `CLAUDE.md` forbids copying them here —
and the demo may not depend on a PDF *writer* to show off a PDF *reader*. So the generator is a
hundred lines of hand-assembled objects and a classic cross-reference table, with a guard that
refuses to emit a byte WinAnsiEncoding does not have.

Its content streams are uncompressed on purpose. It makes the file legible in a hex editor, and it
leaves the three save modes at the foot of Pages a real difference to report rather than the nothing
you get from repacking an already-packed file.

One thing the sample cannot show: it embeds no font program, so the Fonts panel has no specimen to
draw and says where to find one instead. Embedding a face would mean shipping several hundred
kilobytes of someone else's typeface, or writing an sfnt from scratch — and any PDF exported from a
word processor has one, so the feature is a drop away.

## Page pictures are pdf.js's

The engine has no rasterizer. Page rendering is out of scope for its v1, and this binding cannot
invent what the engine does not do — so every picture of a page here, the thumbnails under
**Pages** and the full-size view a click on one opens, is drawn by
[Mozilla's pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0).

That is an uncomfortable thing to put on a page whose purpose is to show off Prism, which is
exactly why it is said twice — the empty state, and a notice at the top of the Pages panel itself.
The alternative was worse in both directions: no page pictures at all makes the page less useful
than it could be, and unlabelled ones would advertise a capability the engine does not have. A
reader who walks away thinking Prism rasterizes pages has been misled by this demo, and that is
the one outcome worth engineering against.

Three things follow from the decision:

- **It is vendored, not linked.** `build/build-demo.sh` copies pdf.js out of `node_modules` into
  `vendor/pdfjs/`, so the page still makes no third-party request and still works offline. It is
  the minified ESM build, renamed `.mjs` → `.js` on the way in: both are ES modules either way,
  and `.js` is the extension every static host already maps to JavaScript.
- **It is loaded lazily**, by `import()` on first use. A visitor who never asks for a page image
  never fetches the 460 KB — which matters, because pdf.js is roughly five times the size of the
  whole wasm engine this page exists to show. The CMaps, Standard 14 font programs, and JPEG 2000 /
  JBIG2 decoders beside it are fetched per document, and only by a document that needs one.
- **Its documents are closed like handles are.** pdf.js holds worker-side resources of its own, so
  releasing a file destroys them alongside `doc.close()`. Same discipline, different heap.

The full-size viewer is also, unintentionally, the most interesting thing on the page: two
independent implementations read the same bytes, so its readout prints the page count from *both*
and says so when they disagree. A file that Prism opens and pdf.js rejects — or the reverse — is a
bug report waiting to be written, and the demo will show you which one it is rather than blaming
the engine for the other library's failure.

It found something immediately. Of the five files in `corpus/malformed/`, Prism recovers all five;
pdf.js refuses `missing-startxref.pdf` and `truncated-trailer.pdf` with "Invalid PDF structure".
The viewer says so in those words — *pdf.js could not open this file … Prism opened it, so the
two disagree about it* — and `tests/demo/run.mjs` pins that wording, because the failure mode this
panel must never have is one library's rejection reading as the other's.

## Deploying

`.github/workflows/pages.yml` builds and publishes `_site/` to GitHub Pages on every push to
`main`. Pages serves `.wasm` as `application/wasm`, which `WebAssembly.instantiateStreaming`
requires.

The published site is about 6 MB, five of which are vendored pdf.js — its CMaps and Standard 14
font programs are many small files that are only ever fetched by a document that needs one. What a
visitor actually downloads is the page, `dist/`, and the 856 KB engine; pdf.js is fetched only when
something asks for a picture of a page.

Two hosting notes worth keeping:

- **`raw.githubusercontent.com` will not work.** It serves everything as `text/plain` with
  `X-Content-Type-Options: nosniff`, which breaks both the ES module imports and the streaming
  instantiation. A CDN that sets types correctly (jsDelivr) is fine; Pages is simpler.
- **No COOP/COEP headers are needed.** Cross-origin isolation is only required for threads and
  `SharedArrayBuffer`, and this module is single-threaded — which is fortunate, because Pages
  cannot set response headers at all.

## Known limits

- **The page pictures are not the engine's.** See above. Everything else on the page is; the images
  drawn on a page are extracted by Prism and shown under Images, which is a different claim from
  "this is what the page looks like".
- **Everything Prism does runs on the main thread.** Fine for ordinary documents; a very large scan
  will make the tab unresponsive for the duration of a call. Find is the one place this is worked
  around — it extracts in slices and yields between them, so a long document reports progress
  instead of freezing — and that workaround is the argument for the real fix. Moving the engine
  into a Web Worker is the first thing to do if this ever becomes more than a demo. It was left out
  here because the message-passing layer would obscure the API this page exists to show.
- **The page grid stops at 400 pages.** The engine has no trouble with the page count; four
  hundred DOM cards and four hundred queued renders are this page's problem, not the engine's.
  Every other panel, and export, still covers the whole document.
- **A raw image in an Indexed, Separation or DeviceN space is described, not drawn.** The engine
  reports the samples and the component count; the palette needed to interpret them is not part of
  this API. CMYK is drawn with the naive conversion, which is a preview, not a proof.
- **Handles are closed explicitly**, and the footer bar says whether one is open. That is not
  decoration: the wasm heap is not the JavaScript heap, and nothing collects an unreachable
  `Document`. Keeping the demo to one open document at a time means there is only ever one handle
  to account for — opening a new file closes the old one on the same path an explicit close does —
  which is a simplification the demo can afford and a real application usually cannot. See
  [`docs/ownership.md`](../docs/ownership.md).
- **Only one document is open at a time.** Opening a file closes whatever was open, and there is no
  merge feature any more, because merging needs two files to act on. `merge` is still demonstrated
  — Pages reaches for it internally when a page is turned to two different angles and a `merge` is
  the only way to get both into one export — just not as its own tool.
