/** Shared counters observe cleanup performed inside the production UI Worker. */
export const uiCleanupSlots = {
  tray: 0,
  adapter: 1,
  com: 2,
  windows: 3,
  apartment: 4,
  bindings: 5,
};

/** Controls and per-window counts for lifecycle tests, separate from host teardown counts. */
export const uiLifecycleSlots = {
  confirmClose: 0,
  confirmations: 1,
  holdProfileReuse: 2,
  detach: 3,
  finish: 4,
  destroy: 5,
  close: 6,
  inputRestoreFailures: 7,
  inputRestores: 8,
};
