import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const origin = "https://docs.local";
const pages = new Map();
const failures = [];
let checked = 0;

function decodeAttribute(value) {
  // Decode before comparing paths and fragment IDs as browsers see them.
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|#\d+|#x[0-9a-f]+);/gi,
    (entity) => {
      const named = {
        "&amp;": "&",
        "&quot;": '"',
        "&apos;": "'",
        "&lt;": "<",
        "&gt;": ">",
      };
      if (named[entity]) {
        return named[entity];
      }
      const hex = entity.startsWith("&#x");
      return String.fromCodePoint(
        Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10),
      );
    },
  );
}

function collect(directory) {
  // Index generated routes and IDs once for cross-page link resolution.
  for (const entry of readdirSync(directory, {
    withFileTypes: true,
  })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      collect(path);
    } else if (entry.name.endsWith(".html")) {
      const html = readFileSync(path, "utf8");
      const route = path
        .slice(dist.length)
        .replaceAll("\\", "/")
        .replace(/index\.html$/, "");
      pages.set(route, {
        html,
        ids: new Set(
          [
            ...html.matchAll(/\bid="([^"]*)"/g),
          ].map((match) => decodeAttribute(match[1])),
        ),
      });
    }
  }
}
collect(dist);

if (!pages.size) {
  failures.push("No HTML pages found in docs/site/dist.");
}

function isLocalFile(pathname) {
  const destination = resolve(dist, `.${pathname}`);
  const relativeDestination = relative(dist, destination);
  // Reject path traversal before checking for a local asset.
  if (
    relativeDestination === ".." ||
    relativeDestination.startsWith(`..${sep}`) ||
    isAbsolute(relativeDestination)
  ) {
    return false;
  }
  try {
    return statSync(destination).isFile();
  } catch {
    return false;
  }
}

// Only page routes resolve fragments; assets resolve as files.
for (const [route, { html }] of pages) {
  for (const tag of html.matchAll(/<a\b[^>]*>/g)) {
    const attribute = /\bhref="([^"]*)"/.exec(tag[0]);
    if (!attribute) {
      continue;
    }
    const href = decodeAttribute(attribute[1]);
    let url;
    try {
      url = new URL(href, origin + route);
    } catch {
      failures.push(`${route}: invalid URL ${href}`);
      continue;
    }
    if (url.origin !== origin) {
      continue;
    }
    checked += 1;
    let pathname;
    let hash;
    try {
      pathname = decodeURIComponent(url.pathname);
      hash = decodeURIComponent(url.hash.slice(1));
    } catch {
      failures.push(`${route}: invalid URL encoding ${href}`);
      continue;
    }
    const destination =
      pages.get(pathname) ?? pages.get(`${pathname.replace(/\/$/, "")}/`);
    if (!destination) {
      if (!isLocalFile(pathname)) {
        failures.push(`${route}: missing ${href}`);
      }
    } else if (url.hash && !destination.ids.has(hash)) {
      failures.push(`${route}: missing anchor ${href}`);
    }
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exitCode = 1;
} else {
  console.log(
    `Internal links: ${checked} links and anchors checked across ${pages.size} HTML pages.`,
  );
}
