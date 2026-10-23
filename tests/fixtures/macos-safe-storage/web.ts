import { createClient } from "@bunaway/client";

const client = createClient();
function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
async function rejected(work: Promise<unknown>, code: string) {
  try {
    await work;
  } catch (error) {
    check(
      error instanceof Error && "code" in error && error.code === code,
      `Expected ${code}: ${String(error)}`,
    );
    return;
  }
  throw new Error(`Expected ${code}`);
}
try {
  check(
    await client.invoke("plugin.safe-storage.isAvailable", null),
    "Keychain status",
  );
  await rejected(
    client.invoke("plugin.safe-storage.encryptString", {
      text: "synthetic",
      appId: "caller-selected",
    }),
    "INVALID_ARGUMENT",
  );
  const texts = [
    "",
    "\uFEFF한글\u0000🙂",
    "🙂".repeat(16384),
  ];
  const encrypted = await Promise.all(
    texts.map((text) =>
      client.invoke("plugin.safe-storage.encryptString", {
        text,
      }),
    ),
  );
  for (let i = 0; i < texts.length; i++) {
    const ciphertext = encrypted[i];
    check(typeof ciphertext === "string", "Encrypted string result");
    check(
      (await client.invoke("plugin.safe-storage.decryptString", {
        ciphertext,
      })) === texts[i],
      "WebView Unicode round trip",
    );
  }
  const ciphertext = await client.invoke("plugin.safe-storage.encryptBytes", {
    bytes: "AP8q",
  });
  await rejected(
    client.invoke("plugin.safe-storage.decryptBytes", {
      ciphertext,
    }),
    "PERMISSION_DENIED",
  );
  await rejected(
    client.invoke("plugin.safe-storage.decryptString", {
      ciphertext: "AA==",
    }),
    "INTERNAL",
  );
  await client.invoke("test.report", "passed");
  await client.invoke("plugin.windows.close", null);
} catch (error) {
  if (
    !(error instanceof Error && "code" in error && error.code === "CANCELLED")
  ) {
    console.error("Safe storage native host fixture failed", error);
    await client.invoke("test.report", "failed");
    await client.invoke("plugin.windows.close", null);
  }
}
