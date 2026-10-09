import { NativeRegistry } from "../../../../../packages/protocol/src/index.ts";
import { capabilitiesPlugin } from "../../../../../plugins/capabilities/src/index.ts";
import { logPlugin } from "../../../../../plugins/log/src/index.ts";
import { storagePlugin } from "../../../../../plugins/storage/src/index.ts";
import { windowsPlugin } from "../../../../../plugins/windows/src/index.ts";

const nativePlugins = new NativeRegistry([
  storagePlugin,
  logPlugin,
  capabilitiesPlugin,
  windowsPlugin,
]);
export const expectedCapabilityNames = [
  ...nativePlugins.operations.keys(),
];

/**
 * Match every operation and mark Windows window operations unsupported on macOS.
 */
export function matchesCapabilities(value: unknown, platform: string): boolean {
  if (
    !Array.isArray(value) ||
    ![
      "win32",
      "darwin",
    ].includes(platform)
  ) {
    return false;
  }
  const names = expectedCapabilityNames;
  if (value.length !== names.length) {
    return false;
  }
  const seen = new Set<string>();
  return value.every((capability) => {
    if (!capability || typeof capability !== "object") {
      return false;
    }
    const { name, support, permission } = capability;
    if (!names.includes(name) || seen.has(name)) {
      return false;
    }
    seen.add(name);
    const expected =
      name.startsWith("windows.") && platform === "darwin"
        ? "unsupported"
        : "supported";
    return support === expected && permission === "not-required";
  });
}
