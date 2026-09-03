# What WebAssembly changes

Three properties the engine guarantees on a native target do not survive the trip to
`wasm32-unknown-unknown`. None of them is a bug in the engine or in this binding — they are
properties of the target — but a consumer who assumes the native contract will be wrong, so they
are written down here rather than discovered.

Everything on this page was measured against the pinned engine tag, not inferred.

## 1. A panic is a trap, and a trap is fatal

The engine's C ABI wraps every entry point in `catch_unwind` and reports a caught panic as
`PrismPdfStatus_Internal`, so "panics never cross the boundary" (`DESIGN.md` §6.1). Its release
profile deliberately keeps `panic = "unwind"` for exactly this reason, and
`docs/native-artifacts.md` warns that setting `panic = "abort"` "would turn that contained error
into a host-process abort".

`wasm32-unknown-unknown` has no unwinding to keep. `rustc` lowers a panic to an `unreachable`
instruction, so:

- `catch_unwind` does not catch. It is not that this binding declines to call it — it cannot work.
- A panic traps the instance. Every handle in that module's linear memory is gone, and every
  subsequent call throws `RuntimeError: unreachable`.
- `Status.Internal` therefore never arrives from a panic here. It is reachable only from the
  handful of errors the engine reports as internal in the ordinary way.

**What this binding does about it.** `src/errors.ts` re-throws anything that is not a structured
engine failure untouched, so a trap surfaces as the `RuntimeError` it is rather than being dressed
up as a status a caller might handle as though the document were merely malformed.

**What a consumer should do about it.** Treat a `RuntimeError` from this package as fatal to the
module, not to the document: create a fresh instance before continuing. In a browser that means a
new worker; on Node, a new `import()` of a fresh module instance. If you are running untrusted
files at scale, a worker per batch is the shape that survives this.

The engine's own defence still applies and is the reason this is a footnote rather than a
headline: its parser is written to have no panicking paths on untrusted input, `unwrap_used` and
`expect_used` are denied in its core crates, and it is continuously fuzzed. This crate denies the
same two lints for the same reason.

## 2. There is no clock

`SystemTime::now()` traps on this target. Measured, not assumed:

```
clockProbe() => THREW: unreachable
```

The engine reads the clock in three places, all on the signing and verification paths
(`pdf-document/src/signing.rs`, `pdf-crypto/src/sign/verification.rs` and its revocation checks).
Each is written as `SystemTime::now().duration_since(UNIX_EPOCH).map(…).unwrap_or(0)` — defensive
about a *failing* clock, but the trap happens inside `now()`, before the `unwrap_or(0)` can help.

**Consequence.** The signing and verification area cannot be bound as-is. It is not that a
signature would be wrong; the call would take the module down. This cut binds the read path, so
nothing here reaches those lines — but it is the reason the security area is not simply "next".

**What unblocks it**, in increasing order of cost:

1. An engine change to let a caller inject the time. `SignSettings::set_signing_time` already pins
   the signing clock, so the shape exists; verification and revocation would need the same.
2. Building for `wasm32-wasip1` instead, which does provide a clock — a good fit for server-side
   runtimes and no help at all in a browser.
3. Patching `SystemTime` at the wasm boundary, which is possible and is not worth it: it would
   make the engine's behaviour depend on a shim this repository maintains.

This belongs in an issue against the engine rather than a workaround here — the same rule
`docs/native-artifacts.md` applies to unsupported targets.

## 3. Randomness has to be asked for

`getrandom` refuses to compile for `wasm*-unknown-unknown` unless its `js` feature is on, and it
is a hard `compile_error!`, not a runtime surprise:

```
error: the wasm*-unknown-unknown targets are not supported by default,
       you may need to enable the "js" feature.
```

The engine's crypto stack depends on it transitively, so a plain
`cargo build -p prismpdf --target wasm32-unknown-unknown` fails outright. `getrandom` is therefore
a direct dependency of `crates/prism-pdf-wasm` even though no line of this crate calls it: Cargo
features are additive across the dependency graph, so enabling it here enables it beneath us.

With the feature on, randomness comes from `crypto.getRandomValues`, which is present in every
browser and in Node 18+. Where it is absent the engine refuses to encrypt rather than proceeding
under predictable material — that arrives as `Status.Internal`, and this binding maps
`DocError::RandomUnavailable` to it deliberately, because it describes the environment and not the
document.

## What does not change

Worth stating, because it is most of the engine:

- **Parsing, recovery and text extraction** behave identically. The conformance suite runs the same
  journeys against the same corpus and asserts the same facts as every other binding.
- **The engine touches no filesystem.** Every `std::fs` call in the engine's shipping crates is
  inside `#[cfg(test)]`, so there is nothing to stub.
- **Overflow checks stay on** in the release profile, for the reason the engine gives: in a parser
  of hostile input a wrapped offset is a logic error that safe Rust will not otherwise catch.
- **Memory is bounded the same way.** The anti-DoS limits are the same knobs; `maxDecodedStream` is
  the decompression-bomb guard, and a browser tab is precisely where you want it set.

## Sizes, measured

Built with `opt-level = "s"`, fat LTO, one codegen unit, and `wasm-opt -O`:

| | raw | gzipped |
|---|---:|---:|
| `pkg/web/prism_pdf_bg.wasm` | 840 KB | 298 KB |
| `pkg/node/prism_pdf_bg.wasm` | 840 KB | 298 KB |
| the whole npm tarball | 628 KB | — |

That covers the read and parse surface this cut binds. The figure will grow as authoring, layout
and composition are bound — wasm-opt dead-strips what nothing reaches, so the cost is paid per area
actually exported, not per area the engine contains.
