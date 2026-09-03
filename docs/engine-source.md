# Where the engine comes from

## The short version

`ENGINE_TAG` names one engine release. Everything else that mentions it is checked against it by
`build/check-tag.sh`, which runs first in CI.

```
ENGINE_TAG                             v1.0.0-alpha.1
crates/prism-pdf-wasm/Cargo.toml       tag = "v1.0.0-alpha.1"
Cargo.lock                             the commit that tag resolved to
```

## Why this binding compiles the engine, when no other one does

`docs/native-artifacts.md` in the engine repository is emphatic that a binding should not
cross-compile Rust:

> Building that ABI from source is fine for developing a binding and wrong for shipping one: a
> NuGet, wheel or npm package has to carry a prebuilt library for every platform it claims to
> support, and no binding repository should be in the business of cross-compiling Rust for sixteen
> targets.

The engine therefore publishes, per tag, thirteen native shared libraries and an XCFramework. **Not
one of them can be loaded by a WebAssembly runtime.** There is no `wasm32-unknown-unknown` artifact
to download, so this binding has no choice but to build one.

The reasoning behind that rule also mostly evaporates here. The rule exists because sixteen targets
each need settings a binding cannot fix afterwards — a static CRT on Windows, a glibc floor, a
separate musl build, a macOS deployment target and code signature. This binding builds **one**
target. There is no floor to hold, no libc to choose, nothing to sign, and no RID matrix. A
two-minute cached `cargo build` in CI is the whole cost.

What is genuinely lost is the append-only ABI guarantee. A C-ABI binding vendors a header and keeps
working against a newer library; this one compiles against the facade's Rust API, so an engine
upgrade is a recompile that can fail. It fails at build time, loudly, which is the good failure
mode — but it is why the tag is pinned in one place and enforced.

**If the engine ever publishes a wasm artifact, this should switch to consuming it.** That would be
the better arrangement — one pipeline serving every binding, as `native-artifacts.md` intends — and
the request belongs in an issue against the engine repository rather than a workaround here.

## Updating to a newer engine release

1. Edit `ENGINE_TAG`.
2. Update `tag = "…"` in `crates/prism-pdf-wasm/Cargo.toml`.
3. `cargo update -p prismpdf` to re-resolve `Cargo.lock` against the new tag.
4. `npm run check:tag` — this should now pass; it is what CI runs.
5. `npm run build && npm test`. Because this binding compiles the engine rather than loading it,
   an incompatible change is a **compile error**, not a runtime surprise. Read it as the diff of
   what the facade changed.
6. Note anything newly bound, and anything the engine changed under you, in `CHANGELOG.md`.

The engine's `CHANGELOG.md` records ABI additions per release, and its `docs/ABI.md` lists what has
not yet crossed the boundary at all.

## Working against a local engine checkout

For engine work, patch in a checkout instead of the tag. The checkout can live anywhere:

```bash
build/build-wasm.sh --core ../prism-pdf
```

That writes a `[patch]` into `.cargo/config.toml`, which is gitignored — so a local working tree can
never be committed as the dependency. Drop the flag (or delete the file) to go back to the pinned
tag:

```bash
build/build-wasm.sh
```

## The corpus is pinned separately

`build/fetch-corpus.sh` downloads `prism-pdf-corpus-<tag>.tar.gz` from the same release and
verifies its published SHA-256 before unpacking. The corpus changes far less often than the engine,
which is why the engine ships it as its own artifact — and why it is fetched rather than forked
into this repository. See [conformance-suite.md](conformance-suite.md).
