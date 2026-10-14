import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import notification from "@bunaway/plugin-notification";
import opener from "@bunaway/plugin-opener";
import type { HostContext, HostResponse } from "@bunaway/protocol";
import { Channel } from "#native/windows/bun/channel";
import { nativeFactory } from "../fixtures/native-platform.ts";
import { bundleIOPluginFixture } from "../fixtures/native-worker.ts";
import {
  cleanupFailedNotificationShortcutCreation,
  NotificationShortcutCreationError,
} from "../fixtures/notification-shortcut-cleanup.ts";
import { createNotificationShortcut } from "../fixtures/windows-notification-shortcut.ts";

test.skipIf(process.platform !== "win32")(
  "native notification query crosses the I/O worker with real WinRT, current identity, authorization and STA cleanup",
  async () => {
    // AppUserModelID is process-wide. Isolate the host identity and UUID shortcut from the rest of the suite.
    if (process.env.BUNAWAY_NOTIFICATION_FIXTURE !== "1") {
      const module = new URL(
        "../../plugins/notification/src/winrt.ts",
        import.meta.url,
      ).href;
      // A separate unregistered process prevents failed WinRT identity lookup from caching the wrong app context.
      const missing = Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          "-e",
          `
import assert from "node:assert/strict";
const { createNotifications } = await import(${JSON.stringify(module)});
const native = createNotifications(${JSON.stringify(`test.${crypto.randomUUID()}`)});
try {
  assert.throws(() => native.getStatus(), error => error.code === "UNSUPPORTED" && error.details.hresult === 0x80070490 && error.details.stage === "ToastNotifier.Setting");
} finally { native.dispose(); }
`,
        ],
        {
          timeout: 15000,
        },
      );
      expect(missing.exitCode, missing.stderr.toString()).toBe(0);
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "test",
          import.meta.path,
        ],
        {
          env: {
            ...process.env,
            BUNAWAY_NOTIFICATION_FIXTURE: "1",
            BUNAWAY_NOTIFICATION_SETTINGS_NATIVE: "0",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 40000,
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, `${stdout}\n${stderr}`).toBe(0);
      return;
    }
    const root = resolve(
      import.meta.dir,
      `../../build/windows-notification-${crypto.randomUUID()}`,
    );
    await mkdir(root, {
      recursive: true,
    });
    const appId = `test.${crypto.randomUUID()}`;
    const toastTag = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const toastGroup = "bunaway-fixture";
    let removeShortcut: (() => Promise<void>) | undefined;
    let creationFailure: unknown;
    try {
      try {
        removeShortcut = await createNotificationShortcut(appId);
      } catch (error) {
        if (error instanceof NotificationShortcutCreationError) {
          removeShortcut = error.cleanup;
        }
        creationFailure = error;
        throw error;
      }
      // Compare FFI to a strict projected getter. PowerShell's ordinary property syntax can suppress getter failures.
      const probe = Bun.spawnSync(
        [
          "powershell.exe",
          "-NoProfile",
          "-EncodedCommand",
          Buffer.from(
            `$ErrorActionPreference='Stop'; try {
        Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class NotificationIdentity {
          [DllImport("shell32.dll", CharSet=CharSet.Unicode)] public static extern int SetCurrentProcessExplicitAppUserModelID(string id);
          public static int HistoryCount(object target, System.Reflection.MethodInfo method, string id) {
            var history = method.Invoke(target, new object[] { id });
            if (history == null) throw new InvalidOperationException("GetHistory returned null");
            var items = history as System.Collections.IEnumerable;
            if (items == null) throw new InvalidOperationException("GetHistory is not a projected collection: " + history.GetType().FullName);
            int count = 0; foreach (object item in items) { if (item == null) throw new InvalidOperationException("Null notification entry"); count++; }
            Console.Error.WriteLine("notification-history type=" + history.GetType().FullName + " count=" + count);
            return count;
          }
        }';
        if ([NotificationIdentity]::SetCurrentProcessExplicitAppUserModelID('${appId}') -lt 0) { throw 'Process identity setup failed' }
        $manager=[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime];
        $notifier=$manager::CreateToastNotifier('${appId}');
        # Unpackaged settings need an existing notification database entry (Microsoft Toolkit's PreRegisterIdentityLessApp).
        # This disposable fixture alone primes that entry; production getStatus never sends a toast.
        $xml=[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime]::new();
        $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>Bunaway notification regression fixture</text></binding></visual></toast>');
        $toastType=[Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType=WindowsRuntime];
        $toast=$toastType::new($xml);
        $suppression=$toastType.GetProperty('SuppressPopup');
        $suppression.SetValue($toast,$true,$null);
        if ($suppression.GetValue($toast,$null) -ne $true) { throw 'Popup suppression was not applied' }
        foreach ($name in @('Tag','Group')) {
          $expected=if ($name -eq 'Tag') { '${toastTag}' } else { '${toastGroup}' };
          $property=$toastType.GetProperty($name); $property.SetValue($toast,$expected,$null);
          if ($property.GetValue($toast,$null) -cne $expected) { throw "$name was not applied" }
        }
        $expiration=[DateTimeOffset]::UtcNow.AddSeconds(15);
        $expiry=$toastType.GetProperty('ExpirationTime'); $expiry.SetValue($toast,$expiration,$null);
        if ($null -eq $expiry.GetValue($toast,$null)) { throw 'Expiration was not applied' }
        $primaryError=$null; $cleanupError=$null; $stage='Show';
        try {
        $notifier.Show($toast);
        $stage='Setting';
        $notifierType=[Windows.UI.Notifications.ToastNotifier, Windows.UI.Notifications, ContentType=WindowsRuntime];
        $property=$notifierType.GetProperty('Setting');
        if ($null -eq $property) { throw 'Setting property is unavailable' }
        $deadline=[DateTime]::UtcNow.AddSeconds(10);
        while ($true) {
          try { $value=$property.GetValue($notifier,$null); if ($null -eq $value) { throw 'Setting returned null' }; break }
          catch {
            $nativeError=$_.Exception; while ($null -ne $nativeError.InnerException) { $nativeError=$nativeError.InnerException }
            if ($nativeError.HResult -ne -2147023728 -or [DateTime]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Milliseconds 100
          }
        }
        [Console]::Write([int]$value)
        } catch {
          $primaryError=$_.Exception;
          [Console]::Error.WriteLine("notification-primary stage=$stage " + $primaryError.ToString());
        } finally {
          try {
            $manager::History.Remove('${toastTag}','${toastGroup}','${appId}');
            $historyType=[Windows.UI.Notifications.ToastNotificationHistory, Windows.UI.Notifications, ContentType=WindowsRuntime];
            $getHistory=$historyType.GetMethod('GetHistory',[Type[]]@([string]));
            if ($null -eq $getHistory) { throw 'Projected GetHistory method is unavailable' }
            $deadline=[DateTime]::UtcNow.AddSeconds(5);
            do {
              # Count inside C# so PowerShell cannot unwrap an empty WinRT collection to null or count its wrapper.
              $count=[NotificationIdentity]::HistoryCount($manager::History,$getHistory,'${appId}');
              if ($count -eq 0) { break }; Start-Sleep -Milliseconds 100;
            } while ([DateTime]::UtcNow -lt $deadline);
            if ($count -ne 0) { throw "Disposable notification history cleanup failed: count=$count" }
          } catch {
            $cleanupError=$_.Exception;
            [Console]::Error.WriteLine('notification-cleanup ' + $cleanupError.ToString());
          }
        }
        if ($null -ne $primaryError -or $null -ne $cleanupError) { throw 'Notification fixture failed; primary and cleanup diagnostics above' }
      } catch {
        [Console]::Error.WriteLine($_.Exception.ToString());
        try {
          $services=Get-CimInstance Win32_Service -Filter "Name='WpnService' OR Name LIKE 'WpnUserService%'" | Select-Object Name,State,StartMode;
          $os=Get-CimInstance Win32_OperatingSystem;
          [Console]::Error.WriteLine('notification-platform ' + (@{ os=$os.Caption; productType=$os.ProductType; services=@($services) } | ConvertTo-Json -Compress -Depth 3));
        } catch { [Console]::Error.WriteLine('notification-platform diagnostics unavailable: ' + $_.Exception.Message) }
        exit 1
      }`,
            "utf16le",
          ).toString("base64"),
        ],
        {
          timeout: 20000,
        },
      );
      expect(
        probe.exitCode,
        `stdout=${probe.stdout.toString()}\n${probe.stderr.toString()}`,
      ).toBe(0);
      expect(probe.stdout.toString().trim()).toMatch(/^[0-4]$/);
      const settingValue = Number(probe.stdout.toString().trim());
      const settings = [
        "enabled",
        "disabledForApplication",
        "disabledForUser",
        "disabledByGroupPolicy",
        "disabledByManifest",
      ];
      const setting = settings[settingValue];
      expect(setting).toBeDefined();
      if (!setting) {
        throw new Error("Unexpected Windows notification setting.");
      }
      const trace = resolve(root, "trace.json");
      const manifest = [
        notification,
        opener,
      ].map(({ _definition: { name, version, native } }) => ({
        name,
        version,
        native,
        thread: "worker" as const,
      }));
      const notificationModule = resolve(
        "plugins/notification/dist/native/windows.js",
      );
      const openerModule = resolve("plugins/opener/dist/native/windows.js");
      await bundleIOPluginFixture(
        root,
        manifest,
        `
import assert from "node:assert/strict";
import { dlopen, ptr } from "bun:ffi";
import { writeFileSync } from "node:fs";
const ole = dlopen("ole32.dll", {
  CoGetApartmentType: { args: ["ptr", "ptr"], returns: "i32" },
  CoInitializeEx: { args: ["ptr", "u32"], returns: "i32" },
  CoUninitialize: { args: [], returns: "void" },
});
const calls = [];
const apartment = new Int32Array(1), qualifier = new Int32Array(1);
const apartmentType = () => ole.symbols.CoGetApartmentType(ptr(apartment), ptr(qualifier));
export const pluginImports = {
  notification: { operations: () => import(${JSON.stringify(notificationModule)}).then(({default: plugin}) => ({
    createOperations(environment) {
      assert.equal(environment.app.id, ${JSON.stringify(appId)});
      const adapter = plugin._definition.nativePlatforms.windows.create(environment);
      return { ...adapter, async prepare(name, input, source) {
        const execute = await adapter.prepare(name, input, source);
        return async () => {
          assert.equal(apartmentType(), 0); assert([0,3].includes(apartment[0]));
          calls.push(name);
          let result;
          try { result = await execute(); } catch (error) {
            // The fixture reports trusted native diagnostics before the host strips public error details.
            console.error("notification-native-failure", JSON.stringify({ operation: name, code: error.code, details: error.details, apartmentResult: apartmentType(), apartment: apartment[0] }));
            throw error;
          }
          assert.equal(apartmentType(), 0, "Notification queries must preserve the opener's existing apartment");
          return result;
        };
      }, dispose() {
        try {
          adapter.dispose(); adapter.dispose();
          const apartmentResult = apartmentType();
          // WinRT may retain a process-wide implicit MTA. S_OK for a fresh STA proves our thread's initialization was released;
          // S_FALSE would expose a leaked opener or notification initialization even when its apartment type still looks valid.
          const initialization = ole.symbols.CoInitializeEx(null, 2);
          try {
            assert.equal(initialization, 0, JSON.stringify({ stage: "notification-dispose", apartmentResult, apartment: apartment[0], qualifier: qualifier[0], initialization }));
          } finally {
            if (initialization >= 0) ole.symbols.CoUninitialize();
          }
          writeFileSync(${JSON.stringify(trace)}, JSON.stringify(calls));
        } catch (error) {
          console.error("notification-dispose-failure", error);
          throw error;
        } finally {
          ole.close();
        }
      }};
    }
  })) },
  opener: { operations: () => import(${JSON.stringify(openerModule)}).then(({default: plugin}) => ({createOperations: plugin._definition.nativePlatforms.windows.create})) },
};
`,
      );
      const runtime = {
        id: appId,
        generation: "1",
      };
      const context = "notification-native" as HostContext;
      const worker = new Worker(
        pathToFileURL(resolve(root, "host-operations.js")),
        {
          workerData: {
            runtime,
            dataRoot: root,
            assets: root,
            plugins: [
              notification,
              opener,
            ].map(({ _definition: { name, version, native } }) => ({
              name,
              version,
              native,
            })),
            app: {
              id: appId,
              launch: {
                mode: "packaged",
                executablePath: process.execPath,
                args: [],
              },
            },
          },
        },
      );
      let ready = false;
      let cleaned = false;
      let failure: unknown;
      let exitCode: number | undefined;
      const prepares = new Set<string>();
      const replies = new Map<string, HostResponse>();
      const exited = new Promise<number>((done) =>
        worker.once("exit", (code) => {
          exitCode = code;
          done(code);
        }),
      );
      worker.once("error", (error) => {
        failure = error;
      });
      const channel = new Channel(
        worker,
        runtime,
        "main-io",
        (packet) => {
          if (packet.kind === "ready") {
            ready = true;
          } else if (packet.kind === "authorize-input") {
            channel.notify({
              kind: "input-authorized",
              requestId: packet.requestId,
              context: packet.context,
              allowed: true,
            });
          } else if (packet.kind === "prepare") {
            prepares.add(packet.requestId);
          } else if (packet.kind === "host-response") {
            replies.set(packet.requestId, packet.response);
          } else if (packet.kind === "cleaned") {
            cleaned = true;
          }
        },
        (error) => {
          failure = error;
        },
      );
      const waitFor = async (condition: () => boolean) => {
        const deadline = Date.now() + 15000;
        while (!condition()) {
          if (failure) {
            throw failure;
          }
          if (exitCode !== undefined) {
            throw new Error(`Notification worker exited early: ${exitCode}`);
          }
          if (Date.now() > deadline) {
            throw new Error("Notification worker timed out.");
          }
          await Bun.sleep(2);
        }
      };
      const request = (
        requestId: string,
        operation = "notification.getStatus",
      ) =>
        channel.send({
          kind: "operation",
          requestId,
          context,
          source: "backend",
          call: {
            operation,
            payload: null,
          },
        });
      const grant = (requestId: string, allowed: boolean) =>
        channel.send({
          kind: "grant",
          requestId,
          context,
          allowed,
        });
      try {
        await waitFor(() => ready);
        await request("denied", "notification.openSettings");
        await waitFor(() => prepares.has("denied"));
        await grant("denied", false);
        await waitFor(() => replies.has("denied"));
        expect(replies.get("denied")).toMatchObject({
          kind: "error",
          error: {
            code: "PERMISSION_DENIED",
          },
        });
        await request("cancelled");
        await waitFor(() => prepares.has("cancelled"));
        await channel.send({
          kind: "cancel",
          requestId: "cancelled",
          context,
        });
        await grant("cancelled", true);
        for (const requestId of [
          "approved",
          "repeated",
        ]) {
          await request(requestId);
          await waitFor(() => prepares.has(requestId));
          await grant(requestId, true);
          await waitFor(() => replies.has(requestId));
          expect(replies.get(requestId)).toEqual({
            kind: "result",
            payload: {
              support: "supported",
              appUserModelId: appId,
              setting,
            },
          });
        }
        expect(replies.has("cancelled")).toBe(false);
        await channel.send({
          kind: "shutdown",
        });
        await waitFor(() => cleaned);
        expect(await exited).toBe(0);
        expect(failure).toBeUndefined();
        expect(await Bun.file(trace).json()).toEqual([
          "notification.getStatus",
          "notification.getStatus",
        ]);
      } finally {
        if (exitCode === undefined) {
          await worker.terminate();
        }
        channel.close();
        await rm(root, {
          recursive: true,
          force: true,
        });
      }
    } finally {
      try {
        if (creationFailure !== undefined && removeShortcut) {
          // Retry retained ownership while keeping the creation failure and any second cleanup failure observable.
          await cleanupFailedNotificationShortcutCreation(
            creationFailure,
            removeShortcut,
          );
        } else {
          await removeShortcut?.();
        }
      } finally {
        await rm(root, {
          recursive: true,
          force: true,
        });
      }
    }
  },
  45000,
);

test.skipIf(
  process.platform !== "win32" ||
    process.env.BUNAWAY_NOTIFICATION_SETTINGS_NATIVE !== "1",
)(
  "disposable desktop accepts the fixed Windows notification Settings request",
  async () => {
    const { default: nativeDefinition } = await import(
      "#plugins/notification/src/index"
    );
    const createOperations = nativeFactory(nativeDefinition, "windows");
    const adapter = createOperations({
      dataRoot: ".",
      capabilities: [],
      app: {
        id: `test.${crypto.randomUUID()}`,
        launch: {
          mode: "packaged",
          executablePath: process.execPath,
          args: [],
        },
      },
    });
    try {
      expect(
        await adapter.execute("notification.openSettings", null, "backend"),
      ).toBeNull();
    } finally {
      await adapter.dispose();
    }
  },
);
