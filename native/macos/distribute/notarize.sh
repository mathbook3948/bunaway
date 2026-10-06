#!/bin/zsh
# notarizes a mac-direct artifact (DMG or zipped .app) via Apple's notarytool
# and staples the ticket.
#
#   notarize.sh --artifact <file.dmg|file.zip>
#               --profile <keychain-profile>   # `xcrun notarytool
#                                              #   store-credentials <name>`
#               [--app <signed.app>]           # staple the app too
#
# UNVERIFIED path: without --profile this script cannot reach Apple's notary
# service — it then only prints what it WOULD run and exits 2.
#
# Credentials never appear on this command line or in logs: the profile is a
# login-keychain item name created once with `xcrun notarytool
# store-credentials`. App-specific passwords / API keys must never be passed
# here inline.
set -eu -o pipefail

ARTIFACT=""; PROFILE=""; APP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --artifact) ARTIFACT="$2"; shift 2;;
    --profile) PROFILE="$2"; shift 2;;
    --app) APP="$2"; shift 2;;
    -h|--help) sed -n '2,19p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 64;;
  esac
done

die() { echo "notarize.sh: $*" >&2; exit 1; }
[ -n "$ARTIFACT" ] || die "requires --artifact"
[ -f "$ARTIFACT" ] || die "artifact not found: $ARTIFACT"
[ -z "$APP" ] || [ -d "$APP" ] || die "app not found: $APP"
case "$ARTIFACT" in
  *.dmg|*.zip) ;;
  *) die "artifact must be a .dmg or .zip";;
esac

if [ -z "$PROFILE" ]; then
  cat >&2 <<'MSG'
notarize.sh: UNVERIFIED — no --profile given.
  Create one once (stores creds in your login keychain):
    xcrun notarytool store-credentials <profile-name> \
      --apple-id <id> --team-id <TEAM> --password <app-specific-pw>
  (or --key/--key-id/--issuer for App Store Connect API keys)
  Then: notarize.sh --artifact <file> --profile <profile-name>
MSG
  exit 2
fi

say() { printf 'notarize.sh: %s\n' "$*"; }
STAGE=$(mktemp -d "$(dirname "$ARTIFACT")/.bunaway-notary.XXXXXX")
trap 'rm -rf "$STAGE"' EXIT
say "submitting $ARTIFACT (profile '$PROFILE')…"
xcrun notarytool submit "$ARTIFACT" --keychain-profile "$PROFILE" --wait \
  --output-format json > "$STAGE/submission.json" \
  || die "notarytool submission failed or was rejected"
RESULT=$(/usr/bin/plutil -extract status raw -o - "$STAGE/submission.json")
[ "$RESULT" = "Accepted" ] || die "notarization was not accepted: $RESULT"
case "$ARTIFACT" in
  *.zip)
    # ZIP has no place for a ticket. Staple the submitted app inside a copy
    # of the archive, then rebuild on the same filesystem before replacing it.
    ditto -x -k "$ARTIFACT" "$STAGE/unpacked"
    APPS=("$STAGE/unpacked"/*.app(N))
    [ ${#APPS[@]} -eq 1 ] || die "ZIP must contain exactly one top-level .app"
    xcrun stapler staple "${APPS[1]}" || die "stapler staple on archived app failed"
    xcrun stapler validate "${APPS[1]}" || die "stapler validate on archived app failed"
    ditto -c -k "$STAGE/unpacked" "$STAGE/notarized.zip"
    mv "$STAGE/notarized.zip" "$ARTIFACT" || die "could not place notarized ZIP"
    ;;
  *.dmg)
    say "accepted — stapling $ARTIFACT"
    xcrun stapler staple "$ARTIFACT" || die "stapler staple failed"
    xcrun stapler validate "$ARTIFACT" || die "stapler validate failed"
    ;;
esac
if [ -n "$APP" ]; then
  say "stapling $APP"
  xcrun stapler staple "$APP" || die "stapler staple on app failed"
  xcrun stapler validate "$APP" || die "stapler validate on app failed"
fi
say "done"
