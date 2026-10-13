import { createClient } from "@bunaway/client";
import {
  openFile,
  openFileWith,
  openUrl,
  revealFile,
} from "@bunaway/plugin-opener";
import { windows } from "@bunaway/plugin-windows";

const client = createClient();
// This entry is bundled for WKWebView; repository test types also include Bun files.
declare const location: {
  href: string;
  pathname: string;
};
function check(value: unknown, message: string): asserts value {
  if (!value) {
    throw new Error(message);
  }
}
async function rejected(work: Promise<unknown>, code: string) {
  try {
    await work;
  } catch (error) {
    check(
      error instanceof Error && "code" in error && error.code === code,
      `Expected ${code}: ${String(error)}`,
    );
    return;
  }
  throw new Error(`Expected ${code}`);
}
try {
  const file = new URL(location.href).searchParams.get("file");
  check(file, "Missing controlled file");
  if (location.pathname === "/denied.html") {
    await rejected(openFile(file), "PERMISSION_DENIED");
    await rejected(revealFile(file), "PERMISSION_DENIED");
    await rejected(openUrl("http://127.0.0.1/denied"), "PERMISSION_DENIED");
    await client.invoke("test.denied", null);
  } else {
    // These package helpers exercise browser -> Core -> host -> the real I/O adapter.
    check((await openFile(file)) === null, "File request accepted");
    await rejected(openFile(`${file}.missing`), "INVALID_ARGUMENT");
    check((await revealFile(file)) === null, "Finder request accepted");
    // Direct host input exercises platform support before selected-app Windows normalization.
    await rejected(
      client.invoke("plugin.opener.openFileWith", {
        path: file,
        app: "C:/app.exe",
      }),
      "UNSUPPORTED",
    );
    await rejected(openFileWith("C:/file.txt", "C:/app.exe"), "UNSUPPORTED");
    const controller = new AbortController();
    controller.abort();
    await rejected(
      client.invoke(
        "plugin.opener.openUrl",
        {
          url: "http://127.0.0.1/cancelled",
        },
        {
          signal: controller.signal,
        },
      ),
      "CANCELLED",
    );
    check(
      (await openUrl('http://127.0.0.1:43210/한글 값?q=one#quote"')) === null,
      "HTTP accepted",
    );
    check(
      (await openUrl('https://127.0.0.1:43210/한글 값?q=two#quote"')) === null,
      "HTTPS accepted",
    );
    await client.invoke("test.wait", null);
    await client.invoke("test.report", {
      ok: true,
      file,
      requests: [
        "openFile",
        "revealFile",
        "openUrl.http",
        "openUrl.https",
      ],
      denied: true,
      unsupported: "openFileWith",
      cancelled: true,
    });
    await windows.close({
      view: "denied",
    });
    await windows.close({
      view: "main",
    });
  }
} catch (error) {
  if (
    !(error instanceof Error && "code" in error && error.code === "CANCELLED")
  ) {
    await client.invoke("test.report", {
      ok: false,
      message: String(error),
    });
    await windows.close({
      view: "main",
    });
  }
}
