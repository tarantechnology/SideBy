#!/usr/bin/env bash
# Launches Google Chrome with a dedicated Sideby profile and a DevTools port
# so the extension can be exercised on a real, logged-in Netflix session.
#
# One-time setup in the window that opens:
#   1. Sign in to Netflix.
#   2. chrome://extensions → Developer mode → Load unpacked → packages/extension/dist
# Both persist in the profile; later launches need neither.
set -euo pipefail
PROFILE="${SIDEBY_CHROME_PROFILE:-$HOME/.sideby-chrome}"
PORT="${SIDEBY_CDP_PORT:-9222}"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mkdir -p "$PROFILE"
exec "$CHROME" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --no-first-run --no-default-browser-check \
  --disable-features=TranslateUI \
  --window-size=1400,900 \
  "${1:-chrome://extensions}"
