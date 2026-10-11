import {
  clampWindowSize,
  hasValidWindowSizeConstraints,
  type WindowSpec,
} from "@bunaway/plugin-api/native";
import { BunawayError } from "@bunaway/protocol";
import type { WindowInput } from "./contract.ts";

/** Resolve validated options without modifying the catalog or a previous creation's configuration. */
export function mergeCreationOptions(
  spec: WindowSpec,
  options: WindowInput<"windows.create">["options"],
): WindowSpec {
  const title = options?.title ?? spec.title;
  // Window declarations bound UTF-16 code units; schema maxLength counts Unicode code points.
  if (!title || title.length > 1024 || title.includes("\0")) {
    throw new BunawayError({ code: "INVALID_ARGUMENT", message: "Window title must contain 1 to 1024 UTF-16 code units without NUL." });
  }
  const window = {
    ...spec.window,
    ...options?.window,
  };
  const constraints = {
    minWidth: window.minWidth ?? null,
    minHeight: window.minHeight ?? null,
    maxWidth: window.maxWidth ?? null,
    maxHeight: window.maxHeight ?? null,
  };
  if (!hasValidWindowSizeConstraints(constraints)) {
    throw new BunawayError({
      code: "INVALID_ARGUMENT",
      message: "Window minimum dimensions cannot exceed maximum dimensions.",
    });
  }
  const { showWhenReady: declaredReadiness, ...base } = spec;
  const showWhenReady =
    options?.showWhenReady === undefined
      ? declaredReadiness
      : options.showWhenReady;
  return {
    ...base,
    title,
    ...(options?.visible === undefined
      ? {}
      : {
          visible: options.visible,
        }),
    ...(showWhenReady === null || showWhenReady === undefined
      ? {}
      : {
          showWhenReady,
        }),
    window: {
      ...window,
      ...clampWindowSize(window.width, window.height, constraints),
    },
  };
}
