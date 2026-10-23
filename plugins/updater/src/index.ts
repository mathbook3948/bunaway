import { defineNativePlugin } from "@bunaway/plugin";
import { updaterOperations } from "#updater/operations";
import {
  busy as busyMacos,
  dispose as disposeMacos,
  initialize as initializeMacos,
} from "#updater/platforms/macos";
import {
  busy as busyWindows,
  dispose as disposeWindows,
  initialize as initializeWindows,
} from "#updater/platforms/windows";
/**
 * Compare the running app version with the update manifest at the endpoint the app fixed in bunaway.json,
 * and download the package it names into the app's update folder after checking its SHA-256 and size.
 * `updater.downloadStatus` reports the bytes received by the download that is running.
 */
export default defineNativePlugin({
  name: "updater",
  platforms: {
    macos: {
      initialize: initializeMacos,
      dispose: disposeMacos,
      busy: busyMacos,
      operations: updaterOperations,
    },
    windows: {
      initialize: initializeWindows,
      dispose: disposeWindows,
      busy: busyWindows,
      operations: updaterOperations,
    },
  },
});

export type {
  UpdaterCheckResult,
  UpdaterDownloadResult,
  UpdaterDownloadStatus,
} from "#updater/contract";
