#!/usr/bin/env bash
# Three consecutive projections. A card that is only correct on a clean board is not a projection.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
N="${1:-3}"
for i in $(seq 1 "$N"); do
  echo "═══ board projection $i/$N"
  node "$HERE/board-projection.mjs"
done
echo
echo "${N}x CONSECUTIVE GREEN (board projection)"
