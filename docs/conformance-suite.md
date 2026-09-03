# The conformance suite

## What it is

A binding's test suite is a **port of the engine's journeys**, against the **same inputs**,
asserting the **same facts**. That is what "the binding works" means, and it is also how the
binding tests the engine from a real consumer's seat.

```bash
npm run corpus     # fetch and verify the shared corpus for the pinned tag
npm test           # the ported journeys, on Node
npm run test:browser   # the vertical slice, in headless Chromium
```

## The corpus is not forked into this repository

The engine publishes `corpus/{valid,malformed,edge}` once per tag. Copying those files here would
let them drift, and the drift would look like a passing suite — every binding would be asserting
against its own slightly different inputs while appearing to agree.

`build/fetch-corpus.sh` downloads the archive for `ENGINE_TAG`, checks its published SHA-256, and
unpacks it into a gitignored `corpus/`. `tests/corpus.ts` also finds it via `PRISMPDF_CORPUS`, or in
an engine checkout beside this repository — useful when working on both at once.

**A suite that cannot find the corpus skips, with a message.** That is the right courtesy for a
contributor who has not fetched it: everything that does not need it still runs green. CI treats any
skip as a failure, because there a green leg that tested nothing looks identical to one that tested
everything.

## The journeys

| File | Journey |
|---|---|
| `tests/vertical-slice.test.ts` | The eight-call slice the guide requires of every new binding, in its order. |
| `tests/parse-journey.test.ts` | Every corpus file opened; page counts, versions, text; collections; metadata; all three save modes. |
| `tests/failure-paths.test.ts` | The semantic contracts: one error type, absence vs. index, disposal, argument handling. |
| `tests/web-entry.test.ts` | The browser entry point's loader, driven from Node with the bytes in hand. |
| `tests/entry-parity.test.ts` | The two entry points' export lists, which have to match for one source file to run in both. |
| `tests/browser/` | The slice inside real Chromium, served over HTTP. |

Not yet ported, because the areas are not bound: create, manipulate, compose, security, and the
invoice acceptance test (`compose_invoice.c`), which is the anchor every binding builds and
reopens.

## One semantic worth knowing before writing assertions

`openReport.mode === "recovered"` means **the cross-reference data was rebuilt**, not that the
parser was lenient. Two files in `corpus/malformed/` open in `"strict"` mode for exactly that
reason: their xref parses cleanly and they are malformed in some other way.

So `parse-journey.test.ts` asserts that a malformed file either opens *or* fails with `Parse`, and
that its mode is one of the two — not that it recovered. An assertion that every malformed file
reports `"recovered"` would be wrong about the engine, and would fail for the right file for the
wrong reason.

## The one deliberate gap

`docs/BINDINGS.md` requires the wrong-password failure path, and it is **not covered**: the shared
corpus ships no encrypted fixture, and this cut binds the read path only, so the suite cannot write
one either. It is marked skipped in `failure-paths.test.ts` with that explanation rather than left
silent, and it closes when the security area lands and `saveEncrypted` can produce the fixture
in-process — which is how the .NET binding covers it.

## Running against a local engine

```bash
build/build-wasm.sh --core ../prism-pdf && npm run build:ts && npm test
```

Because this binding compiles the engine rather than loading a prebuilt library, the suite is also
a usable check on an engine change: a facade change that breaks a consumer breaks the build here
before it breaks anyone's runtime.
