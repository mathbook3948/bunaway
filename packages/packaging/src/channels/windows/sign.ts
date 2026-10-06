import { resolve } from "node:path";
import { CODES, type StageContext } from "../../contract.ts";
import { findWindowsKitTool, must } from "./common.ts";

const DEFAULT_TIMESTAMP_URL = "http://timestamp.digicert.com";

// Signing is an optional adapter stage driven by developer-provided
// credentials. The config only references credentials (certificate file,
// cert-store thumbprint, env var name holding the password); the values are
// never written to disk by this package. Missing credentials surface as
// PKG_SIGNING_MISSING diagnostics, tool failures as PKG_SIGNING_FAILED.

// Args shared by every signtool invocation for the resolved signing config.
export function signingArgs(ctx: StageContext): string[] {
  const signing = ctx.input.signing;
  if (!signing) return [];
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
        throw new Error(`Missing signing password in environment variable ${signing.passwordEnv}.`);
      }
      args.push("/p", password);
    }
  } else if (signing.thumbprint) {
    args.push("/sha1", signing.thumbprint);
  }
  if (signing.subject) args.push("/n", signing.subject);
  return args;
}

// Signs PE files (.exe/.dll/.msix) in place. Returns the signtool path used.
// Throws when signing is configured but signtool is unavailable.
export async function signFiles(ctx: StageContext, files: string[]): Promise<string> {
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
    throw new Error("signtool.exe not found; install the Windows 10/11 SDK signing tools.");
  }
  try {
    await must(signtool, ["sign", ...signingArgs(ctx), ...files]);
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

// Verifies Authenticode signatures on the produced package files.
export async function verifySignatures(ctx: StageContext, files: string[]): Promise<void> {
  const signtool = await findWindowsKitTool("signtool.exe");
  if (!signtool) {
    ctx.report({
      code: CODES.TOOL_MISSING,
      severity: "warning",
      message: "signtool.exe not found; signature verification skipped.",
    });
    return;
  }
  for (const file of files) {
    try {
      await must(signtool, ["verify", "/pa", file]);
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
