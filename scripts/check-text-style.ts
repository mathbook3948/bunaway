/**
 * Reject typographic characters the writing style forbids in documentation, source
 * text and commit messages: the em dash (U+2014) and the middle dot (U+00B7).
 *
 * Usage:
 *   bun scripts/check-text-style.ts                 # every tracked text file
 *   bun scripts/check-text-style.ts <file>...       # the given files, for Git hooks
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

/** Tracked paths whose text is quoted third-party or binary-like content. */
const EXCLUDED_PATH_PATTERN =
  /^(licenses\/|THIRD-PARTY-NOTICES\.txt$|FRAMEWORK-LICENSE\.txt$|patches\/|bun\.lock$)/;
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

/** Every tracked or new file the writing style applies to, relative to the repository root. */
export async function trackedTextPaths(root: string): Promise<string[]> {
  const listing =
    await Bun.$`git -C ${root} ls-files -z --cached --others --exclude-standard`.quiet();
  return listing
    .text()
    .split("\0")
    .filter((path) => path.length > 0 && isStyledTextPath(path));
}

/** Check files and return the violations; a missing file is reported as a violation. */
export function checkFiles(paths: string[]): TextStyleViolation[] {
  const violations: TextStyleViolation[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
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

if (import.meta.main) {
  const requested = process.argv.slice(2);
  const paths = requested.length > 0 ? requested : await trackedTextPaths(".");
  const violations = checkFiles(paths);
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
  console.log(`Text style checked across ${paths.length} files.`);
}
