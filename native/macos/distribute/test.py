#!/usr/bin/env python3
"""Real macOS signing/packaging checks; only the Apple notary service is mocked."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


SCRIPTS = Path(__file__).resolve().parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


@unittest.skipUnless(sys.platform == "darwin", "requires macOS codesign, ditto and hdiutil")
class DistributionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.template_dir = tempfile.TemporaryDirectory(prefix="bunaway-distribution-template-")
        cls.template = Path(cls.template_dir.name) / "Fixture.app"
        resources = cls.template / "Contents/Resources"
        (resources / "runtime").mkdir(parents=True)
        host = cls.template / "Contents/MacOS/bunaway-host"
        host.parent.mkdir()
        # A small system Mach-O is enough for signing/rollback tests. No C compiler.
        shutil.copyfile("/usr/bin/true", host)
        host.chmod(0o755)
        shutil.copy2(host, resources / "runtime/bun")
        with (cls.template / "Contents/Info.plist").open("wb") as f:
            plistlib.dump({
                "CFBundleExecutable": "bunaway-host",
                "CFBundleIdentifier": "ai.bunaway.distribution-test",
                "CFBundleName": "Fixture",
                "CFBundlePackageType": "APPL",
                "CFBundleShortVersionString": "1.2.3",
                "CFBundleVersion": "4",
            }, f)
        cls.upstream = digest(resources / "runtime/bun")
        # Include an old packaged digest to ensure re-signing refreshes it.
        (resources / "manifest.json").write_text(json.dumps({"bun": {
            "executableSha256": cls.upstream, "packagedSha256": "0" * 64,
        }}))

    @classmethod
    def tearDownClass(cls):
        cls.template_dir.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="bunaway distribution test ")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.app = self.root / "Input.app"
        shutil.copytree(self.template, self.app)
        self.out = self.root / "Signed.app"
        self.stage = self.root / "scratch"
        self.stage.mkdir()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env = {**os.environ, "TMPDIR": str(self.stage),
                    "PATH": str(self.bin) + os.pathsep + os.environ["PATH"]}

    def run_script(self, name, args, expected=0):
        result = subprocess.run(["zsh", str(SCRIPTS / name), *map(str, args)],
                                env=self.env, text=True, capture_output=True, timeout=120)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def mock(self, command, body):
        path = self.bin / command
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o755)

    def sign(self, channel="mac-direct", extra=(), expected=0, app=None, out=None):
        return self.run_script("sign.sh", ["--channel", channel, "--app", app or self.app,
                               "--out", out or self.out, "--identity", "-", *extra], expected)

    def previous_output(self):
        self.out.mkdir()
        (self.out / "previous-marker").write_text("last-good")

    def assert_previous(self):
        self.assertEqual((self.out / "previous-marker").read_text(), "last-good")
        self.assertEqual(list(self.root.glob("Signed.app.publish.*")), [])
        self.assertEqual(list(self.stage.iterdir()), [])

    def assert_signed(self, app, channel):
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
        resources = app / "Contents/Resources"
        runtime = resources / "runtime/bun" if channel == "mac-direct" else app / "Contents/Helpers/bun"
        manifest = json.loads((resources / "manifest.json").read_text())
        self.assertEqual(manifest["bun"]["executableSha256"], self.upstream)
        self.assertEqual(manifest["bun"]["packagedSha256"], digest(runtime))

    def test_direct_sign_preserves_source_hash_updates_metadata_and_cleans_stage(self):
        self.previous_output()
        self.sign(extra=["--display-name", "New Display Name", "--version", "2.0.0",
                         "--build-number", "5", "--min-os", "14.0"])
        self.assert_signed(self.out, "mac-direct")
        with (self.out / "Contents/Info.plist").open("rb") as f:
            plist = plistlib.load(f)
        self.assertEqual(plist["CFBundleDisplayName"], "New Display Name")
        self.assertEqual(plist["CFBundleShortVersionString"], "2.0.0")
        self.assertEqual(plist["CFBundleVersion"], "5")
        self.assertEqual(plist["LSMinimumSystemVersion"], "14.0")
        self.assertFalse((self.out / "previous-marker").exists())
        self.assertEqual(list(self.stage.iterdir()), [])
        self.assertEqual(list(self.root.glob("Signed.app.publish.*")), [])
        self.assertEqual(digest(self.app / "Contents/Resources/runtime/bun"), self.upstream)

    def test_store_layout_and_entitlements(self):
        self.sign("mac-store", ["--team-id", "ABCD1234EF"])
        self.assert_signed(self.out, "mac-store")
        self.assertFalse((self.out / "Contents/Resources/runtime/bun").exists())
        result = subprocess.run(["codesign", "-d", "--entitlements", ":-", str(self.out)],
                                check=True, capture_output=True)
        entitlements = plistlib.loads(result.stdout)
        self.assertTrue(entitlements["com.apple.security.app-sandbox"])
        self.assertNotIn("com.apple.application-identifier", entitlements)
        self.assertNotIn("com.apple.developer.team-identifier", entitlements)
        self.assertEqual(list(self.stage.iterdir()), [])

    def test_manifest_writer_failure_preserves_previous_output(self):
        self.previous_output()
        self.mock("python3", "exit 47")
        self.sign(expected=47)
        self.assert_previous()

    def test_verification_failure_preserves_previous_output(self):
        self.previous_output()
        self.mock("codesign", 'if [ "$1" = --verify ]; then exit 47; fi\nexec /usr/bin/codesign "$@"')
        self.sign(expected=1)
        self.assert_previous()

    def test_final_rename_failure_restores_previous_output(self):
        self.previous_output()
        self.mock("mv", 'case "$1" in */new.app) exit 47;; esac\nexec /bin/mv "$@"')
        self.sign(expected=1)
        self.assert_previous()

    def test_backup_rename_failure_leaves_previous_output(self):
        self.previous_output()
        self.mock("mv", 'case "$2" in */previous.app) exit 47;; esac\nexec /bin/mv "$@"')
        self.sign(expected=1)
        self.assert_previous()

    def test_failed_rollback_retains_recoverable_backup(self):
        self.previous_output()
        self.mock("mv", 'case "$1" in */new.app|*/previous.app) exit 47;; esac\nexec /bin/mv "$@"')
        self.sign(expected=1)
        backups = list(self.root.glob("Signed.app.publish.*/previous.app/previous-marker"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), "last-good")

    def test_direct_dmg_and_store_pkg_are_real_artifacts_and_leave_no_scratch(self):
        for channel in ["mac-direct", "mac-store"]:
            with self.subTest(channel=channel):
                self.sign(channel, ["--team-id", "ABCD1234EF"] if channel == "mac-store" else [])
                self.run_script("package.sh", ["--channel", channel, "--app", self.out,
                                               "--out-dir", self.root / "artifacts"])
                suffix = "dmg" if channel == "mac-direct" else "pkg"
                artifact = self.root / "artifacts" / ("Fixture-1.2.3-4." + suffix)
                self.assertTrue(artifact.is_file())
                if channel == "mac-direct":
                    subprocess.run(["hdiutil", "verify", str(artifact)], check=True)
                    mount = self.root / "mount"
                    mount.mkdir()
                    subprocess.run(["hdiutil", "attach", "-readonly", "-nobrowse",
                                    "-mountpoint", str(mount), str(artifact)], check=True)
                    try:
                        self.assert_signed(mount / "Signed.app", channel)
                        self.assertEqual(os.readlink(mount / "Applications"), "/Applications")
                    finally:
                        subprocess.run(["hdiutil", "detach", str(mount)], check=True)
                else:
                    expanded = self.root / "expanded"
                    subprocess.run(["pkgutil", "--expand", str(artifact), str(expanded)], check=True)
                    self.assertTrue(list(expanded.rglob("PackageInfo")))
                self.assertEqual(list(self.stage.iterdir()), [])

    def test_failed_dmg_build_preserves_existing_artifact_and_cleans_stage(self):
        artifacts = self.root / "artifacts"
        artifacts.mkdir()
        dmg = artifacts / "Fixture-1.2.3-4.dmg"
        dmg.write_bytes(b"last-good")
        self.mock("hdiutil", "exit 47")
        self.run_script("package.sh", ["--channel", "mac-direct", "--app", self.app,
                                       "--out-dir", artifacts], expected=1)
        self.assertEqual(dmg.read_bytes(), b"last-good")
        self.assertEqual(list(self.stage.iterdir()), [])

    def notary_mock(self):
        # Log every operation and emulate Apple's inability to staple ZIPs.
        driver = self.root / "notary.py"
        driver.write_text('''import json, os, pathlib, sys
args = sys.argv[1:]
with open(os.environ["NOTARY_LOG"], "a") as f:
    f.write(json.dumps(args) + "\\n")
if args[0] == "notarytool":
    print(json.dumps({"status": os.environ.get("NOTARY_STATUS", "Accepted")}))
elif args[0] == "stapler":
    path = pathlib.Path(args[2])
    if path.suffix == ".zip" or os.environ.get("FAIL_STAPLE") == "1":
        sys.exit(65)
    if path.suffix == ".app":
        ticket = path / "Contents/Resources/test-ticket"
        if args[1] == "staple":
            ticket.write_text("ticket")
        elif not ticket.is_file():
            sys.exit(65)
    elif path.suffix == ".dmg":
        if args[1] == "staple":
            path.write_bytes(path.read_bytes() + b"ticket")
        elif os.environ.get("FAIL_VALIDATE") == "1":
            sys.exit(65)
''')
        self.env["NOTARY_LOG"] = str(self.root / "notary.log")
        self.mock("xcrun", "exec " + shlex.quote(sys.executable) + " " + shlex.quote(str(driver)) + ' "$@"')

    def make_zip(self):
        # Preserve sibling content as well as the .app when re-archiving.
        contents = self.root / "zip-input"
        contents.mkdir()
        shutil.copytree(self.app, contents / "Input.app")
        (contents / "README.txt").write_text("keep this")
        archive = self.root / "App.zip"
        subprocess.run(["ditto", "-c", "-k", str(contents), str(archive)], check=True)
        return archive

    def test_zip_staples_archived_app_and_rebuilds_archive(self):
        archive = self.make_zip()
        self.notary_mock()
        self.run_script("notarize.sh", ["--artifact", archive, "--profile", "test", "--app", self.app])
        unpacked = self.root / "result"
        subprocess.run(["ditto", "-x", "-k", str(archive), str(unpacked)], check=True)
        self.assertTrue((unpacked / "Input.app/Contents/Resources/test-ticket").is_file())
        self.assertEqual((unpacked / "README.txt").read_text(), "keep this")
        calls = [json.loads(line) for line in (self.root / "notary.log").read_text().splitlines()]
        self.assertFalse(any(call[:2] == ["stapler", "staple"] and call[2].endswith(".zip") for call in calls))
        self.assertEqual(list(self.root.glob(".bunaway-notary.*")), [])

    def test_failed_zip_stapling_preserves_original_archive(self):
        archive = self.make_zip()
        original = digest(archive)
        self.notary_mock()
        self.env["FAIL_STAPLE"] = "1"
        self.run_script("notarize.sh", ["--artifact", archive, "--profile", "test"], expected=1)
        self.assertEqual(digest(archive), original)
        self.assertEqual(list(self.root.glob(".bunaway-notary.*")), [])

    def test_dmg_and_optional_app_are_stapled_and_validated(self):
        dmg = self.root / "App.dmg"
        dmg.write_bytes(b"mock-dmg")
        self.notary_mock()
        self.run_script("notarize.sh", ["--artifact", dmg, "--profile", "test", "--app", self.app])
        calls = [json.loads(line) for line in (self.root / "notary.log").read_text().splitlines()]
        staged_dmg = calls[1][2]
        self.assertEqual(calls[1:], [
            ["stapler", "staple", staged_dmg], ["stapler", "validate", staged_dmg],
            ["stapler", "staple", str(self.app)], ["stapler", "validate", str(self.app)],
        ])
        self.assertEqual(Path(staged_dmg).name, "notarized.dmg")
        self.assertTrue(Path(staged_dmg).parent.name.startswith(".bunaway-notary."))
        self.assertEqual(Path(staged_dmg).parent.parent, self.root)
        self.assertEqual(dmg.read_bytes(), b"mock-dmgticket")
        self.assertEqual(list(self.root.glob(".bunaway-notary.*")), [])

    def test_failed_dmg_validation_preserves_original_artifact(self):
        dmg = self.root / "App.dmg"
        dmg.write_bytes(b"last-good")
        self.notary_mock()
        self.env["FAIL_VALIDATE"] = "1"
        self.run_script("notarize.sh", ["--artifact", dmg, "--profile", "test"], expected=1)
        calls = [json.loads(line) for line in (self.root / "notary.log").read_text().splitlines()]
        self.assertEqual([call[:2] for call in calls[1:]], [["stapler", "staple"], ["stapler", "validate"]])
        self.assertEqual(calls[1][2], calls[2][2])
        self.assertNotEqual(calls[1][2], str(dmg))
        self.assertEqual(dmg.read_bytes(), b"last-good")
        self.assertEqual(list(self.root.glob(".bunaway-notary.*")), [])

    def test_invalid_notary_status_is_not_treated_as_accepted(self):
        archive = self.make_zip()
        original = digest(archive)
        self.notary_mock()
        self.env["NOTARY_STATUS"] = "Invalid"
        self.run_script("notarize.sh", ["--artifact", archive, "--profile", "test"], expected=1)
        self.assertEqual(digest(archive), original)
        self.assertEqual(len((self.root / "notary.log").read_text().splitlines()), 1)

    def test_missing_notary_profile_returns_unverified_without_submission(self):
        archive = self.make_zip()
        self.notary_mock()
        self.run_script("notarize.sh", ["--artifact", archive], expected=2)
        self.assertFalse((self.root / "notary.log").exists())

    def test_real_bunaway_bundle_in_both_channels(self):
        source = os.environ.get("BUNAWAY_DISTRIBUTION_APP")
        if not source:
            self.skipTest("set BUNAWAY_DISTRIBUTION_APP to the native host .app")
        app = Path(source).resolve()
        manifest = json.loads((app / "Contents/Resources/manifest.json").read_text())
        for channel in ["mac-direct", "mac-store"]:
            with self.subTest(channel=channel):
                out = self.root / (channel + ".app")
                self.sign(channel, ["--team-id", "ABCD1234EF"] if channel == "mac-store" else [],
                          app=app, out=out)
                subprocess.run(["codesign", "--verify", "--deep", "--strict", str(out)], check=True)
                final = json.loads((out / "Contents/Resources/manifest.json").read_text())
                self.assertEqual(final["bun"]["executableSha256"], manifest["bun"]["executableSha256"])
                if manifest.get("host", {}).get("kind") == "bun-compiled":
                    self.assertFalse((out / "Contents/Resources/runtime/bun").exists())
                    self.assertFalse((out / "Contents/Helpers/bun").exists())
                    details = subprocess.run(["codesign", "-d", "--entitlements", ":-", str(out)], check=True, capture_output=True)
                    entitlements = plistlib.loads(details.stdout)
                    self.assertTrue(entitlements["com.apple.security.cs.allow-jit"])
                    self.assertTrue(entitlements["com.apple.security.cs.allow-unsigned-executable-memory"])
                    if channel == "mac-direct":
                        # Execute the hardened FFI app, not just its signature verifier.
                        home = self.root / "hardened-home"
                        home.mkdir()
                        report = home / "Library/Application Support/bunaway/tests.bunaway.host/temp/report3.json"
                        child = subprocess.Popen([str(out / "Contents/MacOS/bunaway-host")],
                            env={"HOME": str(home), "PATH": "/usr/bin:/bin"},
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                        try:
                            deadline = time.monotonic() + 15
                            while not report.exists() and child.poll() is None and time.monotonic() < deadline:
                                time.sleep(0.1)
                            self.assertTrue(report.exists(), "hardened Bun FFI app did not complete its WKWebView report")
                            child.terminate()
                            _, errors = child.communicate(timeout=10)
                            self.assertEqual(child.returncode, 0, errors.decode())
                        finally:
                            if child.poll() is None:
                                child.kill()
                            child.communicate(timeout=10)
                else:
                    runtime = out / ("Contents/Resources/runtime/bun" if channel == "mac-direct" else "Contents/Helpers/bun")
                    self.assertEqual(final["bun"]["packagedSha256"], digest(runtime))


if __name__ == "__main__":
    unittest.main(verbosity=2)
