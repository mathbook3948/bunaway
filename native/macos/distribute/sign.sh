#!/bin/zsh
# signs a bunaway .app for a distribution channel, inside-out:
#
#   nested executables (bundled Bun) -> record post-signing sha256 into
#   manifest.json -> host binary -> outer bundle -> verify
#
# The post-signing hash matters: codesign rewrites the binary, so the hash
# baked into the manifest must be taken AFTER the bun child is signed,
# otherwise the host's launch-time integrity check fails (measured).
#
#   sign.sh --channel mac-direct|mac-store
#           --app <input.app>
#           --out <signed.app>
#           --identity <codesign-identity>
#           [--team-id TEAMID]          required for mac-store
#           [--provisionprofile <file>] mac-store: embedded.provisionprofile
#           [--bundle-id id] [--version v] [--build-number n]
#           [--display-name s] [--icon file.icns] [--min-os v]
#
# mac-store additionally relocates the bundled Bun to Contents/Helpers/bun
# (Apple's nested-executable convention) — the host resolves that path via a
# fallback next to Contents/Resources/runtime/bun.
#
# Never prints credential material; identities are keychain item NAMES only.
set -u -o pipefail

SELF="${0:A:h}"
ENTS="$SELF/entitlements"

CHANNEL=""; APP=""; OUT=""; IDENTITY=""; TEAM_ID=""
PROFILE=""; BUNDLE_ID=""; VERSION=""; BUILD_NUM=""; DISPLAY=""; ICON=""; MINOS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2;;
    --app) APP="$2"; shift 2;;
    --out) OUT="$2"; shift 2;;
    --identity) IDENTITY="$2"; shift 2;;
    --team-id) TEAM_ID="$2"; shift 2;;
    --provisionprofile) PROFILE="$2"; shift 2;;
    --bundle-id) BUNDLE_ID="$2"; shift 2;;
    --version) VERSION="$2"; shift 2;;
    --build-number) BUILD_NUM="$2"; shift 2;;
    --display-name) DISPLAY="$2"; shift 2;;
    --icon) ICON="$2"; shift 2;;
    --min-os) MINOS="$2"; shift 2;;
    -h|--help) sed -n '2,22p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 64;;
  esac
done

die() { echo "sign.sh: $*" >&2; exit 1; }
[ -n "$CHANNEL" ] && [ -n "$APP" ] && [ -n "$OUT" ] && [ -n "$IDENTITY" ] \
  || die "requires --channel --app --out --identity"
[ "$CHANNEL" = "mac-direct" ] || [ "$CHANNEL" = "mac-store" ] \
  || die "--channel must be mac-direct or mac-store"
[ -d "$APP" ] || die "input app not found: $APP"
[ "$CHANNEL" = "mac-store" ] && [ -z "$TEAM_ID" ] && die "mac-store requires --team-id"
command -v codesign >/dev/null || die "codesign not available"

# Stage: sign a copy, never in place; only move into $OUT on full success.
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/bunaway-sign.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
STAGED="$STAGE/${${APP:t}%.app}.app"
ditto "$APP" "$STAGED" || die "failed to stage $APP"
MACOS_DIR="$STAGED/Contents/MacOS"
RES_DIR="$STAGED/Contents/Resources"
PLIST="$STAGED/Contents/Info.plist"
[ -f "$PLIST" ] || die "staged app missing Info.plist"
[ -f "$RES_DIR/manifest.json" ] || die "staged app missing manifest.json"
PB=/usr/libexec/PlistBuddy

# ------------------------------------------------------------- metadata ---
[ -n "$BUNDLE_ID" ]  && "$PB" -c "Set :CFBundleIdentifier $BUNDLE_ID" "$PLIST"
[ -n "$VERSION" ]    && "$PB" -c "Set :CFBundleShortVersionString $VERSION" "$PLIST"
[ -n "$BUILD_NUM" ]  && "$PB" -c "Set :CFBundleVersion $BUILD_NUM" "$PLIST"
[ -n "$DISPLAY" ]    && "$PB" -c "Set :CFBundleName $DISPLAY" "$PLIST" \
                     && "$PB" -c "Set :CFBundleDisplayName $DISPLAY" "$PLIST" 2>/dev/null || true
[ -n "$MINOS" ]      && { "$PB" -c "Add :LSMinimumSystemVersion string" "$PLIST" 2>/dev/null; \
                        "$PB" -c "Set :LSMinimumSystemVersion $MINOS" "$PLIST"; }
if [ -n "$ICON" ]; then
  [ -f "$ICON" ] || die "icon not found: $ICON"
  ditto "$ICON" "$RES_DIR/AppIcon.icns"
  { "$PB" -c "Add :CFBundleIconFile string" "$PLIST" 2>/dev/null; }
  "$PB" -c "Set :CFBundleIconFile AppIcon" "$PLIST"
