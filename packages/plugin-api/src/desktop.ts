export type QuitReason = "last-window" | "tray" | "api";

export type OpenRequest = {
  readonly source: "initial" | "second-instance";
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly urls: readonly string[];
  readonly files: readonly string[];
};

// Trusted app callbacks only. WebViews cannot issue lifecycle control packets.
export interface DesktopContext {
  show(): Promise<void>;
  hide(): Promise<void>;
  quit(): Promise<boolean>;
}

export type DesktopOptions = {
  readonly closeBehavior?: "quit" | "hide";
  readonly tray?: {
    readonly tooltip: string;
  };
  onOpen?(request: OpenRequest, context: DesktopContext): void | Promise<void>;
  // biome-ignore lint/suspicious/noConfusingVoidType: async callbacks may allow quitting without an explicit return.
  beforeQuit?(reason: QuitReason): boolean | void | Promise<boolean | void>;
};
