# Prism PDF for WebAssembly

A JavaScript and TypeScript SDK for [Prism PDF](https://github.com/theunloop/prism-pdf) — a
pure-Rust PDF engine that reads, manipulates and generates PDFs. This repository is the **WASM
binding**: it compiles the engine to `wasm32-unknown-unknown` and projects it into an idiomatic
JavaScript API that runs the same in a browser and on Node.

> **Status: read, parse and manipulate surface, no release yet.** Opening, text extraction,
> annotations, form fields, outlines, attachments, fonts, images, metadata, all three save modes
> and the page manipulations (split, rotate, merge) are bound and covered by the ported
> conformance journeys. Authoring, layout, composition, conformance production and the COS escape
> hatch are not bound yet, and the security area is blocked upstream — see
> [What is missing](#what-is-missing). Nothing has been published to npm.

```ts
import init, { Document } from "prism-pdf";

await init();                                    // a no-op on Node

using doc = Document.open(bytes);
console.log(`${doc.pageCount} pages, PDF ${doc.version?.major}.${doc.version?.minor}`);
console.log(doc.pageText(0));
```

## What this SDK is, and is not

It is a **binding**, not a reimplementation. Every capability comes from the Rust engine; this
repository contributes two layers:

1. **A raw layer** — `crates/prism-pdf-wasm/`, about 600 lines of `#[wasm_bindgen]` over the
   engine's `prismpdf` facade. It owns handle lifetime and the status mapping, and nothing else.
2. **An idiomatic layer** — `src/`, in TypeScript. The public API, and the one place the engine's
   ownership and error conventions are enforced, so user code cannot leak a handle, use one after
   closing it, or misread a status.

The object model, the ten naming rules and the six semantic contracts all come from the engine's
**binding author's guide** (`docs/BINDINGS.md`), whose goal is that `doc.pageCount` in JavaScript,
`doc.PageCount` in C# and `doc.page_count` in Python are recognisably the same call. Where this
binding deviates — collections are plain arrays, not list handles — the deviation and its reasoning
are recorded in [`docs/naming.md`](docs/naming.md).

### Why not the C ABI

Every other Prism PDF binding consumes the engine's C ABI. This one goes through the Rust facade
instead, because the engine's own `DESIGN.md` §6.2 says so: Browser/JS is a *tier-1* target, to be
served by wasm-bindgen rather than a C boundary, alongside PyO3 for Python and napi-rs for Node.
The practical argument is the same one: `pdf-ffi` returns everything through out-parameters, and in
wasm an out-parameter is an offset the caller must allocate — so a C-ABI binding would first need
its own allocator shim, then hand-roll 386 exports of pointer arithmetic across `memory.buffer`,
reimplementing what wasm-bindgen generates. [`docs/architecture.md`](docs/architecture.md) records
the full trade, including what is given up.

## Getting started

```bash
npm install prism-pdf
```

Node 18+, or any browser with WebAssembly. The engine ships **inside** the package — two builds,
one per runtime — so there is nothing to install alongside it and nothing is ever fetched at run
time.

In a browser the `.wasm` is fetched and compiled, so `await init()` once before the first call. On
Node that is already done and `init()` resolves immediately, so the same code runs in both.

Full walkthrough: [`docs/getting-started.md`](docs/getting-started.md).

### Close your documents

The WebAssembly heap is not the JavaScript heap. A `Document` you stop referencing is **not**
collected — use `using`, or `close()` in a `finally`:

```ts
using doc = Document.open(bytes);   // released at the end of the block
```

## What you can do today

| Area | Status | Entry points |
|---|---|---|
| **Open** — plain, encrypted, with anti-DoS limits | ✅ | `Document.open(bytes, { password, limits })` |
| **Recovery reporting** | ✅ | `doc.openReport` |
| **Read** — text, positioned text, versions | ✅ | `doc.pageText`, `.pageTextPositioned`, `.text`, `.version`, `.minVersion` |
| **Inspect** — annotations, form fields, outline, attachments, fonts, images | ✅ | `doc.pageAnnotations()`, `.formFields()`, `.outline()`, `.attachments()`, `.fonts()`, `.pageImages()` |
| **Metadata** — `/Info`, XMP, dates | ✅ | `doc.info()`, `.xmp`, `.creationDate`, `.modificationDate` |
| **Save** — classic, compact, packed | ✅ | `doc.save()`, `.saveCompact()`, `.savePacked()` |
| **Manipulate** — split, rotate, merge | ✅ | `doc.extractPages()`, `.rotatePage()`, `merge()` — each with a `…WithReport` companion |
| **Author, layout, compose** — including form filling | ⬜ not yet bound | |
| **PDF/A & PDF/UA production** | ⬜ not yet bound | |
| **Encrypt, sign, verify** | ⛔ blocked upstream | see below |
| **Page rendering** | ⛔ out of scope for the engine's v1 | the demo's page pictures are pdf.js, not this package |

## The demo

[`demo/`](demo/) is a single static page that opens PDFs, reads and searches their text, walks
their structure, renders a specimen of every embedded font, pulls out their images and attachments,
reorganises their pages and writes the file back out — entirely in the browser. It is the package
used the way a consumer on a static host uses it: no bundler, `await init()` with no argument,
files from a file input.

```bash
npm run demo        # build/build-demo.sh, then serve _site/ on :8080
npm run test:demo   # drive the assembled page in headless Chromium
```

Every panel opens with a line saying which call ran, over how much, and how long it took, measured
around the call rather than asserted — including the numbers that are not flattering. There is a
sample document, written from nothing by `build/make-sample.mjs` at build time, so a first-time
visitor has something to take apart in one click.

**The page pictures on that page are not this package.** The engine has no rasterizer, so the page
thumbnails — and the full-size view a click opens — are drawn by
[pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0), vendored into the site under
`vendor/pdfjs/` and loaded only when something first asks for a picture. The page says so in its
empty state and in a notice on the Pages panel — a demo that let a visitor assume the engine drew
those pages would be advertising a capability that does not exist. Everything else on it is Prism.

It is published to GitHub Pages by `.github/workflows/pages.yml`, and CI drives it in a browser on
every pull request. [`demo/README.md`](demo/README.md) covers the panels, the sample document, the
pdf.js decision and the hosting constraints — chiefly that `raw.githubusercontent.com` cannot serve
it, because it sets `text/plain` with `nosniff` on everything.

## What is missing

**Signing and verification cannot be bound as-is.** `SystemTime::now()` traps on
`wasm32-unknown-unknown`, and the engine reads the clock on the signing, verification and
revocation paths. The calls are written defensively (`.unwrap_or(0)`), but the trap happens inside
`now()` before that can help — so the call would not return an error, it would take the module
down. This is measured, not inferred. Unblocking it is an engine change (inject the clock, as
`SignSettings::set_signing_time` already does for one of the three), and belongs in an issue there.

**Everything else missing is simply not bound yet**, in the order the guide prescribes: parse →
create/manipulate → compose → security.

**Page rendering is not on that list**, because it is not a binding gap — the engine has no
rasterizer to bind. It exposes the parts one would be built from (`parse_content_stream`, the page
dictionaries, `page_content_bytes`, the image and font layers), but writing the renderer is engine
work, not binding work. Until it exists, anything that needs pixels needs a second library; the
demo shows what that looks like, and labels it.

[`docs/wasm-constraints.md`](docs/wasm-constraints.md) covers this and the two other things
WebAssembly changes — panics become fatal traps, and randomness has to be asked for explicitly.

## Size

| | raw | gzipped |
|---|---:|---:|
| `pkg/web/prism_pdf_bg.wasm` | 856 KB | 306 KB |
| the npm tarball | 674 KB | — |

`wasm-opt` dead-strips what nothing reaches, so this grows per area actually bound, not per area
the engine contains.

## Developing

```bash
npm ci
npm run corpus        # fetch and verify the engine's shared conformance corpus
npm run build         # cargo + wasm-bindgen + wasm-opt, then tsc
npm test              # the ported journeys, on Node
npm run test:browser  # the vertical slice, in headless Chromium
npm run smoke         # pack the tarball and use it from a throwaway project
```

Needs Node 18+ and a Rust toolchain with the `wasm32-unknown-unknown` target plus `wasm-pack`.
[`.devcontainer/`](.devcontainer) has all of it configured, and
[`CONTRIBUTING.md`](CONTRIBUTING.md) has the rest.

Working on the engine at the same time? Point the build at a checkout:

```bash
build/build-wasm.sh --core ../prism-pdf
```

## Documentation

| | |
|---|---|
| [getting-started.md](docs/getting-started.md) | Install, read, inspect, rewrite. Start here. |
| [architecture.md](docs/architecture.md) | The two layers, why the facade and not the C ABI, one API over two loaders. |
| [wasm-constraints.md](docs/wasm-constraints.md) | The three things WebAssembly changes. Read before binding a new area. |
| [error-handling.md](docs/error-handling.md) | One error type, the status table, and the two readings of `NotFound`. |
| [ownership.md](docs/ownership.md) | The six semantic contracts and where each is enforced. |
| [naming.md](docs/naming.md) | The ten naming rules applied, and every deviation. |
| [conformance-suite.md](docs/conformance-suite.md) | The ported journeys and the shared corpus. |
| [engine-source.md](docs/engine-source.md) | The pinned tag, and why this binding compiles the engine. |

The engine's own docs are the authority and win where they disagree with anything here:
`docs/BINDINGS.md`, `docs/ABI.md` and `DESIGN.md` in
[theunloop/prism-pdf](https://github.com/theunloop/prism-pdf).

## License

MIT. See [LICENSE.md](LICENSE.md).
