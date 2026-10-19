import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  type LogConfiguration,
  type LogInput,
  MAX_LOG_ARCHIVES,
} from "#log/contract";

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const LEVEL_ORDER = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
} as const;

function existing(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return undefined;
  }
}

function checkedFile(path: string): Stats | undefined {
  const info = existing(path);
  if (info && !info.isFile()) {
    throw new Error("App log target must be a regular file.");
  }
  return info;
}

/** Own synchronous app log I/O on the plugin worker, without retaining file handles. */
export class AppLog {
  private readonly directory: string;
  private readonly path: string;
  private minimumLevel: LogInput["level"] = "debug";
  private maxFileBytes = DEFAULT_MAX_FILE_BYTES;
  private maxArchives = 1;

  constructor(private readonly dataRoot: string) {
    this.directory = resolve(dataRoot, "logs");
    this.path = resolve(this.directory, "app.log");
  }

  /** Check host-selected directories; absent directories remain lazy until a write. */
  private checkDirectories(): void {
    for (const path of [
      this.dataRoot,
      this.directory,
    ]) {
      const info = existing(path);
      if (info && !info.isDirectory()) {
        throw new Error("App log directory must be a directory.");
      }
    }
  }

  /** Apply a validated backend update, pruning only the plugin's numbered archives. */
  configure(input: LogConfiguration): null {
    const maxArchives = input.maxArchives ?? this.maxArchives;
    this.checkDirectories();
    this.pruneArchives(maxArchives);
    // Failed pruning leaves the previous settings active; callers can retry.
    this.minimumLevel = input.minimumLevel ?? this.minimumLevel;
    this.maxFileBytes = input.maxFileBytes ?? this.maxFileBytes;
    this.maxArchives = maxArchives;
    return null;
  }

  private pruneArchives(maxArchives: number): void {
    // Preflight every removal so an unsafe target cannot cause partial pruning.
    for (let index = maxArchives + 1; index <= MAX_LOG_ARCHIVES; index++) {
      checkedFile(`${this.path}.${index}`);
    }
    for (let index = maxArchives + 1; index <= MAX_LOG_ARCHIVES; index++) {
      rmSync(`${this.path}.${index}`, {
        force: true,
      });
    }
  }

  private rotate(): void {
    for (let index = 1; index <= this.maxArchives; index++) {
      checkedFile(`${this.path}.${index}`);
    }
    // Restarted instances can inherit archives created under a larger retention setting.
    this.pruneArchives(this.maxArchives);
    if (this.maxArchives === 0) {
      rmSync(this.path);
      return;
    }
    rmSync(`${this.path}.${this.maxArchives}`, {
      force: true,
    });
    for (let index = this.maxArchives - 1; index >= 1; index--) {
      const archive = `${this.path}.${index}`;
      if (existing(archive)) {
        renameSync(archive, `${this.path}.${index + 1}`);
      }
    }
    renameSync(this.path, `${this.path}.1`);
  }

  /** Complete each accepted JSONL append before returning, retaining the legacy rotation boundary. */
  write(input: LogInput, source: string): null {
    if (LEVEL_ORDER[input.level] < LEVEL_ORDER[this.minimumLevel]) {
      return null;
    }
    this.checkDirectories();
    mkdirSync(this.directory, {
      recursive: true,
      mode: 0o700,
    });
    this.checkDirectories();
    const info = checkedFile(this.path);
    // Preserve compatibility: exactly the threshold still accepts one more record.
    if (info && info.size > this.maxFileBytes) {
      this.rotate();
    }
    const { level, message, details } = input;
    const text = `${JSON.stringify({
      t: Date.now(),
      source,
      level,
      message,
      ...(details === undefined
        ? {}
        : {
            details,
          }),
    })}\n`;
    this.withFile(
      this.path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT,
      (fd) => {
        writeFileSync(fd, text);
      },
    );
    return null;
  }

  /** Flush active and retained files to the OS; never create a file for an empty log. */
  flush(): null {
    this.checkDirectories();
    const paths = [
      this.path,
    ];
    for (let index = 1; index <= this.maxArchives; index++) {
      paths.push(`${this.path}.${index}`);
    }
    for (const path of paths) {
      if (checkedFile(path)) {
        this.withFile(path, constants.O_WRONLY, fsyncSync);
      }
    }
    return null;
  }

  private withFile(
    path: string,
    flags: number,
    run: (fd: number) => void,
  ): void {
    const fd = openSync(path, flags, 0o600);
    try {
      const info = fstatSync(fd);
      if (!info.isFile()) {
        throw new Error("App log target must be a regular file.");
      }
      run(fd);
    } finally {
      closeSync(fd);
    }
  }
}
