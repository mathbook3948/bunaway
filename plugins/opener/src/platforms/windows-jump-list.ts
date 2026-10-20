import { dlopen, type Pointer, ptr, read } from "bun:ffi";
import { failWithCleanup, type NativeEnvironment } from "@bunaway/plugin";
import { OLE32, pick, wide } from "@bunaway/plugin/win32";
import { BunawayError } from "@bunaway/protocol";
import type {
  JumpListInput,
  JumpListResult,
  JumpListTask,
  RemovedJumpListTask,
} from "#opener/contract";
import { ComScope, guid, SHELL_LINK_SLOT } from "#opener/platforms/windows-com";
import {
  buildJumpListArguments,
  entryArguments,
} from "#opener/platforms/windows-jump-list-command";

type AppLaunch = NonNullable<NativeEnvironment["app"]>["launch"];

const CLSCTX_INPROC_SERVER = 0x1;
const SLGP_RAWPATH = 0x4;
const E_ACCESSDENIED = 0x80070005;
const VT_BOOL = 11;
const VT_LPWSTR = 31;
const VARIANT_TRUE = -1;
// PROPVARIANT: a 16-bit type, then the value at offset 8 on 64-bit Windows.
const PROPVARIANT_BYTES = 24;
const PROPVARIANT_VALUE_OFFSET = 8;
// PROPERTYKEY: a format GUID followed by a 32-bit property id.
const PROPERTY_KEY_BYTES = 20;
const GUID_BYTES = 16;
// Text read back from the Shell is cut at these sizes, in UTF-16 units.
const TEXT_UNITS = 8192;
const ICON_INDEX_BYTES = 4;
const COUNT_BYTES = 4;

/** `ICustomDestinationList`, `IObjectCollection`/`IObjectArray` and `IPropertyStore` slots. */
const SLOT = {
  beginList: 4,
  appendCategory: 5,
  addUserTasks: 7,
  commitList: 8,
  deleteList: 10,
  abortList: 11,
  getCount: 3,
  getAt: 4,
  addObject: 5,
  getValue: 5,
  setValue: 6,
  commit: 7,
} as const;

const CLSID_DESTINATION_LIST = guid("77f10cf0-3db5-4966-b520-b7c54fd35ed6");
const IID_DESTINATION_LIST = guid("6332debf-87b5-4670-90c0-5e57b408a49e");
const CLSID_COLLECTION = guid("2d3468c1-36a7-43b6-ac24-d3f02fd9607a");
const IID_OBJECT_COLLECTION = guid("5632b1a4-e38a-400a-928a-d4cd63230295");
const IID_OBJECT_ARRAY = guid("92ca9dcd-5622-4bba-a805-5e9f541bd8c9");
const CLSID_SHELL_LINK = guid("00021401-0000-0000-c000-000000000046");
const IID_SHELL_LINK = guid("000214f9-0000-0000-c000-000000000046");
const IID_PROPERTY_STORE = guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");

function propertyKey(format: string, id: number): Buffer {
  const key = Buffer.alloc(PROPERTY_KEY_BYTES);
  guid(format).copy(key);
  key.writeUInt32LE(id, GUID_BYTES);
  return key;
}
const PKEY_TITLE = propertyKey("f29f85e0-4ff9-1068-ab91-08002b27b3d9", 2);
const PKEY_IS_SEPARATOR = propertyKey(
  "9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3",
  6,
);

function jumpListFailed(): BunawayError {
  return new BunawayError({
    code: "INTERNAL",
    message: "Windows could not process the Jump List.",
  });
}

function unsupportedWithoutApp(): BunawayError {
  return new BunawayError({
    code: "UNSUPPORTED",
    message: "The Jump List needs the host app identity.",
  });
}

/** Fail the request on a negative HRESULT. */
function succeeded(result: number): void {
  if (result < 0) {
    throw jumpListFailed();
  }
}

