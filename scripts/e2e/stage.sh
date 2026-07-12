#!/usr/bin/env bash
# Stage the plugin into a soksak home (idempotent, no symlinks).
#
# This plugin is two halves: the JS entry (plugin.json + main.js, loaded from the plugins dir) and
# the service sidecar, which the core resolves at <home>/sidecars/soksak-sidecar-workflow/dist/.
# Both must land, or the eight service commands answer nothing.
#
# The binary is replaced by rename — an in-place copy over a running binary is a torn file, and a
# service that half-starts is worse than one that does not start at all.
#
# Usage: stage.sh <home>   e.g. stage.sh "$HOME/.soksak-debug"
set -euo pipefail
HOME_DIR="${1:?home dir required (e.g. \$HOME/.soksak-debug)}"
SRC="$(cd "$(dirname "$0")/../.." && pwd)"

DEST="$HOME_DIR/plugins/soksak-plugin-workflow"
mkdir -p "$DEST"
for f in plugin.json main.js package.json; do
  cp "$SRC/$f" "$DEST/$f"
done
for f in README.md README.ko.md; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$DEST/$f"
done
[ -d "$SRC/workflows" ] && { mkdir -p "$DEST/workflows"; cp "$SRC/workflows/"*.json "$DEST/workflows/" 2>/dev/null || true; }
cat > "$DEST/.soksak.json" <<'JSON'
{ "version": "dev", "repo": "https://github.com/soksak-ai/soksak-plugin-workflow.git", "branch": "main" }
JSON
echo "staged plugin → $DEST"

BIN="$SRC/target/release/soksak-sidecar-workflow"
if [ -f "$BIN" ]; then
  SIDE="$HOME_DIR/sidecars/soksak-sidecar-workflow/dist"
  mkdir -p "$SIDE"
  cp "$BIN" "$SIDE/.soksak-sidecar-workflow.staging"
  mv -f "$SIDE/.soksak-sidecar-workflow.staging" "$SIDE/soksak-sidecar-workflow"
  echo "staged sidecar → $SIDE/soksak-sidecar-workflow"
else
  echo "sidecar binary not built ($BIN) — build it or the service commands will not answer" >&2
  exit 1
fi
