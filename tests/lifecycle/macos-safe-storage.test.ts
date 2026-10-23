import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { JsonValue } from "@bunaway/protocol";
import { transformMacosEnvelope } from "../../plugins/safe-storage/src/platforms/macos-envelope.ts";
import {
  keychainError,
  type MacosKeychainStore,
  secretAccount,
} from "../../plugins/safe-storage/src/platforms/macos-key-store.ts";
import { macosSafeStorageOperations as macosOperations } from "../fixtures/injected-native-plugins.ts";

function fixture() {
  let stored: Buffer | null = null;
  let failure: Error | undefined;
  const counts = {
    opened: 0,
    read: 0,
    add: 0,
    disposed: 0,
  };
  const copies: Buffer[] = [];
  const secrets = new Map<string, Buffer>();
  const secretCopies: Buffer[] = [];
  const store: MacosKeychainStore = {
    available: () => !failure,
    read() {
      counts.read++;
      if (failure) {
        throw failure;
      }
      const copy = stored && Buffer.from(stored);
      if (copy) {
        copies.push(copy);
      }
      return copy;
    },
    add(key) {
      counts.add++;
      if (stored) {
        return false;
      }
      stored = Buffer.from(key);
      return true;
    },
    setSecret(key, value) {
      if (failure) {
        throw failure;
      }
      // The Keychain keeps its own copy; the caller's buffer is zeroed afterwards.
      secrets.set(key, Buffer.from(value));
      secretCopies.push(value);
    },
    getSecret(key) {
      if (failure) {
        throw failure;
      }
      const stored = secrets.get(key);
      const copy = stored && Buffer.from(stored);
      if (copy) {
        secretCopies.push(copy);
      }
      return copy ?? null;
    },
    deleteSecret(key) {
      if (failure) {
        throw failure;
      }
      return secrets.delete(key);
    },
    dispose() {
      counts.disposed++;
    },
  };
  const open = () => {
    counts.opened++;
    return store;
  };
  return {
    counts,
    copies,
    secrets,
    secretCopies,
    store,
    open,
    fail(status: number) {
      failure = keychainError(status);
    },
    restore() {
      failure = undefined;
    },
    replace(bytes: Buffer | null) {
      stored?.fill(0);
      stored = bytes;
    },
  };
}

