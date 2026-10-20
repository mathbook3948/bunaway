import { defineNativePlugin } from "@bunaway/plugin";
import { screenCaptureOperations } from "#screen-capture/operations";
import { dispose, initialize } from "#screen-capture/platforms/windows";
/**
 * List monitors and top-level windows and capture one of them as a PNG on Windows.
 * Screen content is sensitive and Windows shows no capture indicator, so grant the two permissions
 * only to views that start a trusted backend command. A started capture cannot be cancelled.
 */
export default defineNativePlugin({
  name: "screenCapture",
  platforms: {
    windows: {
      initialize,
      dispose,
      operations: screenCaptureOperations,
    },
  },
});

export type {
  ScreenCaptureImage,
  ScreenCaptureInput,
  ScreenCaptureListInput,
  ScreenCaptureSource,
  ScreenCaptureSourceKind,
} from "#screen-capture/contract";
