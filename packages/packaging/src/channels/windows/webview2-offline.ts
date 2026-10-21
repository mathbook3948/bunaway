import { copyFile, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { StageContext } from "../../contract.ts";
import { findWindowsKitTool, must } from "./common.ts";

// Offline WebView2 mode embeds an Evergreen Standalone Installer that the app
// supplies. The installer runs at install time, so the build refuses any file
// that is not the right architecture and Microsoft signed. There is no
// fallback to check-only: a rejected file fails the build.

type TargetArch = "x64" | "arm64";

/** PE `Machine` field values for the architectures a WebView2 installer targets. */
const PE_MACHINE: Record<TargetArch, number> = {
  x64: 0x8664,
  arm64: 0xaa64,
};

/** PE `Machine` of 32-bit x86 files; Microsoft's Edge Update based installers can be x86 for every target. */
const PE_MACHINE_X86 = 0x14c;

/** The PE headers sit inside this prefix of the file. */
const PE_HEADER_READ_BYTES = 4096;
const DOS_PE_POINTER_OFFSET = 0x3c;
const PE_SIGNATURE = 0x00004550;

/** Certificate simple name Microsoft uses to sign the WebView2 Runtime installers. */
export const WEBVIEW2_SIGNER = "Microsoft Corporation";

/**
 * Reads the `Machine` field of a PE file header, or undefined when the bytes
 * are not a PE image.
 */
export function readPeMachine(header: Uint8Array): number | undefined {
  if (header.byteLength < DOS_PE_POINTER_OFFSET + 4) {
    return undefined;
  }
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  const peOffset = view.getUint32(DOS_PE_POINTER_OFFSET, true);
  if (peOffset + 6 > header.byteLength) {
    return undefined;
  }
  if (view.getUint32(peOffset, true) !== PE_SIGNATURE) {
    return undefined;
  }
  return view.getUint16(peOffset + 4, true);
}

async function readHeader(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(PE_HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Throws unless the file is a PE image built for the target architecture. */
async function requireArchitecture(
  path: string,
  arch: TargetArch,
): Promise<void> {
  const machine = readPeMachine(await readHeader(path));
  if (machine === undefined) {
    throw new Error(`${path} is not a Windows executable.`);
  }
  // An x86 installer runs on both x64 and arm64 Windows, so it is accepted for
  // either target; any other machine must match the target.
  if (machine !== PE_MACHINE[arch] && machine !== PE_MACHINE_X86) {
    throw new Error(
      `${path} was built for another architecture (machine 0x${machine.toString(16)}); the ${arch} target needs the ${arch} Standalone Installer.`,
    );
  }
}

/** Throws unless the Authenticode signature is valid and the signer is Microsoft. */
async function requireMicrosoftSignature(path: string): Promise<void> {
  const signtool = await findWindowsKitTool("signtool.exe");
  if (!signtool) {
    throw new Error(
      "signtool.exe not found; the WebView2 Standalone Installer signature cannot be verified.",
    );
  }
  await must(signtool, [
    "verify",
    "/pa",
    path,
  ]);
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  const result = await must(
    join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference = 'Stop'
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
  [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($env:BUNAWAY_VERIFY_FILE))
try { $certificate.GetNameInfo('SimpleName', $false) } finally { $certificate.Dispose() }`,
    ],
    {
      env: {
        ...process.env,
        BUNAWAY_VERIFY_FILE: path,
      },
    },
  );
  const signer = result.stdout.trim();
  if (signer !== WEBVIEW2_SIGNER) {
    throw new Error(
      `${path} is signed by "${signer}", not ${WEBVIEW2_SIGNER}.`,
    );
  }
}

/** The configured installer path for the target architecture; throws when the app set none. */
export function requireInstallerPath(
  installers: Partial<Record<TargetArch, string>>,
  arch: TargetArch,
): string {
  const configured = installers[arch];
  if (!configured) {
    throw new Error(
      `webView2.installers.${arch} is not set; the ${arch} target needs a Standalone Installer.`,
    );
  }
  return configured;
}

/**
 * Validates the app-supplied Standalone Installer for the build target and
 * copies it into staging, returning the staged path the installer embeds.
 * Every failure throws so the build fails; the staged copy is discarded with
 * the rest of staging.
 */
export async function stageOfflineInstaller(
  ctx: StageContext,
  installers: Partial<Record<TargetArch, string>>,
  arch: TargetArch,
): Promise<string> {
  const configured = requireInstallerPath(installers, arch);
  const root = await realpath(ctx.input.metadata.root);
  const source = resolve(root, configured);
  const file = Bun.file(source);
  if (!(await file.exists()) || file.size === 0) {
    throw new Error(`WebView2 Standalone Installer not found: ${source}.`);
  }
  // Links and junctions must not lead out of the project.
  const real = await realpath(source);
  const fromRoot = relative(root, real);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(
      `WebView2 Standalone Installer ${source} resolves outside the project.`,
    );
  }
  const dest = join(
    ctx.staging,
    "webview2",
    `MicrosoftEdgeWebView2RuntimeInstaller${arch}.exe`,
  );
  await mkdir(dirname(dest), {
    recursive: true,
  });
  // Check the staged copy so the verified bytes are the embedded bytes.
  await copyFile(real, dest);
  await requireArchitecture(dest, arch);
  await requireMicrosoftSignature(dest);
  return dest;
}
