import { bootstrapSchema, hostResponseSchema, messageSchema, policySchema } from "../src/schema.ts";

for (const [name, schema] of Object.entries({
  message: messageSchema,
  policy: policySchema,
  bootstrap: bootstrapSchema,
  "host-response": hostResponseSchema,
})) {
  const file = new URL(`../../../native/host-api/generated/${name}.schema.json`, import.meta.url);
  await Bun.write(file, `${JSON.stringify(schema, null, 2)}\n`);
}
