import { hostCallSchema } from "../src/host-api.ts";
import {
  bootstrapSchema,
  hostResponseSchema,
  messageSchema,
  policySchema,
  processSchema,
} from "../src/schema.ts";

for (const [name, schema] of Object.entries({
  message: messageSchema,
  policy: policySchema,
  bootstrap: bootstrapSchema,
  "host-response": hostResponseSchema,
  process: processSchema,
  "host-call": hostCallSchema,
})) {
  const file = new URL(
    `../../../native/host-api/generated/${name}.schema.json`,
    import.meta.url,
  );
  await Bun.write(file, `${JSON.stringify(schema, null, 2)}\n`);
}
