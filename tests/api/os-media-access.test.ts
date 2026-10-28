import { expect, test } from "bun:test";
import os from "@bunaway/plugin-os";
import { NativeRegistry } from "@bunaway/protocol";
import { mediaAccessStatusSchema } from "#plugins/os/src/contract";
import { osOperations } from "#plugins/os/src/operations";
import {
  type ConsentValue,
  type MediaAccessBindings,
  mediaAccessStatus,
} from "#plugins/os/src/platforms/windows-media-access";

const missing: ConsentValue = {
  kind: "missing",
};
const unreadable: ConsentValue = {
  kind: "unreadable",
};
const value = (text: string): ConsentValue => ({
  kind: "value",
  value: text,
});

/** Consent store fake that records which hive and device class were read. */
function fakeBindings(machine: ConsentValue, user: ConsentValue) {
  const reads: string[] = [];
  const bindings: MediaAccessBindings = {
    readConsent(hive, mediaType) {
      reads.push(`${hive}:${mediaType}`);
      return hive === "machine" ? machine : user;
    },
  };
  return {
    bindings,
    reads,
  };
}

test("the user setting decides when device policy does not deny", () => {
  for (const machine of [
    missing,
    value("Allow"),
  ]) {
    expect(
      mediaAccessStatus(
        fakeBindings(machine, value("Allow")).bindings,
        "camera",
      ),
    ).toBe("granted");
    expect(
      mediaAccessStatus(
        fakeBindings(machine, value("Deny")).bindings,
        "camera",
      ),
    ).toBe("denied");
    expect(
      mediaAccessStatus(fakeBindings(machine, missing).bindings, "camera"),
    ).toBe("not-determined");
  }
});

test("a device policy Deny is restricted whatever the user setting says", () => {
  for (const user of [
    value("Allow"),
    value("Deny"),
    missing,
    unreadable,
  ]) {
    const fake = fakeBindings(value("Deny"), user);
    expect(mediaAccessStatus(fake.bindings, "microphone")).toBe("restricted");
    // The user hive is not read once the device policy has decided.
    expect(fake.reads).toEqual([
      "machine:microphone",
    ]);
  }
});

test("failed reads and unexpected values are unknown, never granted", () => {
  expect(
    mediaAccessStatus(
      fakeBindings(unreadable, value("Allow")).bindings,
      "camera",
    ),
  ).toBe("unknown");
  expect(
    mediaAccessStatus(fakeBindings(missing, unreadable).bindings, "camera"),
  ).toBe("unknown");
  expect(
    mediaAccessStatus(
      fakeBindings(value("Prompt"), value("Allow")).bindings,
      "camera",
    ),
  ).toBe("unknown");
  expect(
    mediaAccessStatus(fakeBindings(missing, value("allow")).bindings, "camera"),
  ).toBe("unknown");
  expect(
    mediaAccessStatus(fakeBindings(missing, value("")).bindings, "camera"),
  ).toBe("unknown");
});

test("each device class reads its own key in both hives", () => {
  const fake = fakeBindings(value("Allow"), value("Allow"));
  mediaAccessStatus(fake.bindings, "camera");
  mediaAccessStatus(fake.bindings, "microphone");
  expect(fake.reads).toEqual([
    "machine:camera",
    "user:camera",
    "machine:microphone",
    "user:microphone",
  ]);
});

test("os.getMediaAccessStatus accepts only the two device classes and has its own permission", () => {
  const operation = osOperations.getMediaAccessStatus;
  expect(
    operation.input.parse({
      mediaType: "camera",
    }),
  ).toEqual({
    mediaType: "camera",
  });
  for (const input of [
    null,
    {},
    {
      mediaType: "screen",
    },
    {
      mediaType: "camera",
      path: "x",
    },
    {
      mediaType: "Camera",
    },
  ]) {
    expect(operation.input.safeParse(input).success).toBe(false);
  }
  for (const status of mediaAccessStatusSchema.options) {
    expect(operation.output.parse(status)).toBe(status);
  }
  expect(operation.output.safeParse("allowed").success).toBe(false);
  const registry = new NativeRegistry([
    os._definition,
  ]);
  const call = {
    operation: "os.getMediaAccessStatus",
    payload: {
      mediaType: "microphone",
    },
  };
  expect(
    registry.allowed(
      {
        permissions: [
          call.operation,
        ],
      },
      call,
    ),
  ).toBe(true);
  expect(
    registry.allowed(
      {
        permissions: [
          "os.info",
        ],
      },
      call,
    ),
  ).toBe(false);
});
