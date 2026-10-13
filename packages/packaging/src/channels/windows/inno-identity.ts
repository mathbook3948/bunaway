import { stableGuid } from "./common.ts";

/** Keeps the shipped Inno AppId and its actual previous-data key in agreement. */
export function innoIdentity(identifier: string) {
  // Existing installers expand their escaped AppId to a GUID with two closing
  // braces. Preserve that exact identity: changing it would split over-installs.
  const appId = `{${stableGuid(identifier)}}}`;
  return {
    appId,
    previousDataKey: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appId}_is1`,
  };
}
