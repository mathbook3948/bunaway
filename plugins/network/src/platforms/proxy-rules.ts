import { BunawayError } from "@bunaway/protocol";
import { MAX_HOST_LENGTH, MAX_PROXY_ENTRIES } from "#network/contract";

type ProxyScheme = "http" | "https" | "socks4" | "socks5";
type ProxyServer = {
  kind: "proxy";
  scheme: ProxyScheme;
  host: string;
  port: number;
};
export type ProxyEntry =
  | {
      kind: "direct";
    }
  | ProxyServer;
type RequestScheme = "http" | "https";

const DEFAULT_PORTS: Record<ProxyScheme, number> = {
  http: 80,
  https: 443,
  socks4: 1080,
  socks5: 1080,
};
/** A list entry may carry `scheme=` (the URL scheme it serves) and `scheme://` (how to talk to the proxy). */
const RULE_PREFIX = /^([a-z][a-z0-9]*)=(.*)$/i;
const PROXY_URI_PREFIX = /^(http|https|socks|socks4|socks5):\/\/(.*)$/i;
/** A host name (letters, digits, "_", "-", ".") or a bracketed IPv6 literal, then an optional port. */
const HOST_PORT = /^(\[[0-9a-f:.]+\]|[a-z0-9_][a-z0-9_.-]*)(?::(\d{1,5}))?$/i;
const SEPARATORS = /[;\s]+/;
const DIRECT: ProxyEntry[] = [
  {
    kind: "direct",
  },
];

function proxyScheme(name: string, fallback: ProxyScheme): ProxyScheme {
  switch (name.toLowerCase()) {
    case "http":
      return "http";
    case "https":
      return "https";
    case "socks":
    case "socks4":
      return "socks4";
    case "socks5":
      return "socks5";
    default:
      return fallback;
  }
}

/**
 * One proxy list token as a server, or null when it is not a usable `host[:port]`. A missing port
 * takes the scheme's default. `parseProxyList` has already refused lists with user information.
 */
function parseServer(token: string, fallback: ProxyScheme): ProxyServer | null {
  let rest = token;
  let scheme = fallback;
  const uri = PROXY_URI_PREFIX.exec(rest);
  if (uri) {
    scheme = proxyScheme(uri[1] ?? "", fallback);
    rest = uri[2] ?? "";
  }
  const slash = rest.indexOf("/");
  if (slash >= 0) {
    rest = rest.slice(0, slash);
  }
  const match = HOST_PORT.exec(rest);
  if (!match) {
    return null;
  }
  const port =
    match[2] === undefined ? DEFAULT_PORTS[scheme] : Number(match[2]);
  if (port < 1 || port > 65535 || (match[1] ?? "").length > MAX_HOST_LENGTH) {
    return null;
  }
  return {
    kind: "proxy",
    scheme,
    host: (match[1] ?? "").toLowerCase(),
    port,
  };
}

/** A proxy list split by where each entry applies. */
export type ProxyRules = {
  http: ProxyServer[];
  https: ProxyServer[];
  socks: ProxyServer[];
  /** Entries without `scheme=` serve every URL scheme. */
  all: ProxyServer[];
};

/**
 * Parse the WinHTTP proxy list syntax: `host:port`, `http=host:port;https=host:port;socks=host:port`
 * and `scheme://host:port`, separated by semicolons or whitespace. `ftp=` entries serve no
 * http or https URL and are ignored, as are malformed tokens. A list that contains "@" (user
 * information) fails with `INTERNAL` instead of being read.
 */
export function parseProxyList(text: string): ProxyRules {
  const rules: ProxyRules = {
    http: [],
    https: [],
    socks: [],
    all: [],
  };
  if (text.includes("@")) {
    // A password may itself contain ";", spaces, "/" or "@", so where user information ends and
    // the next entry starts cannot be told. Reading such a list would risk returning part of the
    // credentials as a host, so it is refused whole. Internet Options has no field for them.
    throw new BunawayError({
      code: "INTERNAL",
      message: "Windows proxy setting contains user information.",
    });
  }
  for (const token of text.split(SEPARATORS)) {
    if (token === "") {
      continue;
    }
    const rule = RULE_PREFIX.exec(token);
    const name = rule?.[1]?.toLowerCase();
    // "ftp=" and any other scheme name serve no http or https URL.
    if (rule && name !== "http" && name !== "https" && name !== "socks") {
      continue;
    }
    const kind: "http" | "https" | "socks" | undefined =
      name === "http" || name === "https" || name === "socks"
        ? name
        : undefined;
    const server = parseServer(
      rule ? (rule[2] ?? "") : token,
      kind === "socks" ? "socks4" : "http",
    );
    if (!server) {
      continue;
    }
    (kind === undefined ? rules.all : rules[kind]).push(server);
  }
  return rules;
}

