import { expect, setDefaultTimeout, test } from "bun:test";
import createOperationsDefinition from "#plugins/opener/src/index";
import { deadline } from "../fixtures/deadlines.ts";
import { nativeFactory as createOperationsFactory } from "../fixtures/native-platform.ts";

setDefaultTimeout(deadline("build"));

const createOperations = createOperationsFactory(
  createOperationsDefinition,
  "windows",
);

const EXECUTABLE = "C:\\Bunaway Test\\app.exe";
const APP = {
  id: "test.opener-url-scheme",
  launch: {
    mode: "development" as const,
    executablePath: EXECUTABLE,
    args: [
      "--flag",
    ],
  },
};
const EXPECTED_COMMAND = `"${EXECUTABLE}" "--flag" "%1"`;
const REG_NOT_FOUND = 1;

/** A scheme name no other test or app uses, so cleanup touches only this test's own key. */
const newScheme = () => `bwtest-${crypto.randomUUID().slice(0, 8)}`;
const keyPath = (scheme: string) => `HKCU\\Software\\Classes\\${scheme}`;

/** Run reg.exe, which reads the registry independently of the code under test. */
async function reg(...args: string[]) {
  const child = Bun.spawn(
    [
      "reg",
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return {
    stdout,
    code,
  };
}

/** The value of a registry entry as reg.exe prints it, or null when absent. */
async function regValue(
  key: string,
  name: string | null,
): Promise<string | null> {
  const result = await reg(
    "query",
    key,
    ...(name === null
      ? [
          "/ve",
        ]
      : [
          "/v",
          name,
        ]),
  );
  if (result.code !== 0) {
    return null;
  }
  const line = result.stdout
    .split(/\r?\n/)
    .find((entry) => /^\s+\S.*\sREG_SZ(\s|$)/.test(entry));
  return line?.replace(/^.*\sREG_SZ\s?/, "").trim() ?? null;
}

async function run(
  adapter: ReturnType<typeof createOperations>,
  operation: string,
  scheme: string,
) {
  return adapter.execute(
    `opener.${operation}`,
    {
      scheme,
    },
    "backend",
  );
}

test.skipIf(process.platform !== "win32")(
  "register, query and unregister change only this app's HKCU scheme key",
  async () => {
    const scheme = newScheme();
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
      app: APP,
    });
    try {
      expect(await run(adapter, "isUrlSchemeRegistered", scheme)).toBe(false);
      expect(await run(adapter, "registerUrlScheme", scheme)).toBeNull();
      expect(await run(adapter, "isUrlSchemeRegistered", scheme)).toBe(true);
      // Upper case input names the same key.
      expect(
        await run(adapter, "isUrlSchemeRegistered", scheme.toUpperCase()),
      ).toBe(true);
      const key = keyPath(scheme);
      expect(await regValue(`${key}\\shell\\open\\command`, null)).toBe(
        EXPECTED_COMMAND,
      );
      expect(await regValue(key, "URL Protocol")).toBe("");
      expect(await regValue(key, "BunawayRegistration")).toBe(
        "development.test.opener-url-scheme",
      );
      // A second call is accepted and leaves the registration in place.
      expect(await run(adapter, "registerUrlScheme", scheme)).toBeNull();
      expect(await run(adapter, "unregisterUrlScheme", scheme)).toBe(true);
      expect((await reg("query", key)).code).toBe(REG_NOT_FOUND);
      expect(await run(adapter, "unregisterUrlScheme", scheme)).toBe(false);
      expect(await run(adapter, "isUrlSchemeRegistered", scheme)).toBe(false);
    } finally {
      await run(adapter, "unregisterUrlScheme", scheme);
      await adapter.dispose();
      await reg("delete", keyPath(scheme), "/f");
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "a scheme key made by another owner is left unchanged",
  async () => {
    const scheme = newScheme();
    const key = keyPath(scheme);
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
      app: APP,
    });
    try {
      for (const args of [
        [
          "add",
          key,
          "/ve",
          "/d",
          `URL:${scheme}`,
          "/f",
        ],
        [
          "add",
          key,
          "/v",
          "URL Protocol",
          "/d",
          "",
          "/f",
        ],
        [
          "add",
          `${key}\\shell\\open\\command`,
          "/ve",
          "/d",
          '"C:\\Other\\other.exe" "%1"',
          "/f",
        ],
      ]) {
        expect((await reg(...args)).code).toBe(0);
      }
      await expect(run(adapter, "registerUrlScheme", scheme)).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      expect(await run(adapter, "isUrlSchemeRegistered", scheme)).toBe(false);
      expect(await run(adapter, "unregisterUrlScheme", scheme)).toBe(false);
      expect(await regValue(`${key}\\shell\\open\\command`, null)).toBe(
        '"C:\\Other\\other.exe" "%1"',
      );
      expect(await regValue(key, "BunawayRegistration")).toBeNull();
    } finally {
      await adapter.dispose();
      await reg("delete", key, "/f");
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "reserved and malformed schemes are rejected with INVALID_ARGUMENT",
  async () => {
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
      app: APP,
    });
    try {
      for (const scheme of [
        "http",
        "ms-settings",
        "javascript",
        "x",
        "bad scheme",
      ]) {
        await expect(run(adapter, "registerUrlScheme", scheme)).rejects.toThrow(
          expect.objectContaining({
            code: "INVALID_ARGUMENT",
          }),
        );
      }
    } finally {
      await adapter.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "a system ProgId that exists only in the machine classes is not shadowed",
  async () => {
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
      app: APP,
    });
    try {
      // exefile lives in HKLM\Software\Classes; a user key of that name would hijack .exe launches.
      const hkcuBefore = (await reg("query", keyPath("exefile"))).code;
      expect((await reg("query", "HKCR\\exefile")).code).toBe(0);
      await expect(
        run(adapter, "registerUrlScheme", "exefile"),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "INVALID_ARGUMENT",
        }),
      );
      expect((await reg("query", keyPath("exefile"))).code).toBe(hkcuBefore);
    } finally {
      await adapter.dispose();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "without a host app identity registration reports UNSUPPORTED",
  async () => {
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
    });
    try {
      await expect(
        run(adapter, "registerUrlScheme", newScheme()),
      ).rejects.toThrow(
        expect.objectContaining({
          code: "UNSUPPORTED",
        }),
      );
    } finally {
      await adapter.dispose();
    }
  },
);
