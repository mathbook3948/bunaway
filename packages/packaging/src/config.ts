import {
  CODES,
  isChannelId,
  PACKAGING_CHANNELS,
  type SigningConfig,
} from "./contract.ts";

// bunaway.json.bundle — the single source for packaging metadata.
// Unknown fields and malformed values are rejected up front so adapters can
// trust what they receive. Filesystem checks (icons, certificate files) live
// in resolve.ts; this file validates shape only.
export interface PackagingConfig {
  name?: string;
  identifier?: string;
  publisher?: {
    display?: string;
    identity?: string;
  };
  release?: {
    version?: string;
    build?: number;
  };
  icons?: {
    directory?: string;
    windows?: Record<string, string>;
    macos?: Record<string, string>;
  };
  targets?: {
    platform: string;
    arch: string;
    minVersion?: string;
  }[];
  channels?: Partial<Record<string, Record<string, unknown>>>;
  signing?: SigningConfig;
}

const TOP_LEVEL = [
  "name",
  "identifier",
  "publisher",
  "release",
  "icons",
  "targets",
  "channels",
  "signing",
];

// Channel option keys owned by the shared contract. Channel adapters may read
// these but must not redefine their meaning; channel-private keys are not
// allowed, so a typo fails validation instead of being ignored.
const CHANNEL_KEYS: Record<string, string[]> = {
  "win-direct": [
    "scope",
    "webView2",
    "desktopShortcut",
    "startMenuShortcut",
    "uninstall",
    "signing",
  ],
  "win-store-msix": [
    "packageName",
    "unvirtualizedData",
    "minVersion",
    "maxVersionTested",
    "capabilities",
    "signing",
  ],
  "win-store-unpackaged": [
    "scope",
    "webView2",
    "desktopShortcut",
    "startMenuShortcut",
    "uninstall",
    "signing",
  ],
  "mac-direct": [
    "format",
    "bundleId",
    "minVersion",
    "entitlements",
    "signing",
  ],
  "mac-store": [
    "bundleId",
    "minVersion",
    "entitlements",
    "signing",
  ],
};

const WINDOWS_ICONS = [
  "installer",
  "square44",
  "square150",
  "storeLogo",
  "wide",
];
const MACOS_ICONS = [
  "icns",
];
const SIGNING_KEYS = [
  "certificateFile",
  "thumbprint",
  "subject",
  "timestampUrl",
  "passwordEnv",
];

export const IDENTIFIER_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})?)+$/;
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/;

