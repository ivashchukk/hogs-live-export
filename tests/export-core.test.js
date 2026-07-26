"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { serialize, toGpx } = require("../extension/export-core.js");

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
  assert.match(gpx, /<gpx version="1\.1" creator="HOGS Route Exporter" xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1"/);
  assert.equal((gpx.match(/<wpt /g) || []).length, 2);
  assert.equal((gpx.match(/<rtept /g) || []).length, 0);
  assert.doesNotMatch(gpx, /<rte>/);
  assert.equal((gpx.match(/<trkseg>/g) || []).length, 1);
  assert.equal((gpx.match(/<trkpt /g) || []).length, 2);
  assert.match(gpx, /2026-07-26T12:34:56\.000Z/);
  assert.ok(gpx.indexOf("<metadata>") < gpx.indexOf("<wpt "));
  assert.ok(gpx.indexOf("<wpt ") < gpx.indexOf("<trk>"));
});

test("adds every ordered HOGS stop to waypoints and the dense track", () => {
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
  assert.match(gpx, /<wpt lat="52" lon="17">\s*<ele>42<\/ele>\s*<name>B<\/name>\s*<desc>HOGS stop B<\/desc>/);
  assert.match(track, /<trkpt lat="52" lon="17">\s*<ele>42<\/ele>\s*<name>B<\/name>\s*<desc>HOGS stop B<\/desc>\s*<type>HOGS stop<\/type>/);
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
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../extension/manifest.json"), "utf8"));
  const packageMetadata = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  assert.match(popup, /id="download-gpx"/);
  assert.match(popup, /<title>HOGS Route Exporter<\/title>/);
  assert.match(popup, /<h1>HOGS Route Exporter<\/h1>/);
  assert.doesNotMatch(popup, /CSV|GeoJSON|data-format/);
  assert.equal(manifest.name, "HOGS Route Exporter");
  assert.equal(manifest.action.default_title, "HOGS Route Exporter");
  assert.doesNotMatch(manifest.description, /CSV|GeoJSON/);
  assert.equal(packageMetadata.name, "hogs-route-exporter");
});
