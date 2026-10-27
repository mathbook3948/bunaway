import { resolve } from "node:path";
import { containAppProcess } from "../../../native/windows/bun/job.ts";

// Compiled backend stand-in, built with one entry point like the packaged host. Worker and child
// scripts are plain files beside it: the host build does not take extra entry points.
const role = process.env.BUNAWAY_FIXTURE_ROLE ?? "app";
const scripts = process.env.BUNAWAY_FIXTURE_SCRIPTS as string;

function report(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function workerRoundTrip(label: string, source: string | URL) {
  const worker = new Worker(source);
  const doubled = new Promise((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
  });
  worker.postMessage({
    double: 21,
  });
  report({
    [label]: await doubled,
  });
  const failed = new Promise<string>((resolve) => {
    worker.onerror = (event) => {
      event.preventDefault();
      resolve(event.message);
    };
  });
  worker.postMessage("throw");
  report({
    [`${label}Error`]: await failed,
  });
  worker.terminate();
}

function startChild() {
  const messages: unknown[] = [];
  const waiters: ((message: unknown) => void)[] = [];
  const exited = Promise.withResolvers<{
    code: number | null;
    signal: number | null;
  }>();
  // BUN_BE_BUN makes the compiled executable run the script as plain Bun, so the child does not
  // start the host (which would find the app lock held and forward to this instance).
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(scripts, "utility-process-child.js"),
    ],
    {
      env: {
        ...process.env,
        BUN_BE_BUN: "1",
      },
      stdio: [
        "ignore",
        "ignore",
        "ignore",
      ],
      ipc(message) {
        const waiter = waiters.shift();
        if (waiter) {
          waiter(message);
        } else {
          messages.push(message);
        }
      },
      onExit(_process, code, signal) {
        exited.resolve({
          code,
          signal: signal ?? null,
        });
      },
    },
  );
  return {
    child,
    exited: exited.promise,
    next(): Promise<unknown> {
      const queued = messages.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

async function childRoundTrip() {
  const { child, exited, next } = startChild();
  const ready = (await next()) as {
    ready: number;
  };
  report({
    childDistinct: ready.ready !== process.pid && ready.ready === child.pid,
  });
  child.send({
    echo: "hello",
  });
  report({
    child: await next(),
  });
  child.send("exit");
  report({
    childExit: await exited,
  });
  report({
    parentAlive: true,
  });
}

async function lingeringChild(dataRoot: string, release: string) {
  containAppProcess(dataRoot);
  const { child, next } = startChild();
  await next();
  report({
    lingerPid: child.pid,
  });
  while (!(await Bun.file(release).exists())) {
    await Bun.sleep(20);
  }
  process.exit(0);
}

if (role === "app") {
  // A script file on disk, and a Blob URL for a worker whose source is a string in the bundle.
  await workerRoundTrip(
    "worker",
    resolve(scripts, "utility-process-worker.js"),
  );
  await workerRoundTrip(
    "blobWorker",
    URL.createObjectURL(
      new Blob(
        [
          await Bun.file(resolve(scripts, "utility-process-worker.js")).text(),
        ],
        {
          type: "text/javascript",
        },
      ),
    ),
  );
  await childRoundTrip();
} else {
  await lingeringChild(
    process.env.BUNAWAY_FIXTURE_DATA as string,
    process.env.BUNAWAY_FIXTURE_RELEASE as string,
  );
}
