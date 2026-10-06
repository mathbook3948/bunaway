#!/bin/zsh
# macOS product host build+test: mirror of native/windows/host/run.ps1.
# Usage:
#   ./run.sh                 # verify pins -> build -> package -> tests/lifecycle/macos-host.ts
#   ./run.sh --skip-tests    # build+package only
#   ./run.sh --sample        # package the memo sample instead of the test suite
#   ./run.sh --app           # additionally build and test an ad-hoc signed build/Bunaway.app
#   BUN=/path/to/bun ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
ROOT=$(cd ../../.. && pwd)
PIN="$ROOT/runtime/build-manifests/darwin-aarch64.json"
[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || {
  echo "macOS arm64 is required by the pinned darwin-aarch64 runtime; Intel is not supported." >&2
  exit 1
}
# Policy, schemas and web entries are shared with Windows. The macOS test
# app declaration remains single-window until this host supports windows[].
WIN_TEST="$ROOT/native/windows/host/test"
SKIP_TESTS=0
SAMPLE=0
MAKE_APP=0
HOST_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --sample) SAMPLE=1 ;;
    --app) MAKE_APP=1 ;;
    --host-only) HOST_ONLY=1 ;;
  esac
done

field() { /usr/bin/python3 -c "import json,sys; print(json.load(open('$PIN'))[sys.argv[1]][sys.argv[2]])" "$1" "$2"; }
check() {
  local got
  got=$(/usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}')
  [[ "$got" == "$2" ]] || { echo "Hash mismatch: $1 ($got)" >&2; exit 1; }
}
download() {
  [[ -f "$2" ]] || curl -fL "$1" -o "$2"
  check "$2" "$3"
}

BUN_TARGET=$(field bun target)
[[ "$BUN_TARGET" == darwin-aarch64 ]] || { echo "Unexpected Bun target: $BUN_TARGET" >&2; exit 1; }
CACHE="$ROOT/runtime/bun-bundle/vendor"
JSON_DIR="$ROOT/native/macos/vendor"
mkdir -p "$CACHE" "$JSON_DIR"
ARCHIVE="$CACHE/bun-$BUN_TARGET.zip"
download "$(field bun archiveUrl)" "$ARCHIVE" "$(field bun archiveSha256)"
[[ -d "$CACHE/bun-$BUN_TARGET" ]] || /usr/bin/ditto -xk "$ARCHIVE" "$CACHE"
BUNDLED="$CACHE/bun-$BUN_TARGET/bun"
check "$BUNDLED" "$(field bun executableSha256)"
chmod +x "$BUNDLED"
[[ "$(/usr/bin/lipo -archs "$BUNDLED")" == arm64 ]] || { echo "Bundled Bun must be arm64." >&2; exit 1; }
[[ "$("$BUNDLED" --version)" == "$(field bun version)" ]] || { echo "Bundled Bun version mismatch." >&2; exit 1; }
download "$(field bun licenseUrl)" "$CACHE/LICENSE.bun" "$(field bun licenseSha256)"
download "$(field json headerUrl)" "$JSON_DIR/json.hpp" "$(field json headerSha256)"
download "$(field json licenseUrl)" "$JSON_DIR/LICENSE.nlohmann-json" "$(field json licenseSha256)"

BUILD_BUN=${BUN:-$(command -v bun || true)}
[[ -n "$BUILD_BUN" ]] || BUILD_BUN="$BUNDLED"
[[ "$("$BUILD_BUN" --version)" == "$(field bun version)" ]] || {
  echo "Build Bun version must match the pin ($("$BUILD_BUN" --version))." >&2; exit 1; }
command -v clang++ >/dev/null || { echo "Xcode CLT clang++ is required." >&2; exit 1; }

BUILD="$ROOT/build/macos-host"
PACKAGE="$ROOT/build/$( ((SAMPLE)) && echo 'macos-memo-package' || echo 'macos-host-package')"
mkdir -p "$BUILD" "$PACKAGE/assets/web" "$PACKAGE/assets/tmp" "$PACKAGE/licenses" "$PACKAGE/runtime"
clang++ -std=c++20 -O2 -Wall -Wextra -fobjc-arc -I"$JSON_DIR" \
  "$HERE/main.mm" -framework Cocoa -framework WebKit -o "$BUILD/bunaway-host"
if (( HOST_ONLY )); then
  echo "Native host: $BUILD/bunaway-host"
  exit 0
fi
cp "$BUILD/bunaway-host" "$PACKAGE/bunaway-host"
cp "$BUNDLED" "$PACKAGE/runtime/bun"
chmod +x "$PACKAGE/bunaway-host" "$PACKAGE/runtime/bun"
cp "$CACHE/LICENSE.bun" "$JSON_DIR/LICENSE.nlohmann-json" "$PACKAGE/licenses/"

