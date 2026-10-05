#!/bin/zsh
# macOS probe build+test: mirror of native/windows/probe/run.ps1.
# Usage:
#   ./run.sh                 # download pins if missing, build, package, run driver
#   ./run.sh --skip-tests    # build+package only
#   BUN=/path/to/bun ./run.sh
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
ROOT=$(cd ../../.. && pwd)
PIN="$ROOT/runtime/build-manifests/darwin-aarch64.json"
SKIP_TESTS=0
for arg in "$@"; do [[ "$arg" == "--skip-tests" ]] && SKIP_TESTS=1; done

field() { # field <bun|json> <key> — read a value from the pin manifest
  /usr/bin/python3 -c "import json,sys; print(json.load(open('$PIN'))[sys.argv[1]][sys.argv[2]])" "$1" "$2"
}
check() { # check <file> <sha256>
  local got
  got=$(/usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}')
  [[ "$got" == "$2" ]] || { echo "Hash mismatch: $1 ($got)" >&2; exit 1; }
}
download() { # download <url> <file> <sha256>
  [[ -f "$2" ]] || curl -fL "$1" -o "$2"
  check "$2" "$3"
}

BUN_TARGET=$(field bun target)
CACHE="$ROOT/runtime/bun-bundle/vendor"
JSON_DIR="$HERE/vendor"
mkdir -p "$CACHE" "$JSON_DIR"
ARCHIVE="$CACHE/bun-$BUN_TARGET.zip"
download "$(field bun archiveUrl)" "$ARCHIVE" "$(field bun archiveSha256)"
[[ -d "$CACHE/bun-$BUN_TARGET" ]] || /usr/bin/ditto -xk "$ARCHIVE" "$CACHE"
BUNDLED="$CACHE/bun-$BUN_TARGET/bun"
check "$BUNDLED" "$(field bun executableSha256)"
chmod +x "$BUNDLED"
download "$(field bun licenseUrl)" "$CACHE/LICENSE.bun" "$(field bun licenseSha256)"
download "$(field json headerUrl)" "$JSON_DIR/json.hpp" "$(field json headerSha256)"
download "$(field json licenseUrl)" "$JSON_DIR/LICENSE.nlohmann-json" "$(field json licenseSha256)"

BUILD_BUN=${BUN:-$(command -v bun || true)}
[[ -n "$BUILD_BUN" ]] || BUILD_BUN="$BUNDLED"
[[ "$("$BUILD_BUN" --version)" == "$(field bun version)" ]] || {
  echo "Build Bun version must match the pin ($("$BUILD_BUN" --version))." >&2; exit 1; }
command -v clang++ >/dev/null || { echo "Xcode CLT clang++ is required." >&2; exit 1; }

BUILD="$ROOT/build/macos-probe"
PACKAGE="$BUILD/package"
mkdir -p "$PACKAGE/assets/tmp" "$PACKAGE/licenses" "$PACKAGE/runtime"
clang++ -std=c++20 -O2 -Wall -Wextra -I"$HERE/vendor" "$HERE/host.cpp" -o "$BUILD/bunaway-probe"
cp -f "$BUILD/bunaway-probe" "$PACKAGE/bunaway-probe"
cp "$BUNDLED" "$PACKAGE/runtime/bun"
chmod +x "$PACKAGE/bunaway-probe" "$PACKAGE/runtime/bun"
cp "$CACHE/LICENSE.bun" "$JSON_DIR/LICENSE.nlohmann-json" "$PACKAGE/licenses/"
cp "$HERE/bunfig.toml" "$HERE/tsconfig.json" "$ROOT/native/host-api/generated/process.schema.json" \
  "$PACKAGE/assets/"
(cd "$ROOT" && "$BUILD_BUN" build "$HERE/backend.ts" --target=bun --outfile "$PACKAGE/assets/backend.js")

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
echo "Probe package: $PACKAGE"
[[ "$SKIP_TESTS" == 1 ]] || "$BUILD_BUN" "$ROOT/tests/lifecycle/macos-process.ts" --package "$PACKAGE"
