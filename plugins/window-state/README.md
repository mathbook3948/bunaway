# Window state plugin

`@bunaway/plugin-window-state` saves a window's normal bounds, DPI, maximized, fullscreen and
visible state and restores it on the next run. Register `windowState` in the app definition.
It declares no native operation of its own: `windowState.save`, `restore` and `remove` call the
`windows` and `store` plugins with the caller's permissions, so those plugins must be installed
and registered and the caller needs their operation permissions.

- `src/contract.ts` declares the stored record schema, the named limits and the call inputs.
- `src/placement.ts` is the pure function that fits a saved rectangle to the current monitors
  (keep when still visible, otherwise center on the primary work area, scale by the DPI ratio).
- `src/state.ts` creates the three calls from injected `windows` and `store` clients.

See the [public contract](../../docs/site/src/content/docs/reference/plugins/window-state.mdx) for
inputs, results and restore order. `tests/api/window-state-persistence.test.ts` covers placement and
call order with fake clients; `tests/lifecycle/windows-window-state.ts` runs the round trips on a
real window.

Not provided: automatic saving on close or exit, saving of minimized state, and tests of real
monitor changes or mixed-DPI monitors.
