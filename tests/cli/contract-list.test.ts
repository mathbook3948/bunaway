import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Policy } from "@bunaway/protocol";
import { buildContractList, readAppDefinition } from "#cli/contract-list";
import { deadline } from "../fixtures/deadlines.ts";
import { createProject } from "./project.ts";

setDefaultTimeout(deadline("build"));

let home: string;
let project: string;
let appSource: string;
let policySource: string;

/** Runs the CLI entry in a child process and returns what it wrote. */
async function runContract(directory: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../../packages/cli/src/main.ts"),
      "contract",
      directory,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  return {
    code: await child.exited,
    stdout: await stdout,
    stderr: await stderr,
  };
}

beforeAll(async () => {
  home = await realpath(await mkdtemp(resolve(tmpdir(), "bunaway-contract-")));
  project = resolve(home, "app");
  await createProject(project);
  const install = Bun.spawn(
    [
      process.execPath,
      "install",
    ],
    {
      cwd: project,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = new Response(install.stdout).text();
  const errors = new Response(install.stderr).text();
  expect(await install.exited, `${await output}\n${await errors}`).toBe(0);
  appSource = await Bun.file(resolve(project, "src-bunaway/app.ts")).text();
  policySource = await Bun.file(
    resolve(project, "src-bunaway/policy.json"),
  ).text();
}, deadline("toolchain"));

afterAll(async () => {
  await rm(home, {
    recursive: true,
    force: true,
  });
});

test("contract lists the template's commands, events and view exposure", async () => {
  const { code, stdout } = await runContract(project);
  expect(code).toBe(0);
  const list = JSON.parse(stdout);
  expect(list.version).toBe(1);
  expect(
    list.commands.map(
      (entry: { name: string; owner: string; views: string[] }) => [
        entry.name,
        entry.owner,
        entry.views,
      ],
    ),
  ).toEqual([
    [
      "message.read",
      "app",
      [
        "main",
      ],
    ],
    [
      "message.save",
      "app",
      [
        "main",
      ],
    ],
  ]);
  expect(list.commands[1].input).toEqual({
    type: "string",
    maxLength: 10000,
  });
  expect(list.events.map((entry: { name: string }) => entry.name)).toEqual([
    "message.saved",
  ]);
  expect(list.views).toEqual([
    {
      id: "main",
      origins: [
        "https://app.bunaway.local",
      ],
      commands: [
        "message.read",
        "message.save",
      ],
      events: [
        "message.saved",
      ],
      hostPermissions: [
        "storage.readText",
        "storage.writeText",
      ],
    },
  ]);
  // Same project, same bytes.
  expect((await runContract(project)).stdout).toBe(stdout);
});

test("output from the app's top-level code stays out of the document", async () => {
  await Bun.write(
    resolve(project, "src-bunaway/app.ts"),
    `console.log("noise from app");\n${appSource}`,
  );
  try {
    const { code, stdout, stderr } = await runContract(project);
    expect(code).toBe(0);
    expect(stdout.startsWith("{")).toBe(true);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain("noise from app");
  } finally {
    await Bun.write(resolve(project, "src-bunaway/app.ts"), appSource);
  }
});

test("a policy name the app does not register fails with a nonzero exit", async () => {
  await Bun.write(
    resolve(project, "src-bunaway/policy.json"),
    policySource.replace('"message.read"', '"message.read", "message.gone"'),
  );
  try {
    const { code, stdout, stderr } = await runContract(project);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('view "main" lists command "message.gone"');
  } finally {
    await Bun.write(resolve(project, "src-bunaway/policy.json"), policySource);
  }
});

test("an app entry that fails to import fails with a nonzero exit and no document", async () => {
  await Bun.write(
    resolve(project, "src-bunaway/app.ts"),
    `throw new Error("boom");\n${appSource}`,
  );
  try {
    const { code, stdout, stderr } = await runContract(project);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Importing the app entry failed");
  } finally {
    await Bun.write(resolve(project, "src-bunaway/app.ts"), appSource);
  }
});

test("an app entry that never finishes importing is stopped at the limit", async () => {
  await Bun.write(
    resolve(project, "src-bunaway/app.ts"),
    `await new Promise(() => {});\n${appSource}`,
  );
  try {
    await expect(
      readAppDefinition(resolve(project, "src-bunaway/app.ts"), project, 500),
    ).rejects.toThrow("took longer than 500 ms");
  } finally {
    await Bun.write(resolve(project, "src-bunaway/app.ts"), appSource);
  }
});

test("plugin entries carry their owner and unexposed entries list no views", () => {
  const policy: Policy = {
    version: 1,
    views: [
      {
        id: "z",
        origins: [],
        commands: [
          "plug.ping",
        ],
        events: [],
        host: {
          permissions: [],
        },
      },
      {
        id: "a",
        origins: [],
        commands: [
          "plug.ping",
        ],
        events: [],
        host: {
          permissions: [],
        },
      },
    ],
    backend: {
      permissions: [],
    },
  };
  const list = buildContractList(policy, {
    commands: {
      "app.hidden": {
        input: {},
        output: {},
      },
    },
    events: {
      "app.changed": {
        type: "string",
      },
    },
    plugins: [
      {
        name: "plug",
        commands: {
          "plug.ping": {
            input: {
              const: null,
            },
            output: {
              const: null,
            },
          },
        },
        events: {},
      },
    ],
  });
  expect(
    list.commands.map((entry) => [
      entry.name,
      entry.owner,
    ]),
  ).toEqual([
    [
      "app.hidden",
      "app",
    ],
    [
      "plug.ping",
      "plugin:plug",
    ],
  ]);
  expect(list.commands[0]?.views).toEqual([]);
  expect(list.commands[1]?.views).toEqual([
    "a",
    "z",
  ]);
  expect(list.events[0]?.views).toEqual([]);
  expect(list.views.map((view) => view.id)).toEqual([
    "a",
    "z",
  ]);
});
