#!/usr/bin/env bun
import { release } from "./distribution.ts";
import { main } from "./main.ts";

if (import.meta.main) {
  try {
    if (process.argv.slice(2).join(" ") === "--version") {
      console.log((await release()).version);
    } else {
      process.exitCode = await main(process.argv.slice(2));
    }
  } catch (error) {
    console.error(
      `bunaway: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
