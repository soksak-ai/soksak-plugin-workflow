#!/usr/bin/env bash
# Three consecutive full-loop runs against the same live app, each spawning real agents.
# A cold-only pass is not idempotency: the run that matters starts in the state the last one left.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
N="${1:-3}"
for i in $(seq 1 "$N"); do
  echo "═══ full loop $i/$N"
  node "$HERE/loop-full.mjs"
done
echo
echo "${N}x CONSECUTIVE GREEN (full loop)"
