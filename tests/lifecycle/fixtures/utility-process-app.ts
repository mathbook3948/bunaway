import { containAppProcess } from "../../../native/windows/bun/job.ts";

// Compiled backend stand-in. The role comes from the environment so the same executable is the
// app, the Bun.spawn child and, through the extra entry point, the worker module's host.
const role = process.env.BUNAWAY_FIXTURE_ROLE ?? "app";

function report(event: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function workerRoundTrip() {
  const worker = new Worker(
    new URL("./utility-process-worker.ts", import.meta.url).href,
  );
  const doubled = new Promise((resolve) => {
    worker.onmessage = (event) => resolve(event.data);
  });
  worker.postMessage({
    double: 21,
  });
  report({
    worker: await doubled,
  });
  const failed = new Promise<string>((resolve) => {
    worker.onerror = (event) => {
      event.preventDefault();
      resolve(event.message);
    };
  });
  worker.postMessage("throw");
  report({
    workerError: await failed,
  });
  worker.terminate();
}

function startChild(mode: string) {
  const messages: unknown[] = [];
  const waiters: ((message: unknown) => void)[] = [];
  const exited = Promise.withResolvers<{
    code: number | null;
    signal: number | null;
  }>();
  const child = Bun.spawn(
    [
      process.execPath,
    ],
    {
      env: {
        ...process.env,
        BUNAWAY_FIXTURE_ROLE: mode,
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
  const { child, exited, next } = startChild("child");
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
  const { child, next } = startChild("linger");
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
  await workerRoundTrip();
  await childRoundTrip();
} else if (role === "contain") {
  await lingeringChild(
    process.env.BUNAWAY_FIXTURE_DATA as string,
    process.env.BUNAWAY_FIXTURE_RELEASE as string,
  );
} else {
  // Child side: announce the pid, answer messages, and stay alive when the IPC channel closes.
  process.send?.({
    ready: process.pid,
  });
  process.on("message", (message) => {
    if (message === "exit") {
      process.exit(3);
    }
    process.send?.({
      echoed: message,
    });
  });
  setInterval(() => {}, 1000);
}
