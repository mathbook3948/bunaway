import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findWindowsKitTool } from "#packaging/channels/windows/common";
import { renderAppxManifest } from "#packaging/channels/windows/msix";
import { deadline, waitFor } from "../fixtures/deadlines.ts";

/**
 * Measures what an installed MSIX package does with a compiled app. A real package is built with
 * makeappx, signed with a throwaway certificate, installed for the current user, activated three
 * ways (shell, URL scheme, file type) and removed again. The channel adapter stays disabled; this
 * records what packaged activation and data paths look like so that decision rests on
 * measurements. It installs software and changes the machine trust store, so it runs only when
 * BUNAWAY_MSIX_PROBE=1 is set (the windows-msix CI job).
 */
const enabled =
  process.platform === "win32" && process.env.BUNAWAY_MSIX_PROBE === "1";

const VARIANTS = [
  {
    name: "virtualized",
    unvirtualizedData: false,
  },
  {
    name: "unvirtualized",
    unvirtualizedData: true,
  },
] as const;
type VariantName = (typeof VARIANTS)[number]["name"];

type Report = {
  packaged: boolean;
  packagePath: string | null;
  execPath: string;
  cwd: string;
  argv: string[];
  environment: Record<string, string | undefined>;
  localAppData: string;
  launchArguments: string;
  request: {
    urls?: string[];
    files?: string[];
    error?: string;
  };
  update: {
    outcome: string;
    code?: string;
    reason?: string;
  };
  localMarker: {
    path?: string;
    readBack?: string;
    error?: string;
  };
  roamingMarker: {
    path?: string;
    readBack?: string;
    error?: string;
  };
};

/** Where one data root's marker file ended up, by looking in each place the package could put it. */
type Placement = {
  real: boolean;
  virtualized: boolean;
  realAfterRemoval: boolean;
};

type Measurement = {
  family: string;
  reports: Record<string, Report>;
  local: Placement;
  roaming: Placement;
};

const measurements = {} as Record<VariantName, Measurement>;
let root = "";
let thumbprint = "";
const packageNames: string[] = [];
const dataFolders: string[] = [];
const suffix = Math.random().toString(16).slice(2, 10);

/**
 * Windows PowerShell 5.1 hosts the Appx and certificate cmdlets. The module path is reset because
 * the test runner can pass the path of another PowerShell edition, which hides them.
 */
const PRELUDE =
  "$ErrorActionPreference = 'Stop'; $env:PSModulePath = [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine'); Import-Module Microsoft.PowerShell.Security, PKI;";

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function powershell(script: string): string {
  const result = Bun.spawnSync(
    [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `${PRELUDE} ${script}`,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `PowerShell failed (${result.exitCode}): ${result.stderr.toString()}\n${result.stdout.toString()}`,
    );
  }
  return result.stdout.toString().trim();
}

async function tool(args: string[]): Promise<string> {
  const child = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(`${args.join(" ")} failed (${code}):\n${out}\n${err}`);
  }
  return out;
}

/** The recent package deployment log, to explain an install the system refused. */
function deploymentLog(): string {
  try {
    return powershell(
      "Get-AppxLog -All | Select-Object -First 40 | Format-List | Out-String -Width 200",
    );
  } catch (error) {
    return `no deployment log: ${String(error)}`;
  }
}

const LOGO =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=";

/** Compiles the measuring app for one variant; the output folder and names are baked in. */
async function compileProbe(
  output: string,
  executable: string,
  appId: string,
  scheme: string,
): Promise<void> {
  const compiled = await Bun.build({
    entrypoints: [
      resolve(import.meta.dir, "../fixtures/msix-probe-app.ts"),
    ],
    target: "bun",
    define: {
      PROBE_OUTPUT: JSON.stringify(output),
      PROBE_APP_ID: JSON.stringify(appId),
      PROBE_SCHEME: JSON.stringify(scheme),
    },
    compile: {
      outfile: executable,
      executablePath: process.execPath,
      windows: {
        hideConsole: true,
      },
    },
  });
  if (!compiled.success) {
    throw new Error(compiled.logs.map(String).join("\n"));
  }
}

async function readReport(
  output: string,
  name: string,
): Promise<Report | undefined> {
  const path = join(output, `${name}.json`);
  if (!existsSync(path)) {
    return undefined;
  }
  return JSON.parse(await readFile(path, "utf8")) as Report;
}

async function awaitReport(output: string, name: string): Promise<Report> {
  return waitFor(() => readReport(output, name), {
    deadline: "childStep",
    what: `the ${name} report in ${output}`,
    intervalMs: 200,
  });
}

function placement(
  real: string,
  virtualized: string,
): Omit<Placement, "realAfterRemoval"> {
  return {
    real: existsSync(real),
    virtualized: existsSync(virtualized),
  };
}

