import { dlopen, ptr } from "bun:ffi";
import { expect, setDefaultTimeout, test } from "bun:test";
import { OLE32, pick } from "@bunaway/plugin/win32";
import { toastActivatorClsid } from "@bunaway/protocol";
import { writeToastActivatorServer } from "#plugins/notification/src/platforms/toast-activator-registry";
import type { ActivatorCall } from "#plugins/notification/src/platforms/toast-com-activator";
import { registerToastActivator } from "#plugins/notification/src/platforms/toast-com-activator";
import { deadline, killAfter, waitFor } from "../fixtures/deadlines.ts";

setDefaultTimeout(deadline("nativeFixture"));

const COINIT_APARTMENTTHREADED = 2;
const PM_REMOVE = 1;
const E_INVALIDARG = -2147024809;
const REGDB_E_CLASSNOTREG = -2147221164;

/**
 * Runs in a second process: connects to the activator class through COM (proxy and stub, as Windows
 * does for a toast click) and calls `INotificationActivationCallback::Activate` with several inputs.
 * Prints one JSON line of HRESULTs, or the CoCreateInstance failure.
 */
const CLIENT_SCRIPT = `
import { dlopen, ptr, read, CFunction } from "bun:ffi";
import { OLE32, pick, wide } from "@bunaway/plugin/win32";
const guid = (value) => {
  const bytes = Buffer.from(value.replaceAll("-", ""), "hex");
  bytes.subarray(0, 4).reverse(); bytes.subarray(4, 6).reverse(); bytes.subarray(6, 8).reverse();
  return bytes;
};
const [clsid, aumid] = process.argv.slice(-2);
const ole = dlopen("ole32.dll", { ...pick(OLE32, "CoInitializeEx", "CoCreateInstance") });
ole.symbols.CoInitializeEx(null, 0);
const out = new BigUint64Array(1);
const created = ole.symbols.CoCreateInstance(ptr(guid(clsid)), null, 4, ptr(guid("53e31837-6600-4a81-9395-75cffe746f94")), ptr(out));
if (created < 0) { console.log(JSON.stringify({ created })); process.exit(0); }
const object = Number(out[0]);
const activate = CFunction({ ptr: read.ptr(read.ptr(object), 3 * 8), args: ["ptr", "ptr", "ptr", "ptr", "u32"], returns: "i32" });
const call = (args, inputs) => {
  const keep = [];
  const struct = Buffer.alloc(16 * Math.max(inputs.length, 1));
  inputs.forEach(([key, value], index) => {
    const k = wide(key), v = wide(value);
    keep.push(k, v);
    struct.writeBigUInt64LE(BigInt(ptr(k)), index * 16);
    struct.writeBigUInt64LE(BigInt(ptr(v)), index * 16 + 8);
  });
  const text = wide(args), id = wide(aumid);
  return activate(object, ptr(id), ptr(text), inputs.length ? ptr(struct) : null, inputs.length);
};
const body = "bunaway1;bunaway;order;";
const results = {
  created,
  body: call(body, []),
  reply: call("bunaway1;bunaway;order;reply", [["reply", "hi there"]]),
  oversized: call("bunaway1;bunaway;order;" + "x".repeat(200), []),
  twoInputs: call(body, [["reply", "a"], ["other", "b"]]),
};
console.log(JSON.stringify(results));
`;

function runClient(clsid: string, appUserModelId: string) {
  return Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "-e",
      CLIENT_SCRIPT,
      clsid,
      appUserModelId,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

/** Dispatch window messages on this thread so COM can deliver calls to the STA this test registered in. */
function startPump() {
  const user = dlopen("user32.dll", {
    PeekMessageW: {
      args: [
        "ptr",
        "ptr",
        "u32",
        "u32",
        "u32",
      ],
      returns: "bool",
    },
    TranslateMessage: {
      args: [
        "ptr",
      ],
      returns: "bool",
    },
    DispatchMessageW: {
      args: [
        "ptr",
      ],
      returns: "i64",
    },
  });
  const message = Buffer.alloc(48);
  const timer = setInterval(() => {
    while (user.symbols.PeekMessageW(ptr(message), null, 0, 0, PM_REMOVE)) {
      user.symbols.TranslateMessage(ptr(message));
      user.symbols.DispatchMessageW(ptr(message));
    }
  }, 2);
  return () => {
    clearInterval(timer);
    user.close();
  };
}

async function readClient(child: ReturnType<typeof runClient>) {
  const killer = killAfter(child, "childStep");
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Record<
      string,
      number
    >;
  } finally {
    clearTimeout(killer);
  }
}

test.skipIf(process.platform !== "win32")(
  "another process reaches the registered activator through COM and invalid calls are refused",
  async () => {
    const appId = `test.${crypto.randomUUID()}`;
    const clsid = toastActivatorClsid(appId);
    const ole = dlopen("ole32.dll", {
      ...pick(OLE32, "CoInitializeEx", "CoUninitialize"),
    });
    ole.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
    const received: ActivatorCall[] = [];
    const server = registerToastActivator(clsid, (call) => {
      received.push(call);
    });
    const stopPump = startPump();
    try {
      const results = await readClient(runClient(clsid, appId));
      expect(results).toMatchObject({
        body: 0,
        reply: 0,
        oversized: E_INVALIDARG,
        twoInputs: E_INVALIDARG,
      });
      await waitFor(() => received.length >= 2, {
        deadline: "inProcess",
        what: "both valid activations reach the plugin",
      });
      expect(received).toEqual([
        {
          appUserModelId: appId,
          arguments: "bunaway1;bunaway;order;",
          reply: null,
        },
        {
          appUserModelId: appId,
          arguments: "bunaway1;bunaway;order;reply",
          reply: "hi there",
        },
      ]);
      server.dispose();
      server.dispose();
      // The class is gone after the revoke, so a click can no longer reach this process.
      const afterRevoke = await readClient(runClient(clsid, appId));
      expect(afterRevoke.created).toBe(REGDB_E_CLASSNOTREG);
    } finally {
      stopPump();
      server.dispose();
      ole.symbols.CoUninitialize();
      ole.close();
    }
  },
);

test.skipIf(process.platform !== "win32")(
  "the activator command is written quoted to the user's classes hive and rewritten on the next start",
  async () => {
    const clsid = toastActivatorClsid(`test.${crypto.randomUUID()}`);
    const key = `HKCU\\Software\\Classes\\CLSID\\{${clsid}}`;
    const query = async () => {
      const child = Bun.spawn(
        [
          "reg.exe",
          "query",
          `${key}\\LocalServer32`,
          "/ve",
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      return {
        stdout,
        code,
      };
    };
    try {
      writeToastActivatorServer(
        clsid,
        "C:\\Program Files\\Example App\\app.exe",
      );
      const first = await query();
      expect(first.code).toBe(0);
      expect(first.stdout).toContain(
        '"C:\\Program Files\\Example App\\app.exe"',
      );
      writeToastActivatorServer(clsid, "D:\\Moved\\app.exe");
      const second = await query();
      expect(second.stdout).toContain('"D:\\Moved\\app.exe"');
      expect(second.stdout).not.toContain("Example App");
    } finally {
      const removed = Bun.spawn(
        [
          "reg.exe",
          "delete",
          key,
          "/f",
        ],
        {
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      await removed.exited;
    }
  },
);
