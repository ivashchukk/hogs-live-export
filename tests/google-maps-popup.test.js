"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function harness() {
  const elements = new Map();
  let refresh;
  let response;
  let downloaded;
  let scans = 0;
  const document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          style: {}, handlers: {}, attributes: {},
          setAttribute(name, value) { this.attributes[name] = value; },
          addEventListener(name, fn) { this.handlers[name] = fn; }
        });
      }
      return elements.get(id);
    },
    createElement() { return { click() {} }; }
  };
  const window = {
    HereRouteRefresh: { createRefreshController(options) { refresh = options; return { start() {} }; } },
    HereRouteExporters: {
      serialize(snapshot) { downloaded = snapshot; return { content: "gpx", mimeType: "application/gpx+xml" }; },
      filenameForSnapshot() { return "test.gpx"; }
    },
    addEventListener() {}, setTimeout() {}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../extension/popup.js"), "utf8"), {
    document, window, Blob,
    URL: { createObjectURL: () => "blob:test" },
    chrome: {
      runtime: { onMessage: { addListener() {} } },
      tabs: {
        query: async () => [{ id: 1, url: "https://www.google.pl/maps/dir/test" }],
        sendMessage: async () => { scans += 1; return response; }
      }
    }
  });
  const snapshot = (signature) => ({
    provider: "google-maps", routeSignature: signature, distanceMeters: 100,
    points: [{ lat: 50, lng: 19 }, { lat: 51, lng: 20 }]
  });
  return {
    elements, snapshot,
    get scans() { return scans; },
    get downloaded() { return downloaded; },
    setResponse(value) { response = value; },
    async refresh(reason = "manual") { refresh.onResult(await refresh.scan(), reason); },
    download() { return elements.get("download-gpx").handlers.click(); }
  };
}

test("rechecks Google Maps selection at download time and exports the current route", async () => {
  const h = harness();
  h.setResponse({ ok: true, snapshot: h.snapshot("old") });
  await h.refresh();
  h.setResponse({ ok: true, snapshot: h.snapshot("new") });
  await h.download();
  assert.equal(h.scans, 2);
  assert.equal(h.downloaded.routeSignature, "new");
});

test("clears the previous Google Maps route on fallback or download failure", async () => {
  for (const action of ["fallback", "download"]) {
    const h = harness();
    h.setResponse({ ok: true, snapshot: h.snapshot("old") });
    await h.refresh();
    h.setResponse({ ok: false, error: { code: "GOOGLE_MAPS_NOT_READY" } });
    if (action === "download") {
      await h.download();
    } else {
      await h.refresh("fallback");
    }
    assert.equal(h.downloaded, undefined);
    assert.equal(h.elements.get("download-gpx").disabled, true);
    assert.equal(h.elements.get("route-details").hidden, true);
    assert.equal(h.elements.get("empty-state").hidden, false);
  }
});

test("shows route labels, ordered stop count, and a preview from the actual coordinates", async () => {
  const h = harness();
  const snapshot = {
    ...h.snapshot("route"),
    routeName: "Nyíregyháza to Kraków",
    stops: [{ lat: 50, lng: 19 }, { lat: 50.5, lng: 19.5 }, { lat: 51, lng: 20 }]
  };
  h.setResponse({ ok: true, snapshot });
  await h.refresh();
  assert.equal(h.elements.get("route-provider").textContent, "Google Maps");
  assert.equal(h.elements.get("route-origin-name").textContent, "Nyíregyháza");
  assert.equal(h.elements.get("route-destination-name").textContent, "Kraków");
  assert.equal(h.elements.get("stop-count").textContent, "3");
  assert.equal(h.elements.get("empty-state").hidden, true);
  const path = h.elements.get("route-preview-track").attributes.points;
  assert.equal(path, h.elements.get("route-preview-halo").attributes.points);
  const [first, last] = path.split(" ").map((point) => point.split(",").map(Number));
  assert.ok(first[0] < last[0]);
  assert.ok(first[1] > last[1]);
});

test("fits dense, dateline-crossing, and coincident geometry without changing export coordinates", async () => {
  for (const points of [
    [{ lat: 0, lng: 179.9 }, { lat: 0, lng: -179.9 }],
    [{ lat: 50, lng: 19 }, { lat: 50, lng: 19 }],
    Array.from({ length: 150000 }, (_value, i) => ({ lat: 50 + i / 100000, lng: 19 + i / 100000 }))
  ]) {
    const h = harness();
    const snapshot = { ...h.snapshot("preview"), points };
    h.setResponse({ ok: true, snapshot });
    await h.refresh();
    const positions = h.elements.get("route-preview-track").attributes.points.split(" ").map((point) => point.split(",").map(Number));
    assert.ok(positions.length <= 501);
    assert.ok(positions.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y) && x >= 24 && x <= 304 && y >= 24 && y <= 84));
    assert.equal(snapshot.points, points);
    assert.equal(h.elements.get("point-count").textContent, points.length.toLocaleString());
  }
});
