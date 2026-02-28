#!/bin/sh
set -eu

MODE="unsigned"
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/release/macos-release.sh [--mode unsigned|signed|signed-notarized] [--dry-run]

Modes:
  unsigned         Build unsigned macOS app + DMG bundles.
  signed           Build signed bundles (requires APPLE_SIGNING_IDENTITY).
  signed-notarized Build signed + notarization-ready bundles (requires
                   APPLE_SIGNING_IDENTITY, APPLE_API_KEY, APPLE_API_ISSUER,
                   and APPLE_API_KEY_PATH).
EOF
}

require_env() {
  key="$1"
  value="$(printenv "$key" || true)"
  if [ -z "$value" ]; then
    echo "error: required env var is missing: $key" >&2
    exit 1
  fi
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --)
      shift
      ;;
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

case "$MODE" in
  unsigned|signed|signed-notarized)
    ;;
  *)
    echo "error: invalid mode '$MODE'" >&2
    usage >&2
    exit 1
    ;;
esac

if [ "$MODE" = "signed" ] || [ "$MODE" = "signed-notarized" ]; then
  require_env "APPLE_SIGNING_IDENTITY"
fi

if [ "$MODE" = "signed-notarized" ]; then
  require_env "APPLE_API_KEY"
  require_env "APPLE_API_ISSUER"
  require_env "APPLE_API_KEY_PATH"
  if [ ! -f "$APPLE_API_KEY_PATH" ]; then
    echo "error: APPLE_API_KEY_PATH does not exist: $APPLE_API_KEY_PATH" >&2
    exit 1
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "ok: macOS release preflight passed (mode=$MODE, dry-run=1)"
  exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: macOS release builds are supported only on Darwin hosts" >&2
  exit 1
fi

echo "Starting macOS release build (mode=$MODE)..."
pnpm exec tauri build --bundles app,dmg
echo "macOS release build complete."
