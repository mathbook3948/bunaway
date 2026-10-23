import type { FFIFunction } from "bun:ffi";
import { open } from "node:fs/promises";
import { isRecord } from "@bunaway/protocol";
import { MAX_SIGNATURE_WORKERS } from "#updater/contract";
import { requestFromWorker } from "#updater/platforms/signature-worker";
import { fail } from "#updater/request";
import type { SignatureOutcome, SignatureVerifier } from "#updater/signature";

/**
 * wintrust.dll and crypt32.dll symbols the signature check calls. `WinVerifyTrust` can wait on
 * revocation servers for as long as the network takes, so the calls run in a worker thread and
 * the host thread keeps serving requests. The worker declares them from this one table.
 */
export const AUTHENTICODE_SYMBOLS = {
  WinVerifyTrust: {
    args: [
      "u64",
      "ptr",
      "ptr",
    ],
    returns: "i32",
  },
  WTHelperProvDataFromStateData: {
    args: [
      "u64",
    ],
    returns: "ptr",
  },
  WTHelperGetProvSignerFromChain: {
    args: [
      "ptr",
      "u32",
      "i32",
      "u32",
    ],
    returns: "ptr",
  },
  WTHelperGetProvCertFromChain: {
    args: [
      "ptr",
      "u32",
    ],
    returns: "ptr",
  },
  CertGetNameStringW: {
    args: [
      "ptr",
      "u32",
      "u32",
      "ptr",
      "ptr",
      "u32",
    ],
    returns: "u32",
  },
} as const satisfies Record<string, FFIFunction>;

/**
 * Source of the worker module. It is a string, not a file, because the plugin build bundles one
 * entry point and does not carry a separate worker file. The module is self-contained: it
 * imports only `bun:ffi` and receives the symbol table above.
 *
 * Protocol: one request `{ path }`, one reply that is `{ code, subject }` (the WinVerifyTrust
 * result, and the signer's subject name when the result is success) or `{ fail }` with a
 * message. The reply never carries pointers: the subject is copied before the trust state closes.
 */
