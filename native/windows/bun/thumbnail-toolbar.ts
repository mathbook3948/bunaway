import {
  NATIVE_THUMBNAIL_BUTTON_LIMIT,
  type NativeThumbnailButton,
  type NativeThumbnailButtonFlag,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import type { ThumbnailButtonSlot } from "./taskbar.ts";

/** HIWORD(wParam) of a WM_COMMAND sent by a thumbnail toolbar button. */
const THBN_CLICKED = 0x1800;
// THUMBBUTTON flags (THBF_*); THBF_ENABLED is 0.
const flagBits: Record<NativeThumbnailButtonFlag, number> = {
  enabled: 0,
  disabled: 0x1,
  dismissonclick: 0x2,
  nobackground: 0x4,
  hidden: 0x8,
  noninteractive: 0x10,
};
/** A press on these never reaches the app: Windows greys out or hides them, and a forged message is dropped too. */
const NOT_PRESSABLE =
  flagBits.disabled | flagBits.hidden | flagBits.noninteractive;
const BUTTON_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** `THUMBBUTTON.szTip` holds 260 UTF-16 code units including the terminator. */
const MAX_TOOLTIP_UNITS = 259;

/** The buttons the shell shows, retained to translate a press (slot number) back to the app's id. */
export type ThumbnailToolbar = readonly {
  id: string;
  flags: number;
}[];

function invalid(message: string): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message,
  });
}

function flagMask(flags: readonly NativeThumbnailButtonFlag[]): number {
  let mask = 0;
  for (const flag of flags) {
    const bit = flagBits[flag];
    if (bit === undefined) {
      throw invalid(`Unknown thumbnail button flag ${String(flag)}.`);
    }
    mask |= bit;
  }
  if (flags.includes("enabled") && flags.includes("disabled")) {
    throw invalid("A thumbnail button cannot be both enabled and disabled.");
  }
  return mask;
}

/** Native callers bypass the plugin schema; enforce its limits before any HICON exists. */
export function thumbnailToolbarOf(
  buttons: readonly NativeThumbnailButton[],
): ThumbnailToolbar {
  if (buttons.length > NATIVE_THUMBNAIL_BUTTON_LIMIT) {
    throw invalid(
      `A window has at most ${NATIVE_THUMBNAIL_BUTTON_LIMIT} thumbnail buttons.`,
    );
  }
  const ids = new Set<string>();
  return buttons.map((button) => {
    if (!BUTTON_ID.test(button.id) || ids.has(button.id)) {
      throw invalid("Thumbnail button ids must be unique and well formed.");
    }
    ids.add(button.id);
    if (
      button.tooltip.includes("\0") ||
      button.tooltip.length > MAX_TOOLTIP_UNITS
    ) {
      throw invalid(
        `A thumbnail tooltip cannot contain NUL or exceed ${MAX_TOOLTIP_UNITS} UTF-16 code units.`,
      );
    }
    return {
      id: button.id,
      flags: flagMask(button.flags),
    };
  });
}

/**
 * All `NATIVE_THUMBNAIL_BUTTON_LIMIT` slots for ThumbBarAddButtons/UpdateButtons: the buttons first, in
 * order, then hidden slots. Windows lets ThumbBarAddButtons run once per taskbar button, so always
 * describing every slot lets later calls change the number of visible buttons.
 */
export function thumbnailSlots(
  toolbar: ThumbnailToolbar,
  buttons: readonly NativeThumbnailButton[],
  icons: readonly bigint[],
): ThumbnailButtonSlot[] {
  return Array.from(
    {
      length: NATIVE_THUMBNAIL_BUTTON_LIMIT,
    },
    (_, index) => {
      const button = buttons[index];
      const icon = icons[index];
      const entry = toolbar[index];
      return button && icon && entry
        ? {
            id: index,
            icon,
            tooltip: button.tooltip,
            flags: entry.flags,
          }
        : {
            id: index,
            tooltip: "",
            flags: flagBits.hidden,
          };
    },
  );
}

/** The app's button id for a WM_COMMAND wParam, or undefined for anything else, including unusable slots. */
export function pressedThumbnailButton(
  toolbar: ThumbnailToolbar | undefined,
  wparam: bigint,
): string | undefined {
  if (Number((wparam >> 16n) & 0xffffn) !== THBN_CLICKED) {
    return undefined;
  }
  const entry = toolbar?.[Number(wparam & 0xffffn)];
  return entry && !(entry.flags & NOT_PRESSABLE) ? entry.id : undefined;
}
