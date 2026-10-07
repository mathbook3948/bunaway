import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const origin = "https://docs.local";
const pages = new Map();
const failures = [];
let checked = 0;

function decodeAttribute(value) {
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

for (const [route, { html }] of pages) {
  for (const tag of html.matchAll(/<a\b[^>]*>/g)) {
    const attribute = /\bhref="([^"]*)"/.exec(tag[0]);
    if (!attribute) {
      continue;
    }
    const href = decodeAttribute(attribute[1]);
    const url = new URL(href, origin + route);
    if (url.origin !== origin) {
      continue;
    }
    checked += 1;
    const pathname = decodeURIComponent(url.pathname);
    const destination =
      pages.get(pathname) ?? pages.get(`${pathname.replace(/\/$/, "")}/`);
    if (!destination) {
      if (!existsSync(join(dist, pathname))) {
        failures.push(`${route}: missing ${href}`);
      }
    } else if (
      url.hash &&
      !destination.ids.has(decodeURIComponent(url.hash.slice(1)))
    ) {
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
