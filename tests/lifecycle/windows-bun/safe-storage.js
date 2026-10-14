import { createClient } from "@bunaway/client";
import safeStorage from "@bunaway/plugin-safe-storage";

const client = createClient();
await client.ready;
if (location.pathname === "/denied.html") {
  let denied = false;
  try {
    await safeStorage.decryptString({
      ciphertext: "AA==",
    });
  } catch (error) {
    denied = error.code === "PERMISSION_DENIED";
  }
  if (!denied) {
    throw new Error("View without decrypt permission reached DPAPI.");
  }
  await client.invoke("test.report-denied", true);
} else {
  let report = {
    pass: false,
  };
  let uiTicksDuringRequests = 0;
  const ticking = setInterval(() => {
    uiTicksDuringRequests++;
  }, 1);
  try {
    const available = await safeStorage.isAvailable(null);
    if (!available) {
      throw new Error("Windows DPAPI is unavailable.");
    }
    const values = Array.from(
      {
        length: 32,
      },
      (_, index) => `\uFEFF한글\u0000🙂 ${index}`,
    );
    const restored = await Promise.all(
      values.map(async (text) => {
        const ciphertext = await safeStorage.encryptString({
          text,
        });
        if (!ciphertext || ciphertext === text) {
          throw new Error("Encryption returned plaintext.");
        }
        return safeStorage.decryptString({
          ciphertext,
        });
      }),
    );
    const concurrent = restored.every((text, index) => text === values[index]);
    if (!concurrent) {
      throw new Error("Concurrent Unicode round trips were mixed.");
    }
    const exactLimit = "🙂".repeat(16384);
    const boundaryCiphertext = await safeStorage.encryptString({
      text: exactLimit,
    });
    if (
      (await safeStorage.decryptString({
        ciphertext: boundaryCiphertext,
      })) !== exactLimit
    ) {
      throw new Error("UTF-16 boundary round trip failed.");
    }
    let aboveLimitRejected = false;
    try {
      await safeStorage.encryptString({
        text: "🙂".repeat(16385),
      });
    } catch (error) {
      aboveLimitRejected = error.code === "INVALID_ARGUMENT";
    }
    if (!aboveLimitRejected) {
      throw new Error("Text beyond the UTF-16 limit reached DPAPI.");
    }
    for (const bytes of [
      "",
      "AP+A",
      btoa(
        String.fromCharCode(
          ...Array.from(
            {
              length: 256,
            },
            (_, index) => index,
          ),
        ),
      ),
    ]) {
      const ciphertext = await safeStorage.encryptBytes({
        bytes,
      });
      if (
        (await safeStorage.decryptBytes({
          ciphertext,
        })) !== bytes
      ) {
        throw new Error("Byte round trip failed.");
      }
    }
    const ciphertext = await safeStorage.encryptString({
      text: "tamper test",
    });
    const raw = atob(ciphertext);
    const damaged = btoa(
      raw.slice(0, -1) +
        String.fromCharCode(raw.charCodeAt(raw.length - 1) ^ 255),
    );
    let tamperRejected = false;
    try {
      await safeStorage.decryptString({
        ciphertext: damaged,
      });
    } catch (error) {
      tamperRejected = error.code === "INTERNAL";
    }
    if (!tamperRejected) {
      throw new Error("Tampered ciphertext was accepted.");
    }
    report = {
      pass: true,
      available,
      concurrent,
      tamperRejected,
      uiTicksDuringRequests,
    };
  } catch (error) {
    report = {
      pass: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearInterval(ticking);
  }
  await client.invoke("test.report", report);
  await client.invoke("test.report-confirmed", true);
}
await client.close();
