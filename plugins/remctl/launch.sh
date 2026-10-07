#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOST="$HOME/Applications/RemCTL Capability Host.app/Contents/Resources"
if [ ! -f "$HOST/remctl-capability-python-path" ]; then
  echo "Install RemCTL Capability Host before starting CodexTaskCtl." >&2
  exit 1
fi
PYTHON=$(cat "$HOST/remctl-capability-python-path")
[ -x "$PYTHON" ] || { echo "RemCTL's protected Python is unavailable." >&2; exit 1; }
export REMCTL_PLUGIN=1
exec "$PYTHON" -E -s -B "$HERE/runtime/start_plugin.py"
