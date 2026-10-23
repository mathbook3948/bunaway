import type { Dirent } from "node:fs";
import { join } from "node:path";
import { BunawayError } from "@bunaway/plugin";
import {
  MAX_FILENAME_CHARACTERS,
  MAX_RECURSIVE_PAGE_PATH_CHARACTERS,
  MAX_RECURSIVE_PATH_COMPONENTS,
  RECURSIVE_CURSOR_SUCCESSOR,
  type StorageRecursiveEntry,
  type StorageRecursivePage,
} from "#storage/contract";
import {
  compareNames,
  createCheckpoint,
  type DirectorySizeLimits,
  describeChild,
  limitExceeded,
  openFrame,
} from "./node-directory.ts";

/** One request for a page of the tree below the root. */
export type RecursiveListRequest = {
  after: string | undefined;
  limit: number;
};

/**
 * A directory being walked: a window of its children in name order and the next child to visit.
 * Only the first names at or after the cursor are held, so memory follows the page size and the
 * depth (at most one window per directory on the current path), not the directory size. `more` is set when later children were left out; the window is read again from
 * after its last name once it is used up. `resume` is the part of the cursor still below this
 * directory; children that sort before its first component were already returned.
 */
type TreeFrame = {
  path: string;
  relative: string;
  depth: number;
  children: Dirent[];
  more: boolean;
  next: number;
  resume: string[];
};

/** A window of one directory's children: the first ones at or after a name, and whether more follow. */
type ChildWindow = {
  children: Dirent[];
  more: boolean;
};

function invalidCursor(): BunawayError {
  return new BunawayError({
    code: "INVALID_ARGUMENT",
    message: "Storage directory cursor is not a relative path.",
  });
}

/**
 * Split a cursor into its path components. A cursor normally is a path this operation returned,
 * but only its position matters, so it need not exist; the spelling is still checked.
 */
function cursorComponents(after: string | undefined): string[] {
  if (after === undefined) {
    return [];
  }
  const components = after.split("/");
  // The last name may carry the successor mark on top of a longest name.
  const last = components.length - 1;
  const tooLong = (name: string, index: number): boolean =>
    name.length >
    MAX_FILENAME_CHARACTERS +
      (index === last && name.endsWith(RECURSIVE_CURSOR_SUCCESSOR)
        ? RECURSIVE_CURSOR_SUCCESSOR.length
        : 0);
  if (
    components.length > MAX_RECURSIVE_PATH_COMPONENTS ||
    components.some((name, index) => name.length === 0 || tooLong(name, index))
  ) {
    throw invalidCursor();
  }
  return components;
}

/** Walks one tree depth first, holding only the frames of the directories on the current path. */
class TreeScan {
  private visited = 0;
  private readonly checkpoint: () => Promise<void>;
  /** Children held per directory: a page takes at most `limit` of them, plus the cursor's own name and one that shows the page is not last. */
  private readonly windowSize: number;

  constructor(
    private readonly limits: DirectorySizeLimits,
    limit: number,
    signal: AbortSignal | undefined,
    alive: () => void,
  ) {
    this.checkpoint = createCheckpoint(signal, alive);
    this.windowSize = limit + 2;
  }

  /**
   * Read a directory into a frame, or null when a descendant vanished. The directory handle is
   * closed before the walk goes on so the handles in use do not grow with the depth.
   */
  private async openTreeFrame(
    path: string,
    relative: string,
    depth: number,
    resume: string[],
  ): Promise<TreeFrame | null> {
    if (depth > this.limits.depth) {
      throw limitExceeded();
    }
    const window = await this.readWindow(path, depth, resume[0]);
    if (!window) {
      return null;
    }
    return {
      path,
      relative,
      depth,
      ...window,
      next: 0,
      resume,
    };
  }

  /**
   * Stream a directory once and keep its first `windowSize` children whose name is not below
   * `from`, in name order. Every child read counts against the entry bound, including those that
   * are skipped or left out. A name above the window's current end is dropped at once, and the
   * buffer is cut back whenever it doubles, so memory stays near the window size however large
   * the directory is. Null when the directory vanished.
   */
  private async readWindow(
    path: string,
    depth: number,
    from: string | undefined,
  ): Promise<ChildWindow | null> {
    const directory = openFrame(path, depth);
    if (!directory) {
      return null;
    }
    let buffer: Dirent[] = [];
    let ceiling: string | undefined;
    let more = false;
    const cut = () => {
      buffer.sort((left, right) => compareNames(left.name, right.name));
      if (buffer.length > this.windowSize) {
        buffer = buffer.slice(0, this.windowSize);
        ceiling = buffer[this.windowSize - 1]?.name;
        more = true;
      }
    };
    try {
      for (
        let child = directory.readSync();
        child;
        child = directory.readSync()
      ) {
        await this.checkpoint();
        if (++this.visited > this.limits.entries) {
          throw limitExceeded();
        }
        if (from !== undefined && child.name < from) {
          continue;
        }
        if (ceiling !== undefined && child.name > ceiling) {
          more = true;
          continue;
        }
        buffer.push(child);
        if (buffer.length >= this.windowSize * 2) {
          cut();
        }
      }
    } finally {
      directory.closeSync();
    }
    cut();
    return {
      children: buffer,
      more,
    };
  }

