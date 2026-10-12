import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChannelConfig, parsePackaging } from "@bunaway/packaging";
import { findIscc, must, stableGuid } from "#packaging/channels/windows/common";
import { renderInnoScript } from "#packaging/channels/windows/inno";

const associations = {
  files: [
    {
      extension: ".NOTE",
      name: "Notes 파일 {문서}",
      mimeType: "application/x-notes",
    },
  ],
  urlSchemes: [
    {
      scheme: "notes",
      name: "Notes URL",
    },
  ],
};

test("installer association config normalizes keys and rejects unsafe or ambiguous declarations", () => {
  const parse = (value: unknown, channel = "win-direct") =>
    parsePackaging(
      JSON.stringify({
        channels: {
          [channel]: {
            associations: value,
          },
        },
      }),
    );
  expect(
    parse(associations).channels?.["win-direct"]?.associations?.files?.[0]
      ?.extension,
  ).toBe(".note");
  expect(
    parse(associations, "win-store-unpackaged").channels?.[
      "win-store-unpackaged"
    ]?.associations,
  ).toBeDefined();
  for (const value of [
    {},
    {
      files: [],
    },
    {
      files: [
        {
          extension: "note",
          name: "Notes",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a\\b",
          name: "Notes",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "Notes",
          icon: "other.exe",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "Notes",
          mimeType: "bad",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "Notes\n[Code]",
        },
      ],
    },
    {
      files: [
        {
          extension: ".a",
          name: "A",
        },
        {
          extension: ".A",
          name: "B",
        },
      ],
    },
    {
      urlSchemes: [
        {
          scheme: "notes:",
          name: "Notes",
        },
      ],
    },
    {
      urlSchemes: [
        {
          scheme: "notes",
          name: "A",
        },
        {
          scheme: "NOTES",
          name: "B",
        },
      ],
    },
    {
      files: Array.from(
        {
          length: 33,
        },
        (_, i) => ({
          extension: `.x${i}`,
          name: "X",
        }),
      ),
    },
  ]) {
    expect(() => parse(value)).toThrow();
  }
  expect(() => parse(associations, "win-store-msix")).toThrow("unknown field");
});

const script = (
  identifier: string,
  payloadDir: string,
  outputDir: string,
  executableName: string,
  declarations?: ChannelConfig["associations"],
) =>
  renderInnoScript({
    name: "연결 App {문서}",
    identifier,
    version: "1.0.0",
    publisher: "Tests",
    scope: "perUser",
    payloadDir,
    outputDir,
    outputBaseName: "setup",
    executableName,
    desktopShortcut: false,
    startMenuShortcut: false,
    webView2: "check",
    appDataDir: "{localappdata}\\bunaway\\association-test",
    preserveUserData: true,
    assetPaths: [],
    ...(declarations
      ? {
          associations: declarations,
        }
      : {}),
  });

test("association installer tasks are unchecked and quote executable and argument separately", () => {
  const rendered = script(
    "tests.associations",
    "payload",
    "output",
    "연결 {App}.exe",
    associations,
  );
  expect(rendered).toContain(
    'Name: "fileassociations"; Description: "파일 열기 앱으로 등록"; GroupDescription: "앱 연결:"; Flags: unchecked',
  );
  expect(rendered).toContain(
    'Name: "urlschemes"; Description: "URL 열기 앱으로 등록"; GroupDescription: "앱 연결:"; Flags: unchecked',
  );
  expect(rendered).toContain(
    "ExpandConstant('{app}') + '\\' + '연결 {App}.exe'",
  );
  expect(rendered).toContain("Result := '\"' + Executable + '\" \"%1\"';");
  expect(rendered).toContain("ChangesAssociations=yes");
  expect(rendered).toContain("Notes 파일 {문서}");
  expect(rendered).not.toContain(
    "WriteAssociationValue('Software\\Classes\\notes'",
  );
});

const iscc = process.platform === "win32" ? await findIscc() : undefined;

