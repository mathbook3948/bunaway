/**
 * Reject typographic characters the writing style forbids in documentation, source
 * text and commit messages: the em dash (U+2014) and the middle dot (U+00B7).
 *
 * Usage:
 *   bun scripts/check-text-style.ts                        # every tracked or new text file
 *   bun scripts/check-text-style.ts <file>...              # the given files
 *   bun scripts/check-text-style.ts --commit-message <file> # a commit message, for the Git hook
 *
 * Exit code 1 lists each offending file with its line number; 0 means clean.
 */
import { readFileSync } from "node:fs";

/** Characters the writing style replaces with sentences, commas, colons or conjunctions. */
// Built from code points so a formatter never rewrites the escapes into the characters themselves.
const FORBIDDEN_CHARACTERS: ReadonlyMap<string, string> = new Map([
  [
    String.fromCharCode(0x2014),
    "em dash (U+2014)",
  ],
  [
    String.fromCharCode(0x00b7),
    "middle dot (U+00B7)",
  ],
]);

/**
 * Tracked paths whose text is quoted third-party or binary-like content. The skills under
 * `.claude/skills/` are third-party except the two project-owned ones, which stay checked.
 */
const EXCLUDED_PATH_PATTERN =
  /^(licenses\/|THIRD-PARTY-NOTICES\.txt$|FRAMEWORK-LICENSE\.txt$|patches\/|bun\.lock$|\.claude\/skills\/(?!native-change-verification\/|verify-bunaway\/))/;
const TEXT_EXTENSION_PATTERN =
  /\.(md|mdx|ts|tsx|mts|cts|js|mjs|cjs|jsx|json|toml|ya?ml|html|css|svelte|vue|txt|java|swift|m|mm|c|h|iss|ps1|cmd|bat|xml|plist)$/;

export type TextStyleViolation = {
  path: string;
  line: number;
  description: string;
};

/** Find every forbidden character in `text`, reported with its 1-based line number. */
export function findTextStyleViolations(
  path: string,
  text: string,
): TextStyleViolation[] {
  const violations: TextStyleViolation[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    for (const [character, description] of FORBIDDEN_CHARACTERS) {
      if (line.includes(character)) {
        violations.push({
          path,
          line: index + 1,
          description,
        });
      }
    }
  }
  return violations;
}

/** Whether the writing style applies to a repository path. */
export function isStyledTextPath(path: string): boolean {
  return TEXT_EXTENSION_PATTERN.test(path) && !EXCLUDED_PATH_PATTERN.test(path);
}

/**
 * Every tracked file the writing style applies to, relative to the repository root. With
 * `includeUntracked`, new files that are not ignored are listed as well; the repository
 * contract test scans tracked files only so a developer's scratch files cannot fail it.
 */
export async function trackedTextPaths(
  root: string,
  options: {
    includeUntracked?: boolean;
  } = {},
): Promise<string[]> {
  const untracked = options.includeUntracked
    ? [
        "--others",
        "--exclude-standard",
      ]
    : [];
  const listing =
    await Bun.$`git -C ${root} ls-files -z --cached ${untracked}`.quiet();
  return listing
    .text()
    .split("\0")
    .filter((path) => path.length > 0 && isStyledTextPath(path));
}

/**
 * The part of a commit message file that Git stores: everything before the scissors line
 * that `git commit -v` appends, without the comment lines Git strips. `commentChar` is the
 * repository's `core.commentChar`, `#` by default.
 */
export function storedCommitMessage(text: string, commentChar = "#"): string {
  const scissors = `${commentChar} ------------------------ >8 ------------------------`;
  const scissorsAt = text.indexOf(scissors);
  const body = scissorsAt >= 0 ? text.slice(0, scissorsAt) : text;
  return body
    .split("\n")
    .filter((line) => !line.startsWith(commentChar))
    .join("\n");
}

/**
 * Check files and return the violations. A file deleted from the working tree but still
 * tracked is skipped; any other read failure is reported as a violation.
 */
export function checkFiles(paths: string[]): TextStyleViolation[] {
  const violations: TextStyleViolation[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      violations.push({
        path,
        line: 0,
        description: `unreadable: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    violations.push(...findTextStyleViolations(path, text));
  }
  return violations;
}

/** The repository's comment character for commit messages, `#` unless configured. */
async function commitCommentChar(): Promise<string> {
  const configured = await Bun.$`git config --get core.commentChar`
    .quiet()
    .nothrow();
  const value = configured.text().trim();
  return value === "" || value === "auto" ? "#" : value;
}

if (import.meta.main) {
  const requested = process.argv.slice(2);
  let violations: TextStyleViolation[];
  let scanned = "the commit message";
  if (requested[0] === "--commit-message" && requested[1]) {
    const stored = storedCommitMessage(
      readFileSync(requested[1], "utf8"),
      await commitCommentChar(),
    );
    violations = findTextStyleViolations("commit message", stored);
  } else {
    const paths =
      requested.length > 0
        ? requested
        : await trackedTextPaths(".", {
            includeUntracked: true,
          });
    violations = checkFiles(paths);
    scanned = `${paths.length} files`;
  }
  for (const violation of violations) {
    console.error(
      `${violation.path}:${violation.line}: ${violation.description}`,
    );
  }
  if (violations.length > 0) {
    console.error(
      `${violations.length} text style violation(s). Use sentences, commas, colons or conjunctions instead.`,
    );
    process.exit(1);
  }
  console.log(`Text style checked across ${scanned}.`);
}
