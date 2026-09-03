# Architecture

## Two layers, always

The engine's binding author's guide is prescriptive here, and this binding follows it:

> Every binding has exactly two layers:
>
> 1. **The raw layer**: one flat, mechanical projection of the engine's surface. No logic, no
>    renaming beyond the language's FFI syntax.
> 2. **The idiomatic layer**: the canonical object model. This is the public API and the only thing
>    user code sees. It is where the ownership and error conventions are enforced, once, so user
>    code cannot leak, double-free, or misread a status.

```
      your code
          │
          ▼
┌──────────────────────────────────────────────────────────┐
│  idiomatic layer            src/  (TypeScript)           │
│  Document, PrismPdfError, Status, init, the result types │
│                                                          │
│  · every failure becomes one error type, here            │
│  · every absence becomes null, here                      │
│  · every handle's lifetime is a close(), here            │
│  · the two runtimes are reconciled, here                 │
└──────────────────────────────────────────────────────────┘
          │  the generated pkg/{web,node} glue
          ▼
┌──────────────────────────────────────────────────────────┐
│  raw layer     crates/prism-pdf-wasm/  (Rust)            │
│  #[wasm_bindgen] over the `prismpdf` facade              │
│                                                          │
│  · owns handle lifetime and the status mapping           │
│  · returns plain JS values; no logic beyond that         │
└──────────────────────────────────────────────────────────┘
          │
          ▼
     the Rust engine (prismpdf → the workspace)
```

## Why the facade, and not the C ABI

Every other Prism PDF binding consumes the engine's C ABI (`pdf-ffi`). This one does not, and the
engine's own design says so: `DESIGN.md` §6.2 lists Browser/JS under *"Idiomatic wrappers for tier
1 languages"* —

> For the highest-demand languages it is better NOT to go through the C ABI, but to use native
> frameworks, for ergonomics and zero-copy: Python → PyO3, **Browser/JS → wasm-bindgen**
> (`wasm32-unknown-unknown` target, npm package), Node → napi-rs.

Two concrete reasons, beyond the citation:

**A C ABI in wasm has to be hand-driven.** `pdf-ffi` returns everything through out-parameters, and
in wasm an out-parameter is an offset into linear memory that the *caller* must allocate. `pdf-ffi`
exports no allocator, so a C-ABI binding would first need a shim crate exporting `malloc`/`free`,
then hand-roll 386 exports' worth of pointer arithmetic, string copying and buffer freeing across
`memory.buffer` — reimplementing, worse, what wasm-bindgen already generates.

**The append-only guarantee does not transfer, and that is the real cost.** A C-ABI binding can
vendor a header, and an older header keeps working against a newer library. This binding compiles
against the facade's Rust API, which is `#[non_exhaustive]` but not append-only, so an engine
upgrade is a recompile that can fail — loudly, at build time, which is the good failure mode.
`ENGINE_TAG` pins exactly one release and `build/check-tag.sh` keeps every mention of it in
agreement. See [engine-source.md](engine-source.md).

What is *kept* from the C-ABI bindings is everything that makes bindings interchangeable: the
object model, the ten naming rules, the six semantic contracts, and the conformance journeys.
`doc.pageCount` here is `doc.PageCount` in C# because the guide says so, not because wasm-bindgen
happened to produce it. Deviations are recorded in [naming.md](naming.md).

## The raw layer is small on purpose

`crates/prism-pdf-wasm/` is about 600 lines and does four things:

| | |
|---|---|
| `lib.rs` | One `#[wasm_bindgen]` method per bound call. |
| `error.rs` | The status codes, and the map from the engine's error enums onto them. |
| `read.rs` | One engine value → one plain JS object, per result type. |
| `js.rs` | Building those objects, and the copy rules for strings and bytes. |

Everything else is TypeScript. That split is deliberate: the Rust side is the part that is
expensive to change (it needs a toolchain, a two-minute build, and a wasm-opt pass), so ergonomics
— options objects, defaults, `null` normalisation, disposal, the error class — all live on the side
that a contributor can iterate on in a second.

## One API, two loaders

The package ships two wasm builds from one compile, because no single wasm-bindgen output serves
both runtimes without one of them paying for the other's loader:

| | `pkg/web` | `pkg/node` |
|---|---|---|
| Module format | ESM | CommonJS |
| Instantiation | `WebAssembly.instantiateStreaming` over a fetched URL | `fs.readFileSync` at require time |
| `await init()` | required | already done |

`src/runtime.ts` holds the instantiated module; `src/index.web.ts` and `src/index.node.ts` differ
only in how they obtain it, and both re-export `src/api.ts`. So `init()` exists in both and
consumer code is identical — a browser must await it, and on Node awaiting it is a no-op.

`package.json`'s `exports` map picks the entry point by condition, so a consumer writes
`import { Document } from "prism-pdf"` and gets the right one. `pkg/node/package.json` carries
`{"type":"commonjs"}` because this repository is `"type": "module"` and Node would otherwise apply
that to wasm-pack's CommonJS output.

## There is no `Page` type

The engine has no page handle, so page-indexed calls take an index on the document:

```ts
doc.pageText(0);
doc.pageAnnotations(0);
doc.pageImages(0);
```

The guide is blunt about why: *"A binding that grows a `Page` façade diverges from every other
binding for zero capability gain."* A `Page` object would either hold a document and an index — a
wrapper adding nothing — or cache page state, which can go stale.

## The boundary is immutable

Every transform serialises a **new** document and leaves its input untouched:

```ts
const packed = doc.savePacked();   // returns bytes
// doc is unchanged — always
```

There is no mutating save. To work with a result, reopen it — which is also how the conformance
suite asserts, because round-tripping through the package's own reader is what a consumer does and
what proves the reader and writer agree.

## Where each contract is enforced

| Contract | Enforced in |
|---|---|
| One error type carrying the stable status | `wrap()` and `PrismPdfError` in `src/errors.ts` |
| Absence on an optional getter is `null`; an out-of-range index is an error | `js::text` / `js::num` in the shim; `pageText` raises `NotFound` |
| A closed handle raises the wrapper's error, not a trap | `Document.#live` in `src/document.ts` |
| Owned strings and buffers are copied, not viewed | `js::bytes` in `crates/prism-pdf-wasm/src/js.rs` |
| Handles are not shared across threads | Structural: a wasm instance is not shared across workers |

Each has a case in `tests/failure-paths.test.ts`. Change one of those and that file is what tells
you. [ownership.md](ownership.md) goes through them one at a time.
