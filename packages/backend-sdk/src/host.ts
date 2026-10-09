import { currentHost } from "@bunaway/plugin-api/host";
import type { HostAPI } from "@bunaway/protocol";
export const host = Object.freeze<HostAPI>({
  /** Uses the Host API bound to the current command or plugin setup execution. */
  call: (contract, input) => currentHost().call(contract, input),
});
