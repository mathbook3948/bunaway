import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeEnvironment } from "@bunaway/plugin";
import type { BunawayError } from "@bunaway/protocol";
import { createUpdater } from "#plugins/updater/src/adapter";
import { createPackageFiles } from "#plugins/updater/src/platforms/package-files";
import { createAuthenticodeVerifier } from "#plugins/updater/src/platforms/windows-authenticode";
import { publisherMatches } from "#plugins/updater/src/signature";
import { deadline } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("build"));

/**
 * Real Authenticode checks through WinVerifyTrust. The test adds a self-signed code signing
 * certificate to the machine's trusted roots, so it runs only on a CI runner, where the machine
 * is disposable, and removes the certificate afterwards.
 */
const enabled = process.platform === "win32" && Boolean(process.env.CI);
const windowsOnly = enabled ? test : test.skip;

const TRUSTED_SUBJECT = "CN=Bunaway Test Publisher, O=Bunaway Test";
const UNTRUSTED_SUBJECT = "CN=Bunaway Untrusted Publisher";

let folder = "";
let trustedThumbprint = "";
let untrustedThumbprint = "";
const files: Record<string, string> = {};

function powershell(script: string): string {
  const result = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'; ${script}`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `PowerShell failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

function sign(path: string, thumbprint: string): void {
  const status = powershell(
    `(Set-AuthenticodeSignature -FilePath '${path}' -Certificate (Get-Item Cert:\\CurrentUser\\My\\${thumbprint}) -HashAlgorithm SHA256).Status`,
  );
  expect(status).toBe("Valid");
}

beforeAll(() => {
  if (!enabled) {
    return;
  }
  folder = mkdtempSync(join(tmpdir(), "bunaway-updater-signature-"));
  const certificates = powershell(`
    $trusted = New-SelfSignedCertificate -Type CodeSigningCert -Subject '${TRUSTED_SUBJECT}' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(1)
    $other = New-SelfSignedCertificate -Type CodeSigningCert -Subject '${UNTRUSTED_SUBJECT}' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(1)
    $cer = Join-Path '${folder}' 'trusted.cer'
    Export-Certificate -Cert $trusted -FilePath $cer | Out-Null
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\\LocalMachine\\Root | Out-Null
    "$($trusted.Thumbprint) $($other.Thumbprint)"
  `).split(" ");
  trustedThumbprint = certificates[0] ?? "";
  untrustedThumbprint = certificates[1] ?? "";

  // Small unsigned executable and an empty installer database, each signed under both identities.
  const system = process.env.SystemRoot ?? "C:\\Windows";
  for (const name of [
    "trusted",
    "untrusted",
    "tampered",
    "unsigned",
  ]) {
    files[name] = join(folder, `${name}.exe`);
    copyFileSync(join(system, "System32", "whoami.exe"), files[name]);
  }
  files.msi = join(folder, "trusted.msi");
  powershell(`
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @('${files.msi}', 3))
    $database.GetType().InvokeMember('Commit', 'InvokeMethod', $null, $database, $null)
  `);
  sign(files.trusted as string, trustedThumbprint);
  sign(files.tampered as string, trustedThumbprint);
  sign(files.untrusted as string, untrustedThumbprint);
  sign(files.msi, trustedThumbprint);
  // Change one byte inside the signed image so the digest in the signature no longer matches.
  const bytes = readFileSync(files.tampered as string);
  bytes[1024] = (bytes[1024] ?? 0) ^ 0xff;
  writeFileSync(files.tampered as string, bytes);
});

afterAll(() => {
  if (!enabled) {
    return;
  }
  try {
    powershell(`
      Remove-Item Cert:\\LocalMachine\\Root\\${trustedThumbprint} -ErrorAction SilentlyContinue
      Remove-Item Cert:\\CurrentUser\\My\\${trustedThumbprint} -ErrorAction SilentlyContinue
      Remove-Item Cert:\\CurrentUser\\My\\${untrustedThumbprint} -ErrorAction SilentlyContinue
    `);
  } finally {
    rmSync(folder, {
      recursive: true,
      force: true,
    });
  }
});

/** The checked file under the name the updater gives packages: its digest and no extension. */
function asPackage(source: string, name: string): string {
  const target = join(folder, `${name}.package`);
  copyFileSync(source, target);
  return target;
}

windowsOnly(
  "a signed exe and a signed msi are valid and report the signer's subject, without a file extension",
  async () => {
    const verifier = createAuthenticodeVerifier();
    const signal = new AbortController().signal;
    for (const name of [
      "trusted",
      "msi",
    ]) {
      const outcome = await verifier.verify(
        asPackage(files[name] as string, `${name}-copy`),
        signal,
      );
      expect(outcome.kind).toBe("signed");
      if (outcome.kind === "signed") {
        expect(
          publisherMatches(outcome.subject, "Bunaway Test Publisher"),
        ).toBe(true);
        expect(
          publisherMatches(
            outcome.subject,
            "CN=Bunaway Test Publisher,O=Bunaway Test",
          ),
        ).toBe(true);
        expect(publisherMatches(outcome.subject, "Bunaway Test")).toBe(false);
        expect(publisherMatches(outcome.subject, "O=Another Org")).toBe(false);
      }
    }
    verifier.close();
  },
);

windowsOnly(
  "an unsigned, tampered, untrusted or non-installer file is not accepted",
  async () => {
    const verifier = createAuthenticodeVerifier();
    const signal = new AbortController().signal;
    const kindOf = async (name: string) =>
      (
        await verifier.verify(
          asPackage(files[name] as string, `${name}-copy`),
          signal,
        )
      ).kind;
    expect(await kindOf("unsigned")).toBe("unsigned");
    expect(await kindOf("tampered")).toBe("untrusted");
    expect(await kindOf("untrusted")).toBe("untrusted");
    const text = join(folder, "notes.package");
    writeFileSync(text, "not an installer");
    expect((await verifier.verify(text, signal)).kind).toBe(
      "unsupportedFormat",
    );
    verifier.close();
  },
);

windowsOnly(
  "repeated checks do not leave workers behind and a cancelled check returns at once",
  async () => {
    const verifier = createAuthenticodeVerifier();
    const target = asPackage(files.trusted as string, "repeat");
    for (let count = 0; count < 6; count++) {
      expect(
        (await verifier.verify(target, new AbortController().signal)).kind,
      ).toBe("signed");
    }
    const controller = new AbortController();
    const pending = verifier.verify(target, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    verifier.close();
  },
);

function environment(
  root: string,
  publisherNames: string[],
): NativeEnvironment {
  return {
    dataRoot: root,
    capabilities: [],
    app: {
      id: "com.example.app",
      version: "1.0.0",
      pluginSettings: {
        updater: {
          endpoint: "https://updates.example.com/{{target}}/{{channel}}",
          authenticode: {
            publisherNames,
          },
        },
      },
      launch: {
        mode: "packaged",
        executablePath: "C:\\App.exe",
        args: [],
      },
    },
  };
}

/** A full check and download of one file through the Windows adapter wiring. */
async function download(source: string, publisherNames: string[]) {
  const bytes = readFileSync(source);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  const manifest = {
    version: "1.2.0",
    platforms: {
      "windows-x86_64": {
        url: "https://downloads.example.com/app.exe",
        sha256: hasher.digest("hex"),
        size: bytes.byteLength,
      },
    },
  };
  const root = mkdtempSync(join(folder, "data-"));
  const verifier = createAuthenticodeVerifier();
  const instance = createUpdater(
    "windows",
    "x64",
    environment(root, publisherNames),
    {
      fetchImpl: (async (input: URL) =>
        String(input).startsWith("https://updates.example.com/")
          ? new Response(JSON.stringify(manifest))
          : new Response(bytes)) as unknown as typeof fetch,
      files: createPackageFiles(root),
      signature: verifier,
    },
  );
  await instance.check();
  try {
    return {
      result: await instance.download(),
      error: undefined,
      root,
    };
  } catch (error) {
    return {
      result: undefined,
      error: error as BunawayError,
      root,
    };
  } finally {
    await instance.dispose();
  }
}

windowsOnly(
  "the adapter keeps a package signed by a listed publisher and removes the others",
  async () => {
    const accepted = await download(files.trusted as string, [
      "Someone Else",
      "Bunaway Test Publisher",
    ]);
    expect(accepted.error).toBeUndefined();
    expect(accepted.result?.path.endsWith(".package")).toBe(true);

    const mismatch = await download(files.trusted as string, [
      "Bunaway Untrusted Publisher",
    ]);
    expect(reasonOf(mismatch.error)).toBe("publisherMismatch");
    const unsigned = await download(files.unsigned as string, [
      "Bunaway Test Publisher",
    ]);
    expect(reasonOf(unsigned.error)).toBe("signatureMissing");
    const untrusted = await download(files.untrusted as string, [
      "Bunaway Untrusted Publisher",
    ]);
    expect(reasonOf(untrusted.error)).toBe("signatureUntrusted");
    for (const failed of [
      mismatch,
      unsigned,
      untrusted,
    ]) {
      expect(readdirOrEmpty(join(failed.root, "data", "updates"))).toEqual([]);
    }
  },
);

function reasonOf(error: BunawayError | undefined): unknown {
  const details = error?.details as
    | {
        reason?: string;
      }
    | undefined;
  return details?.reason;
}

function readdirOrEmpty(path: string): string[] {
  return existsSync(path) ? readdirSync(path) : [];
}
