import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NativeEnvironment } from "@bunaway/plugin";
import { BunawayError, type JsonValue } from "@bunaway/protocol";
import { createUpdater } from "#plugins/updater/src/adapter";
import { settingsSchema } from "#plugins/updater/src/contract";
import { parseDistinguishedName } from "#plugins/updater/src/distinguished-name";
import { createPackageFiles } from "#plugins/updater/src/platforms/package-files";
import { requestFromWorker } from "#plugins/updater/src/platforms/signature-worker";
import {
  classifyTrustFailure,
  createAuthenticodeVerifier,
  parseTrustReply,
} from "#plugins/updater/src/platforms/windows-authenticode";
import {
  publisherMatches,
  type SignatureOutcome,
  type SignatureVerifier,
} from "#plugins/updater/src/signature";

const ENDPOINT = "https://updates.example.com/{{target}}/{{channel}}";
const PACKAGE_URL = "https://downloads.example.com/app-1.2.0.exe";
const BYTES = new TextEncoder().encode("package-bytes-".repeat(64));
const SHA256 = createHash("sha256").update(BYTES).digest("hex");
const SUBJECT = 'CN="Example, Inc.", O=Example Corp, S=Seoul, C=KR';
const MANIFEST = {
  version: "1.2.0",
  platforms: {
    "windows-x86_64": {
      url: PACKAGE_URL,
      sha256: SHA256,
      size: BYTES.byteLength,
    },
  },
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunaway-updater-signature-"));
});

afterEach(() => {
  rmSync(root, {
    recursive: true,
    force: true,
  });
});

function updateFiles(): string[] {
  const folder = join(root, "data", "updates");
  return existsSync(folder) ? readdirSync(folder) : [];
}

