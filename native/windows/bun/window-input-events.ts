import { HTCAPTION } from "./window-drag.ts";

export const WM_APPCOMMAND = 0x0319;
export const WM_CONTEXTMENU = 0x007b;
export const WM_NCHITTEST = 0x0084;
const HTSYSMENU = 3;
/** Device bits (mouse, key, OEM) share the high word with the command; they are not part of it. */
const FAPPCOMMAND_MASK = 0xf000;

/** APPCOMMAND_* values 1 to 53 as kebab-case names; index is the command code. Gaps are never sent. */
const APP_COMMANDS: readonly (string | undefined)[] = [
  undefined,
  "browser-backward",
  "browser-forward",
  "browser-refresh",
  "browser-stop",
  "browser-search",
  "browser-favorites",
  "browser-home",
  "volume-mute",
  "volume-down",
  "volume-up",
  "media-nexttrack",
  "media-previoustrack",
  "media-stop",
  "media-play-pause",
  "launch-mail",
  "launch-media-select",
  "launch-app1",
  "launch-app2",
  "bass-down",
  "bass-boost",
  "bass-up",
  "treble-down",
  "treble-up",
  "microphone-volume-mute",
  "microphone-volume-down",
  "microphone-volume-up",
  "help",
  "find",
  "new",
  "open",
  "close",
  "save",
  "print",
  "undo",
  "redo",
  "copy",
  "cut",
  "paste",
  "reply-to-mail",
  "forward-mail",
  "send-mail",
  "spell-check",
  undefined,
  "mic-on-off-toggle",
  "correction-list",
  "media-play",
  "media-pause",
  "media-record",
  "media-fast-forward",
  "media-rewind",
  "media-channel-up",
  "media-channel-down",
  "delete",
];

/** Named command from a WM_APPCOMMAND lParam, or undefined for codes outside the published set. */
export function appCommandName(lparam: bigint): string | undefined {
  const high = Number((lparam >> 16n) & 0xffffn);
  return APP_COMMANDS[high & ~FAPPCOMMAND_MASK];
}

/** Signed screen point of a pointer-originated WM_CONTEXTMENU; keyboard invocation passes -1. */
export function contextMenuPoint(lparam: bigint):
  | {
      x: number;
      y: number;
    }
  | undefined {
  const bits = Number(lparam & 0xffffffffn);
  if (bits === 0xffffffff) {
    return undefined;
  }
  return {
    x: (bits << 16) >> 16,
    y: bits >> 16,
  };
}

/** Title bar and system menu icon are the non-client areas that open the system menu. */
export function isSystemMenuArea(hit: number): boolean {
  return hit === HTCAPTION || hit === HTSYSMENU;
}
