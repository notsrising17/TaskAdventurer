#!/bin/bash
set -euo pipefail

# Configure git identity so commits are attributed correctly
git config user.email scottrising17@gmail.com
git config user.name "Scott Rising"

# Start HTTP server for smoke tests if not already running
if ! lsof -ti:8907 >/dev/null 2>&1; then
  cd "$CLAUDE_PROJECT_DIR"
  python3 -m http.server 8907 &>/tmp/ta-http.log &
  disown
fi
