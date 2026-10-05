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
set -u -o pipefail

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
say "submitting $ARTIFACT (profile '$PROFILE')…"
xcrun notarytool submit "$ARTIFACT" --keychain-profile "$PROFILE" --wait \
  || die "notarytool submission failed or was rejected"
say "accepted — stapling $ARTIFACT"
xcrun stapler staple "$ARTIFACT" || die "stapler staple failed"
xcrun stapler validate "$ARTIFACT" || die "stapler validate failed"
if [ -n "$APP" ]; then
  say "stapling $APP"
  xcrun stapler staple "$APP" || die "stapler staple on app failed"
fi
say "done"
