// @effect-diagnostics nodeBuiltinImport:off - Exercises the native updater event adapter without Electron or Squirrel.
import * as NodeEvents from "node:events";

import { assert, it } from "@effect/vitest";

import { makeNativeUpdatePreparation } from "./nativeUpdatePreparation.ts";

function setup() {
  let checks = 0;
  const updater = Object.assign(new NodeEvents.EventEmitter(), {
    checkForUpdates: () => {
      checks += 1;
    },
  });
  return { updater, preparation: makeNativeUpdatePreparation(updater), checks: () => checks };
}

it("waits for native staging, caches only that download, and resets for the next artifact", async () => {
  const { updater, preparation, checks } = setup();
  let completed = false;
  const pending = preparation.prepare().then(() => {
    completed = true;
  });
  assert.equal(checks(), 1);
  assert.isFalse(completed);
  updater.emit("update-downloaded");
  await pending;
  assert.isTrue(completed);
  await preparation.prepare();
  assert.equal(checks(), 1);
  preparation.reset();
  const next = preparation.prepare();
  assert.equal(checks(), 2);
  updater.emit("update-downloaded");
  await next;
  assert.equal(updater.listenerCount("error"), 0);
});

it("drains an older native check before preparing a later download", async () => {
  const { updater, preparation, checks } = setup();
  const old = preparation.prepare();
  preparation.reset();
  const next = preparation.prepare();
  assert.equal(checks(), 1);
  updater.emit("update-downloaded");
  await old;
  assert.equal(checks(), 2);
  updater.emit("update-downloaded");
  await next;
  assert.equal(checks(), 2);
});

it.each(["error", "update-not-available"])(
  "cleans up and permits retry after %s",
  async (event) => {
    const { updater, preparation, checks } = setup();
    const pending = preparation.prepare();
    const rejected = pending.then(
      () => assert.fail("Expected native staging to fail."),
      () => undefined,
    );
    updater.emit(event, new Error("Native staging refused."));
    await rejected;
    assert.equal(updater.listenerCount("update-downloaded"), 0);
    assert.equal(updater.listenerCount("update-not-available"), 0);
    const retry = preparation.prepare();
    assert.equal(checks(), 2);
    updater.emit("update-downloaded");
    await retry;
  },
);

it("cleans up after a synchronous native check failure", async () => {
  const { updater, preparation } = setup();
  updater.checkForUpdates = () => {
    throw new Error("Native updater refused the check.");
  };
  await preparation.prepare().then(
    () => assert.fail("Expected the native check to fail."),
    () => undefined,
  );
  assert.equal(updater.listenerCount("error"), 0);
  assert.equal(updater.listenerCount("update-downloaded"), 0);
  updater.checkForUpdates = () => {
    updater.emit("update-downloaded");
  };
  await preparation.prepare();
});