/** Read a NUL-terminated UTF-16 string the Shell allocated. */
function readWide(address: number): string {
  const units: number[] = [];
  for (let offset = 0; units.length < TEXT_UNITS; offset += 2) {
    const unit = read.u16(address as Pointer, offset);
    if (unit === 0) {
      break;
    }
    units.push(unit);
  }
  return String.fromCharCode(...units);
}

/** Text from a fixed UTF-16 buffer the Shell filled. */
function bufferText(buffer: Buffer): string {
  return buffer.toString("utf16le").split("\0", 1)[0] ?? "";
}

/**
 * The taskbar Jump List of this process, held on the opener's initialized STA. Each request
 * creates its own COM objects and releases them before it returns. The list belongs to the
 * process's explicit AppUserModelID, which the host sets. Dispose after the adapter stops.
 */
export function createJumpLists(app: NativeEnvironment["app"]) {
  const ole = dlopen("ole32.dll", {
    ...pick(OLE32, "CoCreateInstance", "CoTaskMemFree"),
  });
  let disposed = false;

  function launchOf(): AppLaunch {
    if (app === undefined) {
      throw unsupportedWithoutApp();
    }
    return app.launch;
  }

  function withScope<T>(use: (scope: ComScope) => T): T {
    if (disposed) {
      throw new BunawayError({
        code: "CANCELLED",
        message: "Opener has been disposed.",
      });
    }
    const scope = new ComScope(jumpListFailed);
    try {
      return use(scope);
    } finally {
      scope.release();
    }
  }

  function create(scope: ComScope, clsid: Buffer, iid: Buffer): Pointer {
    return scope.acquire((out) =>
      ole.symbols.CoCreateInstance(
        ptr(clsid),
        null,
        CLSCTX_INPROC_SERVER,
        ptr(iid),
        out,
      ),
    );
  }

  /** Start building a list; returns the destinations the user removed since the last commit. */
  function beginList(scope: ComScope, list: Pointer): Pointer {
    const minimumSlots = Buffer.alloc(COUNT_BYTES);
    return scope.acquire((out) =>
      scope.call(list, SLOT.beginList, [
        "ptr",
        "ptr",
        "ptr",
      ])(ptr(minimumSlots), ptr(IID_OBJECT_ARRAY), out),
    );
  }

  /** Discard a list that was begun but not committed; its previous contents stay. */
  function abortList(scope: ComScope, list: Pointer): void {
    scope.call(list, SLOT.abortList, [])();
  }

  function setText(
    scope: ComScope,
    link: Pointer,
    slot: number,
    value: string,
  ): void {
    const text = wide(value);
    succeeded(
      scope.call(link, slot, [
        "ptr",
      ])(ptr(text)),
    );
  }

  function setProperty(
    scope: ComScope,
    link: Pointer,
    key: Buffer,
    variant: Buffer,
  ): void {
    const store = scope.queryInterface(link, IID_PROPERTY_STORE);
    succeeded(
      scope.call(store, SLOT.setValue, [
        "ptr",
        "ptr",
      ])(ptr(key), ptr(variant)),
    );
    succeeded(scope.call(store, SLOT.commit, [])());
  }

  function separatorLink(scope: ComScope): Pointer {
    const link = create(scope, CLSID_SHELL_LINK, IID_SHELL_LINK);
    const variant = Buffer.alloc(PROPVARIANT_BYTES);
    variant.writeUInt16LE(VT_BOOL, 0);
    variant.writeInt16LE(VARIANT_TRUE, PROPVARIANT_VALUE_OFFSET);
    setProperty(scope, link, PKEY_IS_SEPARATOR, variant);
    return link;
  }

  function taskLink(
    scope: ComScope,
    launch: AppLaunch,
    task: JumpListTask,
  ): Pointer {
    const link = create(scope, CLSID_SHELL_LINK, IID_SHELL_LINK);
    // The program is always this app; a task only chooses what it is started with.
    setText(scope, link, SHELL_LINK_SLOT.setPath, launch.executablePath);
    const line = buildJumpListArguments(launch, task.args ?? []);
    if (line.length > 0) {
      setText(scope, link, SHELL_LINK_SLOT.setArguments, line);
    }
    if (task.cwd !== undefined) {
      setText(scope, link, SHELL_LINK_SLOT.setWorkingDirectory, task.cwd);
    }
    if (task.description !== undefined) {
      setText(scope, link, SHELL_LINK_SLOT.setDescription, task.description);
    }
    if (task.iconPath !== undefined || task.iconIndex !== undefined) {
      const icon = wide(task.iconPath ?? launch.executablePath);
      succeeded(
        scope.call(link, SHELL_LINK_SLOT.setIconLocation, [
          "ptr",
          "i32",
        ])(ptr(icon), task.iconIndex ?? 0),
      );
    }
    const title = wide(task.title);
    const variant = Buffer.alloc(PROPVARIANT_BYTES);
    variant.writeUInt16LE(VT_LPWSTR, 0);
    variant.writeBigUInt64LE(BigInt(ptr(title)), PROPVARIANT_VALUE_OFFSET);
    // `title` stays referenced until the property store has copied it.
    setProperty(scope, link, PKEY_TITLE, variant);
    return link;
  }

  /** Append one category's items to the list; reports whether the Shell refused a custom category. */
  function appendCategory(
    scope: ComScope,
    list: Pointer,
    launch: AppLaunch,
    category: JumpListInput["categories"][number],
  ): JumpListResult {
    const collection = create(scope, CLSID_COLLECTION, IID_OBJECT_COLLECTION);
    for (const item of category.items) {
      const link =
        item.type === "separator"
          ? separatorLink(scope)
          : taskLink(scope, launch, item);
      succeeded(
        scope.call(collection, SLOT.addObject, [
          "ptr",
        ])(link),
      );
    }
    // A collection is an object array, so its pointer is passed where the list asks for one.
    if (category.type === "tasks") {
      succeeded(
        scope.call(list, SLOT.addUserTasks, [
          "ptr",
        ])(collection),
      );
      return "ok";
    }
    const name = wide(category.name);
    const result = scope.call(list, SLOT.appendCategory, [
      "ptr",
      "ptr",
    ])(ptr(name), collection);
    if (result >>> 0 === E_ACCESSDENIED) {
      return "customCategoryAccessDenied";
    }
    succeeded(result);
    return "ok";
  }

  function readText(scope: ComScope, link: Pointer, slot: number): string {
    const output = Buffer.alloc(TEXT_UNITS * 2);
    succeeded(
      scope.call(link, slot, [
        "ptr",
        "i32",
      ])(ptr(output), TEXT_UNITS),
    );
    return bufferText(output);
  }

  /** The title stored on the entry, or an empty string when it has none. */
  function readTitle(scope: ComScope, link: Pointer): string {
    const store = scope.queryInterfaceOptional(link, IID_PROPERTY_STORE);
    if (!store) {
      return "";
    }
    const variant = Buffer.alloc(PROPVARIANT_BYTES);
    succeeded(
      scope.call(store, SLOT.getValue, [
        "ptr",
        "ptr",
      ])(ptr(PKEY_TITLE), ptr(variant)),
    );
    if (variant.readUInt16LE(0) !== VT_LPWSTR) {
      return "";
    }
    const address = Number(variant.readBigUInt64LE(PROPVARIANT_VALUE_OFFSET));
    if (!address) {
      return "";
    }
    try {
      return readWide(address);
    } finally {
      ole.symbols.CoTaskMemFree(address as Pointer);
    }
  }

  /** One removed entry as a task, or null when this app's launch command did not write it. */
  function readRemovedTask(
    scope: ComScope,
    link: Pointer,
    launch: AppLaunch,
  ): RemovedJumpListTask | null {
    const path = Buffer.alloc(TEXT_UNITS * 2);
    succeeded(
      scope.call(link, SHELL_LINK_SLOT.getPath, [
        "ptr",
        "i32",
        "ptr",
        "u32",
      ])(ptr(path), TEXT_UNITS, null, SLGP_RAWPATH),
    );
    if (
      bufferText(path).toLowerCase() !== launch.executablePath.toLowerCase()
    ) {
      return null;
    }
    const args = entryArguments(
      launch,
      readText(scope, link, SHELL_LINK_SLOT.getArguments),
    );
    if (args === null) {
      return null;
    }
    const icon = Buffer.alloc(TEXT_UNITS * 2);
    const index = Buffer.alloc(ICON_INDEX_BYTES);
    succeeded(
      scope.call(link, SHELL_LINK_SLOT.getIconLocation, [
        "ptr",
        "i32",
        "ptr",
      ])(ptr(icon), TEXT_UNITS, ptr(index)),
    );
    return {
      type: "task",
      title: readTitle(scope, link),
      args,
      description: readText(scope, link, SHELL_LINK_SLOT.getDescription),
      iconPath: bufferText(icon),
      iconIndex: index.readInt32LE(0),
      cwd: readText(scope, link, SHELL_LINK_SLOT.getWorkingDirectory),
    };
  }

  function readRemovedTasks(
    scope: ComScope,
    removed: Pointer,
    launch: AppLaunch,
  ): RemovedJumpListTask[] {
    const count = Buffer.alloc(COUNT_BYTES);
    succeeded(
      scope.call(removed, SLOT.getCount, [
        "ptr",
      ])(ptr(count)),
    );
    const tasks: RemovedJumpListTask[] = [];
    for (let position = 0; position < count.readUInt32LE(0); position++) {
      // An entry that is not a shell link (a removed file, for example) is not a task.
      const link = scope.acquireOptional((out) =>
        scope.call(removed, SLOT.getAt, [
          "u32",
          "ptr",
          "ptr",
        ])(position, ptr(IID_SHELL_LINK), out),
      );
      const task = link ? readRemovedTask(scope, link, launch) : null;
      if (task) {
        tasks.push(task);
      }
    }
    return tasks;
  }

  return {
    /**
     * Replace the list with the given categories. A custom category the Shell refuses to
     * show is skipped and reported, and the rest is still committed. Any other failure
     * aborts the build, so the previous list stays.
     */
    set(input: JumpListInput): JumpListResult {
      const launch = launchOf();
      return withScope((scope) => {
        const list = create(
          scope,
          CLSID_DESTINATION_LIST,
          IID_DESTINATION_LIST,
        );
        beginList(scope, list);
        try {
          let outcome: JumpListResult = "ok";
          for (const category of input.categories) {
            if (appendCategory(scope, list, launch, category) !== "ok") {
              outcome = "customCategoryAccessDenied";
            }
          }
          succeeded(scope.call(list, SLOT.commitList, [])());
          return outcome;
        } catch (error) {
          return failWithCleanup(
            error,
            () => abortList(scope, list),
            "Jump List cleanup failed.",
          );
        }
      });
    },
    /** Entries the user removed from the list since it was last set, written by this app's launch command. */
    removedItems(): RemovedJumpListTask[] {
      const launch = launchOf();
      return withScope((scope) => {
        const list = create(
          scope,
          CLSID_DESTINATION_LIST,
          IID_DESTINATION_LIST,
        );
        const removed = beginList(scope, list);
        try {
          return readRemovedTasks(scope, removed, launch);
        } finally {
          // Reading changes nothing, so the begun list is discarded.
          abortList(scope, list);
        }
      });
    },
    /** Remove this app's custom Jump List entirely. */
    clear(): void {
      withScope((scope) => {
        const list = create(
          scope,
          CLSID_DESTINATION_LIST,
          IID_DESTINATION_LIST,
        );
        // A null application id names the calling process.
        succeeded(
          scope.call(list, SLOT.deleteList, [
            "ptr",
          ])(null),
        );
      });
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      ole.close();
    },
  };
}
