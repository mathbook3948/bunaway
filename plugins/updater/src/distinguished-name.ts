/** One `KEY=value` pair of a distinguished name; the key is upper case, the value keeps its case. */
export type NameAttribute = {
  key: string;
  value: string;
};

/**
 * How a name is written. `rfc2253` uses backslash escapes (`Name\, Inc.`), as the app writes
 * `publisherNames`. `windows` is what `CertGetNameStringW` prints: values with special characters are
 * quoted with `""` for a quote, and a backslash is an ordinary character, so decoding it would let a
 * certificate whose name contains `\` pass for another name.
 */
export type DistinguishedNameStyle = "rfc2253" | "windows";

/** Windows prints the state attribute as `S`; RFC 2253 names it `ST`. */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  S: "ST",
};

const HEX_PAIR = /^[0-9a-fA-F]{2}$/;
const SEPARATORS = new Set([
  ",",
  ";",
  "+",
]);

/** Decode a `\` escape at `index`: a hex byte pair, or the escaped character itself. */
function readEscape(
  text: string,
  index: number,
): {
  bytes: number[];
  next: number;
} | null {
  const first = text[index + 1];
  if (first === undefined) {
    return null;
  }
  const pair = text.slice(index + 1, index + 3);
  if (HEX_PAIR.test(pair)) {
    return {
      bytes: [
        Number.parseInt(pair, 16),
      ],
      next: index + 3,
    };
  }
  return {
    bytes: [
      ...new TextEncoder().encode(first),
    ],
    next: index + 2,
  };
}

/** Split `text` into attribute strings at unquoted, unescaped separators. */
function splitAttributes(
  text: string,
  style: DistinguishedNameStyle,
): string[] | null {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    if (char === "\\" && style === "rfc2253" && !quoted) {
      current += text.slice(index, index + 2);
      index += 1;
    } else if (char === '"') {
      // A doubled quote inside a quoted value is a literal quote.
      if (quoted && text[index + 1] === '"') {
        current += '""';
        index += 1;
      } else {
        quoted = !quoted;
        current += char;
      }
    } else if (!quoted && SEPARATORS.has(char)) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (quoted) {
    return null;
  }
  parts.push(current);
  return parts;
}

/** The text of an attribute value, unquoted and unescaped; null for a form not supported. */
function readValue(raw: string, style: DistinguishedNameStyle): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("#")) {
    return null;
  }
  if (trimmed.startsWith('"')) {
    return trimmed.length >= 2 && trimmed.endsWith('"')
      ? trimmed.slice(1, -1).replaceAll('""', '"')
      : null;
  }
  const bytes: number[] = [];
  for (let index = 0; index < trimmed.length; ) {
    if (style === "rfc2253" && trimmed[index] === "\\") {
      const escaped = readEscape(trimmed, index);
      if (escaped === null) {
        return null;
      }
      bytes.push(...escaped.bytes);
      index = escaped.next;
    } else {
      bytes.push(...new TextEncoder().encode(trimmed.charAt(index)));
      index += 1;
    }
  }
  return new TextDecoder("utf-8", {
    fatal: true,
  }).decode(Uint8Array.from(bytes));
}

/**
 * Parse a distinguished name written in the given style (`CN="Name, Inc.", O=Org` for `windows`,
 * `CN=Name\, Inc.,O=Org` for `rfc2253`). Returns null for text that is not a list of `KEY=value`
 * pairs, so a malformed publisher setting or subject never matches anything.
 */
export function parseDistinguishedName(
  text: string,
  style: DistinguishedNameStyle,
): NameAttribute[] | null {
  const parts = splitAttributes(text, style);
  if (parts === null) {
    return null;
  }
  const attributes: NameAttribute[] = [];
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals < 1) {
      return null;
    }
    const rawKey = part.slice(0, equals).trim().toUpperCase();
    let value: string | null;
    try {
      value = readValue(part.slice(equals + 1), style);
    } catch {
      // Bytes that are not UTF-8 make the name unusable, which is the same outcome as bad syntax.
      value = null;
    }
    if (rawKey === "" || value === null || value === "") {
      return null;
    }
    attributes.push({
      key: KEY_ALIASES[rawKey] ?? rawKey,
      value,
    });
  }
  return attributes;
}
