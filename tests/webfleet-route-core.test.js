"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RouteExportError,
  findActiveRoute,
  flattenLatLngs
} = require("../extension/webfleet-route-core.js");

class FakeMap {
  constructor(layers) {
    this.layers = layers;
  }

  eachLayer(callback) {
    this.layers.forEach(callback);
  }
}

class FakePolyline {
  constructor(latLngs, className = "t3sel-map-my-route-trace t3sel-polyline t3sel-polyline-inner") {
    this.latLngs = latLngs;
    this.options = { className, color: "#00a2bd", weight: 7 };
  }

  getLatLngs() {
    return this.latLngs;
  }
}

class FakeMarker {
  constructor(point, kind) {
    this.point = point;
    this.kind = kind;
    this.options = { icon: { options: { className: "t3sel-routing-marker-icon" } } };
  }

  getLatLng() {
    return this.point;
  }

  getElement() {
    return {
      querySelector: (selector) => selector === `.t3sel-${this.kind}-position-icon` ? {} : null
    };
  }
}

test("extracts and orients a selected multipoint Webfleet route", () => {
  const start = { lat: 50, lng: 10 };
  const firstStop = { lat: 51, lng: 11 };
  const secondStop = { lat: 52, lng: 12 };
  const end = { lat: 53, lng: 13 };
  const selected = new FakePolyline([[
    end,
    secondStop,
    firstStop,
    start
  ]]);
  const unrelated = new FakePolyline([
    { lat: 40, lng: 1 },
    { lat: 41, lng: 2 },
    { lat: 42, lng: 3 },
    { lat: 43, lng: 4 },
    { lat: 44, lng: 5 }
  ], "vehicle-track");
  const map = new FakeMap([
    unrelated,
    selected,
    new FakeMarker(end, "end"),
    new FakeMarker(firstStop, "base"),
    new FakeMarker(start, "start"),
    new FakeMarker(secondStop, "base")
  ]);

  const snapshot = findActiveRoute([map], {
    routeName: "Morning run",
    sourceUrl: "https://live-wf.webfleet.com/web/map",
    capturedAt: "2026-09-30T12:00:00.000Z"
  });

  assert.equal(snapshot.provider, "webfleet");
  assert.equal(snapshot.routeName, "Morning run");
  assert.deepEqual(snapshot.points, [start, firstStop, secondStop, end]);
  assert.deepEqual(snapshot.stops, [start, firstStop, secondStop, end]);
  assert.equal(snapshot.orderMethod, "webfleet-markers");
  assert.equal(snapshot.selectedStyle.detectionMethod, "webfleet-route-layer");
  assert.ok(snapshot.distanceMeters > 300_000);
});

test("flattens nested Leaflet geometry and falls back to route endpoints", () => {
  assert.deepEqual(flattenLatLngs([[
    { lat: 54, lng: 18 },
    [{ lat: 53, lng: 17, alt: 5 }]
  ]]), [
    { lat: 54, lng: 18 },
    { lat: 53, lng: 17, alt: 5 }
  ]);

  const snapshot = findActiveRoute([new FakeMap([
    new FakePolyline([
      { lat: 54, lng: 18 },
      { lat: 54, lng: 18 },
      { lat: 53, lng: 17 }
    ])
  ])]);

  assert.deepEqual(snapshot.points, [
    { lat: 54, lng: 18 },
    { lat: 53, lng: 17 }
  ]);
  assert.deepEqual(snapshot.stops, snapshot.points);
  assert.equal(snapshot.orderMethod, "geometry-fallback");
});

test("route name participates in refresh signatures", () => {
  const map = new FakeMap([new FakePolyline([
    { lat: 54, lng: 18 },
    { lat: 53, lng: 17 }
  ])]);

  const first = findActiveRoute([map], { routeName: "First" });
  const second = findActiveRoute([map], { routeName: "Second" });
  assert.notEqual(first.routeSignature, second.routeSignature);
});

test("reports missing maps and routes explicitly", () => {
  assert.throws(
    () => findActiveRoute([]),
    (error) => error instanceof RouteExportError && error.code === "MAP_NOT_FOUND"
  );
  assert.throws(
    () => findActiveRoute([new FakeMap([])]),
    (error) => error instanceof RouteExportError && error.code === "NO_ACTIVE_ROUTE"
  );
});
