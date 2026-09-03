# Security

## Reporting a vulnerability

Do not open a public issue.

- **In the engine** — a PDF that makes Prism PDF crash, hang, or exhaust memory is an *engine*
  report, and belongs in
  [theunloop/prism-pdf](https://github.com/theunloop/prism-pdf/security/advisories/new). That is
  where the parser lives and where a fix has to land for every binding at once.
- **In this binding** — a memory-safety or correctness problem in the wasm shim or the TypeScript
  layer: use this repository's
  [Security Advisories](https://github.com/theunloop/prism-pdf-wasm/security/advisories/new).

If you are unsure, report against the engine. It is the easier direction to redirect from.

## The threat model

This package is built to be handed **untrusted PDFs**, because that is what a browser upload is.
Two things follow.

### Set limits on untrusted input

Anti-DoS bounds are opt-in, not default-on, because the engine's defaults are sized for a server
rather than a tab:

```ts
using doc = Document.open(bytes, {
  limits: {
    maxDecodedStream: 64 * 1024 * 1024,   // the decompression-bomb guard
    maxObjects: 500_000,
    maxDepth: 64,
  },
});
```

A file that exceeds a limit fails with `Status.Parse` rather than exhausting the page.

### Use a worker

A wasm trap is fatal to the module instance, not to the call — every handle in that instance goes
with it. Running untrusted files in a worker, one instance per batch, bounds the damage and keeps
the main thread responsive. See [`docs/wasm-constraints.md`](docs/wasm-constraints.md).

## What the sandbox does and does not give you

WebAssembly is memory-safe with respect to the host: a bug in the engine cannot read your page's
JavaScript heap or escape the instance. It does **not** protect against denial of service inside
the instance, which is what the limits above are for.

The engine itself is written for hostile input: no panicking paths on untrusted data,
`unwrap_used` and `expect_used` denied in its core crates, and continuous fuzzing. This crate
denies the same two lints.

## Supply chain

- The engine is pinned to one release in `ENGINE_TAG`, and `Cargo.lock` records the exact commit
  that tag resolved to. `build/check-tag.sh` fails the build if any mention of it drifts.
- The shared corpus is downloaded with its published SHA-256 verified before it is unpacked.
- **Nothing is fetched at run time.** Both wasm builds ship inside the npm tarball. A package that
  downloads its own executable code on first use breaks air-gapped consumers and is a liability.
- Releases are published with npm provenance, so the tarball can be traced to the workflow run and
  commit that built it.
