import {
  defineNativePlugin,
  type Infer,
  type NativeInvokeOptions,
  s,
} from "@bunaway/plugin";
import manifest from "../package.json";

const nullableString = {
  anyOf: [
    s.string(),
    s.null(),
  ],
} as const;
const statusSchema = s.object({
  registrationName: s.string(),
  registered: s.boolean(),
  commandLine: nullableString,
  executablePath: nullableString,
  args: {
    anyOf: [
      s.array(s.string()),
      s.null(),
    ],
  },
  startupState: s.enum([
    "enabled",
    "disabled",
    "unknown",
  ]),
  matchesCurrentLaunch: s.boolean(),
});

const plugin = defineNativePlugin({
  name: "autostart",
  version: manifest.version,
  operations: {
    enable: {
      input: s.object({
        args: s.array(
          s.string({
            maxLength: 260,
          }),
          {
            maxItems: 64,
          },
        ),
      }),
      output: statusSchema,
      permission: "configure",
      osPermission: "not-required",
    },
    disable: {
      input: s.null(),
      output: s.null(),
      permission: "configure",
      osPermission: "not-required",
    },
    getStatus: {
      input: s.null(),
      output: statusSchema,
      permission: "read",
      osPermission: "not-required",
    },
  },
});

/** Optional user-scoped Windows login registration. Importing does not register the app. */
export const autostartPlugin = plugin.definition;
export default autostartPlugin;

/** Stored launch data and the independently observed Windows startup approval state. */
export type AutostartStatus = Infer<typeof statusSchema>;

/**
 * Replace this app's Run value with the host-selected launch and these app arguments.
 * Preserves Windows startup approval, including the user's disabled choice.
 * Rejects a complete encoded command line longer than 260 UTF-16 code units.
 */
export function enableAutostart(
  args: string[] = [],
  options?: NativeInvokeOptions,
): Promise<AutostartStatus> {
  return plugin.api.enable(
    {
      args,
    },
    options,
  );
}

/** Delete only this app's Run value. Repeated removal succeeds; approval is not changed. */
export function disableAutostart(options?: NativeInvokeOptions): Promise<null> {
  return plugin.api.disable(null, options);
}

/** Read the real stored path and arguments without repairing or enabling the registration. */
export function getAutostartStatus(
  options?: NativeInvokeOptions,
): Promise<AutostartStatus> {
  return plugin.api.getStatus(null, options);
}
