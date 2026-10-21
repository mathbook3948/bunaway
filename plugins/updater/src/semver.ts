import { MAX_VERSION_LENGTH } from "#updater/contract";

/** SemVer 2.0.0 grammar: no leading `v`, no leading zeros in numbers, no empty identifiers. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

export type SemVer = {
  core: [
    bigint,
    bigint,
    bigint,
  ];
  prerelease: string[];
};

/** Parse a strict SemVer 2.0.0 string, or return null. Build metadata is validated and dropped. */
export function parseSemVer(text: string): SemVer | null {
  if (text.length > MAX_VERSION_LENGTH) {
    return null;
  }
  const match = SEMVER.exec(text);
  if (!match) {
    return null;
  }
  return {
    core: [
      BigInt(match[1] as string),
      BigInt(match[2] as string),
      BigInt(match[3] as string),
    ],
    prerelease: match[4] === undefined ? [] : match[4].split("."),
  };
}

function order(left: bigint | string, right: bigint | string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function compareIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return order(BigInt(left), BigInt(right));
  }
  if (leftNumeric !== rightNumeric) {
    // Numeric identifiers always rank below alphanumeric ones.
    return leftNumeric ? -1 : 1;
  }
  return order(left, right);
}

/** Order two versions by SemVer 2.0.0 section 11; build metadata does not take part. */
export function compareSemVer(left: SemVer, right: SemVer): number {
  for (let index = 0; index < 3; index++) {
    const result = order(
      left.core[index] as bigint,
      right.core[index] as bigint,
    );
    if (result !== 0) {
      return result;
    }
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    // A version without prerelease ranks above the same core with one.
    return order(
      BigInt(right.prerelease.length ? 1 : 0),
      BigInt(left.prerelease.length ? 1 : 0),
    );
  }
  const shared = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < shared; index++) {
    const result = compareIdentifier(
      left.prerelease[index] as string,
      right.prerelease[index] as string,
    );
    if (result !== 0) {
      return result;
    }
  }
  return order(BigInt(left.prerelease.length), BigInt(right.prerelease.length));
}
