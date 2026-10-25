/** Longest `url` a `windows.documentFaviconChanged` event carries, in UTF-16 code units. */
export const MAX_FAVICON_URL_LENGTH = 2048;

/**
 * The favicon URL to publish. An icon address longer than the limit (a large `data:` icon) cannot
 * be cut into a usable URL, so it is reported as the empty string.
 */
export function limitFaviconUrl(url: string): string {
  return url.length <= MAX_FAVICON_URL_LENGTH ? url : "";
}