GENERATED="$ROOT/native/host-api/generated"
for name in bunfig.toml tsconfig.json policy.json; do
  cp "$WIN_TEST/$name" "$PACKAGE/assets/$name"
done
cp "$HERE/test/app.json" "$PACKAGE/assets/app.json"
for name in process.schema.json message.schema.json policy.schema.json host-call.schema.json host-operations.json; do
  cp "$GENERATED/$name" "$PACKAGE/assets/$name"
done
if (( ! SAMPLE )); then
  for f in "$WIN_TEST"/web/*; do cp "$f" "$PACKAGE/assets/web/"; done
  for entry in app.js page2.js; do
    (cd "$ROOT" && "$BUILD_BUN" build "$WIN_TEST/web/$entry" --target=browser --outfile "$PACKAGE/assets/web/$entry")
  done
  cp "$HERE/test/web/security.html" "$PACKAGE/assets/web/security.html"
  (cd "$ROOT" && "$BUILD_BUN" build "$HERE/test/web/security.js" --target=browser --outfile "$PACKAGE/assets/web/security.js")
fi
cp "$ROOT/examples/memo/web/memo.html" "$PACKAGE/assets/web/memo.html"
(cd "$ROOT" && "$BUILD_BUN" build examples/memo/web/memo.js --target=browser --outfile "$PACKAGE/assets/web/memo.js")
if (( SAMPLE )); then
  cp "$ROOT/examples/memo/app.json" "$ROOT/examples/memo/policy.json" "$PACKAGE/assets/"
  BACKEND_ENTRY="$ROOT/examples/memo/backend.ts"
else
  BACKEND_ENTRY="$WIN_TEST/backend.ts"
fi
(cd "$ROOT" && "$BUILD_BUN" build "$BACKEND_ENTRY" --target=bun --outfile "$PACKAGE/assets/backend.js")

"$BUILD_BUN" -e '
  const { createHash } = await import("node:crypto");
  const pin = JSON.parse(await Bun.file(process.argv[1]).text());
  const assets = {};
  for (const dir of ["assets", "licenses"]) {
    for (const name of (await Array.fromAsync(new Bun.Glob(`${dir}/**`).scan(process.argv[2]))).sort()) {
      assets[name] = createHash("sha256").update(await Bun.file(`${process.argv[2]}/${name}`).bytes()).digest("hex");
    }
  }
  pin.assets = assets;
  await Bun.write(`${process.argv[2]}/manifest.json`, JSON.stringify(pin, null, 2) + "\n");
' "$PIN" "$PACKAGE"
echo "Host package: $PACKAGE"

if (( MAKE_APP )); then
  # Ad-hoc signed .app for local verification. Product release adds a real
  # Developer ID signature + notarization (see README).
  APP="$ROOT/build/Bunaway.app"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  cp "$PACKAGE/bunaway-host" "$APP/Contents/MacOS/bunaway-host"
  cp -R "$PACKAGE/runtime" "$PACKAGE/assets" "$PACKAGE/licenses" "$PACKAGE/manifest.json" "$APP/Contents/Resources/"
  /usr/bin/plutil -create binary1 "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleExecutable string bunaway-host' "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIdentifier string ai.bunaway.app' "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleName string bunaway' "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleShortVersionString string 0.0.0' "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleVersion string 0' "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :LSMinimumSystemVersion string 14.0' "$APP/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c 'Add :NSPrincipalClass string NSApplication' "$APP/Contents/Info.plist"
  /usr/bin/codesign --force --deep --sign - "$APP"
  echo "App bundle: $APP (ad-hoc signed; verify: $APP/Contents/MacOS/bunaway-host --package $APP/Contents/Resources)"
fi

if (( ! SKIP_TESTS && ! SAMPLE )); then
  clang++ -std=c++20 -O2 -Wall -Wextra -fobjc-arc -I"$JSON_DIR" \
    "$ROOT/tests/lifecycle/macos-host-native.mm" -framework Cocoa -framework WebKit -o "$BUILD/host-native-tests"
  "$BUILD_BUN" "$ROOT/tests/lifecycle/macos-host.ts" --package "$PACKAGE"
  if (( MAKE_APP )); then
    BUNAWAY_PACKAGE_IN_PLACE=1 \
    BUNAWAY_HOST_EXEC="$APP/Contents/MacOS/bunaway-host" \
    BUNAWAY_TEST_WORKSPACE="$ROOT/build/macos-host-in-place" \
    BUNAWAY_NATIVE_TEST_EXEC="$BUILD/host-native-tests" \
    BUNAWAY_TEST_SIGN_IDENTITY=- \
      "$BUILD_BUN" "$ROOT/tests/lifecycle/macos-host.ts" --package "$APP/Contents/Resources"
  fi
fi
