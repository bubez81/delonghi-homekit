#!/bin/bash
# Installs delonghi2mqtt as a LaunchAgent for the current user and starts it.
# Usage: bash install.sh [path/to/config.json]
set -euo pipefail
NODE=${NODE:-/usr/local/bin/node}
REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
CONFIG="${1:-$HOME/.delonghi2mqtt/config.json}"
PLIST="$HOME/Library/LaunchAgents/com.delonghi2mqtt.plist"
LOG="$HOME/Library/Logs/delonghi2mqtt.log"

[ -f "$CONFIG" ] || { echo "config not found: $CONFIG"; exit 1; }
[ -f "$REPO/packages/delonghi2mqtt/dist/cli.js" ] || { echo "build first: npm run build"; exit 1; }

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.delonghi2mqtt</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE</string>
        <string>$REPO/packages/delonghi2mqtt/dist/cli.js</string>
        <string>-c</string>
        <string>$CONFIG</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
EOF
plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/com.delonghi2mqtt" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "started; logs: tail -f $LOG"
