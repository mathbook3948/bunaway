#!/bin/zsh
# builds the channel artifact from a signed bunaway .app:
#
#   mac-direct -> <name>-<version>.dmg  (drag-install: app + /Applications link)
#   mac-store  -> <name>-<version>.pkg  (productbuild installer package)
#
#   package.sh --channel mac-direct|mac-store
#              --app <signed.app>
#              --out-dir <dir>
#              [--name <base>]            default: CFBundleName or app dir name
#              [--installer-identity id]  mac-store only; without it the .pkg
#                                         is built UNSIGNED (dev/CI layout check)
#
# Output goes to a staging dir and is only moved into place on success, so a
# failed build never clobbers the previous artifact.
set -u -o pipefail

CHANNEL=""; APP=""; OUTDIR=""; NAME=""; INSTALLER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL="$2"; shift 2;;
    --app) APP="$2"; shift 2;;
    --out-dir) OUTDIR="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --installer-identity) INSTALLER="$2"; shift 2;;
    -h|--help) sed -n '2,18p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 64;;
  esac
done

die() { echo "package.sh: $*" >&2; exit 1; }
[ -n "$CHANNEL" ] && [ -n "$APP" ] && [ -n "$OUTDIR" ] || die "requires --channel --app --out-dir"
[ "$CHANNEL" = "mac-direct" ] || [ "$CHANNEL" = "mac-store" ] || die "--channel must be mac-direct or mac-store"
[ -d "$APP" ] || die "app not found: $APP"
PB=/usr/libexec/PlistBuddy
PLIST="$APP/Contents/Info.plist"
[ -f "$PLIST" ] || die "missing $PLIST"

if [ -z "$NAME" ]; then
  NAME=$("$PB" -c "Print :CFBundleName" "$PLIST" 2>/dev/null) \
    || NAME="${${APP:t}%.app}"
fi
VERSION=$("$PB" -c "Print :CFBundleShortVersionString" "$PLIST" 2>/dev/null) || VERSION="0"
BUILD=$("$PB" -c "Print :CFBundleVersion" "$PLIST" 2>/dev/null || echo "")
[ -n "$BUILD" ] && [ "$BUILD" != "$VERSION" ] && VERSION="$VERSION-$BUILD"

say() { printf 'package.sh[%s] %s\n' "$CHANNEL" "$*"; }
STAGE=$(mktemp -d "${TMPDIR:-/tmp}/bunaway-pkg.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$OUTDIR"

if [ "$CHANNEL" = "mac-direct" ]; then
  DMG="$NAME-$VERSION.dmg"
  mkdir -p "$STAGE/dmg-root"
  ditto "$APP" "$STAGE/dmg-root/${APP:t}" || die "failed staging app"
  ln -s /Applications "$STAGE/dmg-root/Applications"
  hdiutil create -srcfolder "$STAGE/dmg-root" -format UDZO -volname "$NAME" \
    "$STAGE/$DMG" || die "hdiutil create failed"
  mv "$STAGE/$DMG" "$OUTDIR/$DMG" || die "could not place $DMG"
  say "dmg -> $OUTDIR/$DMG"
else
  PKG="$NAME-$VERSION.pkg"
  ARGS=(--component "$APP" /Applications)
  if [ -n "$INSTALLER" ]; then
    ARGS+=(--sign "$INSTALLER")
  else
    say "no --installer-identity: building UNSIGNED pkg (dev/CI only)"
  fi
  productbuild "${ARGS[@]}" "$STAGE/$PKG" || die "productbuild failed"
  mv "$STAGE/$PKG" "$OUTDIR/$PKG" || die "could not place $PKG"
  say "pkg -> $OUTDIR/$PKG"
fi
trap - EXIT
