# Ownership and lifetime

The engine's guide lists six semantic contracts every binding must honour. Five apply here; one is
structurally satisfied. This page says where each lives, and what a consumer has to do.

## The thing to know first

**The wasm heap is not the JavaScript heap.** A `Document` you stop referencing is not collected —
its bytes live in the module's linear memory, which only grows. An unclosed document is a leak that
lasts as long as the instance.

```ts
using doc = Document.open(bytes);   // released at the end of the block
```

```ts
const doc = Document.open(bytes);
try { /* … */ } finally { doc.close(); }
```

`close()` is idempotent, so the second form is safe even when the body already closed.

There is deliberately **no `FinalizationRegistry` safety net**. It offers no guarantee that a
callback ever runs, so a binding that leaned on one would be promising a cleanup it cannot deliver,
and would hide leaks in testing that appear under load. Deterministic disposal is the API.

### The one handle you never see

`merge()` allocates a `Merger` in the wasm heap, fills it, and frees it in a `finally` before it
returns. It is the only handle this binding creates on a caller's behalf, and it cannot escape the
call — including when the merge throws because one of the inputs was closed. There is nothing extra
to dispose. It exists only because the facade's `merge(&[&Document])` has no wasm-bindgen
representation; deviation 6 in [naming.md](naming.md) carries the reasoning.

`merge` does **not** consume its inputs. The accumulator clones each source, so every `Document`
passed to it stays open and usable afterwards. That clone copies the source's bytes, which makes
this the one call whose peak memory is roughly twice the size of its inputs.

## Contract 1 — one error type

Every failure raises `PrismPdfError`, carrying the stable integer status. Enforced in
`wrap()` (`src/errors.ts`), which every call in `src/document.ts` goes through.

The engine's native ABI reads its diagnostic from a **thread-local slot** that the next successful
call clears, which is why the .NET binding warns never to put an `await` between a call and reading
its error. That hazard does not exist here: the shim builds the message into the thrown object at
the point of failure, so there is no slot to race. It is one of the few places this binding has an
easier job than a C-ABI one.

See [error-handling.md](error-handling.md).

## Contract 2 — `NotFound` has two readings

On an **optional getter**, absence is `null` and nothing is thrown:

```ts
doc.xmp          // string | null
doc.info("Author")  // string | null
doc.creationDate    // PdfDate | null
```

On an **index lookup**, it is an error, because asking for page 99 of a two-page document is a
caller mistake:

```ts
doc.pageText(99)    // throws PrismPdfError, status NotFound
```

Enforced in the shim (`js::text`, `js::num` return `null`) and in `Document.page_text`, which
converts the facade's `None` into `NotFound` deliberately.

`null` rather than `undefined`, deliberately: `undefined` is also what a *missing property* reads
as, and the two must stay distinguishable when a caller destructures a result.

## Contract 3 — consuming calls

The ABI has three shapes — *consumes on success*, *consumes always*, *finalises* — and getting one
wrong in C is a double free. None is reachable in this cut: all three belong to the authoring,
layout and composition areas. When those land, the shim marks the handle dead on the JavaScript
side and the rule stays what the guide says it is: **read the export's doc comment, not the call's
name**.

## Contract 4 — borrowed items keep their owner alive

Structurally satisfied and then removed. Collections cross as plain arrays of plain objects
(deviation 1 in [naming.md](naming.md)), so there is no borrowed pointer to outlive anything and no
parent to hold. Every payload is copied at the boundary.

## Contract 5 — copy, then free, immediately

Every string and byte buffer is copied into the JavaScript heap as it crosses; nothing lends a view
into linear memory. `js::bytes` builds a `Uint8Array` by copy for a reason worth stating: a view
onto wasm memory is **detached** when that memory grows, so a caller holding one would find it
silently zero-length after the next allocation, with no error to explain it.

## Contract 6 — no shared mutable handles across threads

Free here. A `Document` is an offset into one module instance's memory, and that memory is not
shared with another worker unless you go out of your way to share it. Passing a `Document` through
`postMessage` is not possible — it is not structured-cloneable — so the mistake is unavailable
rather than merely discouraged.

To use Prism PDF from several workers, instantiate the module in each. They share nothing, which is
the intended shape: it is also what limits the blast radius of a trap
([wasm-constraints.md](wasm-constraints.md)).

## Two rules that are ours, not the ABI's

**`init()` before anything else.** In a browser the module has to be fetched and compiled. Calling
into the API first raises a `PrismPdfError` with `InvalidUse` and a message saying so, rather than
failing inside generated glue. `init()` is safe to call repeatedly and concurrently — repeat calls
share one instantiation.

**A trap is fatal to the instance, not to the document.** If a `RuntimeError` escapes this package,
every handle in that instance is gone. Build a fresh instance rather than retrying the call.
