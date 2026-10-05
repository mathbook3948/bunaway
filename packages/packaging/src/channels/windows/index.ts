import { registerAdapter } from "../../registry.ts";
import msixAdapter from "./msix.ts";
import directAdapter from "./win-direct.ts";
import unpackagedAdapter from "./win-store-unpackaged.ts";

// Importing this module registers every Windows channel adapter. Adding a
// channel means adding its file plus one import/registration line here —
// shared entry points are untouched.
registerAdapter(directAdapter);
registerAdapter(msixAdapter);
registerAdapter(unpackagedAdapter);

export { directAdapter, msixAdapter, unpackagedAdapter };
