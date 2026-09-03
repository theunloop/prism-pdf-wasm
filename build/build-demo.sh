#!/usr/bin/env bash
# Assemble the static demo site into _site/.
#
# The layout is not arbitrary: `dist/index.web.js` imports `../pkg/web/prism_pdf.js`, so the two
# directories have to keep their relative positions or the glue cannot find the .wasm. Everything
# here is copied verbatim — there is no bundler, because the thing being demonstrated is the
# package as published, and a bundler would be demonstrating its own wasm handling instead.
#
# There are two exceptions. `vendor/pdfjs/` is not this package and is not pretending to be: the
# engine has no rasterizer, so every picture of a page — the preview and the thumbnails — is drawn
# by Mozilla's pdf.js. It is vendored rather than pulled from a CDN so that the page still makes no
# third-party request, and it lives under `vendor/` so that nobody has to guess which bytes are
# whose. And `sample/` is a PDF this script writes, so the page has a document to open on a first
# visit. See demo/README.md.
set -euo pipefail

cd "$(dirname "$0")/.."

[ -f dist/index.web.js ] || { echo "dist/ is missing — run 'npm run build' first" >&2; exit 1; }
[ -f pkg/web/prism_pdf_bg.wasm ] || { echo "pkg/web/ is missing — run 'npm run build' first" >&2; exit 1; }
[ -d node_modules/pdfjs-dist ] || { echo "node_modules/pdfjs-dist is missing — run 'npm ci' first" >&2; exit 1; }

rm -rf _site
mkdir -p _site/dist _site/pkg/web _site/vendor/pdfjs _site/sample

cp demo/index.html demo/app.js demo/styles.css _site/

# The sample document, written from nothing rather than copied from anywhere. It is what the page
# offers a visitor who has not brought a PDF of their own, and it is generated here so that it
# cannot drift from the panels that read it. See build/make-sample.mjs.
node build/make-sample.mjs _site/sample/prism-sample.pdf

# Everything but the Node entry point, which would 404 looking for pkg/node and which nothing on
# this page imports.
for f in dist/*; do
  case "$(basename "$f")" in index.node.*) continue ;; esac
  cp "$f" _site/dist/
done

cp pkg/web/prism_pdf.js pkg/web/prism_pdf_bg.wasm pkg/web/prism_pdf.d.ts _site/pkg/web/

# --- pdf.js, for the preview tab only ---------------------------------------------------------
#
# Renamed .mjs -> .js on the way in. Both files are ES modules either way — the extension only
# decides what content type a static host serves them as, and `.js` is the one every host on earth
# already maps to JavaScript. That removes a failure mode the demo cannot test for locally.
#
# The minified builds: the sourcemapped ones are 12M of the 12.5M in build/, and nobody is
# stepping through pdf.js from this page.
PDFJS=node_modules/pdfjs-dist
cp "$PDFJS/build/pdf.min.mjs"        _site/vendor/pdfjs/pdf.min.js
cp "$PDFJS/build/pdf.worker.min.mjs" _site/vendor/pdfjs/pdf.worker.min.js
cp "$PDFJS/LICENSE"                  _site/vendor/pdfjs/LICENSE

# Fetched lazily by pdf.js, per document, and only when a document needs them: CMaps for CJK
# encodings, the Standard 14 font programs for files that do not embed their fonts, the wasm
# decoders for JPEG 2000 and JBIG2, and the ICC profile. Shipping them is what keeps the preview
# working offline instead of silently degrading on exactly the files that are hardest to render.
cp -r "$PDFJS/cmaps"          _site/vendor/pdfjs/cmaps
cp -r "$PDFJS/standard_fonts" _site/vendor/pdfjs/standard_fonts
cp -r "$PDFJS/iccs"           _site/vendor/pdfjs/iccs
mkdir -p _site/vendor/pdfjs/wasm
# quickjs-eval is for PDFs that carry JavaScript; the preview never enables scripting, so it is
# left behind rather than shipped as 900K of dead weight.
for f in "$PDFJS"/wasm/*; do
  case "$(basename "$f")" in quickjs-eval.*) continue ;; esac
  cp "$f" _site/vendor/pdfjs/wasm/
done

# GitHub Pages runs Jekyll by default, which skips files and directories beginning with an
# underscore. Nothing here starts with one today, but the marker costs nothing and removes a
# whole class of "works locally, 404s on Pages".
touch _site/.nojekyll

printf 'demo assembled in _site/ (%s, of which %s is vendored pdf.js)\n' \
  "$(du -sh _site | cut -f1)" "$(du -sh _site/vendor/pdfjs | cut -f1)"
