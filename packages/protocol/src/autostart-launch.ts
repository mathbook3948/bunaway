/** Windows login registration marker. Invocation metadata, never proof of OS origin or authority. */
export const AUTOSTART_ARGUMENT = "--bunaway-autostart";
/** Hidden Windows login registration marker. Requires a configured tray, with the same trust limits. */
export const AUTOSTART_HIDDEN_ARGUMENT = "--bunaway-autostart-hidden";
/** Cross-session writer exclusion, scoped by user SID and complete Run value name. */
export const AUTOSTART_MUTEX_PREFIX = "Global\\Bunaway.Autostart.";
/** Bound each installer mutex wait. Runtime I/O writers poll and return BUSY without waiting. */
export const AUTOSTART_MUTEX_WAIT_MS = 5000;
/** Task ID of the manifest `desktop:StartupTask` that MSIX packages declare and the autostart plugin opens. */
export const MSIX_STARTUP_TASK_ID = "BunawayAutostart";