function environment(authenticode: JsonValue | undefined): NativeEnvironment {
  return {
    dataRoot: root,
    capabilities: [],
    app: {
      id: "com.example.app",
      version: "1.0.0",
      pluginSettings: {
        updater: {
          endpoint: ENDPOINT,
          ...(authenticode === undefined
            ? {}
            : {
                authenticode,
              }),
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

const signedBy = (subject: string): SignatureOutcome => ({
  kind: "signed",
  subject,
});

/** An updater whose package server and signature check are fakes; `calls` records every file checked. */
function setup(
  authenticode: JsonValue | undefined,
  outcome:
    | SignatureOutcome
    | ((signal: AbortSignal) => Promise<SignatureOutcome>)
    | null,
) {
  const calls: {
    path: string;
    existedAsPartial: boolean;
  }[] = [];
  let packageRequests = 0;
  let closed = 0;
  const verify: SignatureVerifier = async (path, signal) => {
    calls.push({
      path,
      existedAsPartial: path.endsWith(".partial"),
    });
    signal.throwIfAborted();
    return typeof outcome === "function"
      ? outcome(signal)
      : (outcome as SignatureOutcome);
  };
  const fetchImpl = (async (input: URL) => {
    if (String(input).startsWith("https://updates.example.com/")) {
      return new Response(JSON.stringify(MANIFEST));
    }
    packageRequests += 1;
    return new Response(BYTES);
  }) as unknown as typeof fetch;
  const instance = createUpdater("windows", "x64", environment(authenticode), {
    fetchImpl,
    files: createPackageFiles(root),
    ...(outcome === null
      ? {}
      : {
          signature: {
            verify,
            close: () => {
              closed += 1;
            },
          },
        }),
  });
  return {
    instance,
    calls,
    packageRequests: () => packageRequests,
    closed: () => closed,
  };
}

async function failure(promise: Promise<unknown>): Promise<BunawayError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BunawayError);
    return error as BunawayError;
  }
  throw new Error("Expected the download to fail.");
}

function reasonOf(error: BunawayError): unknown {
  return (
    error.details as {
      reason?: string;
    }
  ).reason;
}

const PUBLISHERS = {
  publisherNames: [
    "Example, Inc.",
  ],
};

test("a distinguished name is parsed from both the Windows and the RFC 2253 spelling", () => {
  expect(parseDistinguishedName(SUBJECT, "windows")).toEqual([
    {
      key: "CN",
      value: "Example, Inc.",
    },
    {
      key: "O",
      value: "Example Corp",
    },
    {
      key: "ST",
      value: "Seoul",
    },
    {
      key: "C",
      value: "KR",
    },
  ]);
  expect(
    parseDistinguishedName("cn=Example\\, Inc.,O=A\\2BB", "rfc2253"),
  ).toEqual([
    {
      key: "CN",
      value: "Example, Inc.",
    },
    {
      key: "O",
      value: "A+B",
    },
  ]);
  for (const bad of [
    "",
    "Example",
    "CN=",
    "=x",
    'CN="open',
    "CN=#0403414243",
    "CN=\\",
    "CN=\\ff",
  ]) {
    expect(parseDistinguishedName(bad, "rfc2253")).toBeNull();
  }
});

test("a publisher entry matches only on an exact, case sensitive common name or on every listed attribute", () => {
  expect(publisherMatches(SUBJECT, "Example, Inc.")).toBe(true);
  expect(publisherMatches(SUBJECT, "example, inc.")).toBe(false);
  expect(publisherMatches(SUBJECT, "Example")).toBe(false);
  expect(publisherMatches(SUBJECT, "Example, Inc. ")).toBe(false);
  expect(publisherMatches(SUBJECT, "Example Corp")).toBe(false);
  expect(publisherMatches(SUBJECT, "CN=Example\\, Inc.,C=KR")).toBe(true);
  expect(publisherMatches(SUBJECT, "O=Example Corp, ST=Seoul")).toBe(true);
  expect(publisherMatches(SUBJECT, "CN=Example\\, Inc.,C=US")).toBe(false);
  expect(publisherMatches(SUBJECT, "CN=Example\\, Inc.,L=Seoul")).toBe(false);
  expect(publisherMatches(SUBJECT, "CN=Example")).toBe(false);
  expect(publisherMatches("not a name", "not a name")).toBe(false);
  expect(publisherMatches(SUBJECT, "CN=#0403414243")).toBe(false);
});

test("a backslash in the signer's subject is an ordinary character, and a subject with two common names matches none", () => {
  // Windows prints a literal backslash as is, so it must not be decoded as an escape.
  expect(publisherMatches("CN=\\Victim Corp", "Victim Corp")).toBe(false);
  expect(publisherMatches("CN=\\56ictim Corp", "Victim Corp")).toBe(false);
  expect(publisherMatches("CN=\\Victim Corp", "\\Victim Corp")).toBe(true);
  expect(publisherMatches("CN=Foo\\Bar, O=Org", "Foo\\Bar")).toBe(true);
  expect(publisherMatches("CN=\\Victim Corp", "CN=Victim Corp")).toBe(false);
  expect(publisherMatches('CN="Say ""hi""", O=Org', 'Say "hi"')).toBe(true);
  expect(publisherMatches("CN=Attacker, CN=Victim Corp", "Victim Corp")).toBe(
    false,
  );
  expect(
    publisherMatches("CN=Attacker, CN=Victim Corp", "CN=Victim Corp"),
  ).toBe(true);
});

test("only ASCII spaces around a value are ignored, so a name with a format or no-break space character does not match", () => {
  expect(publisherMatches("CN=Victim Corp , O=Org", "Victim Corp")).toBe(true);
  // U+FEFF, U+00A0, U+200B and a tab: characters `String.prototype.trim` would drop.
  for (const code of [
    0xfeff,
    0xa0,
    0x200b,
    0x09,
  ]) {
    const extra = String.fromCodePoint(code);
    expect(
      publisherMatches(`CN=Victim Corp${extra}, O=Org`, "Victim Corp"),
    ).toBe(false);
    expect(
      publisherMatches(`CN=${extra}Victim Corp, O=Org`, "CN=Victim Corp"),
    ).toBe(false);
    expect(
      publisherMatches(`CN=Victim Corp${extra}, O=Org`, `Victim Corp${extra}`),
    ).toBe(true);
  }
});

test("the authenticode setting needs one to eight valid publisher names and nothing else", () => {
  const parse = (authenticode: unknown) =>
    settingsSchema.safeParse({
      endpoint: ENDPOINT,
      authenticode,
    }).success;
  expect(parse(undefined)).toBe(true);
  expect(parse(PUBLISHERS)).toBe(true);
  expect(
    parse({
      publisherNames: [
        "CN=Example,O=Org",
      ],
    }),
  ).toBe(true);
  expect(
    parse({
      publisherNames: [],
    }),
  ).toBe(false);
  expect(
    parse({
      publisherNames: Array.from(
        {
          length: 9,
        },
        (_, index) => `Name ${index}`,
      ),
    }),
  ).toBe(false);
  expect(
    parse({
      publisherNames: [
        "",
      ],
    }),
  ).toBe(false);
  expect(
    parse({
      publisherNames: [
        "CN=",
      ],
    }),
  ).toBe(false);
  expect(
    parse({
      publisherNames: [
        "x".repeat(257),
      ],
    }),
  ).toBe(false);
  expect(
    parse({
      publisherNames: [
        "Example",
      ],
      thumbprint: "00",
    }),
  ).toBe(false);
  expect(parse({})).toBe(false);
});

test("without the setting the signature is never checked", async () => {
  const { instance, calls } = setup(undefined, signedBy(SUBJECT));
  await instance.check();
  await instance.download();
  expect(calls).toEqual([]);
});

test("a new package is checked under its partial name and published only after an accepted publisher", async () => {
  const { instance, calls } = setup(PUBLISHERS, signedBy(SUBJECT));
  await instance.check();
  const result = await instance.download();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.existedAsPartial).toBe(true);
  expect(result.path.endsWith(`${SHA256}.package`)).toBe(true);
  expect(updateFiles()).toEqual([
    `${SHA256}.package`,
  ]);
});

test("an intact package from an earlier download is checked again before it is reused", async () => {
  const first = setup(PUBLISHERS, signedBy(SUBJECT));
  await first.instance.check();
  await first.instance.download();
  const second = setup(
    {
      publisherNames: [
        "Another Publisher",
      ],
    },
    signedBy(SUBJECT),
  );
  await second.instance.check();
  const error = await failure(second.instance.download());
  expect(reasonOf(error)).toBe("publisherMismatch");
  expect(second.calls).toHaveLength(1);
  expect(second.calls[0]?.existedAsPartial).toBe(false);
  expect(second.packageRequests()).toBe(0);
  expect(updateFiles()).toEqual([]);
});

test.each([
  [
    {
      kind: "signed",
      subject: 'CN="Other, Inc."',
    },
    "INTERNAL",
    "publisherMismatch",
  ],
  [
    {
      kind: "unsigned",
    },
    "INTERNAL",
    "signatureMissing",
  ],
  [
    {
      kind: "untrusted",
    },
    "INTERNAL",
    "signatureUntrusted",
  ],
  [
    {
      kind: "revocationUnavailable",
    },
    "INTERNAL",
    "revocationUnavailable",
  ],
  [
    {
      kind: "unsupportedFormat",
    },
    "UNSUPPORTED",
    "signatureUnsupported",
  ],
] as const)(
  "a package whose check ends in %j fails with %s and %s, leaves no file and names no detail",
  async (outcome, code, reason) => {
    const { instance } = setup(PUBLISHERS, outcome);
    await instance.check();
    const error = await failure(instance.download());
    expect(error.code).toBe(code);
    expect(reasonOf(error)).toBe(reason);
    expect(error.message).not.toContain("Other");
    expect(error.message).not.toContain(root);
    expect(JSON.stringify(error.details)).not.toContain(root);
    expect(updateFiles()).toEqual([]);
  },
);

test("a platform without a signature check refuses the download before any request", async () => {
  const { instance, packageRequests } = setup(PUBLISHERS, null);
  await instance.check();
  const error = await failure(instance.download());
  expect(error.code).toBe("UNSUPPORTED");
  expect(reasonOf(error)).toBe("signatureUnsupported");
  expect(packageRequests()).toBe(0);
  expect(updateFiles()).toEqual([]);
});

test("cancelling while the signature is checked stops the download and removes the partial file", async () => {
  const controller = new AbortController();
  const { instance, calls } = setup(PUBLISHERS, (signal) => {
    controller.abort();
    return new Promise<SignatureOutcome>((_resolve, reject) => {
      // The caller's abort has already reached the signal when the check starts waiting.
      if (signal.aborted) {
        reject(signal.reason);
      }
    });
  });
  await instance.check();
  const error = await failure(instance.download(controller.signal));
  expect(error.code).toBe("CANCELLED");
  expect(calls).toHaveLength(1);
  expect(updateFiles()).toEqual([]);
});

test("dispose releases the signature check's resources once the running download has ended", async () => {
  const { instance, closed } = setup(PUBLISHERS, signedBy(SUBJECT));
  await instance.check();
  await instance.download();
  expect(closed()).toBe(0);
  await instance.dispose();
  expect(closed()).toBe(1);
});

test("a WinVerifyTrust result is classified, and an unknown failure never passes", () => {
  const unsigned = 0x800b0100;
  expect(classifyTrustFailure(unsigned | 0)).toEqual({
    kind: "unsigned",
  });
  for (const code of [
    0x80092012,
    0x80092013,
    0x800b010e,
  ]) {
    expect(classifyTrustFailure(code | 0)).toEqual({
      kind: "revocationUnavailable",
    });
  }
  // CERT_E_REVOKED, CERT_E_UNTRUSTEDROOT, TRUST_E_BAD_DIGEST, an unlisted code
  for (const code of [
    0x800b010c,
    0x800b0109,
    0x80096010,
    0x12345678,
  ]) {
    expect(classifyTrustFailure(code | 0)).toEqual({
      kind: "untrusted",
    });
  }
  expect(
    parseTrustReply({
      code: 0,
      subject: SUBJECT,
    }),
  ).toEqual(signedBy(SUBJECT));
  expect(() =>
    parseTrustReply({
      code: 0,
      subject: null,
    }),
  ).toThrow();
  for (const reply of [
    {
      fail: "x",
    },
    null,
  ]) {
    try {
      parseTrustReply(reply);
      throw new Error("Expected the reply to be refused.");
    } catch (error) {
      expect(reasonOf(error as BunawayError)).toBe("verifierFailed");
    }
  }
});

/** A worker double that records messages and lets the test reply or fail it. */
function fakeWorkers() {
  const created: {
    worker: Worker;
    reply(value: unknown): void;
    terminated: () => boolean;
  }[] = [];
  const start = () => {
    let terminated = false;
    const fake = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null,
      onmessageerror: null,
      postMessage() {},
      addEventListener() {},
      terminate() {
        terminated = true;
        return Promise.resolve(0);
      },
    };
    created.push({
      worker: fake as unknown as Worker,
      reply: (value) =>
        fake.onmessage?.({
          data: value,
        } as MessageEvent),
      terminated: () => terminated,
    });
    return {
      worker: fake as unknown as Worker,
      release() {},
    };
  };
  return {
    created,
    start,
  };
}

