#!/usr/bin/env bash
set -euo pipefail
# Isolated Chrome for Testing for the disposable hosted Ubuntu x64 runner.
# Official manifest: https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Expected Linux x64 hosted runner' >&2; exit 1; }
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
root=$(mktemp -d "$RUNNER_TEMP/chrome-for-testing.XXXXXX")
archive="$root/chrome.zip"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 \
  'https://storage.googleapis.com/chrome-for-testing-public/156.0.8078.80/linux64/chrome-linux64.zip' \
  --output "$archive"
printf '%s  %s\n' 'b711c720f774be355197f32edf37e0651418ba036d92446ee2da19ac017540a7' "$archive" | sha256sum --check --strict
unzip -q "$archive" -d "$root"
printf 'PLAYWRIGHT_CHROME_EXECUTABLE_PATH=%s/chrome-linux64/chrome\n' "$root" >> "$GITHUB_ENV"
"$root/chrome-linux64/chrome" --version
