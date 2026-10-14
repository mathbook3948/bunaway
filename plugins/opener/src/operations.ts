import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  fileInput,
  fileWithAppSchema,
  urlInput,
  urlWithAppSchema,
} from "#opener/contract";
import {
  type initialize as initializeMacos,
  openFile as openMacosFile,
  openUrl as openMacosUrl,
  revealFile as revealMacosFile,
} from "#opener/platforms/macos";
import {
  type initialize as initializeWindows,
  openFile as openWindowsFile,
  openFileWith as openWindowsFileWith,
  openUrl as openWindowsUrl,
  openUrlWith as openWindowsUrlWith,
  revealFile as revealWindowsFile,
  trashFile as trashWindowsFile,
} from "#opener/platforms/windows";

const macosOperation =
  defineNativeOperation<ReturnType<typeof initializeMacos>>();
const windowsOperation =
  defineNativeOperation<ReturnType<typeof initializeWindows>>();
/** Declare only implemented native Shell and workspace operations. Keys determine support. */
export const windowsOperations = {
  openUrl: windowsOperation({
    input: urlInput,
    output: z.null(),
    handler: ({ url }, { instance }) => openWindowsUrl(instance, url),
  }),
  openFile: windowsOperation({
    input: fileInput,
    output: z.null(),
    handler: ({ path }, { instance }) => openWindowsFile(instance, path),
  }),
  trashFile: windowsOperation({
    input: fileInput,
    output: z.null(),
    handler: ({ path }, { instance }) => trashWindowsFile(instance, path),
  }),
  revealFile: windowsOperation({
    input: fileInput,
    output: z.null(),
    handler: ({ path }, { instance }) => revealWindowsFile(instance, path),
  }),
  openFileWith: windowsOperation({
    input: fileWithAppSchema,
    output: z.null(),
    handler: ({ path, app }, { instance }) =>
      openWindowsFileWith(instance, path, app),
  }),
  openUrlWith: windowsOperation({
    input: urlWithAppSchema,
    output: z.null(),
    handler: ({ url, app }, { instance }) =>
      openWindowsUrlWith(instance, url, app),
  }),
};
export const macosOperations = {
  openUrl: macosOperation({
    input: urlInput,
    output: z.null(),
    handler: ({ url }, { instance }) => openMacosUrl(instance, url),
  }),
  openFile: macosOperation({
    input: fileInput,
    output: z.null(),
    handler: ({ path }, { instance }) => openMacosFile(instance, path),
  }),
  revealFile: macosOperation({
    input: fileInput,
    output: z.null(),
    handler: ({ path }, { instance }) => revealMacosFile(instance, path),
  }),
};
