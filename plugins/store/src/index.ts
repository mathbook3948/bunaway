import { defineNativePlugin } from "@bunaway/plugin";
import { storeOperations } from "#store/operations";
import { dispose, initialize } from "#store/platforms/node-store";

/** Keep app settings as named JSON key-value stores in the app's data directory. */
export default defineNativePlugin({
  name: "store",
  platforms: {
    macos: {
      initialize,
      dispose,
      operations: storeOperations,
    },
    windows: {
      initialize,
      dispose,
      operations: storeOperations,
    },
  },
});

export type {
  StoreChange,
  StoreGetResult,
  StoreLoadInput,
  StoreLoadResult,
  StoreValue,
} from "#store/contract";
