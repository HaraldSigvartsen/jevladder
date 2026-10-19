#!/bin/sh
if ! command -v node >/dev/null 2>&1; then
  exit 0
fi
DIR=$(dirname "$0")
exec node "$DIR/tierclef-observe.mjs"
