import type { BunawayError } from "@bunaway/protocol";
import { parseDistinguishedName } from "#updater/distinguished-name";
import { fail } from "#updater/request";

/** What a platform verifier found out about an installer file. */
export type SignatureOutcome =
  /** A valid, trusted signature; `subject` is the signing certificate's subject name. */
  | {
      kind: "signed";
      subject: string;
    }
  /** The file is not a format the platform signs (for Windows: not a PE or MSI file). */
  | {
      kind: "unsupportedFormat";
    }
  | {
      kind: "unsigned";
    }
  /** A signature exists but is invalid, tampered, revoked or does not chain to a trusted root. */
  | {
      kind: "untrusted";
    }
  /** The revocation servers could not be reached, so the signature cannot be called good. */
  | {
      kind: "revocationUnavailable";
    };

/**
 * Check the file at `path`, which is a package this plugin wrote into its own update folder.
 * Rejects with the cancellation reason when `signal` aborts; a verifier that cannot run rejects too.
 */
export type SignatureVerifier = (
  path: string,
  signal: AbortSignal,
) => Promise<SignatureOutcome>;

/** The `plugins.updater.authenticode` clause with the verifier the platform supplies. */
export type SignatureCheck = {
  publisherNames: readonly string[];
  verify: SignatureVerifier;
};

/**
 * Whether one `publisherNames` entry names the signer. An entry without `=` is a common name and
 * must equal the subject's only CN exactly. An entry with `=` is a distinguished name and every
 * attribute it lists must appear in the subject with the same value. Comparison is exact and case
 * sensitive; nothing is normalized, trimmed inside values or matched by prefix.
 */
export function publisherMatches(subject: string, entry: string): boolean {
  const attributes = parseDistinguishedName(subject, "windows");
  if (attributes === null) {
    return false;
  }
  if (!entry.includes("=")) {
    // A subject with several CN attributes has no single common name, so none is accepted.
    const names = attributes.filter((attribute) => attribute.key === "CN");
    return names.length === 1 && names[0]?.value === entry;
  }
  const wanted = parseDistinguishedName(entry, "rfc2253");
  if (wanted === null) {
    return false;
  }
  return wanted.every((pair) =>
    attributes.some(
      (attribute) =>
        attribute.key === pair.key && attribute.value === pair.value,
    ),
  );
}

/**
 * Turn a verifier outcome into the download's failure. Messages never carry the certificate
 * subject, the file path or an operating system code, so a failure shown to the user or the
 * web view reveals nothing about the package beyond the reason.
 */
export function signatureFailure(
  outcome: SignatureOutcome,
  publisherNames: readonly string[],
): BunawayError | null {
  switch (outcome.kind) {
    case "signed":
      return publisherNames.some((entry) =>
        publisherMatches(outcome.subject, entry),
      )
        ? null
        : fail(
            "INTERNAL",
            "publisherMismatch",
            "Update package is not signed by an accepted publisher.",
          );
    case "unsupportedFormat":
      return fail(
        "UNSUPPORTED",
        "signatureUnsupported",
        "Update package is not a file format that carries a signature.",
      );
    case "unsigned":
      return fail(
        "INTERNAL",
        "signatureMissing",
        "Update package has no digital signature.",
      );
    case "untrusted":
      return fail(
        "INTERNAL",
        "signatureUntrusted",
        "Update package signature is not valid or not trusted.",
      );
    case "revocationUnavailable":
      return fail(
        "INTERNAL",
        "revocationUnavailable",
        "Update package signature could not be checked for revocation.",
      );
  }
}
