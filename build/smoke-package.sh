#!/usr/bin/env bash
# Pack the tarball and prove a consumer can actually use it.
#
# `npm pack` proves nothing on its own. The failure this exists to catch is the one every wasm
# package hits at least once: a tarball that packs, installs, resolves — and throws on the first
# call, because the .wasm was not in `files`, or the exports map sent Node to the browser build,
# or a relative path that worked in the repository does not survive being moved into node_modules.
#
# Nothing here reaches into the source tree: the throwaway project imports the package by name.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"

[ -d pkg/node ] && [ -d dist ] || { echo "run 'npm run build' first" >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

tarball="$(cd "$work" && npm pack "$ROOT" --silent)"
echo "packed $tarball ($(du -h "$work/$tarball" | cut -f1))"

# Everything the package needs at run time must be inside the tarball. Checking the listing is
# cheaper than debugging a MODULE_NOT_FOUND from inside node_modules.
#
# The listing is taken once, into a file, rather than re-run per entry inside a pipe: under
# `pipefail`, `tar | grep -q` fails whenever the entry is *found*, because `grep -q` exits at the
# first match and `tar` then dies of SIGPIPE (141). That made this loop report the first required
# file as missing no matter what the tarball actually held.
tar tzf "$work/$tarball" > "$work/listing.txt"
for required in package/dist/index.node.js package/dist/index.web.js \
                package/pkg/node/prism_pdf.js package/pkg/node/prism_pdf_bg.wasm \
                package/pkg/web/prism_pdf_bg.wasm package/pkg/node/package.json; do
  grep -qx -- "$required" "$work/listing.txt" \
    || { echo "::error::$required is missing from the tarball"; exit 1; }
done
echo "tarball carries dist/, both wasm builds, and the commonjs marker"

cd "$work"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "./$tarball"

cat > smoke.mjs <<'JS'
import { readFileSync } from "node:fs";
// The default-import form deliberately: this is what the README leads with, and resolving it
// through the exports map from inside node_modules is the only place the `node` condition's
// export list is checked against a real consumer. It threw here once.
import init, { Document, PrismPdfError, Status, engineVersion } from "prism-pdf";
import * as pkg from "prism-pdf";

await init();

if (pkg.default !== pkg.init) throw new Error("default export is not `init`");

// A one-page PDF built by hand, so the smoke test needs no corpus.
const minimal = Buffer.from(
  "%PDF-1.4\n" +
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
  "trailer<</Root 1 0 R/Size 4>>\n", "latin1");

const doc = Document.open(new Uint8Array(minimal));
if (doc.pageCount !== 1) throw new Error(`expected 1 page, got ${doc.pageCount}`);
if (doc.save().length === 0) throw new Error("save() returned nothing");
doc.close();

// The error path has to work from inside node_modules too.
try {
  Document.open(new Uint8Array([1, 2, 3]));
  throw new Error("expected a PrismPdfError");
} catch (e) {
  if (!(e instanceof PrismPdfError) || e.status !== Status.Parse) throw e;
}

console.log(`ok — engine ${engineVersion()}, installed from the tarball`);
JS

node smoke.mjs
