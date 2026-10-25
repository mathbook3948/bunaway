/** Longest `title` a `windows.documentTitleChanged` event carries, in UTF-16 code units (same bound as `windows.setTitle`). */
export const MAX_DOCUMENT_TITLE_LENGTH = 1024;

/**
 * Cut a page title to `MAX_DOCUMENT_TITLE_LENGTH` code units. A surrogate pair that straddles the
 * limit is dropped whole, so the result is always well-formed UTF-16.
 */
export function limitDocumentTitle(title: string): string {
  if (title.length <= MAX_DOCUMENT_TITLE_LENGTH) {
    return title;
  }
  const lastUnit = title.charCodeAt(MAX_DOCUMENT_TITLE_LENGTH - 1);
  const splitsPair = lastUnit >= 0xd800 && lastUnit <= 0xdbff;
  return title.slice(0, MAX_DOCUMENT_TITLE_LENGTH - (splitsPair ? 1 : 0));
}