test("an aborted signature check frees the caller at once but keeps its slot until the worker replies", async () => {
  const { created, start } = fakeWorkers();
  const workers = new Set<Worker>();
  const controller = new AbortController();
  const options = (signal: AbortSignal) => ({
    source: "",
    request: {},
    signal,
    workers,
    limit: 1,
  });
  const first = requestFromWorker(options(controller.signal), start);
  controller.abort(new Error("stop"));
  await expect(first).rejects.toThrow("stop");
  // The native call may still run: the slot stays taken and a second check is refused.
  expect(workers.size).toBe(1);
  expect(created[0]?.terminated()).toBe(false);
  const refused = await failure(
    requestFromWorker(options(new AbortController().signal), start),
  );
  expect(reasonOf(refused)).toBe("verifierBusy");
  created[0]?.reply({
    code: 0,
  });
  expect(workers.size).toBe(0);
  expect(created[0]?.terminated()).toBe(true);
});

test("a signature check answers with the worker's reply and retires the worker", async () => {
  const { created, start } = fakeWorkers();
  const workers = new Set<Worker>();
  const pending = requestFromWorker(
    {
      source: "",
      request: {},
      signal: new AbortController().signal,
      workers,
      limit: 2,
    },
    start,
  );
  created[0]?.reply({
    code: 1,
  });
  expect(await pending).toEqual({
    code: 1,
  });
  expect(workers.size).toBe(0);
  expect(created[0]?.terminated()).toBe(true);
});

