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
set -eu -o pipefail

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
command -v python3 >/dev/null || die "python3 not available"

# Stage: sign a copy, never in place; only move into $OUT on full success.
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/bunaway-sign.XXXXXX")
PUBLISH=""
cleanup() {
  rm -rf "$STAGE"
  if [ -n "$PUBLISH" ]; then
    if [ -e "$PUBLISH/previous.app" ]; then
      echo "sign.sh: previous app preserved at $PUBLISH/previous.app" >&2
    else
      rm -rf "$PUBLISH"
    fi
  fi
}
trap cleanup EXIT
STAGED="$STAGE/${${APP:t}%.app}.app"
ditto "$APP" "$STAGED" || die "failed to stage $APP"
MACOS_DIR="$STAGED/Contents/MacOS"
RES_DIR="$STAGED/Contents/Resources"
PLIST="$STAGED/Contents/Info.plist"
[ -f "$PLIST" ] || die "staged app missing Info.plist"
[ -f "$RES_DIR/manifest.json" ] || die "staged app missing manifest.json"
PB=/usr/libexec/PlistBuddy

# ------------------------------------------------------------- metadata ---
plist_string() {
  "$PB" -c "Set :$1 $2" "$PLIST" 2>/dev/null \
    || "$PB" -c "Add :$1 string $2" "$PLIST"
}
[ -n "$BUNDLE_ID" ] && plist_string CFBundleIdentifier "$BUNDLE_ID"
[ -n "$VERSION" ]   && plist_string CFBundleShortVersionString "$VERSION"
[ -n "$BUILD_NUM" ] && plist_string CFBundleVersion "$BUILD_NUM"
if [ -n "$DISPLAY" ]; then
  plist_string CFBundleName "$DISPLAY"
  plist_string CFBundleDisplayName "$DISPLAY"
fi
[ -n "$MINOS" ] && plist_string LSMinimumSystemVersion "$MINOS"
if [ -n "$ICON" ]; then
  [ -f "$ICON" ] || die "icon not found: $ICON"
  ditto "$ICON" "$RES_DIR/AppIcon.icns"
  plist_string CFBundleIconFile AppIcon
fi
BUNDLE_ID_FINAL=$("$PB" -c "Print :CFBundleIdentifier" "$PLIST")

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

# Preserve the upstream digest; the host prefers the signed packagedSha256.
python3 - "$RES_DIR/manifest.json" "$BUN_BIN" <<'PY'
import hashlib, json, sys
path, bun = sys.argv[1:]
with open(path) as f:
    manifest = json.load(f)
with open(bun, "rb") as f:
    digest = hashlib.sha256(f.read()).hexdigest()
manifest["bun"]["packagedSha256"] = digest
with open(path, "w") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
with open(path) as f:
    if json.load(f)["bun"]["packagedSha256"] != digest:
        raise RuntimeError("Post-signing Bun hash was not recorded")
print("manifest bun.packagedSha256 := " + digest[:12] + "...")
PY

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
codesign -dvvv "$STAGED" 2>&1 | grep -E "Identifier|TeamIdentifier|flags|Signature" \
  | sed 's/^/  /'

# ------------------------------------------------------ commit to output --
# Verify passed — replace the previous artifact only now, so any earlier
# failure leaves the last good signed app untouched.
mkdir -p "$(dirname "$OUT")"
# Both renames stay on the output filesystem. Keep the old app until the
# replacement succeeds; if rollback fails, cleanup leaves its backup intact.
PUBLISH=$(mktemp -d "${OUT}.publish.XXXXXX")
mv "$STAGED" "$PUBLISH/new.app" || die "could not stage signed app at $PUBLISH"
if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  [ -d "$OUT" ] && [ ! -L "$OUT" ] || die "output must be a real app directory"
  mv "$OUT" "$PUBLISH/previous.app" || die "could not preserve previous app"
fi
if ! mv "$PUBLISH/new.app" "$OUT"; then
  if [ -d "$PUBLISH/previous.app" ]; then
    mv "$PUBLISH/previous.app" "$OUT" || die "rollback failed; backup retained at $PUBLISH/previous.app"
  fi
  die "could not place signed app at $OUT"
fi
rm -rf "$PUBLISH/previous.app"
say "signed app -> $OUT"