async function measureVariant(
  variant: (typeof VARIANTS)[number],
  makeappx: string,
  signtool: string,
): Promise<Measurement> {
  const label = variant.name;
  const output = join(root, "reports", label);
  const stage = join(root, "stage", label);
  const appId = `com.bunaway.msixprobe.${suffix}.${label}`;
  const scheme = `bwmsix${suffix}${label === "virtualized" ? "v" : "u"}`;
  const extension = `.bwp${suffix}${label === "virtualized" ? "v" : "u"}`;
  const packageName = `Bunaway.MsixProbe${suffix}${label === "virtualized" ? "V" : "U"}`;
  packageNames.push(packageName);
  const local = join(process.env.LOCALAPPDATA ?? "", "bunaway", appId);
  const roaming = join(process.env.APPDATA ?? "", "bunaway", appId);
  dataFolders.push(local, roaming);
  await mkdir(stage, {
    recursive: true,
  });
  await mkdir(output, {
    recursive: true,
  });
  const executable = join(stage, "probe.exe");
  await compileProbe(output, executable, appId, scheme);

  // The unpackaged control runs the same executable before installing, with the same arguments.
  const sample = join(root, `sample-${label}${extension}`);
  await writeFile(sample, "sample");
  const urlArgument = `${scheme}://probe/item?x=1`;
  for (const args of [
    [],
    [
      urlArgument,
    ],
    [
      sample,
    ],
  ]) {
    await tool([
      executable,
      ...args,
    ]);
  }
  for (const folder of [
    local,
    roaming,
  ]) {
    await rm(folder, {
      recursive: true,
      force: true,
    });
  }

  await writeFile(join(stage, "logo.png"), Buffer.from(LOGO, "base64"));
  await writeFile(
    join(stage, "AppxManifest.xml"),
    renderAppxManifest({
      packageName,
      appId,
      name: `Bunaway MSIX probe ${label}`,
      publisherDisplay: "Bunaway Tests",
      publisherIdentity: `CN=Bunaway MSIX Probe ${suffix}`,
      version: "1.0.0.0",
      minVersion: "10.0.18362.0",
      maxVersionTested: "10.0.26100.0",
      unvirtualizedData: variant.unvirtualizedData,
      capabilities: [],
      associations: {
        files: [
          {
            extension,
            name: "Probe files",
          },
        ],
        urlSchemes: [
          {
            scheme,
            name: "Probe links",
          },
        ],
      },
      executable: "probe.exe",
      logo: {
        square44: "logo.png",
        square150: "logo.png",
        storeLogo: "logo.png",
      },
    }),
  );
  const msix = join(root, `${label}.msix`);
  await tool([
    makeappx,
    "pack",
    "/d",
    stage,
    "/p",
    msix,
    "/o",
  ]);
  await tool([
    signtool,
    "sign",
    "/fd",
    "SHA256",
    "/sha1",
    thumbprint,
    "/s",
    "My",
    msix,
  ]);
  try {
    powershell(`Add-AppxPackage -Path ${quote(msix)}`);
  } catch (error) {
    throw new Error(`${String(error)}\n${deploymentLog()}`);
  }
  const family = powershell(
    `(Get-AppxPackage -Name ${quote(packageName)}).PackageFamilyName`,
  );
  const reports: Record<string, Report> = {};
  for (const kind of [
    "plain",
    "protocol",
    "file",
  ] as const) {
    const targets = {
      plain: `shell:AppsFolder\\${family}!App`,
      protocol: urlArgument,
      file: sample,
    };
    const target = targets[kind];
    powershell(`Start-Process -FilePath ${quote(target)}`);
    reports[`packaged-${kind}`] = await awaitReport(output, `packaged-${kind}`);
    reports[`direct-${kind}`] = (await awaitReport(
      output,
      `direct-${kind}`,
    )) as Report;
  }
  const packageData = join(
    process.env.LOCALAPPDATA ?? "",
    "Packages",
    family,
    "LocalCache",
  );
  const localPlacement = placement(
    join(local, "probe.txt"),
    join(packageData, "Local", "bunaway", appId, "probe.txt"),
  );
  const roamingPlacement = placement(
    join(roaming, "probe.txt"),
    join(packageData, "Roaming", "bunaway", appId, "probe.txt"),
  );
  powershell(
    `Get-AppxPackage -Name ${quote(packageName)} | Remove-AppxPackage`,
  );
  return {
    family,
    reports,
    local: {
      ...localPlacement,
      realAfterRemoval: existsSync(join(local, "probe.txt")),
    },
    roaming: {
      ...roamingPlacement,
      realAfterRemoval: existsSync(join(roaming, "probe.txt")),
    },
  };
}

