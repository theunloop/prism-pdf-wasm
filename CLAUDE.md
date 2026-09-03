# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this
repository.

## What this repository is

The **WebAssembly binding** for Prism PDF, a pure-Rust PDF engine. It is a binding, not a
reimplementation: every capability comes from the engine, compiled to `wasm32-unknown-unknown`.
This repo contributes a `#[wasm_bindgen]` shim crate and a hand-written TypeScript layer.

The engine lives in a separate repo, `https://github.com/theunloop/prism-pdf`. **It is not checked
out here.** Unlike every other binding, this one *compiles* the engine rather than downloading a
prebuilt library: the engine publishes thirteen native RIDs and an XCFramework, and none of them
loads in a WebAssembly runtime. The dependency is a Cargo git dependency pinned to `ENGINE_TAG`.
See `docs/engine-source.md`.

The authorities this SDK is written against live in that core repo and **win over this repo's docs
when they disagree**: `docs/BINDINGS.md` (the binding author's guide — naming rules, the six
semantic contracts, the conformance journeys), `docs/ABI.md`, and `DESIGN.md` (§6.2 is why this
binding uses wasm-bindgen rather than the C ABI).

## Commands

```bash
npm run corpus                    # do this first: the shared corpus, checksum-verified
npm run build                     # cargo + wasm-bindgen + wasm-opt, then tsc
npm run build:wasm                # the slow half; only when Rust changed
npm run build:ts                  # the fast half
npm test                          # the ported journeys, on Node
npm test -- tests/parse-journey.test.ts
npm run test:browser              # the vertical slice in headless Chromium
npm run typecheck
npm run smoke                     # pack the tarball and use it from a throwaway project
npm run check:tag                 # ENGINE_TAG agrees everywhere (CI runs this first)

build/build-wasm.sh --core ../prism-pdf   # build against a local engine checkout
```

Requires Node 18+, a Rust toolchain with `wasm32-unknown-unknown`, and `wasm-pack`.
`.devcontainer/` has all three.

### Running without the corpus

Suites that need fixtures **skip with a message** — never fail — when the corpus is absent. That is
the right courtesy for a contributor who has not fetched it. CI treats any skip as a failure.

## Architecture

### Two layers, and only two

1. **Raw layer** — `crates/prism-pdf-wasm/`, ~600 lines of Rust. A mechanical projection of the
   engine's `prismpdf` facade. Owns handle lifetime and the status mapping; no other logic.
2. **Idiomatic layer** — `src/`, TypeScript. The public API, and the *only* place the ownership and
   error conventions are enforced.

The split is deliberate: Rust is expensive to iterate on (toolchain, two-minute build, wasm-opt),
so all ergonomics — options objects, defaults, `null`, disposal, the error class — live in
TypeScript.

### Why the facade, not the C ABI

`DESIGN.md` §6.2 names Browser/JS a tier-1 target for wasm-bindgen rather than the C boundary. The
practical reason: `pdf-ffi` returns everything through out-parameters, and in wasm an out-parameter
is an offset the *caller* allocates — but `pdf-ffi` exports no allocator. A C-ABI binding would need
its own allocator shim plus 386 exports of hand-rolled pointer arithmetic over `memory.buffer`.

The cost is that the append-only ABI guarantee does not transfer: this binding compiles against the
facade's Rust API, so an engine upgrade is a recompile that can fail — at build time, loudly.

### Where each contract is enforced

| Contract | Enforced in |
|---|---|
| One error type carrying the stable status | `wrap()` / `PrismPdfError`, `src/errors.ts` |
| Absence is `null`; an out-of-range index is an error | `js::text`/`js::num` in the shim; `page_text` raises `NotFound` |
| A closed handle raises the wrapper's error, not a trap | `Document.#live`, `src/document.ts` |
| Copy, then free, immediately | `js::bytes` — a view into wasm memory detaches when it grows |
| No shared handles across threads | Structural; a `Document` is not structured-cloneable |

Each has a case in `tests/failure-paths.test.ts`.

## Things that look like omissions but are not

- **There is no `Page` type.** The engine has no page handle; page-indexed calls take an index on
  the document. A `Page` façade would diverge from every other binding for no capability gain.
- **The boundary is immutable.** Every transform returns *new* bytes and leaves its input untouched;
  there is no mutating `doc.save()`. Tests assert by reopening the returned bytes.
- **Collections are plain arrays, not list handles.** The ABI's list-handle/borrowed-item model
  exists because C has neither a vector nor a lifetime. This is deviation 1 in `docs/naming.md` —
  the one structural divergence, and it is recorded there with its cost.
- **Enums cross as string unions, not numbers.** `Status` is the exception, because there the
  number is the contract.
- **No `FinalizationRegistry`.** It guarantees nothing about when or whether it runs, so offering
  one would imply a safety net that does not exist.
- **`getrandom` is a direct dependency that nothing here calls.** It is there for feature
  unification: without its `js` feature the engine's crypto stack refuses to compile for
  `wasm*-unknown-unknown` with a `compile_error!`.

## WebAssembly changes three things — read `docs/wasm-constraints.md`

1. **A panic is a trap, and a trap is fatal.** `catch_unwind` cannot work where there is no
   unwinding, so the engine's "panics never cross the boundary" contract does not hold. `Internal`
   never arrives from a panic here. `src/errors.ts` deliberately re-throws non-engine failures
   untouched so a trap is not dressed up as a status.
2. **There is no clock.** `SystemTime::now()` traps — measured, not inferred. The engine reads it on
   the signing, verification and revocation paths, so **the security area cannot be bound as-is**.
   Unblocking it is an engine change (inject the clock).
3. **Randomness must be asked for**, via `getrandom`'s `js` feature.

## Tests

Ported from the engine's journeys, against its shared `corpus/{valid,malformed,edge}` — located via
`PRISMPDF_CORPUS`, `corpus/`, or an engine checkout beside this repository. **Do not fork corpus
files into this repo**; the point of the shared corpus is that bindings cannot drift.

One semantic worth knowing: `openReport.mode === "recovered"` means *the cross-reference was
rebuilt*, not *the parser was lenient*. Two files in `malformed/` open `"strict"` for that reason,
so the parse journey asserts "opens or fails with `Parse`", never "recovered".

`vertical-slice`, `parse-journey`, `failure-paths`, `web-entry` and `entry-parity` run under
vitest; `tests/browser/` serves the built package over HTTP and drives it in real Chromium,
which is the only place `WebAssembly.instantiateStreaming` and the `application/wasm` content
type are exercised.

One gap is deliberate and documented: the wrong-password path has no fixture, because the corpus
ships no encrypted file and this cut cannot write one. It closes with the security area.

## Updating to a newer engine release

`ENGINE_TAG` is the single source of truth; `npm run check:tag` enforces the rest.

1. Edit `ENGINE_TAG`.
2. Update `tag = "…"` in `crates/prism-pdf-wasm/Cargo.toml`.
3. `cargo update -p prismpdf`.
4. `npm run check:tag`, then `npm run build && npm test`.
5. Note newly bound surface — and anything the engine changed under you — in `CHANGELOG.md`.

Because this binding compiles the engine, an incompatible facade change is a **compile error**, not
a runtime surprise. Read it as the diff of what the facade changed.