function fail(message: string): never {
  const error = new Error(message);
  (
    error as Error & {
      code?: string;
    }
  ).code = CODES.CONFIG_INVALID;
  throw error;
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`bunaway.json.bundle: ${what} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  allowed: string[],
  what: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    fail(`bunaway.json.bundle: unknown field ${what}.${unknown}.`);
  }
}

function nonempty(value: unknown, what: string, max = 256): string {
  if (typeof value !== "string" || !value || value.length > max) {
    fail(
      `bunaway.json.bundle: ${what} must be a nonempty string of at most ${max} characters.`,
    );
  }
  return value;
}

function optionalBoolean(value: unknown, what: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    fail(`bunaway.json.bundle: ${what} must be a boolean.`);
  }
  return value;
}

function signing(value: unknown, what: string): SigningConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = record(value, what);
  keys(raw, SIGNING_KEYS, what);
  const result: SigningConfig = {};
  if (raw.certificateFile !== undefined) {
    result.certificateFile = nonempty(
      raw.certificateFile,
      `${what}.certificateFile`,
    );
  }
  if (raw.thumbprint !== undefined) {
    result.thumbprint = nonempty(raw.thumbprint, `${what}.thumbprint`);
  }
  if (raw.subject !== undefined) {
    result.subject = nonempty(raw.subject, `${what}.subject`);
  }
  if (raw.timestampUrl !== undefined) {
    const url = nonempty(raw.timestampUrl, `${what}.timestampUrl`);
    try {
      if (!/^https?:$/.test(new URL(url).protocol)) {
        fail(`bunaway.json.bundle: ${what}.timestampUrl must be http(s).`);
      }
    } catch (error) {
      if (
        (
          error as Error & {
            code?: string;
          }
        ).code === CODES.CONFIG_INVALID
      ) {
        throw error;
      }
      fail(`bunaway.json.bundle: ${what}.timestampUrl must be a valid URL.`);
    }
    result.timestampUrl = url;
  }
  if (raw.passwordEnv !== undefined) {
    const name = nonempty(raw.passwordEnv, `${what}.passwordEnv`, 128);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      fail(
        `bunaway.json.bundle: ${what}.passwordEnv must be an environment variable name.`,
      );
    }
    result.passwordEnv = name;
  }
  if (!result.certificateFile && !result.thumbprint) {
    fail(
      `bunaway.json.bundle: ${what} needs certificateFile or thumbprint; secrets go in ${what}.passwordEnv, never in this file.`,
    );
  }
  return result;
}

export function parsePackaging(text: string): PackagingConfig {
  let rawValue: unknown;
  try {
    rawValue = JSON.parse(text);
  } catch {
    fail("bunaway.json.bundle: not valid JSON.");
  }
  const raw = record(rawValue, "bunaway.json.bundle");
  keys(raw, TOP_LEVEL, "bunaway.json.bundle");
  const config: PackagingConfig = {};
  if (raw.name !== undefined) {
    config.name = nonempty(raw.name, "name");
  }
  if (raw.identifier !== undefined) {
    const identifier = nonempty(raw.identifier, "identifier", 128);
    if (!IDENTIFIER_PATTERN.test(identifier)) {
      fail(
        "bunaway.json.bundle: identifier must be reverse-DNS (letters, digits, dots, dashes).",
      );
    }
    config.identifier = identifier;
  }
  if (raw.publisher !== undefined) {
    const publisher = record(raw.publisher, "publisher");
    keys(
      publisher,
      [
        "display",
        "identity",
      ],
      "publisher",
    );
    config.publisher = {};
    if (publisher.display !== undefined) {
      config.publisher.display = nonempty(
        publisher.display,
        "publisher.display",
      );
    }
    if (publisher.identity !== undefined) {
      const identity = nonempty(publisher.identity, "publisher.identity");
      if (!/^CN=.+/i.test(identity)) {
        fail(
          'bunaway.json.bundle: publisher.identity must be an X.500 subject like "CN=Example".',
        );
      }
      config.publisher.identity = identity;
    }
  }
  if (raw.release !== undefined) {
    const release = record(raw.release, "release");
    keys(
      release,
      [
        "version",
        "build",
      ],
      "release",
    );
    config.release = {};
    if (release.version !== undefined) {
      const version = nonempty(release.version, "release.version", 64);
      if (!SEMVER_PATTERN.test(version)) {
        fail(
          "bunaway.json.bundle: release.version must be numeric semver x.y.z.",
        );
      }
      config.release.version = version;
    }
    if (release.build !== undefined) {
      if (
        typeof release.build !== "number" ||
        !Number.isInteger(release.build) ||
        release.build < 0 ||
        release.build > 65535
      ) {
        fail(
          "bunaway.json.bundle: release.build must be an integer between 0 and 65535.",
        );
      }
      config.release.build = release.build;
    }
  }
  if (raw.icons !== undefined) {
    const icons = record(raw.icons, "icons");
    keys(
      icons,
      [
        "directory",
        "windows",
        "macos",
      ],
      "icons",
    );
    config.icons = {};
    if (icons.directory !== undefined) {
      const directory = nonempty(icons.directory, "icons.directory");
      if (
        /^(?:[A-Za-z]:[\\/]|[\\/])/.test(directory) ||
        directory.split(/[\\/]/).includes("..")
      ) {
        fail(
          "bunaway.json.bundle: icons.directory must be project-relative without '..'.",
        );
      }
      config.icons.directory = directory;
    }
    for (const [platform, allowed] of [
      [
        "windows",
        WINDOWS_ICONS,
      ],
      [
        "macos",
        MACOS_ICONS,
      ],
    ] as const) {
      if (icons[platform] === undefined) {
        continue;
      }
      const group = record(icons[platform], `icons.${platform}`);
      keys(
        group,
        [
          ...allowed,
        ],
        `icons.${platform}`,
      );
      const entries: Record<string, string> = {};
      for (const [name, icon] of Object.entries(group)) {
        entries[name] = nonempty(icon, `icons.${platform}.${name}`);
      }
      config.icons[platform] = entries;
    }
  }
  if (raw.targets !== undefined) {
    if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
      fail("bunaway.json.bundle: targets must be a nonempty array.");
    }
    const seen = new Set<string>();
    config.targets = raw.targets.map((entry, index) => {
      const target = record(entry, `targets[${index}]`);
      keys(
        target,
        [
          "platform",
          "arch",
          "minVersion",
        ],
        `targets[${index}]`,
      );
      const platform = nonempty(
        target.platform,
        `targets[${index}].platform`,
        16,
      );
      const arch = nonempty(target.arch, `targets[${index}].arch`, 16);
      if (
        ![
          "windows",
          "macos",
        ].includes(platform)
      ) {
        fail(
          `bunaway.json.bundle: targets[${index}].platform must be windows or macos.`,
        );
      }
      if (
        ![
          "x64",
          "arm64",
        ].includes(arch)
      ) {
        fail(
          `bunaway.json.bundle: targets[${index}].arch must be x64 or arm64.`,
        );
      }
      const id = `${platform}-${arch}`;
      if (seen.has(id)) {
        fail(`bunaway.json.bundle: duplicate target ${id}.`);
      }
      seen.add(id);
      const result: {
        platform: string;
        arch: string;
        minVersion?: string;
      } = {
        platform,
        arch,
      };
      if (target.minVersion !== undefined) {
        result.minVersion = nonempty(
          target.minVersion,
          `targets[${index}].minVersion`,
          32,
        );
      }
      return result;
    });
  }
  const topSigning = signing(raw.signing, "signing");
  if (topSigning) {
    config.signing = topSigning;
  }
  if (raw.channels !== undefined) {
    const channels = record(raw.channels, "channels");
    for (const [channel, value] of Object.entries(channels)) {
      if (!isChannelId(channel)) {
        fail(
          `bunaway.json.bundle: unknown channel channels.${channel} (supported: ${PACKAGING_CHANNELS.join(", ")}).`,
        );
      }
      const options = record(value, `channels.${channel}`);
      keys(options, CHANNEL_KEYS[channel] ?? [], `channels.${channel}`);
      if (options.signing !== undefined) {
        options.signing = signing(
          options.signing,
          `channels.${channel}.signing`,
        );
      }
      if (
        options.webView2 !== undefined &&
        ![
          "check",
          "bootstrap",
        ].includes(options.webView2 as string)
      ) {
        fail(
          `bunaway.json.bundle: channels.${channel}.webView2 must be "check" or "bootstrap".`,
        );
      }
      if (
        channel === "win-store-unpackaged" &&
        options.webView2 === "bootstrap"
      ) {
        fail(
          'bunaway.json.bundle: channels.win-store-unpackaged.webView2 must be "check"; the Store EXE/MSI requirements forbid installer-time downloads.',
        );
      }
      if (
        options.scope !== undefined &&
        ![
          "perUser",
          "perMachine",
        ].includes(options.scope as string)
      ) {
        fail(
          `bunaway.json.bundle: channels.${channel}.scope must be perUser or perMachine.`,
        );
      }
      for (const flag of [
        "desktopShortcut",
        "startMenuShortcut",
        "unvirtualizedData",
      ]) {
        optionalBoolean(options[flag], `channels.${channel}.${flag}`);
      }
      if (options.uninstall !== undefined) {
        const uninstall = record(
          options.uninstall,
          `channels.${channel}.uninstall`,
        );
        keys(
          uninstall,
          [
            "preserveUserData",
          ],
          `channels.${channel}.uninstall`,
        );
        optionalBoolean(
          uninstall.preserveUserData,
          `channels.${channel}.uninstall.preserveUserData`,
        );
        if (
          options.scope === "perMachine" &&
          uninstall.preserveUserData === false
        ) {
          fail(
            `bunaway.json.bundle: channels.${channel}.uninstall.preserveUserData=false requires scope=perUser; perMachine installs cannot safely target user data.`,
          );
        }
      }
      if (options.capabilities !== undefined) {
        if (
          !Array.isArray(options.capabilities) ||
          options.capabilities.some((cap) => typeof cap !== "string" || !cap)
        ) {
          fail(
            `bunaway.json.bundle: channels.${channel}.capabilities must be a list of strings.`,
          );
        }
      }
      if (options.packageName !== undefined) {
        const name = nonempty(
          options.packageName,
          `channels.${channel}.packageName`,
          50,
        );
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,49}$/.test(name)) {
          fail(
            `bunaway.json.bundle: channels.${channel}.packageName must be 3..50 characters, alphanumeric plus . _ -.`,
          );
        }
      }
      for (const key of [
        "minVersion",
        "maxVersionTested",
        "bundleId",
        "format",
      ]) {
        if (options[key] !== undefined) {
          nonempty(options[key], `channels.${channel}.${key}`, 64);
        }
      }
      if (options.entitlements !== undefined) {
        if (
          !Array.isArray(options.entitlements) ||
          options.entitlements.some((cap) => typeof cap !== "string" || !cap)
        ) {
          fail(
            `bunaway.json.bundle: channels.${channel}.entitlements must be a list of strings.`,
          );
        }
      }
    }
    config.channels = channels as Partial<
      Record<string, Record<string, unknown>>
    >;
  }
  return config;
}
