import { expect, test } from "bun:test";
import {
  attemptAll,
  attemptAllAsync,
  failWithCleanup,
  ResourceOwner,
} from "@bunaway/plugin";

test("attemptAll runs every step and reports all failures in one AggregateError", () => {
  const ran: string[] = [];
  expect(() =>
    attemptAll(
      [
        () => ran.push("first"),
        () => {
          throw new Error("second failed");
        },
        () => ran.push("third"),
        () => {
          throw new Error("fourth failed");
        },
      ],
      "Example cleanup failed.",
    ),
  ).toThrow(
    expect.objectContaining({
      message: "Example cleanup failed.",
      errors: [
        new Error("second failed"),
        new Error("fourth failed"),
      ],
    }),
  );
  expect(ran).toEqual([
    "first",
    "third",
  ]);
  expect(() => attemptAll([], "unused")).not.toThrow();
});

test("attemptAllAsync awaits each step in order and aggregates rejections", async () => {
  const order: string[] = [];
  await expect(
    attemptAllAsync(
      [
        async () => {
          await Bun.sleep(5);
          order.push("slow");
        },
        () => {
          order.push("sync");
        },
        async () => {
          throw new Error("async failed");
        },
      ],
      "Async cleanup failed.",
    ),
  ).rejects.toThrow(
    expect.objectContaining({
      message: "Async cleanup failed.",
      errors: [
        new Error("async failed"),
      ],
    }),
  );
  expect(order).toEqual([
    "slow",
    "sync",
  ]);
});

test("failWithCleanup rethrows the original error or both when cleanup fails", () => {
  const original = new Error("work failed");
  let cleaned = 0;
  expect(() =>
    failWithCleanup(
      original,
      () => {
        cleaned++;
      },
      "Work and cleanup failed.",
    ),
  ).toThrow(original);
  expect(cleaned).toBe(1);
  expect(() =>
    failWithCleanup(
      original,
      () => {
        throw new Error("cleanup failed");
      },
      "Work and cleanup failed.",
    ),
  ).toThrow(
    expect.objectContaining({
      message: "Work and cleanup failed.",
      errors: [
        original,
        new Error("cleanup failed"),
      ],
    }),
  );
});

test("ResourceOwner releases in reverse order once and rolls back a failed acquisition", () => {
  const released: string[] = [];
  const owner = new ResourceOwner("Owner cleanup failed.");
  owner.acquire(
    () => "a",
    (name) => released.push(name),
  );
  owner.acquire(
    () => "b",
    (name) => released.push(name),
  );
  expect(owner.disposed).toBe(false);
  owner.dispose();
  owner.dispose();
  expect(owner.disposed).toBe(true);
  expect(released).toEqual([
    "b",
    "a",
  ]);
  expect(() =>
    owner.acquire(
      () => "late",
      () => {},
    ),
  ).toThrow("Cannot acquire a resource after disposal.");

  const rollback: string[] = [];
  const failing = new ResourceOwner("Failing owner cleanup failed.");
  failing.acquire(
    () => "first",
    (name) => rollback.push(name),
  );
  expect(() =>
    failing.acquire(
      () => {
        throw new Error("second creation failed");
      },
      () => rollback.push("never"),
    ),
  ).toThrow("second creation failed");
  expect(failing.disposed).toBe(true);
  expect(rollback).toEqual([
    "first",
  ]);
});

test("ResourceOwner keeps releasing after a failed release and reports every failure", () => {
  const released: string[] = [];
  const owner = new ResourceOwner("Owner cleanup failed.");
  owner.acquire(
    () => "a",
    (name) => released.push(name),
  );
  owner.acquire(
    () => "b",
    () => {
      throw new Error("b release failed");
    },
  );
  expect(() => owner.dispose()).toThrow(
    expect.objectContaining({
      message: "Owner cleanup failed.",
      errors: [
        new Error("b release failed"),
      ],
    }),
  );
  expect(released).toEqual([
    "a",
  ]);
});