const WORKER_BODY = `
import { dlopen, ptr, read } from "bun:ffi";

// WINTRUST_DATA and WINTRUST_FILE_INFO on x64: sizes and field offsets.
const WINTRUST_DATA_BYTES = 88;
const FILE_INFO_BYTES = 32;
const UI_CHOICE_OFFSET = 24;
const REVOCATION_CHECKS_OFFSET = 28;
const UNION_CHOICE_OFFSET = 32;
const FILE_POINTER_OFFSET = 40;
const STATE_ACTION_OFFSET = 48;
const STATE_HANDLE_OFFSET = 56;
const PROVIDER_FLAGS_OFFSET = 72;
const WTD_UI_NONE = 2;
// Check every certificate of the chain for revocation, except the root.
const WTD_REVOKE_WHOLECHAIN = 1;
const WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT = 0x80;
const WTD_CHOICE_FILE = 1;
const WTD_STATEACTION_VERIFY = 1;
const WTD_STATEACTION_CLOSE = 2;
// INVALID_HANDLE_VALUE as the window: no user interface may appear.
const NO_WINDOW = 0xffffffffffffffffn;
const CERT_NAME_RDN_TYPE = 2;
const CERT_X500_NAME_STR = 3;
const MAX_SUBJECT_CHARS = 2048;
// WINTRUST_ACTION_GENERIC_VERIFY_V2 {00AAC56B-CD44-11D0-8CC2-00C04FC295EE}.
const GENERIC_VERIFY_V2 = Buffer.from("6bc5aa0044cdd0118cc200c04fc295ee", "hex");

const wintrust = dlopen("wintrust.dll", WINTRUST_SYMBOLS);
const crypt32 = dlopen("crypt32.dll", CRYPT32_SYMBOLS);

function wide(text) {
  return Buffer.concat([Buffer.from(text, "utf16le"), Buffer.alloc(2)]);
}

// The subject of the first certificate of the first signer, or null when any step finds nothing.
function signerSubject(state) {
  const provider = wintrust.symbols.WTHelperProvDataFromStateData(state);
  const signer = provider && wintrust.symbols.WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
  const entry = signer && wintrust.symbols.WTHelperGetProvCertFromChain(signer, 0);
  // CRYPT_PROVIDER_CERT: a size field, then the certificate context pointer.
  const certificate = entry && read.ptr(entry, 8);
  if (!certificate) {
    return null;
  }
  const style = Buffer.alloc(4);
  style.writeUInt32LE(CERT_X500_NAME_STR, 0);
  const needed = crypt32.symbols.CertGetNameStringW(certificate, CERT_NAME_RDN_TYPE, 0, ptr(style), null, 0);
  if (needed < 2 || needed > MAX_SUBJECT_CHARS) {
    return null;
  }
  const text = Buffer.alloc(needed * 2);
  const written = crypt32.symbols.CertGetNameStringW(certificate, CERT_NAME_RDN_TYPE, 0, ptr(style), ptr(text), needed);
  if (written < 2 || written > needed) {
    return null;
  }
  return text.toString("utf16le", 0, (written - 1) * 2);
}

function verify(request) {
  const path = wide(request.path);
  const file = Buffer.alloc(FILE_INFO_BYTES);
  file.writeUInt32LE(FILE_INFO_BYTES, 0);
  file.writeBigUInt64LE(BigInt(ptr(path)), 8);
  const data = Buffer.alloc(WINTRUST_DATA_BYTES);
  data.writeUInt32LE(WINTRUST_DATA_BYTES, 0);
  data.writeUInt32LE(WTD_UI_NONE, UI_CHOICE_OFFSET);
  data.writeUInt32LE(WTD_REVOKE_WHOLECHAIN, REVOCATION_CHECKS_OFFSET);
  data.writeUInt32LE(WTD_CHOICE_FILE, UNION_CHOICE_OFFSET);
  data.writeBigUInt64LE(BigInt(ptr(file)), FILE_POINTER_OFFSET);
  data.writeUInt32LE(WTD_STATEACTION_VERIFY, STATE_ACTION_OFFSET);
  data.writeUInt32LE(WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT, PROVIDER_FLAGS_OFFSET);
  try {
    const code = wintrust.symbols.WinVerifyTrust(NO_WINDOW, ptr(GENERIC_VERIFY_V2), ptr(data)) >>> 0;
    const subject = code === 0 ? signerSubject(data.readBigUInt64LE(STATE_HANDLE_OFFSET)) : null;
    return { code, subject };
  } finally {
    // Every verify call is followed by a close, whatever its result, to release the trust state.
    data.writeUInt32LE(WTD_STATEACTION_CLOSE, STATE_ACTION_OFFSET);
    wintrust.symbols.WinVerifyTrust(NO_WINDOW, ptr(GENERIC_VERIFY_V2), ptr(data));
    // The native calls only saw these buffers' addresses: keep them reachable until the close returned.
    path.fill(0, 0, 0);
    file.fill(0, 0, 0);
    data.fill(0, 0, 0);
  }
}

self.onmessage = (event) => {
  let reply;
  try {
    reply = verify(event.data);
  } catch {
    reply = { fail: "Signature check failed." };
  }
  postMessage(reply);
  wintrust.close();
  crypt32.close();
};
`;

/** The complete worker module, with the symbol tables inlined as JSON (each library gets its own subset). */
export const AUTHENTICODE_WORKER_SOURCE = `const WINTRUST_SYMBOLS = ${JSON.stringify(
  {
    WinVerifyTrust: AUTHENTICODE_SYMBOLS.WinVerifyTrust,
    WTHelperProvDataFromStateData:
      AUTHENTICODE_SYMBOLS.WTHelperProvDataFromStateData,
    WTHelperGetProvSignerFromChain:
      AUTHENTICODE_SYMBOLS.WTHelperGetProvSignerFromChain,
    WTHelperGetProvCertFromChain:
      AUTHENTICODE_SYMBOLS.WTHelperGetProvCertFromChain,
  },
)};
const CRYPT32_SYMBOLS = ${JSON.stringify({
  CertGetNameStringW: AUTHENTICODE_SYMBOLS.CertGetNameStringW,
})};
${WORKER_BODY}`;

