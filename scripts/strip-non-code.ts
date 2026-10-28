/**
 * Reduce TypeScript or JavaScript text to its code skeleton for import scanning: comments are
 * removed and every string, template and regular expression literal is blanked, except a quoted
 * string that directly follows `from` or `import`, which is a module specifier. The remaining text
 * can be searched with plain regular expressions without matching example text in literals.
 *
 * This is a lexer, not a parser: it tracks strings, nested template expressions, comments and
 * regular expression literals (by the token before the slash), and runs in linear time.
 */

/** What may precede a string literal for it to be a module specifier. */
const SPECIFIER_LEAD_PATTERN =
  /(?:\bfrom|(?<![.\w$])import\s*\(?|(?<![.\w$])require\s*\()\s*$/;
/** A slash after one of these characters or keywords starts a regular expression, not a division. */
const REGEX_LEAD_PATTERN =
  /(?:^|[(,=:[!&|?{};+\-*%<>~^]|\b(?:return|typeof|case|void|delete|throw|in|of))\s*$/;
const LEAD_WINDOW = 24;

class CodeScanner {
  private readonly parts: string[] = [];
  private lead = "";
  private index = 0;
  private braceDepth = 0;
  /** Brace depth at which each open template expression `${` returns to its template text. */
  private readonly expressions: number[] = [];

  constructor(private readonly source: string) {}

  scan(): string {
    while (this.index < this.source.length) {
      this.step();
    }
    return this.parts.join("");
  }

  private emit(text: string): void {
    this.parts.push(text);
    this.lead = (this.lead + text).slice(-LEAD_WINDOW);
  }

  private step(): void {
    const char = this.source.charAt(this.index);
    if (this.skipComment()) {
      return;
    }
    if (char === '"' || char === "'") {
      this.quoted(char);
    } else if (char === "`") {
      this.index += 1;
      this.templateText();
    } else if (char === "/" && REGEX_LEAD_PATTERN.test(this.lead)) {
      this.regex();
    } else {
      this.code(char);
    }
  }

  /** Braces are counted so the `}` that closes a `${` hands control back to the template text. */
  private code(char: string): void {
    this.index += 1;
    if (char === "{") {
      this.braceDepth += 1;
    } else if (char === "}") {
      if (this.expressions.at(-1) === this.braceDepth) {
        this.expressions.pop();
        this.templateText();
        return;
      }
      this.braceDepth -= 1;
    }
    this.emit(char);
  }

  private skipComment(): boolean {
    const { source, index } = this;
    if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index);
      this.index = end === -1 ? source.length : end;
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2);
      this.index = end === -1 ? source.length : end + 2;
    } else {
      return false;
    }
    this.emit(" ");
    return true;
  }

  /** A string literal is kept only as a module specifier. */
  private quoted(quote: string): void {
    const start = this.index;
    let index = start + 1;
    while (index < this.source.length && this.source[index] !== quote) {
      index += this.source[index] === "\\" ? 2 : 1;
    }
    this.index = index + 1;
    this.emit(
      SPECIFIER_LEAD_PATTERN.test(this.lead)
        ? this.source.slice(start, this.index)
        : '""',
    );
  }

  /** Template text up to the closing backtick or the next `${`, whose expression is scanned as code. */
  private templateText(): void {
    let index = this.index;
    while (index < this.source.length) {
      const char = this.source[index];
      if (char === "`") {
        this.index = index + 1;
        this.emit('""');
        return;
      }
      if (char === "$" && this.source[index + 1] === "{") {
        this.index = index + 2;
        this.expressions.push(this.braceDepth);
        this.emit('"" (');
        return;
      }
      index += char === "\\" ? 2 : 1;
    }
    this.index = index;
  }

  /** A regular expression literal: a slash inside a class `[...]` or after a backslash does not end it. */
  private regex(): void {
    let index = this.index + 1;
    let inClass = false;
    while (index < this.source.length) {
      const char = this.source[index];
      if (char === "\n") {
        break;
      }
      if (char === "\\") {
        index += 2;
        continue;
      }
      if (char === "[") {
        inClass = true;
      } else if (char === "]") {
        inClass = false;
      } else if (char === "/" && !inClass) {
        index += 1;
        while (/[a-z]/i.test(this.source.charAt(index))) {
          index += 1;
        }
        this.index = index;
        this.emit("/ /");
        return;
      }
      index += 1;
    }
    // No closing slash on this line: it was a division after all.
    this.code("/");
  }
}

/** The code skeleton of `source`; see the module comment. */
export function stripNonCode(source: string): string {
  return new CodeScanner(source).scan();
}
