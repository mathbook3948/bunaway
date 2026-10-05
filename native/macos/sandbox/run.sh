#!/bin/zsh
# App Sandbox validation harness for bunaway's macOS host (E1-E8).
# Verifies, on a real macOS machine, the properties MAS packaging depends on:
#   - sandbox applies to .app bundles (ad-hoc and dev-cert signatures)
#   - custom helper spawn rules (bundled inherit pair) and system exec controls
#   - sandboxed Bun child + JIT entitlement requirement under hardened runtime
#   - container-scoped data root, guard re-exec, orphan cleanup, read-only exec
#   - WebKit XPC-service entitlement gate findings (see docs/architecture/
#     macos-sandbox-results.md for the full matrix and verdicts)
#
# Usage:  zsh native/macos/sandbox/run.sh
# Needs:  macOS with Xcode CLT, a GUI user session (launchctl gui domain),
#         and — only for the dev-cert leg — the self-signed
#         "bunaway-dev-codesign" identity imported into the login keychain
#         (see build/devsign/README or generate: `RUN_DEVSIGN=1` bootstraps it).
set -u -o pipefail

REPO="${0:A:h:h:h:h}"
SBX="$REPO/native/macos/sandbox"
OUT="$REPO/build/macos-sandbox"
IDENT="${BUNAWAY_SBX_IDENTITY:--}"   # "-" = ad-hoc, or a codesign identity name
mkdir -p "$OUT/bin"

say()  { printf '%s\n' "$*"; }
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; FAILED=1; }
FAILED=0

# ---------------------------------------------------------------- build tools
say "== building probe/child/entsrv =="
clang++ -std=c++20 -O2 -fobjc-arc "$SBX/src/probe.mm"  -framework Security -o "$OUT/bin/probe"  || exit 1
clang   -O2 -fobjc-arc "$SBX/src/child.m"                               -o "$OUT/bin/child" || exit 1
clang++ -std=c++20 -O2 -fobjc-arc "$SBX/src/entsrv.mm" -framework Security -o "$OUT/bin/entsrv" || exit 1

mkapp() {  # mkapp <name> <binary-src> <entitlements-plist> [extra-files-dir]
  local app="$OUT/$1.app"; rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  cp "$2" "$app/Contents/MacOS/probe"
  [ -n "${4:-}" ] && cp -R "$4/." "$app/Contents/Resources/"
  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>tests.bunaway.host.sandbox</string>
  <key>CFBundleName</key><string>probe</string>
  <key>CFBundleExecutable</key><string>probe</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1</string>
</dict></plist>
PLIST
  codesign --force --sign "$IDENT" --entitlements "$3" "$app" 2>/dev/null
  printf '%s' "$app"
}

# ------------------------------------------------------------- E1: container
say "== E1 app-sandbox applies (identity: $IDENT) =="
APP=$(mkapp ProbeSbx "$OUT/bin/probe" "$SBX/entitlements/app-sandbox.plist")
"$APP/Contents/MacOS/probe" report "$OUT/e1" | tee "$OUT/e1.json"
# probe emits NDJSON lines; a sandboxed process is denied file-write-data /
grep -q '"k":"file-write-data /","v":1' "$OUT/e1.json" \
  && pass "app-sandbox active inside .app (write / denied)" || fail "sandbox did not apply"
grep -q '"k":"HOME","v":"[^"]*Library/Containers/tests.bunaway.host.sandbox' "$OUT/e1.json" \
  && pass "HOME remapped to container" || fail "HOME not container-scoped"
grep -q '"k":"NSHomeDirectory","v":"[^"]*Library/Containers/tests.bunaway.host.sandbox' "$OUT/e1.json" \
  && pass "NSHomeDirectory remapped to container" || fail "NSHomeDirectory not container-scoped"

# ------------------------------------------- E1b: write outside container
grep -q '"k":"outside-container","v":1' "$OUT/e1.json" \
  && pass "write outside container denied (EPERM)" \
  || fail "write outside container was not denied"

# -------------------------------------------- E2: child spawn topology rules
say "== E2 spawn rules =="
"$APP/Contents/MacOS/probe" spawn "$OUT/bin/child" >"$OUT/e2-outside.json" 2>&1
grep -q '"k":"posix_spawn","v":1' "$OUT/e2-outside.json" && pass "linker-signed custom helper outside bundle: posix_spawn EPERM" \
  || fail "linker-signed outside-bundle helper unexpectedly ran: $(cat "$OUT/e2-outside.json")"