/** WinVerifyTrust results that mean the file carries no signature (or none this provider can read). */
const UNSIGNED_RESULTS = new Set([
  0x800b0100, // TRUST_E_NOSIGNATURE
  0x800b0001, // TRUST_E_PROVIDER_UNKNOWN
  0x800b0003, // TRUST_E_SUBJECT_FORM_UNKNOWN
]);
/** Results that mean the revocation status of a certificate in the chain could not be learned. */
const REVOCATION_UNAVAILABLE_RESULTS = new Set([
  0x80092012, // CRYPT_E_NO_REVOCATION_CHECK
  0x80092013, // CRYPT_E_REVOCATION_OFFLINE
  0x800b010e, // CERT_E_REVOCATION_FAILURE
]);

/**
 * Classify a WinVerifyTrust result that was not success. A revoked certificate, an untrusted
 * root, a bad digest and every code not listed are all `untrusted`: an unknown failure never passes.
 */
export function classifyTrustFailure(code: number): SignatureOutcome {
  const unsigned = code >>> 0;
  if (UNSIGNED_RESULTS.has(unsigned)) {
    return {
      kind: "unsigned",
    };
  }
  if (REVOCATION_UNAVAILABLE_RESULTS.has(unsigned)) {
    return {
      kind: "revocationUnavailable",
    };
  }
  return {
    kind: "untrusted",
  };
}

/** The worker's reply as an outcome; anything that is not a well-formed reply fails the check. */
export function parseTrustReply(reply: unknown): SignatureOutcome {
  if (isRecord(reply) && typeof reply.code === "number") {
    if (reply.code !== 0) {
      return classifyTrustFailure(reply.code);
    }
    // A valid signature without a readable signer cannot be matched to a publisher.
    if (typeof reply.subject === "string" && reply.subject !== "") {
      return {
        kind: "signed",
        subject: reply.subject,
      };
    }
  }
  throw fail(
    "INTERNAL",
    "signatureUntrusted",
    "Update package signature check failed.",
  );
}

const PE_MAGIC = [
  0x4d,
  0x5a,
] as const;
const MSI_MAGIC = [
  0xd0,
  0xcf,
  0x11,
  0xe0,
  0xa1,
  0xb1,
  0x1a,
  0xe1,
] as const;

/** Whether the file starts with the signature of a PE image (exe, dll) or an MSI (OLE compound) file. */
async function isSignableInstaller(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const header = Buffer.alloc(MSI_MAGIC.length);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    const startsWith = (magic: readonly number[]) =>
      bytesRead >= magic.length && magic.every((byte, i) => header[i] === byte);
    return startsWith(PE_MAGIC) || startsWith(MSI_MAGIC);
  } finally {
    await file.close();
  }
}

/**
 * The Windows signature check: Authenticode through `WinVerifyTrust` for PE and MSI files, with
 * the revocation status of the whole chain except the root required. The format is decided by the
 * file's first bytes, not its name, because packages are stored without an extension. `close`
 * terminates the workers still running; call it once when the plugin is disposed.
 */
export function createAuthenticodeVerifier(
  request: typeof requestFromWorker = requestFromWorker,
): {
  verify: SignatureVerifier;
  close(): void;
} {
  const workers = new Set<Worker>();
  return {
    async verify(path, signal) {
      if (!(await isSignableInstaller(path))) {
        return {
          kind: "unsupportedFormat",
        };
      }
      const reply = await request({
        source: AUTHENTICODE_WORKER_SOURCE,
        request: {
          path,
        },
        signal,
        workers,
        limit: MAX_SIGNATURE_WORKERS,
      });
      return parseTrustReply(reply);
    },
    close() {
      for (const worker of workers) {
        void worker.terminate();
      }
      workers.clear();
    },
  };
}
