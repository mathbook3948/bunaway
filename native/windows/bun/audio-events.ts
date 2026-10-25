/** Mute setting and actual playback of one WebView, as `ICoreWebView2_8` reports them. */
export type AudioState = {
  muted: boolean;
  playing: boolean;
};

/**
 * Publishes a WebView's audio state only when it differs from the last one published, so the two
 * WebView2 change events (mute and playback) never produce a repeated state. A new WebView starts
 * unmuted and silent.
 */
export class AudioChanges {
  private last: AudioState = {
    muted: false,
    playing: false,
  };

  constructor(
    private readonly read: () => AudioState,
    private readonly publish: (state: AudioState) => void,
  ) {}

  /** Read the current state and publish it when it is not the one already published. */
  check(): void {
    const state = this.read();
    if (
      state.muted === this.last.muted &&
      state.playing === this.last.playing
    ) {
      return;
    }
    this.last = state;
    this.publish(state);
  }
}