for binary in /usr/bin/true /bin/echo; do
  "$APP/Contents/MacOS/probe" spawn "$binary" allowed-outside-bundle >"$OUT/e2-${binary:t}.json" 2>&1
  grep -q '"k":"posix_spawn","v":0' "$OUT/e2-${binary:t}.json" \
    && grep -q '"k":"exit","v":0' "$OUT/e2-${binary:t}.json" \
    && pass "system executable $binary outside bundle ran" \
    || fail "system executable $binary failed: $(cat "$OUT/e2-${binary:t}.json")"
done

APP2=$(mkapp ProbePair "$OUT/bin/probe" "$SBX/entitlements/app-sandbox.plist")
mkdir -p "$APP2/Contents/Helpers"
cp "$OUT/bin/child" "$APP2/Contents/Helpers/child"
codesign --force --sign "$IDENT" --entitlements "$SBX/entitlements/child.plist" \
  "$APP2/Contents/Helpers/child" 2>/dev/null
codesign --force --sign "$IDENT" --entitlements "$SBX/entitlements/app-sandbox.plist" "$APP2" 2>/dev/null
"$APP2/Contents/MacOS/probe" spawn "$APP2/Contents/Helpers/child" >"$OUT/e2-pair.json" 2>&1
grep -q 'child-ok.*sandboxed=1' "$OUT/e2-pair.json" && pass "Helpers child w/ sandbox+inherit pair ran sandboxed" \
  || fail "paired child failed: $(cat "$OUT/e2-pair.json")"

# child signed app-sandbox WITHOUT inherit -> SIGTRAP expected
codesign --force --sign "$IDENT" --entitlements "$SBX/entitlements/app-sandbox.plist" \
  "$APP2/Contents/Helpers/child" 2>/dev/null
codesign --force --sign "$IDENT" --entitlements "$SBX/entitlements/app-sandbox.plist" "$APP2" 2>/dev/null
"$APP2/Contents/MacOS/probe" spawn "$APP2/Contents/Helpers/child" >"$OUT/e2-solo.json" 2>&1
grep -q '"k":"signal","v":5' "$OUT/e2-solo.json" \
  && pass "child w/ app-sandbox but no inherit: rejected (SIGTRAP)" \
  || fail "un-paired child did not get rejected: $(cat "$OUT/e2-solo.json")"

# ----------------------------------------- E2b: re-exec of bundle's own main
"$APP2/Contents/MacOS/probe" spawn "$APP2/Contents/MacOS/probe" report "$OUT/e2b" \
  >"$OUT/e2b.json" 2>&1
grep -q '"k":"exit","v":0' "$OUT/e2b.json" && pass "re-exec of own main binary works (guard model)" \
  || fail "self re-exec failed: $(cat "$OUT/e2b.json")"

# ------------------------------------------------- E-net: network.client gate
say "== network.client gating =="
APP3=$(mkapp ProbeNet "$OUT/bin/probe" "$SBX/entitlements/app-sandbox-net.plist")
"$APP3/Contents/MacOS/probe" report "$OUT/e3" > "$OUT/e3.json"
# errno values: EPERM=1 (sandbox deny), ECONNREFUSED=61 (reached stack, refused)
grep -q '"k":"connect-127.0.0.1:9","v":61' "$OUT/e3.json" \
  && pass "network.client => connect reaches stack (ECONNREFUSED)" \
  || fail "network.client connect unexpected: $(grep connect "$OUT/e3.json")"
grep -q '"k":"connect-127.0.0.1:9","v":1' "$OUT/e1.json" \
  && pass "no network.client => EPERM" \
  || fail "unentitled connect unexpected: $(grep connect "$OUT/e1.json")"

# ------------------------------------------------------- summary / cleanup
say ""
if [ "$FAILED" = 0 ]; then
  say "ALL SANDBOX ASSERTIONS PASSED  (results in $OUT)"
  say "WebKit XPC-service gate: see docs/architecture/macos-sandbox-results.md (cause and MAS behavior UNVERIFIED)"
  exit 0
else
  say "SANDBOX ASSERTIONS FAILED — see $OUT/*.json"
  exit 1
fi
