"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { filenameForSnapshot, serialize, toGpx } = require("../extension/export-core.js");

const snapshot = {
  points: [
    { lat: 54.1, lng: 19.2 },
    { lat: 53.9, lng: 18.4, alt: 12.5 }
  ],
  distanceMeters: 557123.7,
  sourceUrl: "https://app.hogs.live/map?a=1&b=2",
  capturedAt: "2026-07-26T12:34:56.000Z",
  selectedStyle: { strokeColor: "#2d55e1", lineWidth: 8, detectionMethod: "color-outlier" }
};

function trackSection(gpx) {
  return gpx.slice(gpx.indexOf("<trk>"), gpx.indexOf("</trk>") + 6);
}

test("creates a GPX 1.1 document with waypoints and one continuous track", () => {
  const gpx = toGpx(snapshot);
  assert.match(gpx, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(gpx, /<gpx version="1\.1" creator="Route Exporter" xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/);
  assert.equal((gpx.match(/<wpt /g) || []).length, 2);
  assert.equal((gpx.match(/<rtept /g) || []).length, 0);
  assert.doesNotMatch(gpx, /<rte>/);
  assert.equal((gpx.match(/<trkseg>/g) || []).length, 1);
  assert.equal((gpx.match(/<trkpt /g) || []).length, 2);
  assert.match(gpx, /2026-07-26T12:34:56\.000Z/);
  assert.ok(gpx.indexOf("<metadata>") < gpx.indexOf("<wpt "));
  assert.ok(gpx.indexOf("<wpt ") < gpx.indexOf("<trk>"));
});

test("adds every ordered route stop to waypoints and the dense track", () => {
  const multipoint = {
    ...snapshot,
    points: [
      { lat: 54, lng: 19 },
      { lat: 53, lng: 18 },
      { lat: 52, lng: 17 },
      { lat: 51, lng: 16 }
    ],
    stops: [
      { lat: 54, lng: 19 },
      { lat: 52, lng: 17, alt: 42 },
      { lat: 51, lng: 16 }
    ]
  };

  const gpx = toGpx(multipoint);
  const track = trackSection(gpx);
  assert.equal((gpx.match(/<wpt /g) || []).length, 3);
  assert.equal((gpx.match(/<rtept /g) || []).length, 0);
  assert.equal((track.match(/<trkpt /g) || []).length, 4);
  assert.match(gpx, /<wpt lat="52" lon="17">\s*<ele>42<\/ele>\s*<name>B<\/name>\s*<desc>Route stop B<\/desc>/);
  assert.match(track, /<trkpt lat="52" lon="17">\s*<ele>42<\/ele>\s*<name>B<\/name>\s*<desc>Route stop B<\/desc>\s*<type>Route stop<\/type>/);
  assert.ok(track.indexOf("<name>A</name>") < track.indexOf("<name>B</name>"));
  assert.ok(track.indexOf("<name>B</name>") < track.indexOf("<name>C</name>"));
});

test("inserts an exact intermediate stop when sparse geometry has no matching vertex", () => {
  const gpx = toGpx({
    ...snapshot,
    points: [
      { lat: 54, lng: 19 },
      { lat: 51, lng: 16 }
    ],
    stops: [
      { lat: 54, lng: 19 },
      { lat: 52.5160338, lng: 13.3769964 },
      { lat: 51, lng: 16 }
    ]
  });
  const track = trackSection(gpx);

  assert.equal((track.match(/<trkpt /g) || []).length, 3);
  assert.match(track, /<trkpt lat="52\.5160338" lon="13\.3769964">\s*<name>B<\/name>/);
  assert.ok(track.indexOf("<name>A</name>") < track.indexOf("<name>B</name>"));
  assert.ok(track.indexOf("<name>B</name>") < track.indexOf("<name>C</name>"));
});

test("uses the first matching occurrence of an intermediate stop on looping geometry", () => {
  const gpx = toGpx({
    ...snapshot,
    points: [
      { lat: 54, lng: 19 },
      { lat: 53, lng: 18 },
      { lat: 52.5, lng: 17.5 },
      { lat: 53, lng: 18 },
      { lat: 51, lng: 16 }
    ],
    stops: [
      { lat: 54, lng: 19 },
      { lat: 53, lng: 18 },
      { lat: 51, lng: 16 }
    ]
  });
  const track = trackSection(gpx);

  assert.ok(track.indexOf("<name>B</name>") < track.indexOf('lat="52.5" lon="17.5"'));
  assert.equal((track.match(/<name>B<\/name>/g) || []).length, 1);
});

test("labels GPX stops after Z as AA in waypoints and the track", () => {
  const stops = Array.from({ length: 27 }, (_value, index) => ({
    lat: 40 + index / 100,
    lng: 10 + index / 100
  }));
  const gpx = toGpx({ ...snapshot, stops });

  assert.equal((gpx.match(/<wpt /g) || []).length, 27);
  assert.equal((gpx.match(/<rtept /g) || []).length, 0);
  assert.equal((gpx.match(/<name>AA<\/name>/g) || []).length, 2);
});

test("exposes GPX as the only export format", () => {
  const output = serialize(snapshot);
  assert.equal(output.mimeType, "application/gpx+xml;charset=utf-8");
  assert.match(output.content, /<gpx version="1\.1"/);
  assert.throws(() => serialize({ points: [] }), /at least two coordinates/);

  const popup = fs.readFileSync(path.join(__dirname, "../extension/popup.html"), "utf8");
  const popupScript = fs.readFileSync(path.join(__dirname, "../extension/popup.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../extension/manifest.json"), "utf8"));
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.match(popup, /id="download-gpx"/);
  assert.match(popup, /<title>Route Exporter<\/title>/);
  assert.match(popup, /<h1>Route Exporter<\/h1>/);
  assert.doesNotMatch(popup, /CSV|GeoJSON|data-format/);
  assert.equal(manifest.name, "Route Exporter");
  assert.equal(manifest.action.default_title, "Route Exporter");
  assert.deepEqual(manifest.host_permissions, [
    "https://app.hogs.live/*",
    "https://apps.impargo.de/*",
    "https://live-wf.webfleet.com/*",
    "https://www.google.com/maps/*",
    "https://www.google.pl/maps/*"
  ]);
  assert.ok(manifest.content_scripts.some(({ matches, world }) =>
    world === "MAIN" && matches.includes("https://live-wf.webfleet.com/*")
  ));
  assert.ok(manifest.content_scripts.some(({ matches, world }) =>
    world === "ISOLATED" && matches.includes("https://live-wf.webfleet.com/*")
  ));
  assert.match(popupScript, /https:\/\/apps\.impargo\.de\//);
  assert.match(popupScript, /https:\/\/live-wf\.webfleet\.com\//);
  for (const origin of ["https://www.google.com/maps/*", "https://www.google.pl/maps/*"]) {
    assert.ok(manifest.content_scripts.some(({ matches, world, js }) =>
      world === "MAIN" && matches.includes(origin) && js.includes("google-maps-page-bridge.js")
    ));
    assert.ok(manifest.content_scripts.some(({ matches, world }) =>
      world === "ISOLATED" && matches.includes(origin)
    ));
  }
  assert.match(manifest.description, /Google Maps/);
  assert.equal(manifest.version, "1.0.0");
  assert.equal(packageMetadata.version, manifest.version);
  assert.doesNotMatch(manifest.description, /CSV|GeoJSON/);
  assert.equal(packageMetadata.name, "route-exporter");
});

test("uses the Webfleet route name as the GPX filename and track name", () => {
  const namedSnapshot = { ...snapshot, routeName: "Route & 42" };
  assert.equal(filenameForSnapshot(namedSnapshot), "Route & 42.gpx");
  assert.equal(filenameForSnapshot({ ...snapshot, routeName: "already.GPX" }), "already.GPX");
  assert.equal(
    filenameForSnapshot(snapshot, new Date(2026, 8, 30, 9, 8, 7)),
    "route-20260930-090807.gpx"
  );
  assert.match(toGpx(namedSnapshot), /<name>Route &amp; 42<\/name>/);
});

test("captures routes stored in custom HERE object-layer groups", () => {
  const bridge = fs.readFileSync(path.join(__dirname, "../extension/page-bridge.js"), "utf8");
  assert.match(bridge, /function trackRouteMutation[\s\S]*registerMap\(this\)/);
});

test("captures Webfleet Leaflet maps and selected route names", () => {
  const bridge = fs.readFileSync(path.join(__dirname, "../extension/page-bridge.js"), "utf8");
  assert.match(bridge, /function patchLeaflet\(\)/);
  assert.match(bridge, /\[data-testid="route-action-export-button"\]/);
  assert.match(bridge, /window\.WebfleetRouteCore\.findActiveRoute/);
});
