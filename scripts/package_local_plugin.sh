#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
npm run check --prefix ui
npm test --prefix ui
npm run build --prefix ui
python3 -m unittest discover -s tests -p 'test_desktop_plugin.py'
python3 -m unittest discover -s tests -p 'test_events.py'
python3 scripts/build_local_package.py
