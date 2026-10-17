import type { NativeEnvironment } from "@bunaway/plugin";
import { createAppearanceController } from "#appearance/platforms/windows-controller";
import { initialize as readPreferences } from "#appearance/platforms/windows-preferences";

export {
  booleanPreference,
  colorRef,
  isDarkColor,
  usesInvertedColors,
} from "#appearance/platforms/windows-preferences";
/** Own reads and subscriptions on the UI worker; direct query-only adapters remain supported. */
export function initialize(environment: NativeEnvironment) {
  const reader = readPreferences();
  try {
    return createAppearanceController(reader, environment.windows);
  } catch (error) {
    reader.dispose();
    throw error;
  }
}
export function dispose(instance: ReturnType<typeof initialize>) {
  instance.dispose();
}
