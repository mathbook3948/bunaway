import { BunawayError, s } from "@bunaway/plugin";

export const MAX_URL_LENGTH = 8192;

export const urlInput = s.object({
  url: s.string({
    maxLength: MAX_URL_LENGTH,
  }),
});

const invalidUrl = () =>
  new BunawayError({
    code: "INVALID_ARGUMENT",
    message:
      "Expected an absolute HTTP or HTTPS URL of at most 8192 characters.",
  });

/**
 * Validate an untrusted URL and return its canonical URL form.
 * @throws {BunawayError} If the input is not a valid HTTP or HTTPS URL within the length limit.
 */
export function normalizeUrl(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > MAX_URL_LENGTH ||
    input.trim() !== input ||
    !/^https?:\/\/[^/?#]/i.test(input) ||
    /[\p{Cc}\\]/u.test(input)
  ) {
    throw invalidUrl();
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalidUrl();
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.href.length > MAX_URL_LENGTH
  ) {
    throw invalidUrl();
  }
  return url.href;
}
