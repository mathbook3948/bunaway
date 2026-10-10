import { resolve } from "node:path";
import { writeJson } from "#cli/files";

const inputs = resolve(process.argv[2] ?? "build/android-host");
const serial = process.env.ANDROID_SERIAL ?? "emulator-5554";
const sdk = process.env.ANDROID_HOME;
if (!sdk || !/^[A-Za-z0-9_.:-]+$/.test(serial)) {
  throw new Error("Set ANDROID_HOME and a valid ANDROID_SERIAL.");
}
const adb = resolve(sdk, "platform-tools/adb.exe");
const appId = "dev.bunaway.fixture";
async function command(...args: string[]): Promise<string> {
  const child = Bun.spawn(
    [
      adb,
      "-s",
      serial,
      ...args,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const missingPid =
    args[0] === "shell" &&
    args[1] === "pidof" &&
    code === 1 &&
    !output.trim() &&
    !errors.trim();
  if (code !== 0 && !missingPid) {
    throw new Error(`adb ${args.join(" ")}: ${errors}`);
  }
  return output.trim();
}

async function launchFixture(): Promise<string> {
  await command("shell", "input", "keyevent", "KEYCODE_HOME");
  const home = await command(
    "shell",
    "cmd",
    "package",
    "resolve-activity",
    "--brief",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.HOME",
  );
  const launcher = home.trim().split("\n").at(-1)?.split("/")[0];
  assert(
    launcher && /^[A-Za-z0-9_.]+$/.test(launcher),
    "Missing home launcher",
  );
  let icon: string | undefined;
  // Tap the installed app in the real launcher. Shell/monkey starts use different root-task Back semantics.
  for (let page = 0; page < 5; page++) {
    const xml = await readUI();
    assert(
      xml.includes(`package="${launcher}"`),
      "Expected the home launcher UI",
    );
    icon = xml
      .match(/<node\b[^>]*>/g)
      ?.find(
        (node) =>
          /(?:text|content-desc)=['"]Bunaway /.test(node) &&
          node.includes('clickable="true"'),
      );
    if (icon) {
      break;
    }
    const screen = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
    assert(screen?.[1] && screen[2], "Missing launcher screen bounds");
    const x = String(Math.floor(Number(screen[1]) / 2));
    await command(
      "shell",
      "input",
      "swipe",
      x,
      String(Math.floor(Number(screen[2]) * 0.8)),
      x,
      String(Math.floor(Number(screen[2]) * 0.2)),
      "400",
    );
  }
  await tapNode(icon, "Missing Bunaway fixture icon in home launcher");
  await command("shell", "wm", "user-rotation", "lock");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const pid = await command("shell", "pidof", appId);
    if (/^[1-9][0-9]*$/.test(pid)) {
      const activity = await command(
        "shell",
        "dumpsys",
        "activity",
        "activities",
        appId,
      );
      assert(
        activity.includes(`launchedFromPackage=${launcher} `) &&
          activity.includes("rootOfTask=true"),
        "Fixture must be a root task started by the home launcher",
      );
      await Bun.write(resolve(inputs, "launcher-activity.txt"), activity);
      return pid;
    }
    await Bun.sleep(100);
  }
  throw new Error("Launcher did not start the fixture host.");
}

async function tapNode(node: string | undefined, error: string): Promise<void> {
  const bounds = node?.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
  assert(bounds?.[1] && bounds[2] && bounds[3] && bounds[4], error);
  await command(
    "shell",
    "input",
    "tap",
    String(Math.floor((Number(bounds[1]) + Number(bounds[3])) / 2)),
    String(Math.floor((Number(bounds[2]) + Number(bounds[4])) / 2)),
  );
}

async function rotate(): Promise<void> {
  const mode = await command("shell", "wm", "user-rotation");
  assert(/^lock [0-3]$/.test(mode), "Expected a locked Android rotation");
  await command(
    "shell",
    "wm",
    "user-rotation",
    "lock",
    mode === "lock 0" || mode === "lock 2" ? "1" : "0",
  );
}

async function requireChildExit(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const processes = await command("shell", "ps", "-A", "-o", "PID,PPID,NAME");
    if (!new RegExp(`^\\s*${pid}\\s`, "m").test(processes)) {
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error("Bun survived Activity finish or renderer failure.");
}

const uiDump = `/sdcard/bunaway-${crypto.randomUUID()}.xml`;
async function readUI(): Promise<string> {
  await command("shell", "uiautomator", "dump", uiDump);
  const xml = await command("shell", "cat", uiDump);
  await Bun.write(resolve(inputs, "ui-last.xml"), xml);
  return xml;
}

async function requireFailureText(text: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if ((await readUI()).includes(text)) {
      return;
    }
  }
  throw new Error(`Missing native failure UI: ${text}`);
}

async function requireFailureButton(): Promise<string> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const node = (await readUI())
      .match(/<node\b[^>]*>/g)
      ?.find((element) =>
        /(?:text|content-desc)="Fail renderer"/.test(element),
      );
    if (node) {
      return node;
    }
  }
  throw new Error("Missing failure button after WebView rendering");
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
type Report = {
  passed: boolean;
  before: {
    count: number;
    pid: number;
  };
  after: {
    count: number;
    pid: number;
  };
  error?: string;
};
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSnapshot(value: unknown): value is Report["before"] {
  return (
    isRecord(value) &&
    typeof value.count === "number" &&
    Number.isSafeInteger(value.count) &&
    value.count >= 0 &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0
  );
}
function parseReport(text: string): Report {
  const value: unknown = JSON.parse(text);
  assert(
    isRecord(value) && typeof value.passed === "boolean",
    "Malformed Android report",
  );
  assert(
    value.passed,
    typeof value.error === "string" ? value.error : "Android UI tests failed",
  );
  assert(
    isSnapshot(value.before) && isSnapshot(value.after),
    "Malformed Android snapshots",
  );
  return {
    passed: true,
    before: value.before,
    after: value.after,
  };
}
async function report(hostPid: string, count: number): Promise<Report> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const logs = await command(
      "logcat",
      "-d",
      "--pid",
      hostPid,
      "-v",
      "raw",
      "BunawayWeb:I",
      "*:S",
    );
    for (const line of logs
      .split("\n")
      .filter((line) => line.startsWith("ANDROID_TEST:"))
      .reverse()) {
      const value = parseReport(line.slice("ANDROID_TEST:".length));
      if (value.after.count >= count) {
        return value;
      }
    }
    await Bun.sleep(200);
  }
  throw new Error("Android UI report timed out.");
}
const rotation = await command(
  "shell",
  "settings",
  "get",
  "system",
  "user_rotation",
);
const automatic = await command(
  "shell",
  "settings",
  "get",
  "system",
  "accelerometer_rotation",
);
try {
  await command(
    "install",
    "-r",
    resolve(inputs, "gradle-output/outputs/apk/debug/app-debug.apk"),
  );
  // Ask WindowManager to own the rotation mode rather than issuing separate Settings writes.
  await command("shell", "wm", "user-rotation", "lock", "0");
  await command("shell", "am", "force-stop", appId);
  const hostPid = await launchFixture();
  assert(/^[1-9][0-9]*$/.test(hostPid), "Expected one Android host PID");
  const first = await report(hostPid, 2);
  assert(
    first.before.count === 0 && first.after.pid !== Number(hostPid),
    "Fresh Core or child PID mismatch",
  );
  const running = await command("shell", "ps", "-A", "-o", "PID,PPID,NAME");
  assert(
    new RegExp(`^\\s*${first.after.pid}\\s+${hostPid}\\s`, "m").test(running),
    "Bun is not the actual app child",
  );
  await command("shell", "input", "keyevent", "KEYCODE_HOME");
  await readUI();
  assert(
    (await launchFixture()) === hostPid,
    "Home navigation replaced the host",
  );
  const resumed = await command("shell", "ps", "-A", "-o", "PID,PPID,NAME");
  assert(
    new RegExp(`^\\s*${first.after.pid}\\s+${hostPid}\\s`, "m").test(resumed),
    "Home navigation terminated Bun",
  );
  // Launch may restore the task's prior rotation. Change the actual live mode after its first report.
  await rotate();
  const rotated = await report(hostPid, 4);
  assert(
    rotated.before.count === 2 && rotated.after.pid === first.after.pid,
    "Activity recreation replaced Core or Bun",
  );
  await command("shell", "input", "keyevent", "4");
  await requireChildExit(first.after.pid);

  // Exercise the ready -> renderer failure -> closed owner -> Activity recreation path.
  await command("shell", "am", "force-stop", appId);
  const failureHost = await launchFixture();
  const beforeFailure = await report(failureHost, 2);
  const node = await requireFailureButton();
  await tapNode(node, "Missing failure button bounds");
  await requireFailureText("Invalid WebView message");
  await requireChildExit(beforeFailure.after.pid);
  await rotate();
  await requireFailureText("Backend is closed. Reopen the app.");
  await writeJson(resolve(inputs, "result.json"), {
    passed: true,
    first,
    rotated,
    shutdown: "Bun PID absent after back",
    launcher: "Home launcher icon, verified launchedFromPackage and root task",
    rendererFailureRotation:
      "Closed owner shows native failure instead of attaching a WebView",
  });
  console.log(
    "PASS: Android Core/SDK, WebView policy, events, cancellation, rotation and shutdown",
  );
} finally {
  await command("shell", "am", "force-stop", appId);
  await command("shell", "rm", "-f", uiDump);
  for (const [name, value] of [
    [
      "user_rotation",
      rotation,
    ],
    [
      "accelerometer_rotation",
      automatic,
    ],
  ] as const) {
    if (value === "null") {
      await command("shell", "settings", "delete", "system", name);
    } else {
      await command("shell", "settings", "put", "system", name, value);
    }
  }
}