test("macOS operations are lazy, do not provision on availability or decrypt, and wipe per-call keys", async () => {
  const f = fixture();
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  expect(f.counts.opened).toBe(0);
  for (const name of [
    "safe-storage.constructor",
    "other.isAvailable",
  ]) {
    await expect(adapter.execute(name, null, "backend")).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  }
  await expect(
    adapter.execute(
      "safe-storage.encryptString",
      {
        text: 1,
      },
      "backend",
    ),
  ).rejects.toThrow("Invalid plugin input.");
  expect(f.counts.opened).toBe(0);
  expect(
    await adapter.execute("safe-storage.isAvailable", null, "backend"),
  ).toBe(true);
  expect(f.counts).toMatchObject({
    read: 0,
    add: 0,
  });
  const absent = transformMacosEnvelope(
    Buffer.from("synthetic"),
    randomBytes(32),
    "tests.bunaway.safe-storage",
    false,
  ).toString("base64");
  await expect(
    adapter.execute(
      "safe-storage.decryptBytes",
      {
        ciphertext: absent,
      },
      "backend",
    ),
  ).rejects.toThrow("missing");
  expect(f.counts.add).toBe(0);
  for (const text of [
    "",
    "\uFEFF한글\u0000🙂",
    "🙂".repeat(16384),
  ]) {
    const ciphertext = await adapter.execute(
      "safe-storage.encryptString",
      {
        text,
      },
      "backend",
    );
    expect(
      await adapter.execute(
        "safe-storage.decryptString",
        {
          ciphertext,
        },
        "backend",
      ),
    ).toBe(text);
  }
  for (const bytes of [
    "",
    Buffer.from([
      0,
      255,
      42,
    ]).toString("base64"),
    Buffer.alloc(256 * 1024, 255).toString("base64"),
  ]) {
    const ciphertext = await adapter.execute(
      "safe-storage.encryptBytes",
      {
        bytes,
      },
      "backend",
    );
    expect(
      await adapter.execute(
        "safe-storage.decryptBytes",
        {
          ciphertext,
        },
        "backend",
      ),
    ).toBe(bytes);
  }
  expect(f.counts.add).toBe(1);
  expect(f.copies.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
  await adapter.dispose();
  await adapter.dispose();
  expect(f.counts.disposed).toBe(1);
  await expect(
    adapter.execute("safe-storage.isAvailable", null, "backend"),
  ).rejects.toThrow("disposed");
  f.replace(null);
});

test("macOS secrets round trip as UTF-8, replace in place, and never create the protection key", async () => {
  const f = fixture();
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  const run = (name: string, input: JsonValue) =>
    adapter.execute(`safe-storage.${name}`, input, "backend");
  expect(
    await run("getSecret", {
      key: "session-token",
    }),
  ).toBeNull();
  expect(
    await run("deleteSecret", {
      key: "session-token",
    }),
  ).toBe(false);
  for (const value of [
    "t",
    "한글 🙂 \u0000 \uFEFF",
    "x".repeat(1280),
  ]) {
    expect(
      await run("setSecret", {
        key: "session-token",
        value,
      }),
    ).toBeNull();
    expect(
      await run("getSecret", {
        key: "session-token",
      }),
    ).toBe(value);
  }
  await run("setSecret", {
    key: "other.key_1-a",
    value: "other",
  });
  expect(
    await run("deleteSecret", {
      key: "session-token",
    }),
  ).toBe(true);
  expect(
    await run("deleteSecret", {
      key: "session-token",
    }),
  ).toBe(false);
  expect(
    await run("getSecret", {
      key: "session-token",
    }),
  ).toBeNull();
  expect(
    await run("getSecret", {
      key: "other.key_1-a",
    }),
  ).toBe("other");
  // Secrets live in their own Keychain items, so the protection key is never provisioned or read.
  expect(f.counts).toMatchObject({
    read: 0,
    add: 0,
  });
  expect(f.secretCopies.every((copy) => copy.every((byte) => byte === 0))).toBe(
    true,
  );
  await adapter.dispose();
});

test("macOS secret input is validated before the Keychain is opened", async () => {
  const f = fixture();
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  for (const [name, input] of [
    [
      "setSecret",
      {
        key: "Token",
        value: "v",
      },
    ],
    [
      "setSecret",
      {
        key: "a:b",
        value: "v",
      },
    ],
    [
      "setSecret",
      {
        key: "",
        value: "v",
      },
    ],
    [
      "setSecret",
      {
        key: "token",
        value: "",
      },
    ],
    [
      "setSecret",
      {
        key: "token",
        value: "x".repeat(1281),
      },
    ],
    [
      "setSecret",
      {
        key: "token",
        value: "\ud800",
      },
    ],
    [
      "getSecret",
      {
        key: "Token",
      },
    ],
    [
      "deleteSecret",
      {
        key: "a b",
      },
    ],
  ] as const) {
    await expect(
      adapter.execute(`safe-storage.${name}`, input, "backend"),
    ).rejects.toThrow("Invalid plugin input.");
  }
  expect(f.counts.opened).toBe(0);
  await adapter.dispose();
});

test("macOS secret failures keep the stored value and map to stable errors", async () => {
  const f = fixture();
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  const run = (name: string, input: JsonValue) =>
    adapter.execute(`safe-storage.${name}`, input, "backend");
  await run("setSecret", {
    key: "token",
    value: "kept",
  });
  for (const [status, code] of [
    [
      -128,
      "CANCELLED",
    ],
    [
      -25293,
      "PERMISSION_DENIED",
    ],
    [
      -25308,
      "PERMISSION_DENIED",
    ],
    [
      -25295,
      "INTERNAL",
    ],
  ] as const) {
    f.fail(status);
    for (const [name, input] of [
      [
        "setSecret",
        {
          key: "token",
          value: "replaced",
        },
      ],
      [
        "getSecret",
        {
          key: "token",
        },
      ],
      [
        "deleteSecret",
        {
          key: "token",
        },
      ],
    ] as const) {
      await expect(run(name, input)).rejects.toMatchObject({
        code,
      });
    }
    f.restore();
    expect(
      await run("getSecret", {
        key: "token",
      }),
    ).toBe("kept");
  }
  // An item that is not UTF-8 text is reported without exposing its bytes.
  f.secrets.set(
    "token",
    Buffer.from([
      0xff,
      0xfe,
      0xfd,
    ]),
  );
  await expect(
    run("getSecret", {
      key: "token",
    }),
  ).rejects.toMatchObject({
    code: "INTERNAL",
  });
  await adapter.dispose();
});

test("macOS secret accounts are namespaced by the host app id", () => {
  expect(secretAccount("tests.app", "token").toString()).toBe(
    "tests.app:token",
  );
  expect(
    secretAccount("tests.app", "token").equals(
      secretAccount("tests.app2", "token"),
    ),
  ).toBe(false);
});

test("macOS AES-GCM matches an independent cryptography AESGCM vector and authenticates all envelope bytes and app identity", () => {
  // Generated with Python cryptography AESGCM, zero key/nonce, header + appId as AAD.
  const vector = Buffer.from(
    "4257534b01000000000000000000000000a5c92f4a23400a007439a0a1ba0c027495096a207a93fca54c468ee161c4",
    "hex",
  );
  const key = Buffer.alloc(32);
  const appId = "tests.bunaway.vector";
  expect(transformMacosEnvelope(vector, key, appId, true)).toEqual(
    Buffer.from("known answer\x00\xff", "latin1"),
  );
  for (let i = 0; i < vector.length; i++) {
    const damaged = Buffer.from(vector);
    damaged[i] = (damaged[i] ?? 0) ^ 1;
    expect(() => transformMacosEnvelope(damaged, key, appId, true)).toThrow(
      "authenticate",
    );
  }
  expect(() =>
    transformMacosEnvelope(vector, key, "tests.other", true),
  ).toThrow("authenticate");
  expect(() =>
    transformMacosEnvelope(vector, randomBytes(32), appId, true),
  ).toThrow("authenticate");
  for (const size of [
    0,
    1,
    32,
    vector.length - 1,
  ]) {
    expect(() =>
      transformMacosEnvelope(vector.subarray(0, size), key, appId, true),
    ).toThrow();
  }
  expect(
    transformMacosEnvelope(Buffer.from("same"), key, appId, false),
  ).not.toEqual(transformMacosEnvelope(Buffer.from("same"), key, appId, false));
});

test("macOS cancellation, denied, locked and unavailable reads never overwrite or regenerate an existing key", async () => {
  const f = fixture();
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  const ciphertext = await adapter.execute(
    "safe-storage.encryptString",
    {
      text: "synthetic fixture",
    },
    "backend",
  );
  for (const status of [
    -128,
    -25293,
    -25308,
    -25315,
    -25291,
    -25295,
  ]) {
    f.fail(status);
    expect(
      await adapter.execute("safe-storage.isAvailable", null, "backend"),
    ).toBe(false);
    for (const [name, input] of [
      [
        "safe-storage.encryptString",
        {
          text: "another",
        },
      ],
      [
        "safe-storage.decryptString",
        {
          ciphertext,
        },
      ],
    ] as const) {
      try {
        await adapter.execute(name, input, "backend");
        throw new Error("Expected Keychain failure");
      } catch (error) {
        expect(error).toMatchObject({
          code: keychainError(status).code,
        });
      }
    }
    expect(f.counts.add).toBe(1);
  }
  f.restore();
  expect(
    await adapter.execute(
      "safe-storage.decryptString",
      {
        ciphertext,
      },
      "backend",
    ),
  ).toBe("synthetic fixture");
  f.replace(Buffer.from("malformed"));
  await expect(
    adapter.execute(
      "safe-storage.encryptString",
      {
        text: "another",
      },
      "backend",
    ),
  ).rejects.toThrow("invalid size");
  expect(f.counts.add).toBe(1);
  await adapter.dispose();
  f.replace(null);
});

test("macOS malformed envelopes are rejected before Keychain access and decryptString rejects non-UTF8 or oversized text", async () => {
  const f = fixture();
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  await expect(
    adapter.execute(
      "safe-storage.decryptString",
      {
        ciphertext: "AA==",
      },
      "backend",
    ),
  ).rejects.toThrow("authenticate");
  expect(f.counts.opened).toBe(0);
  for (const bytes of [
    Buffer.from([
      255,
    ]),
    Buffer.from("x".repeat(32769)),
  ]) {
    const ciphertext = await adapter.execute(
      "safe-storage.encryptBytes",
      {
        bytes: bytes.toString("base64"),
      },
      "backend",
    );
    await expect(
      adapter.execute(
        "safe-storage.decryptString",
        {
          ciphertext,
        },
        "backend",
      ),
    ).rejects.toThrow();
  }
  await adapter.dispose();
  f.replace(null);
});

test("macOS concurrent key creation uses the stored winner and wipes the discarded candidate", async () => {
  const f = fixture();
  const winner = randomBytes(32);
  let candidate: Buffer | undefined;
  f.store.add = (key) => {
    candidate = key;
    f.replace(Buffer.from(winner));
    return false;
  };
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  const ciphertext = await adapter.execute(
    "safe-storage.encryptString",
    {
      text: "race",
    },
    "backend",
  );
  expect(candidate).toEqual(Buffer.alloc(32));
  expect(typeof ciphertext).toBe("string");
  if (typeof ciphertext !== "string") {
    throw new Error("Expected envelope");
  }
  expect(
    transformMacosEnvelope(
      Buffer.from(ciphertext, "base64"),
      winner,
      "tests.bunaway.safe-storage",
      true,
    ).toString(),
  ).toBe("race");
  await adapter.dispose();
  winner.fill(0);
  f.replace(null);
});
