#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
npm run check --prefix ui
npm test --prefix ui
npm run build --prefix ui
python3 -m py_compile remctl_plugin.py remctl_workspace.py remctl_events.py remctl_mcp.py
swiftc capture-bar/CodexTaskCtlCaptureBar.swift -o /tmp/CodexTaskCtlCaptureBar -framework AppKit -framework Carbon
/tmp/CodexTaskCtlCaptureBar --self-test
mkdir -p dist
git archive --format=tar.gz --prefix=CodexTaskCtl-quick-capture/ HEAD > dist/CodexTaskCtl-quick-capture.tar.gz
echo "Created $ROOT/dist/CodexTaskCtl-quick-capture.tar.gz"
