"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { setImmediate } = require("node:timers/promises");
const core = require("../extension/google-maps-route-core.js");
const fixture = require("./fixtures/google-maps-multipoint.json");
const source = fs.readFileSync(require.resolve("../extension/google-maps-page-bridge.js"), "utf8");

function harness() {
  const messages = [];
  const requests = [];
  const cards = [{ index: "0", role: "link", visible: true }];
  let listener;
  class FakeXHR {
    open(...args) { this.openArgs = args; return "opened"; }
    send(...args) { this.sendArgs = args; return "sent"; }
    addEventListener(_name, callback) { this.onLoadEnd = callback; }
    finish(value, status = 200) {
      this.status = status;
      this.responseType = "";
      this.responseText = value;
      this.onLoadEnd();
    }
  }
  const window = {
    GoogleMapsRouteCore: core,
    APP_INITIALIZATION_STATE: [null, null, null, { wrapped: [null, null, null, null, JSON.stringify(fixture)] }],
    location: { href: "https://www.google.pl/maps/dir/test", origin: "https://www.google.pl", pathname: "/maps/dir/test" },
    setTimeout: () => 1,
    clearTimeout() {},
    addEventListener(_name, callback) { listener = callback; },
    postMessage(message) { messages.push(message); },
    fetch(...args) {
      return new Promise((resolve, reject) => requests.push({ args, resolve, reject }));
    }
  };
  const document = {
    querySelectorAll: () => cards.map((card) => ({
      getClientRects: () => card.visible ? [{}] : [],
      getAttribute: (name) => name === "role" ? card.role : name === "data-trip-index" ? card.index : null
    }))
  };
  vm.runInNewContext(source, {
    window, document, URL, XMLHttpRequest: FakeXHR,
    MutationObserver: class { observe() {} }
  });
  return {
    window, cards, requests, FakeXHR,
    scan() {
      listener({ source: window, data: { channel: "here-maps-route-export/v1", direction: "to-page", type: "SCAN_ACTIVE_ROUTE", requestId: "test" } });
      return messages.at(-1).response;
    },
    async resolve(index, data = fixture) {
      requests[index].resolve({ ok: true, clone: () => ({ text: async () => JSON.stringify(data) }) });
      await setImmediate();
    }
  };
}

test("scans hydrated initial route data and rejects closed directions", () => {
  const h = harness();
  assert.equal(h.scan().snapshot.points.length, 14877);
  h.cards[0].visible = false;
  assert.equal(h.scan().error.code, "NO_ACTIVE_ROUTE");
});

test("selects the active link card among alternative buttons", () => {
  const h = harness();
  h.cards.push({ index: "1", role: "button", visible: true });
  assert.equal(h.scan().ok, true);
  h.cards[0].role = "button";
  h.cards[1].role = "link";
  assert.equal(h.scan().error.code, "AMBIGUOUS_GOOGLE_ROUTE");
});

test("captures fetch recalculations, blocks stale exports, and ignores late responses", async () => {
  const h = harness();
  const first = h.window.fetch("/maps/preview/directions?first");
  assert.equal(h.scan().error.code, "GOOGLE_MAPS_NOT_READY");
  const second = h.window.fetch(new URL("https://www.google.pl/maps/preview/directions?second"));
  await h.resolve(1);
  assert.equal(h.scan().ok, true);
  await h.resolve(0, [null]);
  assert.equal(h.scan().ok, true);
  await Promise.all([first, second]);
});

test("failed directions do not fall back to the old initial route", async () => {
  const h = harness();
  const pending = h.window.fetch("/maps/preview/directions?failed");
  h.requests[0].reject(new Error("offline"));
  await assert.rejects(pending, /offline/);
  await setImmediate();
  assert.equal(h.scan().error.code, "GOOGLE_MAPS_NOT_READY");
});

test("ignores unrelated requests and forwards their arguments unchanged", async () => {
  const h = harness();
  const options = { method: "GET" };
  const pending = h.window.fetch("https://unrelated.example/maps/preview/directions", options);
  assert.equal(h.scan().ok, true);
  assert.equal(h.requests[0].args[1], options);
  await h.resolve(0, [null]);
  await pending;
  assert.equal(h.scan().ok, true);
});

test("captures XHR directions and blocks failed or malformed recalculations", () => {
  const h = harness();
  const xhr = new h.FakeXHR();
  assert.equal(xhr.open("GET", "/maps/preview/directions"), "opened");
  assert.equal(xhr.send(), "sent");
  assert.equal(h.scan().error.code, "GOOGLE_MAPS_NOT_READY");
  xhr.finish(JSON.stringify(fixture));
  assert.equal(h.scan().ok, true);
  xhr.send();
  xhr.finish("broken");
  assert.equal(h.scan().error.code, "GOOGLE_MAPS_NOT_READY");
  xhr.send();
  xhr.finish(JSON.stringify(fixture), 500);
  assert.equal(h.scan().error.code, "GOOGLE_MAPS_NOT_READY");
});
