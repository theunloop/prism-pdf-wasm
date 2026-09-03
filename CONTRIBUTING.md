# Contributing

## What this repository is

The WebAssembly binding for [Prism PDF](https://github.com/theunloop/prism-pdf). It is a binding,
not a reimplementation: every capability comes from the Rust engine. Read
[`docs/architecture.md`](docs/architecture.md) before changing anything structural, and
[`docs/wasm-constraints.md`](docs/wasm-constraints.md) before binding a new area — it is short, and
it is where the surprises are.

The engine's own docs are the authority and win when they disagree with this repository's:
`docs/BINDINGS.md` (naming rules, the six semantic contracts, the conformance journeys),
`docs/ABI.md` and `DESIGN.md`.

## Setup

You need Node 18+, a Rust toolchain with the `wasm32-unknown-unknown` target, and `wasm-pack`.
[`.devcontainer/`](.devcontainer) has all three configured — open the repository in a container and
skip this section.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
npm ci
npm run corpus     # the engine's shared conformance corpus, checksum-verified
npm run build
npm test
```

Without `npm run corpus` the package still builds and the suites that need no fixtures still run;
the rest **skip with a message**. That is intended. CI fails on any skip.

## The loop

```bash
npm run build:wasm    # only when Rust changed — it is the slow half
npm run build:ts      # TypeScript only
npm test              # or: npm run test:watch
```

Most changes are TypeScript, which is deliberate: the Rust side is the expensive one to iterate on,
so ergonomics live in the layer that rebuilds in a second.

Working on the engine at the same time:

```bash
build/build-wasm.sh --core ../prism-pdf
```

That patches in a local checkout via a gitignored `.cargo/config.toml`, so a working tree can never
be committed as the dependency. Drop the flag to go back to the pinned tag.

## Binding a new area

The order is the guide's, and it is not arbitrary — each area's conventions are settled by the one
before it: parse → create/manipulate → compose → security.

1. **Read the engine's export first.** `docs/ABI.md` and the facade's own doc comments carry the
   ownership contract. In particular, consuming calls come in three shapes — *consumes on success*,
   *consumes always*, *finalises* — and the shape is stated per export. Do not infer it from the
   name.
2. **Check it against [`docs/wasm-constraints.md`](docs/wasm-constraints.md).** Does it read the
   clock? Can it panic? A panic is a fatal trap here, not a caught status.
3. **Add the raw export** to `crates/prism-pdf-wasm/`. Keep it mechanical: lifetime and status
   mapping, nothing else.
4. **Add the idiomatic layer** in `src/`, applying the ten naming rules. If you have to deviate,
   record it in [`docs/naming.md`](docs/naming.md) **in the same commit** — that file is only
   useful if it is complete.
5. **Port the journey**, against the shared corpus. Same inputs, same assertions as the other
   bindings.
6. **Update `CHANGELOG.md`**, including anything you could not bind and why.

## House rules

- **`ENGINE_TAG` is the single source of truth** for the engine release. `npm run check:tag`
  enforces that every other mention agrees, and runs first in CI.
- **Do not fork corpus files into this repository.** The point of a shared corpus is that bindings
  cannot drift. See [`docs/conformance-suite.md`](docs/conformance-suite.md).
- **Do not commit `pkg/` or `dist/`.** They are build output and ship from CI.
- **No `unwrap()` or `expect()` in the shim.** Both are denied at the crate level, for the reason
  the engine denies them: this code runs on hostile input, and here a panic is a trap.
- **A skipped test needs a reason.** `it.skipIf(...)(SKIP_REASON, ...)` prints one. A silent skip is
  how a suite stops testing anything without anyone noticing.
- Run `cargo fmt` and `npm run typecheck` before pushing; CI runs both plus clippy with warnings
  denied.

## Reporting

An engine bug — a PDF that crashes, hangs, or is parsed wrongly — belongs in the
[engine repository](https://github.com/theunloop/prism-pdf/issues), not here. A binding bug is one
where the engine is right and this package presents it wrongly: a bad type, a leak, a status
mapped to the wrong error, an API that diverges from the guide.

Security reports: [`SECURITY.md`](SECURITY.md).
