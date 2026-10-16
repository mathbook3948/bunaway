export { createCore } from "@bunaway/core";
export type {
  AppDefinition,
  CommandContext,
  CommandDefinition,
  CommandsOf,
  DesktopContext,
  DesktopOptions,
  EventEmitter,
  EventRegistry,
  EventsOf,
  EventTarget,
  OpenRequest,
  Platform,
  PluginDefinition,
  PluginRegistration,
  QuitReason,
  ReopenEvent,
  ShutdownReason,
  StateStore,
  StopHook,
} from "@bunaway/plugin-api";
export type {
  HostAPI,
  HostOperationContract,
  Infer,
  JsonValue,
  NativePluginContract,
  Schema,
} from "@bunaway/protocol";
export { defineApp } from "./app.ts";
export {
  type CommandContract,
  type CommandHandler,
  command,
} from "./command.ts";
export { host } from "./host.ts";
export {
  defineModule,
  type ModuleBuilder,
  type ModuleDefinition,
} from "./module.ts";
