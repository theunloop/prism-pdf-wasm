#!/usr/bin/env bash
# Download the engine's shared conformance corpus for the pinned tag.
#
# The corpus is deliberately NOT forked into this repository. The whole point of it being one set
# of files, published once per engine tag, is that every binding asserts against the same inputs —
# a copy here would drift, and the drift would look like a passing test suite.
set -euo pipefail

cd "$(dirname "$0")/.."
TAG="$(cat ENGINE_TAG)"
DEST="corpus"
BASE="https://github.com/theunloop/prism-pdf/releases/download/${TAG}"

command -v curl >/dev/null || { echo "curl not found" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "fetching corpus for ${TAG}"
curl -fsSL -o "$tmp/corpus.tar.gz" "${BASE}/prism-pdf-corpus-${TAG}.tar.gz"
curl -fsSL -o "$tmp/SHA256SUMS.txt" "${BASE}/SHA256SUMS-${TAG}.txt"

# Verify before unpacking, not after. The checksum file covers every asset in the release, so grep
# out the one line that names this archive rather than failing on the ones that were not downloaded.
sha_tool="$(command -v sha256sum || command -v shasum)"
expected="$(grep "prism-pdf-corpus-${TAG}.tar.gz" "$tmp/SHA256SUMS.txt" | awk '{print $1}')"
[ -n "$expected" ] || { echo "no checksum for prism-pdf-corpus-${TAG}.tar.gz in the release" >&2; exit 1; }
case "$sha_tool" in
  *shasum) actual="$("$sha_tool" -a 256 "$tmp/corpus.tar.gz" | awk '{print $1}')" ;;
  *)       actual="$("$sha_tool" "$tmp/corpus.tar.gz" | awk '{print $1}')" ;;
esac
[ "$expected" = "$actual" ] || { echo "checksum mismatch: expected $expected, got $actual" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"
tar xzf "$tmp/corpus.tar.gz" -C "$DEST" --strip-components=1
echo "corpus -> $DEST/ ($(find "$DEST" -name '*.pdf' | wc -l | tr -d ' ') files, verified)"
