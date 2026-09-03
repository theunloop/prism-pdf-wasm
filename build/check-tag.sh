#!/usr/bin/env bash
# ENGINE_TAG is the single source of truth for the engine release this binding is pinned to.
# Three other places name it; this fails the build when any of them drifts.
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="$(cat ENGINE_TAG)"
fail=0
note() { echo "::error::$1"; fail=1; }

grep -q "tag = \"${TAG}\"" crates/prism-pdf-wasm/Cargo.toml \
  || note "crates/prism-pdf-wasm/Cargo.toml does not pin ${TAG}"

# Cargo.lock records the commit the tag resolved to, which is what actually gets built.
grep -q "prism-pdf?tag=${TAG}" Cargo.lock 2>/dev/null \
  || note "Cargo.lock was not resolved against ${TAG} — run cargo update -p prismpdf"

grep -q "${TAG}" docs/engine-source.md \
  || note "docs/engine-source.md does not mention ${TAG}"

[ "$fail" -eq 0 ] && echo "engine tag ${TAG} is consistent across Cargo.toml, Cargo.lock and docs."
exit "$fail"
