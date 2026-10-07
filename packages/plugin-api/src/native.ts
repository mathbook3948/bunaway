export type WindowSpec = {
  view: string;
  home: string;
  title: string;
  window: {
    width: number;
    height: number;
  };
  startup?: boolean;
};
export type WindowState = {
  closed: boolean;
  cleaned: boolean;
  ready: boolean;
  failure: unknown;
  deadline: number;
};
export type NativeWindow = {
  show(visible: boolean): void;
  focus(): boolean;
  close(): boolean | Promise<boolean>;
  isFullscreen(): boolean;
  setSize(width: number, height: number): void;
  setPosition(x: number, y: number): void;
  setFullscreen(value: boolean): void;
  setCloseConfirmation(message: string | null): void;
};
export type NativeWindowServices = {
  specs: readonly WindowSpec[];
  read(view: string): WindowState | undefined;
  create(spec: WindowSpec): void;
  close(view: string): boolean | Promise<boolean>;
  window(view: string): NativeWindow;
  stopping(): boolean;
  cancelled(requestId: string): boolean;
  now(): number;
  tick(): Promise<void>;
};
