/** The window operations an HTML fullscreen request is mapped onto. */
export interface HtmlFullscreenWindow {
  isFullscreen(): boolean;
  isFullscreenable(): boolean;
  setFullscreen(enabled: boolean): void;
  /** Identity of the current fullscreen stay; a new stay is a new object, none while windowed. */
  fullscreenSession(): object | undefined;
}

/**
 * Link a page's fullscreen element to its native window, as Electron does: when the page enters
 * HTML fullscreen the window enters fullscreen, and when the page leaves it the window returns to
 * its previous state. The returned function takes `ContainsFullScreenElement` after each change.
 *
 * Only the fullscreen stay entered here is undone: a window that was already fullscreen, or that is
 * not fullscreenable, keeps its state, and a window the app took out of fullscreen in the
 * meantime stays as the app left it, even when the app made it fullscreen again.
 */
export function createHtmlFullscreenLink(
  window: HtmlFullscreenWindow,
): (containsFullscreenElement: boolean) => void {
  let enteredSession: object | undefined;
  return (containsFullscreenElement) => {
    if (containsFullscreenElement) {
      if (!window.isFullscreen() && window.isFullscreenable()) {
        window.setFullscreen(true);
        enteredSession = window.fullscreenSession();
      }
      return;
    }
    const session = enteredSession;
    enteredSession = undefined;
    // Leaving can fail; the stay is not retried because the page element is already gone.
    if (session !== undefined && window.fullscreenSession() === session) {
      window.setFullscreen(false);
    }
  };
}
