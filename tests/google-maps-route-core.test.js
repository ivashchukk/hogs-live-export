"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fixture = require("./fixtures/google-maps-multipoint.json");
const alternatives = require("./fixtures/google-maps-alternatives.json");
const { decodeGeometry, findActiveRoute, initialResponse } = require("../extension/google-maps-route-core.js");
const { serialize } = require("../extension/export-core.js");

test("exports the supplied Nyíregyháza–Tornyospálca–Kraków route with its dragged via point", () => {
  const snapshot = findActiveRoute(")]}'\n" + JSON.stringify(fixture), {
    sourceUrl: "https://www.google.pl/maps/dir/",
    capturedAt: "2026-10-20T12:00:00.000Z"
  });
  assert.equal(snapshot.provider, "google-maps");
  assert.equal(snapshot.points.length, 14877);
  assert.ok(Math.abs(snapshot.distanceMeters - 519241) < 1);
  assert.deepEqual(snapshot.points[0], { lat: 47.9460717, lng: 21.6904177 });
  assert.deepEqual(snapshot.points.at(-1), { lat: 50.0646336, lng: 19.9449695 });
  assert.deepEqual(snapshot.stops.map(({ lat, lng }) => [Number(lat.toFixed(7)), lng]), [
    [47.9459318, 21.6909281],
    [48.2661885, 22.1725061],
    [49.1020293, 19.3117241],
    [50.0646501, 19.9449799]
  ]);
  const gpx = serialize(snapshot).content;
  assert.equal((gpx.match(/<wpt /g) || []).length, 4);
  assert.equal((gpx.match(/<trkpt /g) || []).length, 14877);
  assert.doesNotMatch(gpx, /<rte>/);
  assert.match(gpx, /<name>4400, Nyíregyháza, Hungary to Kraków, Poland<\/name>/);
});

test("reads both the initial and hydrated Google Maps state", () => {
  const raw = [null, null, null, "request", ")]}'\n" + JSON.stringify(fixture)];
  assert.equal(initialResponse([null, null, null, raw]), raw[4]);
  assert.equal(initialResponse([null, null, null, { renamedInternalField: raw }]), raw[4]);
  assert.equal(initialResponse(undefined), undefined);
});

test("exports only the explicitly selected alternative and updates its signature", () => {
  assert.throws(() => findActiveRoute(alternatives), { code: "AMBIGUOUS_GOOGLE_ROUTE" });
  assert.throws(() => findActiveRoute(alternatives, { routeIndex: 3 }), { code: "AMBIGUOUS_GOOGLE_ROUTE" });
  const snapshots = [0, 1, 2].map((routeIndex) => findActiveRoute(alternatives, { routeIndex }));
  assert.deepEqual(snapshots.map((snapshot) => snapshot.points.length), [2203, 2213, 2578]);
  [35111, 35425, 39553].forEach((distance, index) => {
    assert.ok(Math.abs(snapshots[index].distanceMeters - distance) < 3);
    assert.equal(snapshots[index].stops.length, 2);
  });
  assert.equal(new Set(snapshots.map((snapshot) => snapshot.routeSignature)).size, 3);
});

test("accepts road travel modes and rejects transit directions", () => {
  const data = structuredClone(fixture);
  for (const mode of [0, 1, 2]) {
    data[0][1][0][0][0] = mode;
    assert.equal(findActiveRoute(data).provider, "google-maps");
  }
  data[0][1][0][0][0] = 3;
  assert.throws(() => findActiveRoute(data), { code: "UNSUPPORTED_GOOGLE_MODE" });
});

test("rejects missing, malformed, or changed directions instead of guessing geometry", () => {
  assert.throws(() => findActiveRoute(null), { code: "NO_ACTIVE_ROUTE" });
  assert.throws(() => findActiveRoute("broken json"), { code: "GOOGLE_MAPS_FORMAT_CHANGED" });
  for (const geometry of [null, [[1, 2], [3]], [[1, "2"], [3, 4]], [[910000000, 1], [0, 1]]]) {
    assert.throws(() => decodeGeometry(geometry), { code: "GOOGLE_MAPS_FORMAT_CHANGED" });
  }
  const data = structuredClone(fixture);
  data[0][0][1][0][0][2][2] = null;
  assert.throws(() => findActiveRoute(data), { code: "GOOGLE_MAPS_FORMAT_CHANGED" });
});

test("decodes negative and zero deltas and removes repeated coordinates", () => {
  assert.deepEqual(decodeGeometry([[500000000, 0, -10000000], [200000000, 0, -20000000]]), [
    { lat: 50, lng: 20 }, { lat: 49, lng: 18 }
  ]);
});
