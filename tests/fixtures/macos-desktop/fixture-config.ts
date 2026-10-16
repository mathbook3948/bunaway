import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

/**
 * File in the app's data root that tells the fixture which scenario to run and where to log. The
 * host gives the backend Worker and the native plugins a sanitized environment, so environment
 * variables of the launching test never arrive; the data root is the one place both sides share.
 */
export const DESKTOP_FIXTURE_FILE = "desktop-fixture.json";

const fixtureSchema = z
  .object({
    scenario: z.string(),
    /** Absolute path of the ordered event log that hooks and the driver append to. */
    events: z.string().min(1),
  })
  .strict();

/** Scenario and event log path of one fixture run. */
export type DesktopFixture = z.infer<typeof fixtureSchema>;

/** Location of the fixture file inside `dataRoot`. */
export function desktopFixturePath(dataRoot: string): string {
  return resolve(dataRoot, DESKTOP_FIXTURE_FILE);
}

/** Reads and validates the fixture file the test wrote into `dataRoot` before launching the host. */
export function readDesktopFixture(dataRoot: string): DesktopFixture {
  return fixtureSchema.parse(
    JSON.parse(readFileSync(desktopFixturePath(dataRoot), "utf8")),
  );
}

/** URL the `open-urls` scenario sends as a URL scheme Apple event; the host forwards it unchanged. */
export const OPEN_URL = "bunaway-test://open/path?q=1";
