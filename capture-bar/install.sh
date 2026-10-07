#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
APP="$HOME/Applications/CodexTaskCtl Capture.app"
BIN="$APP/Contents/MacOS/CodexTaskCtl Capture"
PLIST="$HOME/Library/LaunchAgents/com.maricoxu.codextaskctl.capture-bar.plist"
mkdir -p "$APP/Contents/MacOS" "$HOME/Library/LaunchAgents"
swiftc "$ROOT/capture-bar/CodexTaskCtlCaptureBar.swift" -o "$BIN" -framework AppKit -framework Carbon
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.maricoxu.codextaskctl.capture-bar</string><key>CFBundleName</key><string>CodexTaskCtl Capture</string><key>CFBundleExecutable</key><string>CodexTaskCtl Capture</string><key>LSUIElement</key><true/></dict></plist>
EOF
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.maricoxu.codextaskctl.capture-bar</string><key>ProgramArguments</key><array><string>$BIN</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>
EOF
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed: $APP"
echo "Shortcut: configurable from the Capture Bar menu (default Cmd+Shift+Space)"
