// Shared HWND control contract between the Windows host and development CLI.
/** Win32 message the development CLI posts to request host cleanup. */
export const APP_SHUTDOWN_MESSAGE = 0x8002;
/** Window-class prefix the CLI uses to find Bunaway app windows. */
export const APP_WINDOW_CLASS_PREFIX = "bunaway-bun-";