fi
BUNDLE_ID_FINAL=$("$PB" -c "Print :CFBundleIdentifier" "$PLIST" 2>/dev/null || echo "$BUNDLE_ID")

# ------------------------------------------------- store layout changes ---
BUN_BIN="$RES_DIR/runtime/bun"
if [ "$CHANNEL" = "mac-store" ]; then
  mkdir -p "$STAGED/Contents/Helpers"
  [ -f "$BUN_BIN" ] || die "bundled bun missing at $BUN_BIN"
  mv "$BUN_BIN" "$STAGED/Contents/Helpers/bun"
  rmdir "$RES_DIR/runtime" 2>/dev/null || true
  BUN_BIN="$STAGED/Contents/Helpers/bun"
  if [ -n "$PROFILE" ]; then
    [ -f "$PROFILE" ] || die "provisionprofile not found: $PROFILE"
    ditto "$PROFILE" "$STAGED/Contents/embedded.provisionprofile"
  fi
fi
[ -f "$BUN_BIN" ] || die "bun executable not found at $BUN_BIN"

# -------------------------------------------------------- entitlements ----
gen_ent() { # gen_ent <plist-src> <dst>
  if [ "$CHANNEL" = "mac-store" ]; then
    sed -e "s/\${TEAM_ID}/$TEAM_ID/g" -e "s/\${BUNDLE_ID}/$BUNDLE_ID_FINAL/g" "$1" > "$2"
    if [ -z "$PROFILE" ]; then
      # com.apple.application-identifier / team-identifier are provisioned
      # entitlements: without embedded.provisionprofile AMFI kills the app
      # at exec (measured). Drop them for dev-signed store-layout builds so
      # the pipeline stays smoke-testable; real MAS signing must pass
      # --provisionprofile.
      python3 - "$2" <<'PY'
import plistlib, sys
p = sys.argv[1]
d = plistlib.load(open(p, "rb"))
for k in ("com.apple.application-identifier", "com.apple.developer.team-identifier"):
    d.pop(k, None)
plistlib.dump(d, open(p, "wb"))
PY
    fi
  else
    cp "$1" "$2"
  fi
}
gen_ent "$ENTS/$CHANNEL-app.plist"   "$STAGE/app.ent.plist"
gen_ent "$ENTS/$CHANNEL-child.plist" "$STAGE/child.ent.plist"

# ---------------------------------------------------------------- sign ----
say() { printf 'sign.sh[%s] %s\n' "$CHANNEL" "$*"; }

say "signing nested bun -> $BUN_BIN"
codesign --force --sign "$IDENTITY" --options runtime \
  --entitlements "$STAGE/child.ent.plist" "$BUN_BIN" \
  || die "codesign failed for bun child"

# Manifest must record the POST-signing hash of the executable it protects.
NEW_SHA=$(/usr/bin/shasum -a 256 "$BUN_BIN" | awk '{print $1}')
NEW_SHA="$NEW_SHA" python3 - "$RES_DIR/manifest.json" <<'PY'
import json, os, sys
path = sys.argv[1]
manifest = json.load(open(path))
manifest.setdefault("bun", {})["executableSha256"] = os.environ["NEW_SHA"]
json.dump(manifest, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
say "manifest bun.executableSha256 := ${NEW_SHA:0:12}..."

HOST_BIN="$MACOS_DIR/bunaway-host"
[ -f "$HOST_BIN" ] || HOST_BIN=$(find "$MACOS_DIR" -type f -perm +111 | head -1)
[ -n "$HOST_BIN" ] && [ -f "$HOST_BIN" ] || die "host executable not found in $MACOS_DIR"

say "signing host binary -> $HOST_BIN"
codesign --force --sign "$IDENTITY" --options runtime \
  --entitlements "$STAGE/app.ent.plist" "$HOST_BIN" \
  || die "codesign failed for host binary"

say "sealing bundle -> $STAGED"
codesign --force --sign "$IDENTITY" --options runtime \
  --entitlements "$STAGE/app.ent.plist" "$STAGED" \
  || die "codesign failed for bundle"

# --------------------------------------------------------------- verify ---
codesign --verify --deep --strict --verbose=2 "$STAGED" \
  || die "codesign --verify --deep --strict failed"
codesign -dvvv "$STAGED" 2>&1 | grep -E "Identifier|TeamIdentifier|flags|Signature" | head -4 \
  | sed 's/^/  /'

# ------------------------------------------------------ commit to output --
# Verify passed — replace the previous artifact only now, so any earlier
# failure leaves the last good signed app untouched.
mkdir -p "$(dirname "$OUT")"
OUT_TMP="${OUT}.tmp.$$"
rm -rf "$OUT_TMP"
mv "$STAGED" "$OUT_TMP" || die "could not stage signed app at $OUT_TMP"
rm -rf "$OUT"
mv "$OUT_TMP" "$OUT" || die "could not place signed app at $OUT"
say "signed app -> $OUT"
trap - EXIT
