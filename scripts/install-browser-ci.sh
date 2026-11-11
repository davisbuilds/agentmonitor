#!/usr/bin/env bash
set -euo pipefail
# Isolated upstream Playwright Chromium for the disposable hosted Linux runner.
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Expected Linux x64 hosted runner' >&2; exit 1; }
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
export PLAYWRIGHT_BROWSERS_PATH
PLAYWRIGHT_BROWSERS_PATH=$(mktemp -d "$RUNNER_TEMP/playwright-browser.XXXXXX")
pnpm exec playwright install chromium
browser=$(node -e "console.log(require('@playwright/test').chromium.executablePath())")
printf 'PLAYWRIGHT_BROWSERS_PATH=%s\nPLAYWRIGHT_CHROME_EXECUTABLE_PATH=%s\n' "$PLAYWRIGHT_BROWSERS_PATH" "$browser" >> "$GITHUB_ENV"
"$browser" --version
