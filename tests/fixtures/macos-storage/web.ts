import { createClient } from "@bunaway/client";
import storage from "@bunaway/plugin-storage";
import windows from "@bunaway/plugin-windows";

// This fixture is bundled only for the real browser document.
declare const location: {
  readonly pathname: string;
};
const client = createClient();
const view = location.pathname.includes("denied") ? "denied" : "main";
let restarted = false;
function check(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
async function rejected(work: Promise<unknown>, code: string): Promise<void> {
  try {
    await work;
  } catch (error) {
    check(
      error instanceof Error && "code" in error && error.code === code,
      `Expected ${code}: ${String(error)}`,
    );
    return;
  }
  throw new Error(`Expected ${code}.`);
}
try {
  const paths = await client.invoke("test.paths", null);
  check(
    paths &&
      typeof paths === "object" &&
      "root" in paths &&
      typeof paths.root === "string" &&
      "restarted" in paths &&
      typeof paths.restarted === "boolean",
    "Invalid fixture paths.",
  );
  const root = paths.root;
  restarted = paths.restarted;
  check(
    (await storage.readText({
      path: `${root}/restart.txt`,
    })) === "persistent 한글\0✓",
    "Backend setup and restart text.",
  );
  if (view === "denied") {
    await rejected(
      storage.writeText({
        path: `${root}/denied.txt`,
        text: "forbidden",
      }),
      "PERMISSION_DENIED",
    );
    await rejected(
      client.invoke("test.backendViaView", null),
      "PERMISSION_DENIED",
    );
    await rejected(
      storage.readDirectory({
        path: `${root}/directory-fixture`,
      }),
      "PERMISSION_DENIED",
    );
    await rejected(
      storage.createDirectory({
        path: `${root}/denied-directory`,
      }),
      "PERMISSION_DENIED",
    );
    check(
      (await storage.readText({
        path: `${root}/denied.txt`,
      })) === "preserved",
      "Denied writes changed data.",
    );
  } else {
    const directory = `${root}/created-directories/parent/child`;
    await rejected(
      storage.createDirectory({
        path: `${root}/missing-default/child`,
      }),
      "INVALID_ARGUMENT",
    );
    check(
      !(await storage.exists({
        path: `${root}/missing-default`,
      })),
      "Default recursive must not create parents.",
    );
    await storage.createDirectory({
      path: directory,
      recursive: true,
    });
    await storage.createDirectory({
      path: directory,
    });
    check(
      (
        await storage.readDirectory({
          path: directory,
        })
      ).length === 0,
      "Empty idempotently created directory.",
    );
    const entries = await storage.readDirectory({
      path: `${root}/directory-fixture`,
    });
    check(
      JSON.stringify(entries) ===
        JSON.stringify([
          {
            name: "dangling",
            kind: "link",
          },
          {
            name: "folder",
            kind: "directory",
          },
          {
            name: "link",
            kind: "link",
          },
          {
            name: "한글🙂.txt",
            kind: "file",
          },
        ]),
      "Direct Unicode names and observed link kinds.",
    );
    await rejected(
      storage.readDirectory({
        path: `${root}/outside`,
      }),
      "INVALID_ARGUMENT",
    );
    await rejected(
      storage.createDirectory({
        path: `${root}/outside`,
      }),
      "INVALID_ARGUMENT",
    );
    await rejected(
      storage.createDirectory({
        path: `${root}/symlink`,
      }),
      "PERMISSION_DENIED",
    );
    await rejected(
      storage.remove({
        path: `${root}/outside`,
      }),
      "UNSUPPORTED",
    );
    await rejected(
      storage.remove({
        path: directory,
      }),
      "UNSUPPORTED",
    );
    check(
      (await storage.readText({
        path: `${root}/outside`,
      })) === "outside" &&
        (await storage.exists({
          path: directory,
        })),
      "Unsupported remove must preserve files and directories.",
    );
    const text = `${root}/nested/한글 memo.txt`;
    await storage.writeText({
      path: text,
      text: "long initial content",
    });
    await storage.writeText({
      path: text,
      text: "short",
    });
    await storage.appendText({
      path: text,
      text: "\0✓",
    });
    check(
      (await storage.readText({
        path: text,
      })) === "short\0✓",
      "Text replacement and append.",
    );
    check(
      await storage.exists({
        path: text,
      }),
      "Existing path.",
    );
    const info = await storage.stat({
      path: text,
    });
    check(
      info?.kind === "file" && info.sizeBytes === 9,
      "Native stat byte size.",
    );
    check(
      (await storage.exists({
        path: `${root}/absent/leaf`,
      })) === false,
      "Absent exists.",
    );
    check(
      (await storage.stat({
        path: `${root}/absent/leaf`,
      })) === null,
      "Absent stat.",
    );
    await rejected(
      storage.readText({
        path: `${root}/absent`,
      }),
      "INVALID_ARGUMENT",
    );
    await rejected(
      storage.readText({
        path: `${root}/symlink`,
      }),
      "PERMISSION_DENIED",
    );
    const binary = `${root}/binary.bin`;
    await storage.writeBytes({
      path: binary,
      bytes: "AP8=",
    });
    await storage.appendBytes({
      path: binary,
      bytes: "gA==",
    });
    check(
      (await storage.readBytes({
        path: binary,
      })) === "AP+A",
      "Binary round-trip.",
    );
    const copied = `${root}/copy.bin`;
    const existing = await storage.exists({
      path: copied,
    });
    if (!existing) {
      await storage.copyFile({
        from: binary,
        to: copied,
      });
    }
    await rejected(
      storage.copyFile({
        from: binary,
        to: copied,
      }),
      "INVALID_ARGUMENT",
    );
    check(
      (await storage.readBytes({
        path: copied,
      })) === "AP+A",
      "No-overwrite copy.",
    );
    await rejected(
      storage.move({
        from: copied,
        to: `${root}/moved.bin`,
      }),
      "UNSUPPORTED",
    );
    check(
      (await storage.exists({
        path: copied,
      })) &&
        !(await storage.exists({
          path: `${root}/moved.bin`,
        })),
      "Unsupported move must not mutate names.",
    );
    await client.invoke("test.backendViaView", null);
    check(
      (await storage.readText({
        path: `${root}/command.txt`,
      })) === "view authority",
      "View command uses I/O dispatch.",
    );
  }
  await client.invoke("test.report", {
    view,
    ok: true,
    restarted,
    message: "passed",
  });
} catch (error) {
  await client.invoke("test.report", {
    view,
    ok: false,
    restarted,
    message: String(error),
  });
} finally {
  await windows.close({
    view,
  });
}
