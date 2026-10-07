import type { HostAPI } from "@bunaway/protocol";
import { currentHost } from "./host-context.ts";

export const host = Object.freeze<HostAPI>({
  async call(contract, input) {
    return currentHost().call(contract, input);
  },
});
