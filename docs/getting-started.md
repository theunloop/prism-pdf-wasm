# Getting started

## Install

```bash
npm install prism-pdf
```

The engine ships **inside** the package — two WebAssembly builds, one for browsers and one for
Node. Nothing is downloaded at run time, which matters both for air-gapped consumers and because a
package that fetches its own executable code is a supply-chain liability.

## In a browser

The `.wasm` has to be fetched and compiled, so `init()` is genuinely asynchronous. Await it once.

```ts
import init, { Document } from "prism-pdf";

await init();

const bytes = new Uint8Array(await file.arrayBuffer());
using doc = Document.open(bytes);

console.log(`${doc.pageCount} pages`);
console.log(doc.pageText(0));
```

With no argument the module is resolved relative to the package's own script, which is what Vite,
webpack, Next and friends wire up for you. Pass an argument to load it from somewhere else:

```ts
await init("https://cdn.example.com/prism_pdf_bg.wasm");   // a URL
await init(await fetch(url));                              // a Response
await init(myArrayBuffer);                                 // bytes you already have
```

`init()` is safe to call repeatedly and from several places at once — concurrent calls share one
instantiation rather than compiling the module twice.

## On Node

Node loads the module from disk as the package is imported, so there is nothing to wait for.
`init()` still exists and still returns a promise, so the same code runs in both places:

```ts
import { readFileSync } from "node:fs";
import { Document, init } from "prism-pdf";

await init();   // a no-op here

using doc = Document.open(new Uint8Array(readFileSync("invoice.pdf")));
console.log(doc.pageCount, doc.pageText(0));
```

Node 18 or newer.

## Closing documents

**A document you stop referencing is not collected.** It lives in the WebAssembly heap, which only
grows. Close it:

```ts
using doc = Document.open(bytes);          // released at the end of the block
```

`using` needs TypeScript 5.2+ or a runtime with explicit resource management. Without it:

```ts
const doc = Document.open(bytes);
try {
  // …
} finally {
  doc.close();   // idempotent
}
```

## Reading a document

```ts
using doc = Document.open(bytes);

doc.pageCount;              // 12
doc.version;                // { major: 1, minor: 7 } | null
doc.minVersion;             // the minimum the *content* requires
doc.openReport;             // { mode: "strict" | "recovered", diagnostics: [...] }

doc.pageText(0);            // reading order
doc.pageTextPositioned(0);  // line breaks and gaps from the text matrix
doc.text;                   // every page (runs extraction on each read)
```

## Inspecting it

Every collection is a plain array. Nothing to dispose.

```ts
for (const annotation of doc.pageAnnotations(0)) {
  if (annotation.uri) console.log(annotation.uri, annotation.rect);
}

for (const field of doc.formFields()) {
  console.log(field.name, field.fieldType, field.value);
}

// Fonts, and the PDF/A pre-flight question: is every one of them embedded?
const unembedded = doc.fonts().filter((font) => font.embedded === null);

// Attachments come back decoded through their filter chain.
for (const file of doc.attachments()) {
  console.log(file.name, file.mime, file.data.length);
}

// Images: `Raw` is decoded samples, anything else is a complete container file.
for (const image of doc.pageImages(0)) {
  if (image.kind === "Jpeg") {
    const url = URL.createObjectURL(new Blob([image.data], { type: "image/jpeg" }));
  }
}
```

## Metadata

Optional fields return `null` — absence is not an error.

```ts
doc.info("Title");      // string | null, decoded per §7.9.2.2
doc.xmp;                // the raw XMP packet, or null
doc.creationDate;       // { year, month, day, …, utcOffsetMinutes } | null
```

## Rewriting it

Three modes, all of which return **new** bytes and leave the document untouched:

```ts
doc.save();          // classic cross-reference table — normalises and repairs
doc.saveCompact();   // cross-reference stream (PDF 1.5+)
doc.savePacked();    // object streams — the smallest
```

To work with the result, reopen it. There is no mutating save.

## Untrusted input

If you are parsing uploads, set limits. `maxDecodedStream` is the decompression-bomb guard.

```ts
using doc = Document.open(bytes, {
  limits: {
    maxDecodedStream: 64 * 1024 * 1024,
    maxObjects: 500_000,
    maxDepth: 64,
  },
});
```

A file that exceeds a limit fails with `Status.Parse` rather than exhausting the tab.

Run untrusted files in a **worker**, one instance per batch. That is not only for the main thread's
responsiveness: a wasm trap is fatal to the module instance, and a worker bounds the damage to the
batch. See [wasm-constraints.md](wasm-constraints.md).

## Encrypted documents

```ts
using doc = Document.open(bytes, { password: "secret" });
```

The password is tried as both user and owner. A wrong one raises `Status.Password`, not `Parse`.

## Handling errors

```ts
import { PrismPdfError, Status } from "prism-pdf";

try {
  using doc = Document.open(bytes);
} catch (error) {
  if (error instanceof PrismPdfError && error.status === Status.Password) {
    // ask for a password
  } else {
    throw error;
  }
}
```

Branch on `status`, not on the message. [error-handling.md](error-handling.md) has the full table.