/** Hosts that are never sent through a proxy: loopback and link-local, as in Chromium's implicit bypass rules. */
export function isImplicitDirect(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  if (host.startsWith("[")) {
    const address = host.slice(1, -1);
    return address === "::1" || /^fe[89ab][0-9a-f]:/.test(address);
  }
  return /^(?:127(?:\.\d{1,3}){3}|169\.254(?:\.\d{1,3}){2})$/.test(host);
}

/**
 * Whether `text` matches `pattern`, where `*` stands for any run of characters. Linear in the
 * pattern and text with at most one backtrack point (the last `*`), so a hostile pattern cannot
 * stall the thread the way a nested-quantifier regular expression can.
 */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (pattern[p] === "*") {
      star = p;
      resume = t;
      p += 1;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p += 1;
      t += 1;
    } else if (star >= 0) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") {
    p += 1;
  }
  return p === pattern.length;
}

type BypassMatcher = (
  scheme: RequestScheme,
  host: string,
  port: number,
) => boolean;

/** One bypass token as a matcher; the grammar is WinHTTP's: `<local>`, `*` wildcards, optional `scheme://` and `:port`. */
function bypassMatcher(token: string): BypassMatcher {
  if (token.toLowerCase() === "<local>") {
    return (_scheme, host) => !host.includes(".") && !host.startsWith("[");
  }
  let pattern = token.toLowerCase();
  let onlyScheme: string | undefined;
  const prefix = /^(https?):\/\/(.*)$/.exec(pattern);
  if (prefix) {
    onlyScheme = prefix[1];
    pattern = prefix[2] ?? "";
  }
  let onlyPort: number | undefined;
  const suffix = /^(.*?):(\d{1,5})$/.exec(pattern);
  const head = suffix?.[1] ?? "";
  // A bare IPv6 literal also ends in digits after a colon; only a bracketed one or a name carries a port.
  if (suffix && (!head.includes(":") || head.endsWith("]"))) {
    onlyPort = Number(suffix[2]);
    pattern = head;
  }
  return (scheme, host, port) =>
    (onlyScheme === undefined || onlyScheme === scheme) &&
    (onlyPort === undefined || onlyPort === port) &&
    wildcardMatch(pattern, host);
}

function requestScheme(url: URL): RequestScheme {
  return url.protocol === "https:" ? "https" : "http";
}

/** Whether the bypass list (`*.example.com;<local>;10.*`) excludes the URL from proxying. */
export function matchesBypass(bypass: string | null, url: URL): boolean {
  if (!bypass) {
    return false;
  }
  const scheme = requestScheme(url);
  const defaultPort = scheme === "https" ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  return bypass
    .split(SEPARATORS)
    .filter((token) => token !== "")
    .some((token) => bypassMatcher(token)(scheme, url.hostname, port));
}

/**
 * Entries for a URL from a configured proxy list and bypass list. Servers named for the URL's
 * scheme come first, then those that serve every scheme; SOCKS entries apply only when neither exists. When none apply
 * or the bypass list matches, the request goes direct.
 */
export function selectEntries(
  proxyList: string | null,
  bypass: string | null,
  url: URL,
): ProxyEntry[] {
  if (!proxyList || matchesBypass(bypass, url)) {
    return [
      ...DIRECT,
    ];
  }
  const rules = parseProxyList(proxyList);
  const seen = new Set<string>();
  const servers: ProxyServer[] = [];
  const forScheme = [
    ...rules[requestScheme(url)],
    ...rules.all,
  ];
  // SOCKS entries serve a URL only when no entry names its scheme, as in WinINet and Chromium.
  for (const server of forScheme.length > 0 ? forScheme : rules.socks) {
    const key = `${server.scheme}://${server.host}:${server.port}`;
    if (!seen.has(key)) {
      seen.add(key);
      servers.push(server);
    }
  }
  return servers.length === 0
    ? [
        ...DIRECT,
      ]
    : servers.slice(0, MAX_PROXY_ENTRIES);
}
