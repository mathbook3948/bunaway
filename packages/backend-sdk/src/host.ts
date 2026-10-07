import { currentHost } from "@bunaway/plugin-api/host";
import type { HostAPI } from "@bunaway/protocol";
export const host = Object.freeze<HostAPI>({
  call: (contract, input) => currentHost().call(contract, input),
});
