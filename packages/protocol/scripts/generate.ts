import {
  bootstrapSchema,
  hostResponseSchema,
  messageSchema,
  policySchema,
  processSchema,
} from "../src/schema.ts";
import { hostCallSchema, hostOperations } from "../src/host-api.ts";

for (const [name, schema] of Object.entries({
  message: messageSchema,
  policy: policySchema,
  bootstrap: bootstrapSchema,
  "host-response": hostResponseSchema,
  process: processSchema,
  "host-call": hostCallSchema,
})) {
  const file = new URL(`../../../native/host-api/generated/${name}.schema.json`, import.meta.url);
  await Bun.write(file, `${JSON.stringify(schema, null, 2)}\n`);
}

await Bun.write(
  new URL("../../../native/host-api/generated/host-operations.json", import.meta.url),
  `${JSON.stringify(hostOperations, null, 2)}\n`,
);
