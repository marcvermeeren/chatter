#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

sh "$ROOT/test/smoke.sh" >"$TMP/legacy.out"
CHATTER_ENTRY="$ROOT/dist/bin/chatter.js" CHATTER_MODULE_ROOT="$ROOT/dist/src" \
  sh "$ROOT/test/smoke.sh" >"$TMP/dist.out"

if ! diff -u "$TMP/legacy.out" "$TMP/dist.out"; then
  echo "legacy and compiled behavior differ" >&2
  exit 1
fi

echo "legacy and compiled smoke behavior match"