describe.skipIf(!enabled)("an installed MSIX package", () => {
  beforeAll(async () => {
    const makeappx = await findWindowsKitTool("makeappx.exe");
    const signtool = await findWindowsKitTool("signtool.exe");
    if (!makeappx || !signtool) {
      throw new Error(
        "The Windows SDK tools makeappx and signtool are missing.",
      );
    }
    root = await realpath(await mkdtemp(join(tmpdir(), "bunaway-msix-probe-")));
    // The thumbprint is recorded before the trust store changes, so the cleanup can always find it.
    thumbprint = powershell(
      `(New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=Bunaway MSIX Probe ${suffix}' -CertStoreLocation Cert:\\CurrentUser\\My -NotAfter (Get-Date).AddDays(1)).Thumbprint`,
    );
    const certificate = join(root, "probe.cer");
    powershell(`
      Export-Certificate -Cert (Get-Item Cert:\\CurrentUser\\My\\${thumbprint}) -FilePath ${quote(certificate)} | Out-Null
      Import-Certificate -FilePath ${quote(certificate)} -CertStoreLocation Cert:\\LocalMachine\\TrustedPeople | Out-Null
    `);
    for (const variant of VARIANTS) {
      measurements[variant.name] = await measureVariant(
        variant,
        makeappx,
        signtool,
      );
    }
    // The CI job uploads this file; the numbers are the input to the activation decision.
    const summary = resolve(
      process.env.BUNAWAY_MSIX_PROBE_OUTPUT ?? join(root, "summary.json"),
    );
    await mkdir(resolve(summary, ".."), {
      recursive: true,
    });
    await writeFile(summary, JSON.stringify(measurements, null, 2));
    console.log(JSON.stringify(measurements, null, 2));
  }, deadline("packagedAudit") * 3);

  afterAll(async () => {
    // Each step stands alone, so one failure never keeps the certificate or a package installed.
    const steps = [
      ...packageNames.map(
        (name) => `Get-AppxPackage -Name ${quote(name)} | Remove-AppxPackage`,
      ),
      ...(thumbprint === ""
        ? []
        : [
            `Remove-Item Cert:\\LocalMachine\\TrustedPeople\\${thumbprint}`,
            `Remove-Item Cert:\\CurrentUser\\My\\${thumbprint} -DeleteKey`,
          ]),
    ];
    for (const step of steps) {
      try {
        powershell(step);
      } catch (error) {
        console.warn(`MSIX probe cleanup step failed: ${String(error)}`);
      }
    }
    for (const folder of [
      ...dataFolders,
      ...(root === ""
        ? []
        : [
            root,
          ]),
    ]) {
      await rm(folder, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, deadline("packagedAudit"));

  for (const variant of VARIANTS) {
    describe(variant.name, () => {
      test("the process has package identity and runs from the installed package", () => {
        const plain = measurements[variant.name].reports["packaged-plain"];
        expect(plain?.packaged).toBe(true);
        expect(plain?.packagePath).toBeTruthy();
        expect(plain?.execPath.toLowerCase()).toStartWith(
          `${plain?.packagePath?.toLowerCase()}\\`,
        );
        expect(
          measurements[variant.name].reports["direct-plain"]?.packaged,
        ).toBe(false);
      });

      test("updater.check refuses with managedByStore only in the package", () => {
        const { reports } = measurements[variant.name];
        expect(reports["packaged-plain"]?.update).toEqual({
          outcome: "rejected",
          code: "UNSUPPORTED",
          reason: "managedByStore",
        });
        expect(reports["direct-plain"]?.update.reason).not.toBe(
          "managedByStore",
        );
      });

      test("protocol and file activation reach the same launch arguments as a direct start", () => {
        const { reports } = measurements[variant.name];
        for (const kind of [
          "protocol",
          "file",
        ]) {
          const packaged = reports[`packaged-${kind}`];
          const direct = reports[`direct-${kind}`];
          expect(packaged?.request.error).toBeUndefined();
          expect(
            packaged?.request.urls?.map((url) => url.toLowerCase()),
          ).toEqual(direct?.request.urls?.map((url) => url.toLowerCase()));
          expect(
            packaged?.request.files?.map((path) => path.toLowerCase()),
          ).toEqual(direct?.request.files?.map((path) => path.toLowerCase()));
        }
        expect(reports["packaged-protocol"]?.request.urls).toHaveLength(1);
        expect(reports["packaged-file"]?.request.files).toHaveLength(1);
      });

      test("every data write lands in one place, recorded for the decision", () => {
        const { local, roaming } = measurements[variant.name];
        for (const data of [
          local,
          roaming,
        ]) {
          expect(data.real || data.virtualized).toBe(true);
        }
      });
    });
  }
});
