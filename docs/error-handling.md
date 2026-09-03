# Errors

## One error type

Every failure raises `PrismPdfError`, carrying the stable integer status and, where the engine had
one, its diagnostic message:

```ts
import { Document, PrismPdfError, Status } from "prism-pdf";

try {
  using doc = Document.open(bytes);
} catch (error) {
  if (error instanceof PrismPdfError) {
    switch (error.status) {
      case Status.Password:
        // Encrypted, and the password was wrong or absent. Retry with one.
        break;
      case Status.Parse:
        // Unreadable even after recovery.
        console.warn(error.message);
        break;
    }
  }
}
```

Switch on `error.status`, never on the message. The status values are append-only and are never
renumbered; messages are diagnostics and may change between engine releases.

| Status | Meaning |
|---:|---|
| `Ok` | Success — never thrown. |
| `NullArgument` | A required argument was missing, or a value was rejected. |
| `Parse` | Unparseable even after recovery. |
| `NotFound` | The item does not exist. **Read the next section** — this one has two readings. |
| `Internal` | An internal error. |
| `Password` | Encrypted, and the supplied password is wrong or absent. |
| `Conformance` | A conformance pass refused the document: nothing malformed, a standard's rule unmet. |
| `InvalidUse` | A handle is closed, stale, or already finalised. |
| `Layout` | Composition rejected geometry or could not paginate. |

`statusName(status)` renders any of them, including a code newer than this package — the ABI is
append-only, so a future engine may raise one this release has never seen.

## `NotFound` is absence *or* a mistake

An **optional getter** that finds nothing returns `null`. It does not throw, and a `try` around it
is a sign of a misreading:

```ts
const author = doc.info("Author");   // string | null — absent is normal
```

An **index** that does not exist throws, because asking for a page that is not there is a caller
error:

```ts
doc.pageText(99);   // throws: status NotFound
```

## What is *not* a `PrismPdfError`

Anything this package did not raise deliberately passes through untouched — most importantly a
`RuntimeError` from a wasm trap. That distinction is deliberate: a trap means the module instance
is gone, and presenting it as a status a caller might handle as "this document was malformed" would
be wrong in the most damaging direction. See [wasm-constraints.md](wasm-constraints.md), §1.

```ts
catch (error) {
  if (error instanceof PrismPdfError) { /* the document, or your call */ }
  else { /* the instance — build a fresh one */ }
}
```

## `Internal` here is not `Internal` there

On a native target `Status.Internal` is mostly *a Rust panic was caught at the FFI boundary*. On
wasm a panic is a trap and never becomes a status at all, so `Internal` arrives only from the
handful of conditions the engine reports as internal in the ordinary way. The one worth knowing:
`DocError::RandomUnavailable`, meaning `crypto.getRandomValues` was not available. That describes
the environment, not the document.

## Conformance will get a subclass

When the conformance area is bound, a PDF/A or PDF/UA refusal will raise a
`PrismPdfConformanceError` carrying the specific unmet rule, subclassing `PrismPdfError` so
`instanceof PrismPdfError` still catches it. It will be the only subclass, exactly as in the .NET
binding — everything else fits in a status plus a message.
