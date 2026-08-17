#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
trap 'find "$TMP" -depth -delete' EXIT INT TERM

BASELINE=$(tr -d '[:space:]' < "$ROOT/test/legacy-baseline.txt")
git -C "$ROOT" cat-file -e "$BASELINE^{commit}"
mkdir "$TMP/legacy" "$TMP/repo"
git -C "$ROOT" archive "$BASELINE" | tar -x -C "$TMP/legacy"
git -C "$TMP/repo" init -q
git -C "$TMP/repo" -c user.email=test@example.com -c user.name=test commit --allow-empty -q -m init

DIFF_ROOT="$TMP" DIFF_REPO="$TMP/repo" \
  LEGACY_ENTRY="$TMP/legacy/bin/chatter.js" CURRENT_ENTRY="$ROOT/dist/bin/chatter.js" \
  node --no-warnings --experimental-sqlite "$ROOT/test/differential.js"
