#!/bin/sh
# Automation-only instance and profile. Never opens the personal Chrome profile.
# Use Chromium's test keychain rather than triggering macOS Keychain dialogs.
browser="$HOME/.pi/browser-use/browser/current/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
if [ ! -x "$browser" ]; then
  printf 'Browser Use binary is missing: %s\n' "$browser" >&2
  exit 1
fi
exec "$browser" --use-mock-keychain --password-store=basic "$@"
