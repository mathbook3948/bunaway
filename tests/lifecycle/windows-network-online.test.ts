import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import macosNetworkPlugin from "@bunaway/plugin-network/native/macos";
import windowsNetworkPlugin from "@bunaway/plugin-network/native/windows";

const platforms = [
  [
    "windows",
    windowsNetworkPlugin._definition.nativePlatforms.windows,
  ],
  [
    "macos",
    macosNetworkPlugin._definition.nativePlatforms.macos,
  ],
] as const;

test.each(platforms)(
  "generated %s network adapter reads the real online state",
  async (name, platform) => {
    assert(platform);
    const adapter = platform.create({
      dataRoot: ".",
      capabilities: [],
    });
    assert(adapter.executeUI);
    const call = () =>
      adapter.executeUI?.("network.isOnline", null, "view:test", {
        requestId: crypto.randomUUID(),
        permissions: {
          permissions: [
            "network.isOnline",
          ],
        },
      });
    try {
      const online = await call();
      expect(typeof online).toBe("boolean");
      // CI runners for the native platforms have an active network connection.
      if (process.platform === "win32" && name === "windows") {
        expect(online).toBe(true);
      }
    } finally {
      await adapter.dispose();
    }
    await expect(call()).rejects.toMatchObject({
      code: "CANCELLED",
    });
  },
);