test("a worker that cannot start or an installer that cannot be read fails the check with verifierFailed", async () => {
  const refused = await failure(
    requestFromWorker(
      {
        source: "",
        request: {},
        signal: new AbortController().signal,
        workers: new Set<Worker>(),
        limit: 2,
      },
      () => {
        throw new Error("no workers here");
      },
    ),
  );
  expect(reasonOf(refused)).toBe("verifierFailed");
  expect(refused.message).not.toContain("no workers");
  const unreadable = await failure(
    createAuthenticodeVerifier().verify(
      join(root, "missing.package"),
      new AbortController().signal,
    ),
  );
  expect(reasonOf(unreadable)).toBe("verifierFailed");
  expect(unreadable.message).not.toContain(root);
});

test("the Windows verifier rejects files that are neither PE nor MSI before any worker starts", async () => {
  const text = join(root, "notes.txt");
  const pe = join(root, "installer.exe");
  const msi = join(root, "installer.msi");
  writeFileSync(text, "plain text, not an installer");
  writeFileSync(
    pe,
    Buffer.from([
      0x4d,
      0x5a,
      0x90,
      0x00,
    ]),
  );
  writeFileSync(
    msi,
    Buffer.from([
      0xd0,
      0xcf,
      0x11,
      0xe0,
      0xa1,
      0xb1,
      0x1a,
      0xe1,
      0x00,
    ]),
  );
  const sent: unknown[] = [];
  const verifier = createAuthenticodeVerifier((async (options: {
    request: unknown;
  }) => {
    sent.push(options.request);
    return {
      code: 0,
      subject: SUBJECT,
    };
  }) as typeof requestFromWorker);
  const signal = new AbortController().signal;
  expect(await verifier.verify(text, signal)).toEqual({
    kind: "unsupportedFormat",
  });
  expect(sent).toEqual([]);
  expect(await verifier.verify(pe, signal)).toEqual(signedBy(SUBJECT));
  expect(await verifier.verify(msi, signal)).toEqual(signedBy(SUBJECT));
  expect(sent).toEqual([
    {
      path: pe,
    },
    {
      path: msi,
    },
  ]);
  verifier.close();
});