  /**
   * The next child of a frame, reading the following window of its directory when the current one
   * is used up. Undefined when the frame has no more children.
   */
  private async nextChild(frame: TreeFrame): Promise<Dirent | undefined> {
    if (frame.next >= frame.children.length && frame.more) {
      const last = frame.children.at(-1);
      // A NUL sorts right after the name it follows and cannot be part of a file name.
      const window = await this.readWindow(
        frame.path,
        frame.depth,
        last ? `${last.name}${RECURSIVE_CURSOR_SUCCESSOR}` : undefined,
      );
      frame.children = window?.children ?? [];
      frame.more = window?.more ?? false;
      frame.next = 0;
    }
    return frame.children[frame.next++];
  }

  private openChild(
    parent: TreeFrame,
    child: Dirent,
    resume: string[],
  ): Promise<TreeFrame | null> {
    return this.openTreeFrame(
      join(parent.path, child.name),
      joinRelative(parent.relative, child.name),
      parent.depth + 1,
      resume,
    );
  }

  /**
   * Collect the first `request.limit` paths after the cursor. The walk stops as soon as one more
   * child exists, so `next` is null exactly when no child follows the page (a child that vanishes
   * after that check can leave the following page empty). A page that ends on a directory does
   * not open it, so `next` is set and the following page is empty when the directory is empty.
   */
  async list(root: string, request: RecursiveListRequest) {
    const entries: StorageRecursiveEntry[] = [];
    let pathCharacters = 0;
    const rootFrame = await this.openTreeFrame(
      root,
      "",
      0,
      cursorComponents(request.after),
    );
    const stack: TreeFrame[] = rootFrame
      ? [
          rootFrame,
        ]
      : [];
    for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
      const child = await this.nextChild(frame);
      if (!child) {
        stack.pop();
        continue;
      }
      await this.checkpoint();
      const resume = frame.resume;
      frame.resume = [];
      if (resume.length > 0 && child.name === resume[0]) {
        // The cursor passes through this child: it was returned already, only its contents follow.
        const inner = await this.descendToCursor(frame, child, resume.slice(1));
        if (inner) {
          stack.push(inner);
        }
        continue;
      }
      const relative = joinRelative(frame.relative, child.name);
      if (
        pageIsFull(entries.length, pathCharacters, relative.length, request)
      ) {
        return {
          entries,
          next: entries[entries.length - 1]?.path ?? null,
        } satisfies StorageRecursivePage;
      }
      const entry = describeChild(frame.path, child);
      if (!entry) {
        continue;
      }
      entries.push({
        path: relative,
        kind: entry.kind,
      });
      pathCharacters += relative.length;
      if (entry.kind === "directory") {
        // The shortest child path adds a separator and one character to the directory path.
        if (
          pageIsFull(
            entries.length,
            pathCharacters,
            relative.length + 2,
            request,
          )
        ) {
          // Opening the directory now could fail the page for contents that belong to the next one.
          return {
            entries,
            next: relative,
          } satisfies StorageRecursivePage;
        }
        const inner = await this.openChild(frame, child, []);
        if (inner) {
          stack.push(inner);
        }
      }
    }
    await this.checkpoint();
    return {
      entries,
      next: null,
    } satisfies StorageRecursivePage;
  }

  /** Enter the directory the cursor points into; anything else at that name no longer matters. */
  private async descendToCursor(
    parent: TreeFrame,
    child: Dirent,
    resume: string[],
  ): Promise<TreeFrame | null> {
    const entry = describeChild(parent.path, child);
    if (entry?.kind !== "directory") {
      return null;
    }
    return await this.openChild(parent, child, resume);
  }
}

/**
 * Whether a page of `count` entries and `characters` path characters cannot take one more path of
 * `nextLength` characters: it holds `limit` entries, or the path length budget would be exceeded.
 * A page always takes its first entry, whatever its length.
 */
function pageIsFull(
  count: number,
  characters: number,
  nextLength: number,
  request: RecursiveListRequest,
): boolean {
  return (
    count >= request.limit ||
    (count > 0 && characters + nextLength > MAX_RECURSIVE_PAGE_PATH_CHARACTERS)
  );
}

function joinRelative(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/**
 * List the descendants of a directory depth first without following any link, one page at a time.
 * Children of a directory come in UTF-16 order and a directory directly before its contents. A
 * page starts after the `after` path: directories on its way that sort before it are not opened,
 * so the cost of a page follows the directories on the cursor's path and the page itself, and each
 * call reads at most `limits.entries` children. Links are listed as links and not entered; a
 * subdirectory that vanishes is skipped and any other failure below the root fails the call.
 * `alive` throws when the owner went away; the abort signal ends the scan with CANCELLED.
 */
export function listDirectoryTree(
  root: string,
  request: RecursiveListRequest,
  limits: DirectorySizeLimits,
  signal: AbortSignal | undefined,
  alive: () => void,
): Promise<StorageRecursivePage> {
  return new TreeScan(limits, request.limit, signal, alive).list(root, request);
}
