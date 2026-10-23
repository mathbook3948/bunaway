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
 * A directory being walked: its children in name order and the next child to visit. `resume` is
 * the part of the cursor still below this directory; children that sort before its first
 * component were already returned and are not kept.
 */
type TreeFrame = {
  path: string;
  relative: string;
  depth: number;
  children: Dirent[];
  next: number;
  resume: string[];
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

  constructor(
    private readonly limits: DirectorySizeLimits,
    signal: AbortSignal | undefined,
    alive: () => void,
  ) {
    this.checkpoint = createCheckpoint(signal, alive);
  }

  /**
   * Read a directory into a frame, or null when a descendant vanished. Every child read counts
   * against the entry bound, including those the cursor skips, and the directory handle is closed
   * before the walk goes on so the handles in use do not grow with the depth.
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
    const directory = openFrame(path, depth);
    if (!directory) {
      return null;
    }
    const children: Dirent[] = [];
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
        if (resume.length === 0 || child.name >= (resume[0] ?? "")) {
          children.push(child);
        }
      }
    } finally {
      directory.closeSync();
    }
    children.sort((left, right) => compareNames(left.name, right.name));
    return {
      path,
      relative,
      depth,
      children,
      next: 0,
      resume,
    };
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
      const child = frame.children[frame.next++];
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
  return new TreeScan(limits, signal, alive).list(root, request);
}
