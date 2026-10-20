import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  exchangeInputSchema,
  exchangeResultSchema,
  onlineSchema,
  requestInputSchema,
  resolveHostInputSchema,
  resolveHostResultSchema,
  resolveProxyInputSchema,
  resolveProxyResultSchema,
  responseSchema,
} from "#network/contract";
import {
  type initialize as initializeMacos,
  runExchange as runMacosExchange,
  runIsOnline as runMacosIsOnline,
  runRequest as runMacosRequest,
  runResolveHost as runMacosResolveHost,
  runResolveProxy as runMacosResolveProxy,
} from "#network/platforms/macos";
import {
  type initialize as initializeWindows,
  runExchange as runWindowsExchange,
  runIsOnline as runWindowsIsOnline,
  runRequest as runWindowsRequest,
  runResolveHost as runWindowsResolveHost,
  runResolveProxy as runWindowsResolveProxy,
} from "#network/platforms/windows";

const macosOperation =
  defineNativeOperation<ReturnType<typeof initializeMacos>>();
const windowsOperation =
  defineNativeOperation<ReturnType<typeof initializeWindows>>();
/** Each platform dispatches bounded network work through its native build boundary. */
export const macosOperations = {
  request: macosOperation({
    input: requestInputSchema,
    output: responseSchema,
    handler: (input, { instance, signal }) =>
      runMacosRequest(instance, input, signal),
  }),
  exchange: macosOperation({
    input: exchangeInputSchema,
    output: exchangeResultSchema,
    handler: (input, { instance, signal }) =>
      runMacosExchange(instance, input, signal),
  }),
  isOnline: macosOperation({
    input: z.null(),
    output: onlineSchema,
    handler: (_input, { instance }) => runMacosIsOnline(instance),
  }),
  resolveHost: macosOperation({
    input: resolveHostInputSchema,
    output: resolveHostResultSchema,
    handler: (input, { instance, signal }) =>
      runMacosResolveHost(instance, input, signal),
  }),
  resolveProxy: macosOperation({
    input: resolveProxyInputSchema,
    output: resolveProxyResultSchema,
    handler: () => runMacosResolveProxy(),
  }),
};
export const windowsOperations = {
  request: windowsOperation({
    input: requestInputSchema,
    output: responseSchema,
    handler: (input, { instance, signal }) =>
      runWindowsRequest(instance, input, signal),
  }),
  exchange: windowsOperation({
    input: exchangeInputSchema,
    output: exchangeResultSchema,
    handler: (input, { instance, signal }) =>
      runWindowsExchange(instance, input, signal),
  }),
  isOnline: windowsOperation({
    input: z.null(),
    output: onlineSchema,
    handler: (_input, { instance }) => runWindowsIsOnline(instance),
  }),
  resolveHost: windowsOperation({
    input: resolveHostInputSchema,
    output: resolveHostResultSchema,
    handler: (input, { instance, signal }) =>
      runWindowsResolveHost(instance, input, signal),
  }),
  resolveProxy: windowsOperation({
    input: resolveProxyInputSchema,
    output: resolveProxyResultSchema,
    handler: (input, { instance, signal }) =>
      runWindowsResolveProxy(instance, input, signal),
  }),
};