test.skipIf(!iscc)(
  "native installer registers opt-in candidates, updates declarations and preserves Windows defaults",
  async () => {
    if (!iscc) {
      throw new Error("ISCC is required.");
    }
    const compiler = iscc;
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "bunaway-associations-")),
    );
    const identifier = `tests.associations-${crypto.randomUUID()}`;
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const extension = `.b${suffix.slice(0, 20)}`;
    const scheme = `b${suffix.slice(0, 20)}`;
    const associationRoot = `Software\\Bunaway\\Associations\\${stableGuid(identifier)}`;
    const registration = `연결 App {문서} (${identifier})`;
    const fileProgId = `BW.${stableGuid(`${identifier}:file:${extension}`).replaceAll("-", "")}`;
    const urlProgId = `BW.${stableGuid(`${identifier}:url:${scheme}`).replaceAll("-", "")}`;
    const installDir = join(root, "앱 설치");
    const declarations = {
      files: [
        {
          extension,
          name: "문서",
          mimeType: "application/x-test",
        },
      ],
      urlSchemes: [
        {
          scheme,
          name: "링크",
        },
      ],
    };
    const silent = [
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
    ];
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    async function powershell(body: string) {
      const child = Bun.spawn(
        [
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$ErrorActionPreference='Stop'; ${body}`,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = await new Response(child.stdout).text();
      const error = await new Response(child.stderr).text();
      if ((await child.exited) !== 0) {
        throw new Error(error);
      }
      return output.trim();
    }
    const query = (path: string, name = "") =>
      powershell(
        `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(${quote(path)}); if ($key) { try { $key.GetValue(${quote(name)},'MISSING') } finally { $key.Dispose() } } else { 'MISSING' }`,
      );
    const write = (path: string, name: string, value: string) =>
      powershell(
        `$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey(${quote(path)}); try { $key.SetValue(${quote(name)},${quote(value)}) } finally { $key.Dispose() }`,
      );
    async function install(
      version: string,
      executable: string,
      config: ChannelConfig["associations"],
      tasks?: string,
    ) {
      const staging = join(root, version);
      const payload = join(staging, "app");
      const output = join(staging, "installer");
      await mkdir(payload, {
        recursive: true,
      });
      await mkdir(output);
      await Bun.write(join(payload, executable), "installer payload fixture");
      const iss = join(staging, "setup.iss");
      await Bun.write(
        iss,
        `\ufeff${script(identifier, payload, output, executable, config)}`,
      );
      await must(compiler, [
        "/Q",
        iss,
      ]);
      await must(join(output, "setup.exe"), [
        ...silent,
        `/DIR=${installDir}`,
        ...(tasks !== undefined
          ? [
              `/TASKS=${tasks}`,
            ]
          : []),
      ]);
    }
    async function uninstall() {
      const executable = join(installDir, "unins000.exe");
      if (!(await Bun.file(executable).exists())) {
        return;
      }
      await must(executable, silent);
      for (let i = 0; i < 200; i++) {
        if (!(await Bun.file(executable).exists())) {
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error("Uninstaller did not finish.");
    }
    try {
      // The fixtures are random isolated extensions and schemes. Existing
      // defaults and a synthetic UserChoice record must remain byte-for-byte.
      await write(`Software\\Classes\\${extension}`, "", "Foreign.File");
      await write(
        `Software\\Classes\\${scheme}\\shell\\open\\command`,
        "",
        '"foreign.exe" "%1"',
      );
      await write(
        `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice`,
        "ProgId",
        "Foreign.File",
      );
      await install("disabled", "앱.exe", declarations);
      expect(await query(associationRoot, "Executable")).toBe("MISSING");
      await install(
        "enabled",
        "앱.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe(`"${join(installDir, "앱.exe")}" "%1"`);
      expect(await query(`Software\\Classes\\${fileProgId}`)).toBe("문서");
      expect(await query(`Software\\Classes\\${fileProgId}\\DefaultIcon`)).toBe(
        `"${join(installDir, "앱.exe")}",0`,
      );
      expect(
        await query(`Software\\Classes\\${fileProgId}`, "Content Type"),
      ).toBe("application/x-test");
      expect(
        await query(
          `Software\\Classes\\${extension}\\OpenWithProgids`,
          fileProgId,
        ),
      ).toBe("");
      expect(
        await query(
          `${associationRoot}\\Capabilities\\UrlAssociations`,
          scheme,
        ),
      ).toBe(urlProgId);
      expect(
        await query("Software\\RegisteredApplications", registration),
      ).toBe(`${associationRoot}\\Capabilities`);
      await install("renamed", "새 앱.exe", declarations);
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe(`"${join(installDir, "새 앱.exe")}" "%1"`);
      // A declaration removed from the next snapshot is cleaned without needing
      // the old uninstall log (the existing policy overwrites that log).
      await install("file-only", "새 앱.exe", {
        files: declarations.files,
      });
      expect(
        await query(`Software\\Classes\\${urlProgId}\\shell\\open\\command`),
      ).toBe("MISSING");
      await install("deselected", "새 앱.exe", declarations, "");
      expect(await query(associationRoot, "Executable")).toBe("MISSING");
      await install(
        "reenabled",
        "새 앱.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      await uninstall();
      expect(await query(associationRoot, "Executable")).toBe("MISSING");
      expect(
        await query("Software\\RegisteredApplications", registration),
      ).toBe("MISSING");
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe("MISSING");
      expect(
        await query(`Software\\Classes\\${urlProgId}\\shell\\open\\command`),
      ).toBe("MISSING");
      expect(await query(`Software\\Classes\\${extension}`)).toBe(
        "Foreign.File",
      );
      expect(
        await query(`Software\\Classes\\${scheme}\\shell\\open\\command`),
      ).toBe('"foreign.exe" "%1"');
      expect(
        await query(
          `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}\\UserChoice`,
          "ProgId",
        ),
      ).toBe("Foreign.File");
      await install(
        "foreign-command",
        "앱.exe",
        declarations,
        "fileassociations,urlschemes",
      );
      await write(
        `Software\\Classes\\${fileProgId}\\shell\\open\\command`,
        "",
        '"changed.exe" "%1"',
      );
      await uninstall();
      expect(
        await query(`Software\\Classes\\${fileProgId}\\shell\\open\\command`),
      ).toBe('"changed.exe" "%1"');
      expect(
        await query(
          `Software\\Classes\\${extension}\\OpenWithProgids`,
          fileProgId,
        ),
      ).toBe("");
    } finally {
      await uninstall();
      for (const key of [
        associationRoot,
        `Software\\Classes\\${extension}`,
        `Software\\Classes\\${scheme}`,
        `Software\\Classes\\${fileProgId}`,
        `Software\\Classes\\${urlProgId}`,
        `Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\${extension}`,
      ]) {
        await powershell(
          `[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(${quote(key)},$false)`,
        );
      }
      await powershell(
        `$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\\RegisteredApplications',$true); if ($key) { try { $key.DeleteValue(${quote(registration)},$false) } finally { $key.Dispose() } }`,
      );
      await rm(root, {
        recursive: true,
        force: true,
      });
    }
  },
  120000,
);
