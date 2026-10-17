import { APP_INFO_MAX_LENGTH } from "@bunaway/plugin-api";
import { Objc } from "./objc.ts";

const WEBKIT_BUNDLE_ID = "com.apple.WebKit";
const VERSION_KEYS = [
  "CFBundleShortVersionString",
  "CFBundleVersion",
] as const;

/**
 * Reads the system WebKit framework version from its bundle's Info.plist,
 * preferring the short version string over the build version. Returns `null`
 * when the bundle or both keys are unavailable, or the text is empty or longer
 * than Core accepts. Objective-C or FFI failures throw; the host reports them
 * and continues without a version. Objective-C access requires Bun's main thread, so the host
 * calls this before starting the backend Worker and passes the result to it.
 */
export function readWebKitVersion(): string | null {
  const objc = new Objc();
  return objc.withAutoreleasePool(() => {
    const bundle = objc.send(
      objc.class("NSBundle"),
      "bundleWithIdentifier:",
      objc.string(WEBKIT_BUNDLE_ID),
    );
    if (!bundle) {
      return null;
    }
    for (const key of VERSION_KEYS) {
      const value = objc.send(
        bundle,
        "objectForInfoDictionaryKey:",
        objc.string(key),
      );
      const text = value ? objc.text(value) : "";
      if (text.length > 0 && text.length <= APP_INFO_MAX_LENGTH) {
        return text;
      }
    }
    return null;
  });
}
