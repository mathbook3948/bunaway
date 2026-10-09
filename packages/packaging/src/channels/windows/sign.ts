import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CODES, type StageContext } from "../../contract.ts";
import { findWindowsKitTool, must, run } from "./common.ts";

const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

// Signing is an optional adapter stage driven by developer-provided
// credentials. The config only references credentials (certificate file,
// cert-store thumbprint, env var name holding the password); the values are
// never written to disk by this package. Missing credentials surface as
// PKG_SIGNING_MISSING diagnostics, tool failures as PKG_SIGNING_FAILED.

/**
 * Builds signtool arguments using passwords only from the configured env var.
 * Reports and throws when that variable is configured but empty.
 */
export function signingArgs(ctx: StageContext): string[] {
  const signing = ctx.input.signing;
  if (!signing) {
    return [];
  }
  const args = [
    "/fd",
    "SHA256",
    "/td",
    "SHA256",
    "/tr",
    signing.timestampUrl ?? DEFAULT_TIMESTAMP_URL,
  ];
  if (signing.certificateFile) {
    args.push("/f", resolve(ctx.input.metadata.root, signing.certificateFile));
    if (signing.passwordEnv) {
      const password = process.env[signing.passwordEnv];
      if (!password) {
        ctx.report({
          code: CODES.SIGNING_FAILED,
          severity: "error",
          message: `signing.passwordEnv is set to ${signing.passwordEnv} but that environment variable is empty.`,
        });
        throw new Error(
          `Missing signing password in environment variable ${signing.passwordEnv}.`,
        );
      }
      args.push("/p", password);
    }
  } else if (signing.thumbprint) {
    args.push("/sha1", signing.thumbprint);
  }
  if (signing.subject) {
    args.push("/n", signing.subject);
  }
  return args;
}

/**
 * Signs supplied paths in place and returns the signtool path. Callers pass
 * staging copies to keep build inputs unchanged.
 * Without signing configuration it reports an informational diagnostic and
 * returns an empty string; configured signing failures are reported and thrown.
 */
export async function signFiles(
  ctx: StageContext,
  files: string[],
): Promise<string> {
  const signing = ctx.input.signing;
  if (!signing) {
    ctx.report({
      code: CODES.SIGNING_MISSING,
      severity: "info",
      message: "Signing not configured; leaving files unsigned.",
    });
    return "";
  }
  const signtool = await findWindowsKitTool("signtool.exe");
  if (!signtool) {
    ctx.report({
      code: CODES.TOOL_MISSING,
      severity: "error",
      message:
        "Signing is configured but signtool.exe was not found in the Windows SDK bin directory.",
    });
    throw new Error(
      "signtool.exe not found; install the Windows 10/11 SDK signing tools.",
    );
  }
  try {
    await must(signtool, [
      "sign",
      ...signingArgs(ctx),
      ...files,
    ]);
  } catch (error) {
    ctx.report({
      code: CODES.SIGNING_FAILED,
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
  ctx.report({
    code: CODES.SIGNING_FAILED,
    severity: "info",
    message: `Signed ${files.length} file(s) with signtool.`,
  });
  return signtool;
}

/**
 * Checks that a signed file chains to Microsoft's cached AuthRoot CTL, as
 * required for Store EXE submissions. The extracted root certificate is
 * removed from staging even when verification fails.
 */
export async function verifyStoreCertificate(
  ctx: StageContext,
  file: string,
): Promise<void> {
  const rootFile = join(ctx.staging, `signing-root-${crypto.randomUUID()}.cer`);
  const windows = process.env.SystemRoot ?? "C:\\Windows";
  try {
    await must(
      join(windows, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference = 'Stop'
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
  [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($env:BUNAWAY_VERIFY_FILE))
$chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
$certificates = [System.Security.Cryptography.X509Certificates.X509Certificate2Collection]::new()
try {
  $certificates.Import($env:BUNAWAY_VERIFY_FILE)
  $chain.ChainPolicy.ExtraStore.AddRange($certificates)
  $chain.ChainPolicy.RevocationMode = 'NoCheck'
  $chain.ChainPolicy.VerificationFlags = 'IgnoreNotTimeValid'
  [void]$chain.Build($certificate)
  $root = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate
  [IO.File]::WriteAllBytes($env:BUNAWAY_VERIFY_ROOT, $root.Export('Cert'))
} finally {
  $chain.Dispose()
  $certificate.Dispose()
  foreach ($extra in $certificates) { $extra.Dispose() }
}`,
      ],
      {
        env: {
          ...process.env,
          BUNAWAY_VERIFY_FILE: file,
          BUNAWAY_VERIFY_ROOT: rootFile,
        },
      },
    );
    const result = await run(join(windows, "System32", "certutil.exe"), [
      "-verifyCTL",
      "AuthRoot",
      ctx.staging,
      rootFile,
    ]);
    if (result.code !== 0) {
      throw new Error(
        "Store EXE signing must chain to a Microsoft Trusted Root Program CA; the root is absent from the cached AuthRoot CTL or the CTL could not be verified. Local/private trust is insufficient.",
      );
    }
  } finally {
    await rm(rootFile, {
      force: true,
    });
  }
}

/**
 * Verifies Authenticode signatures and channel certificate rules, reporting
 * failures through the stage context instead of throwing them to the runner.
 */
export async function verifySignatures(
  ctx: StageContext,
  files: string[],
): Promise<void> {
  const signtool = await findWindowsKitTool("signtool.exe");
  if (!signtool) {
    ctx.report({
      code: CODES.TOOL_MISSING,
      severity: "error",
      message: "signtool.exe not found; signature verification cannot proceed.",
    });
    return;
  }
  for (const file of files) {
    try {
      await must(signtool, [
        "verify",
        "/pa",
        file,
      ]);
      if (ctx.input.channel === "win-store-unpackaged") {
        await verifyStoreCertificate(ctx, file);
      }
    } catch (error) {
      ctx.report({
        code: CODES.VERIFY_FAILED,
        severity: "error",
        message: `Signature verification failed for ${file}: ${error instanceof Error ? error.message : String(error)}`,
        path: file,
      });
    }
  }
}
