#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

BASELINE=$(tr -d '[:space:]' < "$ROOT/test/legacy-baseline.txt")
git -C "$ROOT" cat-file -e "$BASELINE^{commit}"
mkdir "$TMP/legacy"
git -C "$ROOT" archive "$BASELINE" | tar -x -C "$TMP/legacy"
cp "$ROOT/test/smoke.sh" "$ROOT/test/surface.js" "$TMP/legacy/test/"

CHATTER_ENTRY="$TMP/legacy/bin/chatter.js" CHATTER_MODULE_ROOT="$TMP/legacy/src" \
  CHATTER_SOURCE_ROOT="$TMP/legacy" CHATTER_SOURCE_EXT=js \
  sh "$TMP/legacy/test/smoke.sh" >"$TMP/legacy.out"
CHATTER_ENTRY="$ROOT/dist/bin/chatter.js" CHATTER_MODULE_ROOT="$ROOT/dist/src" \
  sh "$ROOT/test/smoke.sh" >"$TMP/dist.out"

if ! diff -u "$TMP/legacy.out" "$TMP/dist.out"; then
  echo "legacy and compiled behavior differ" >&2
  exit 1
fi

echo "legacy and compiled smoke behavior match"
