import { homedir } from "node:os";
import { join } from "node:path";

// The fixture app chooses these directories independently of the storage plugin.
const directory = join(
  process.env.LOCALAPPDATA ?? join(homedir(), "Library", "Application Support"),
  "bunaway",
  "tests.bunaway.host",
);

export const dataPath = (path: string) => `${join(directory, "data")}/${path}`;
export const temporaryPath = (path: string) =>
  `${join(directory, "temp")}/${path}`;
