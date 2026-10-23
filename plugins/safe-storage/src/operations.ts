import { defineNativeOperation } from "@bunaway/plugin";
import { z } from "zod";
import {
  bytesInputSchema,
  ciphertextInputSchema,
  ciphertextSchema,
  plaintextSchema,
  type SafeStorageInstance,
  secretKeyInputSchema,
  secretValueSchema,
  setSecretInputSchema,
  textInputSchema,
  textSchema,
} from "#safe-storage/contract";

/** Both implementations share one contract; each operation still needs its own policy grant. */
const operation = defineNativeOperation<SafeStorageInstance>();
export const safeStorageOperations = {
  isAvailable: operation({
    input: z.null(),
    output: z.boolean(),
    handler: (_input, { instance }) => instance.isAvailable(),
  }),
  encryptString: operation({
    input: textInputSchema,
    output: ciphertextSchema,
    handler: ({ text }, { instance }) => instance.encryptString(text),
  }),
  decryptString: operation({
    input: ciphertextInputSchema,
    output: textSchema,
    handler: ({ ciphertext }, { instance }) =>
      instance.decryptString(ciphertext),
  }),
  encryptBytes: operation({
    input: bytesInputSchema,
    output: ciphertextSchema,
    handler: ({ bytes }, { instance }) => instance.encryptBytes(bytes),
  }),
  decryptBytes: operation({
    input: ciphertextInputSchema,
    output: plaintextSchema,
    handler: ({ ciphertext }, { instance }) =>
      instance.decryptBytes(ciphertext),
  }),
  setSecret: operation({
    input: setSecretInputSchema,
    output: z.null(),
    handler: ({ key, value }, { instance }) => {
      instance.setSecret(key, value);
      return null;
    },
  }),
  getSecret: operation({
    input: secretKeyInputSchema,
    output: secretValueSchema.nullable(),
    handler: ({ key }, { instance }) => instance.getSecret(key),
  }),
  deleteSecret: operation({
    input: secretKeyInputSchema,
    output: z.boolean(),
    handler: ({ key }, { instance }) => instance.deleteSecret(key),
  }),
};
