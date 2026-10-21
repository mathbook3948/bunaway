/**
 * Fixed UUID namespace for toast activator class identifiers. Changing it changes every app's
 * CLSID, which orphans the shortcuts and registry keys an earlier install wrote.
 */
const TOAST_ACTIVATOR_NAMESPACE = "5d1c6f0e-3b6a-4a39-9f0c-7b2e8a4d1c53";
const BLOCK_BYTES = 64;
/** The message length field and the 0x80 terminator that SHA-1 padding appends. */
const PADDING_TAIL_BYTES = 9;
const LENGTH_FIELD_BYTES = 8;
const UUID_BYTES = 16;
const VERSION_5 = 0x50;

const rotateLeft = (value: number, bits: number) =>
  ((value << bits) | (value >>> (32 - bits))) >>> 0;

/** Round function and constant of the SHA-1 round `round` (0 to 79). */
function roundFunction(
  round: number,
  b: number,
  c: number,
  d: number,
): [
  number,
  number,
] {
  if (round < 20) {
    return [
      (b & c) | (~b & d),
      0x5a827999,
    ];
  }
  if (round < 40) {
    return [
      b ^ c ^ d,
      0x6ed9eba1,
    ];
  }
  if (round < 60) {
    return [
      (b & c) | (b & d) | (c & d),
      0x8f1bbcdc,
    ];
  }
  return [
    b ^ c ^ d,
    0xca62c1d6,
  ];
}

/** Message padded to whole 64-byte blocks, with the bit length as a big-endian 64-bit suffix. */
function padMessage(message: Uint8Array): Uint8Array {
  const paddedLength =
    Math.ceil((message.length + PADDING_TAIL_BYTES) / BLOCK_BYTES) *
    BLOCK_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = message.length * 8;
  view.setUint32(paddedLength - LENGTH_FIELD_BYTES, Math.floor(bits / 2 ** 32));
  view.setUint32(paddedLength - LENGTH_FIELD_BYTES / 2, bits >>> 0);
  return padded;
}

/**
 * SHA-1 of a short message. Used only to derive a name-based identifier, never for security.
 * WebView-reachable modules cannot use node:crypto, and the digest is small enough to compute here.
 */
function sha1(message: Uint8Array): Uint8Array {
  const padded = padMessage(message);
  const view = new DataView(padded.buffer);
  const state = new Uint32Array([
    0x67452301,
    0xefcdab89,
    0x98badcfe,
    0x10325476,
    0xc3d2e1f0,
  ]);
  const schedule = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += BLOCK_BYTES) {
    for (let index = 0; index < 16; index++) {
      schedule[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 80; index++) {
      schedule[index] = rotateLeft(
        (schedule[index - 3] ?? 0) ^
          (schedule[index - 8] ?? 0) ^
          (schedule[index - 14] ?? 0) ^
          (schedule[index - 16] ?? 0),
        1,
      );
    }
    let [a = 0, b = 0, c = 0, d = 0, e = 0] = state;
    for (let round = 0; round < 80; round++) {
      const [mix, constant] = roundFunction(round, b, c, d);
      const next =
        (rotateLeft(a, 5) + mix + e + constant + (schedule[round] ?? 0)) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }
    state[0] = (state[0] ?? 0) + a;
    state[1] = (state[1] ?? 0) + b;
    state[2] = (state[2] ?? 0) + c;
    state[3] = (state[3] ?? 0) + d;
    state[4] = (state[4] ?? 0) + e;
  }
  const digest = new Uint8Array(20);
  const out = new DataView(digest.buffer);
  state.forEach((word, index) => {
    out.setUint32(index * 4, word);
  });
  return digest;
}

/** UTF-8 bytes of `text`. This package has no TextEncoder type, and identifiers are short. */
function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** Name-based UUID version 5 (RFC 4122) as lowercase text without braces. */
export function uuidV5(namespace: string, name: string): string {
  const namespaceBytes = Uint8Array.from(
    (namespace.replaceAll("-", "").match(/../g) ?? []).map((pair) =>
      Number.parseInt(pair, 16),
    ),
  );
  const nameBytes = Uint8Array.from(utf8Bytes(name));
  const message = new Uint8Array(namespaceBytes.length + nameBytes.length);
  message.set(namespaceBytes);
  message.set(nameBytes, namespaceBytes.length);
  const bytes = sha1(message).slice(0, UUID_BYTES);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | VERSION_5;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const text = hex(bytes);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}

/**
 * COM class identifier of the app's toast activator, lowercase without braces. The installer writes it
 * to the Start menu shortcut and the notification plugin registers the same class, so both derive it
 * from the application identifier instead of storing it.
 */
export function toastActivatorClsid(appId: string): string {
  return uuidV5(TOAST_ACTIVATOR_NAMESPACE, appId);
}
