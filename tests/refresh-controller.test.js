"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createRefreshController } = require("../extension/refresh-controller.js");

class FakeClock {
  constructor() {
    this.now = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextId;
    this.nextId += 1;
    this.tasks.set(id, { callback, due: this.now + delay });
    return id;
  }

  clearTimeout(id) {
    this.tasks.delete(id);
  }

  tick(milliseconds) {
    const target = this.now + milliseconds;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.due <= target)
        .sort((first, second) => first[1].due - second[1].due)[0];
      if (!next) {
        break;
      }
      const [id, task] = next;
      this.tasks.delete(id);
      this.now = task.due;
      task.callback();
    }
    this.now = target;
  }
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("coalesces map changes and never overlaps scans", async () => {
  const clock = new FakeClock();
  const scans = [];
  const results = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const controller = createRefreshController({
    scan: () => {
      const request = deferred();
      scans.push(request);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      return request.promise.finally(() => {
        inFlight -= 1;
      });
    },
    onResult: (result) => results.push(result),
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    changeDebounceMs: 250,
    fallbackMs: 3000
  });

  controller.start();
  assert.equal(scans.length, 1);
  controller.notifyChanged();
  controller.notifyChanged();
  clock.tick(250);
  assert.equal(scans.length, 1);

  scans[0].resolve("stale");
  await flushPromises();
  assert.equal(scans.length, 2);
  assert.deepEqual(results, []);

  scans[1].resolve("current");
  await flushPromises();
  assert.deepEqual(results, ["current"]);
  assert.equal(maximumInFlight, 1);
  controller.stop();
});

test("runs a slow fallback and lets manual refresh replace its result", async () => {
  const clock = new FakeClock();
  const reasons = [];
  const results = [];
  const controller = createRefreshController({
    scan: async (reason) => {
      reasons.push(reason);
      return reason;
    },
    onResult: (result) => results.push(result),
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    fallbackMs: 3000
  });

  controller.start();
  await flushPromises();
  clock.tick(2999);
  assert.deepEqual(reasons, ["initial"]);
  clock.tick(1);
  await flushPromises();
  assert.deepEqual(reasons, ["initial", "fallback"]);

  controller.refreshNow();
  await flushPromises();
  assert.deepEqual(reasons, ["initial", "fallback", "manual"]);
  assert.deepEqual(results, ["initial", "fallback", "manual"]);

  controller.stop();
  clock.tick(6000);
  assert.equal(reasons.length, 3);
});
