#!/usr/bin/env bash
# Get a fresh container to a state where `npm test` is meaningful.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "--- npm dependencies ---"
npm ci

# The engine's shared corpus. Without it most of the suite skips rather than fails, which is
# correct but not much of a welcome.
echo "--- shared conformance corpus ---"
npm run corpus || echo "corpus fetch failed — run 'npm run corpus' once you have network access"

# Warm the Rust build so the first `npm run build` is not a cold compile of the whole engine.
echo "--- prebuilding the shim (this is the slow one, once) ---"
cargo build --release --target wasm32-unknown-unknown || true

cat <<'MSG'

Ready. Try:

  npm run build         # cargo + wasm-bindgen + wasm-opt, then tsc
  npm test              # the ported conformance journeys
  npm run test:browser  # the vertical slice in headless Chromium (needs: npx playwright install chromium)

Docs: README.md, then docs/architecture.md and docs/wasm-constraints.md.
MSG
