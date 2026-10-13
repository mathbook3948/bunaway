import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { transformMacosEnvelope } from "../../plugins/safe-storage/src/macos-envelope.ts";
import {
  keychainError,
  type MacosKeyStore,
} from "../../plugins/safe-storage/src/macos-key-store.ts";
import { macosOperations } from "../../plugins/safe-storage/src/macos-operations.ts";

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
  const store: MacosKeyStore = {
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

test("macOS operations are lazy, do not provision on availability or decrypt, and wipe per-call keys", () => {
  const f = fixture();
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  expect(f.counts.opened).toBe(0);
  expect(adapter.execute("safe-storage.isAvailable", null, "backend")).toBe(
    true,
  );
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
  expect(() =>
    adapter.execute(
      "safe-storage.decryptBytes",
      {
        ciphertext: absent,
      },
      "backend",
    ),
  ).toThrow("missing");
  expect(f.counts.add).toBe(0);
  for (const text of [
    "",
    "\uFEFF한글\u0000🙂",
    "🙂".repeat(16384),
  ]) {
    const ciphertext = adapter.execute(
      "safe-storage.encryptString",
      {
        text,
      },
      "backend",
    );
    expect(
      adapter.execute(
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
    const ciphertext = adapter.execute(
      "safe-storage.encryptBytes",
      {
        bytes,
      },
      "backend",
    );
    expect(
      adapter.execute(
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
  adapter.dispose();
  adapter.dispose();
  expect(f.counts.disposed).toBe(1);
  expect(() =>
    adapter.execute("safe-storage.isAvailable", null, "backend"),
  ).toThrow("disposed");
  f.replace(null);
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

test("macOS cancellation, denied, locked and unavailable reads never overwrite or regenerate an existing key", () => {
  const f = fixture();
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  const ciphertext = adapter.execute(
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
    expect(adapter.execute("safe-storage.isAvailable", null, "backend")).toBe(
      false,
    );
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
        adapter.execute(name, input, "backend");
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
    adapter.execute(
      "safe-storage.decryptString",
      {
        ciphertext,
      },
      "backend",
    ),
  ).toBe("synthetic fixture");
  f.replace(Buffer.from("malformed"));
  expect(() =>
    adapter.execute(
      "safe-storage.encryptString",
      {
        text: "another",
      },
      "backend",
    ),
  ).toThrow("invalid size");
  expect(f.counts.add).toBe(1);
  adapter.dispose();
  f.replace(null);
});

test("macOS malformed envelopes are rejected before Keychain access and decryptString rejects non-UTF8 or oversized text", () => {
  const f = fixture();
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  expect(() =>
    adapter.execute(
      "safe-storage.decryptString",
      {
        ciphertext: "AA==",
      },
      "backend",
    ),
  ).toThrow("authenticate");
  expect(f.counts.opened).toBe(0);
  for (const bytes of [
    Buffer.from([
      255,
    ]),
    Buffer.from("x".repeat(32769)),
  ]) {
    const ciphertext = adapter.execute(
      "safe-storage.encryptBytes",
      {
        bytes: bytes.toString("base64"),
      },
      "backend",
    );
    expect(() =>
      adapter.execute(
        "safe-storage.decryptString",
        {
          ciphertext,
        },
        "backend",
      ),
    ).toThrow();
  }
  adapter.dispose();
  f.replace(null);
});

test("macOS concurrent key creation uses the stored winner and wipes the discarded candidate", () => {
  const f = fixture();
  const winner = randomBytes(32);
  let candidate: Buffer | undefined;
  f.store.add = (key) => {
    candidate = key;
    f.replace(Buffer.from(winner));
    return false;
  };
  const adapter = macosOperations("tests.bunaway.safe-storage", f.open);
  const ciphertext = adapter.execute(
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
  adapter.dispose();
  winner.fill(0);
  f.replace(null);
});
