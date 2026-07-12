#!/usr/bin/env bash
# Three consecutive runs against the same live app. A cold-only pass is not idempotency: the run
# that matters is the one that starts in the state the previous run left behind.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
for i in 1 2 3; do
  echo "═══ run $i/3"
  node "$HERE/loop.mjs"
done
echo
echo "3x CONSECUTIVE GREEN"
