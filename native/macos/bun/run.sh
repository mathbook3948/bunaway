#!/bin/zsh
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../../.." && pwd)
BUN_BIN=${BUN:-$(command -v bun)}
SKIP_TESTS=false
BUILD_APP=false
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=true ;;
    --app) BUILD_APP=true ;;
  esac
done

cd "$ROOT"
"$BUN_BIN" "$ROOT/native/macos/bun/package.ts" "$@"
if "$SKIP_TESTS"; then
  exit 0
fi

# Run native regressions only after the package and optional signed app are ready.
"$BUN_BIN" "$ROOT/tests/lifecycle/macos-webview-regressions.ts"
"$BUN_BIN" "$ROOT/tests/lifecycle/macos-host.ts" --package "$ROOT/build/macos-bun-package"
if "$BUILD_APP"; then
  BUNAWAY_PACKAGE_IN_PLACE=1 \
  BUNAWAY_HOST_EXEC="$ROOT/build/Bunaway.app/Contents/MacOS/bunaway-host" \
  BUNAWAY_TEST_WORKSPACE="$ROOT/build/macos-host-in-place" \
  BUNAWAY_TEST_SIGN_IDENTITY=- \
    "$BUN_BIN" "$ROOT/tests/lifecycle/macos-host.ts" --package "$ROOT/build/Bunaway.app/Contents/Resources"
  BUNAWAY_DISTRIBUTION_APP="$ROOT/build/Bunaway.app" BUN="$BUN_BIN" \
    python3 "$ROOT/native/macos/distribute/test.py"
fi
