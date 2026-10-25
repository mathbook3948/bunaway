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

/**
 * Keep at most one title event in flight per view. A page decides how often it renames itself, so
 * titles that arrive while a send is pending collapse to the latest one instead of filling the
 * native event queue, which would fail the view. `send` must call `settled` exactly once when the
 * event was delivered, dropped or refused.
 */
export function createTitleCoalescer(
  send: (title: string, settled: () => void) => void,
): (title: string) => void {
  let sending = false;
  let waiting: string | undefined;
  const publish = (title: string): void => {
    sending = true;
    send(title, () => {
      sending = false;
      const next = waiting;
      waiting = undefined;
      if (next !== undefined) {
        publish(next);
      }
    });
  };
  return (title) => {
    if (sending) {
      waiting = title;
      return;
    }
    publish(title);
  };
}
