import { resolve } from "node:path";
import { APP_INFO_MAX_LENGTH } from "@bunaway/plugin-api";
import { isRecord } from "@bunaway/protocol";
import {
  type AppMetadata,
  isAppInfoText,
} from "@bunaway/runtime-bun/app-metadata";
import { json } from "./files.ts";

/** Reads the optional `version` of the `package.json` in `directory`; an absent field is `null`. */
async function packageVersion(directory: string): Promise<string | null> {
  const path = resolve(directory, "package.json");
  const manifest = await json(path);
  if (!isRecord(manifest)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  const version: unknown = Reflect.get(manifest, "version");
  if (version === undefined) {
    return null;
  }
  if (!isAppInfoText(version)) {
    throw new Error(
      `${path}: version must be a non-empty string of at most ${APP_INFO_MAX_LENGTH} characters.`,
    );
  }
  return version;
}

/**
 * Resolves the versions that `ctx.app` reports, from the app's and the
 * framework's `package.json`. The desktop package manifest and the mobile
 * build-time constant both use this, so a bad version fails every build alike.
 */
export async function readAppVersions(
  appRoot: string,
  frameworkRoot: string,
): Promise<Pick<AppMetadata, "version" | "framework">> {
  return {
    version: await packageVersion(appRoot),
    framework: await packageVersion(frameworkRoot),
  };
}
