"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  RouteExportError,
  calculateDistance,
  findActiveRoute,
  geometryToSegments,
  normalizeStrokeColor
} = require("../extension/route-core.js");

class FakePolyline {
  constructor(geometry, options = {}) {
    this.geometry = geometry;
    this.style = options.style || { lineWidth: 8, strokeColor: "#2d55e1" };
    this.visible = options.visible !== false;
    this.data = options.data || null;
    this.zIndex = options.zIndex || 0;
    this.parent = options.parent || null;
  }

  toGeoJSON() {
    return { type: "Feature", properties: null, geometry: this.geometry };
  }

  getGeometry() {
    return this.geometry;
  }

  getStyle() {
    return this.style;
  }

  setStyle(style) {
    this.style = style;
  }

  getVisibility() {
    return this.visible;
  }

  getData() {
    return this.data;
  }

  getZIndex() {
    return this.zIndex;
  }

  getParentGroup() {
    return this.parent;
  }
}

class FakeMap {
  constructor(objects, area = 1000) {
    this.objects = objects;
    this.area = area;
  }

  getObjects(recursive) {
    assert.equal(recursive, true);
    return this.objects;
  }

  getElement() {
    return {
      getBoundingClientRect: () => ({ width: this.area, height: 1 })
    };
  }
}

class FakeMarkerGroup {
  constructor() {
    this.objects = [];
  }

  getObjects() {
    return this.objects;
  }
}

class FakeMarker {
  constructor(point, parent) {
    this.point = point;
    this.parent = parent;
    this.visible = true;
  }

  getGeometry() {
    return this.point;
  }

  getParentGroup() {
    return this.parent;
  }

  getVisibility() {
    return this.visible;
  }
}

class FakeDomMarker {
  constructor(point, parent) {
    this.point = point;
    this.parent = parent;
    this.visible = true;
  }

  getGeometry() {
    return this.point;
  }

  getParentGroup() {
    return this.parent;
  }

  getVisibility() {
    return this.visible;
  }
}

const H = { map: { DomMarker: FakeDomMarker, Marker: FakeMarker, Polyline: FakePolyline } };

function line(points) {
  return { type: "LineString", coordinates: points };
}

test("converts GeoJSON LineString and MultiLineString coordinates", () => {
  assert.deepEqual(geometryToSegments(line([[18, 54], [19, 53, 12]])), [[
    { lat: 54, lng: 18 },
    { lat: 53, lng: 19, alt: 12 }
  ]]);

  assert.equal(geometryToSegments({
    type: "MultiLineString",
    coordinates: [
      [[18, 54], [19, 53]],
      [[19, 53], [20, 52]]
    ]
  }).length, 2);
});

test("normalizes equivalent HERE stroke-color formats", () => {
  const hex = normalizeStrokeColor("#2D55E1");
  const shortHex = normalizeStrokeColor("#abc");
  const rgb = normalizeStrokeColor("rgb(45, 85, 225)");
  const rgba = normalizeStrokeColor("rgba(45,85,225,1)");

  assert.equal(hex.key, rgb.key);
  assert.equal(rgb.key, rgba.key);
  assert.equal(hex.display, "#2d55e1");
  assert.equal(shortHex.display, "#aabbcc");
});

test("exports only the distinct-color route when alternatives share endpoints", () => {
  const start = [18, 54];
  const end = [14, 52];
  const gray = { lineWidth: 8, strokeColor: "rgba(120, 120, 120, 0.55)" };
  const blue = { lineWidth: 8, strokeColor: "rgb(45, 85, 225)" };
  const objects = [
    new FakePolyline(line([start, [17.2, 53.1], end]), { style: gray }),
    new FakePolyline(line([start, [16.8, 53.5], end]), { style: gray }),
    new FakePolyline(line([start, [16.2, 52.8], end]), { style: gray }),
    new FakePolyline(line([start, [15.7, 53.2], end]), { style: gray }),
    new FakePolyline(line([start, [16, 53], end]), { style: blue })
  ];

  const snapshot = findActiveRoute([new FakeMap(objects)], H);

  assert.deepEqual(snapshot.points, [
    { lat: 54, lng: 18 },
    { lat: 53, lng: 16 },
    { lat: 52, lng: 14 }
  ]);
  assert.equal(snapshot.selectedStyle.strokeColor, "#2d55e1");
  assert.equal(snapshot.selectedStyle.detectionMethod, "color-outlier");
});

test("joins only same-color sections of the selected route", () => {
  const blue = { lineWidth: 8, strokeColor: "#2d55e1" };
  const gray = { lineWidth: 8, strokeColor: "#777777" };
  const routeLayer = {};
  const objects = [
    new FakePolyline(line([[18, 54], [17, 53]]), { style: blue, parent: routeLayer }),
    new FakePolyline(line([[17, 53], [16, 52]]), { style: blue, parent: routeLayer }),
    new FakePolyline(line([[18, 54], [17.5, 52.5], [16, 52]]), { style: gray, parent: routeLayer }),
    new FakePolyline(line([[18, 54], [16.5, 53.5], [16, 52]]), { style: gray, parent: routeLayer })
  ];

  const snapshot = findActiveRoute([new FakeMap(objects)], H);
  assert.deepEqual(snapshot.points, [
    { lat: 54, lng: 18 },
    { lat: 53, lng: 17 },
    { lat: 52, lng: 16 }
  ]);
});

test("follows the route that receives the distinct selected color", () => {
  const firstRoute = line([[18, 54], [17, 53], [16, 52]]);
  const secondRoute = line([[18, 54], [16.5, 53], [16, 52]]);
  const activeStyle = { lineWidth: 8, strokeColor: "#2d55e1" };
  const inactiveStyle = { lineWidth: 8, strokeColor: "#888888" };

  const firstSelected = findActiveRoute([new FakeMap([
    new FakePolyline(firstRoute, { style: activeStyle }),
    new FakePolyline(secondRoute, { style: inactiveStyle })
  ])], H);
  const secondSelected = findActiveRoute([new FakeMap([
    new FakePolyline(firstRoute, { style: inactiveStyle }),
    new FakePolyline(secondRoute, { style: activeStyle })
  ])], H);

  assert.equal(firstSelected.points[1].lng, 17);
  assert.equal(secondSelected.points[1].lng, 16.5);
});

test("rereads styles from the same live map after the selected route changes", () => {
  const activeStyle = { lineWidth: 8, strokeColor: "#2d55e1" };
  const inactiveStyle = { lineWidth: 8, strokeColor: "#888888" };
  const first = new FakePolyline(line([[18, 54], [17, 53], [16, 52]]), { style: activeStyle });
  const second = new FakePolyline(line([[18, 54], [16.5, 53], [16, 52]]), { style: inactiveStyle });
  const map = new FakeMap([first, second]);

  const before = findActiveRoute([map], H);
  first.setStyle(inactiveStyle);
  second.setStyle(activeStyle);
  const after = findActiveRoute([map], H);

  assert.equal(before.points[1].lng, 17);
  assert.equal(after.points[1].lng, 16.5);
  assert.notEqual(before.routeSignature, after.routeSignature);
});

test("fails safely instead of merging same-color alternatives", () => {
  const style = { lineWidth: 8, strokeColor: "#777777" };
  const alternatives = [
    new FakePolyline(line([[18, 54], [17, 53], [16, 52]]), { style }),
    new FakePolyline(line([[18, 54], [16.5, 53], [16, 52]]), { style })
  ];

  assert.throws(
    () => findActiveRoute([new FakeMap(alternatives)], H),
    (error) => error instanceof RouteExportError && error.code === "AMBIGUOUS_ROUTE_STYLE"
  );
});

test("finds the visible thick active route and ignores a longer hidden alternative", () => {
  const active = new FakePolyline(line([[19, 54], [18, 53], [17, 52]]));
  const hidden = new FakePolyline(line([[30, 60], [10, 40]]), { visible: false });
  const thinOverlay = new FakePolyline(line([[1, 1], [20, 20]]), { style: { lineWidth: 1 } });
  const snapshot = findActiveRoute([new FakeMap([hidden, thinOverlay, active])], H, {
    sourceUrl: "https://app.hogs.live/map",
    capturedAt: "2026-07-26T00:00:00.000Z"
  });

  assert.deepEqual(snapshot.points, [
    { lat: 54, lng: 19 },
    { lat: 53, lng: 18 },
    { lat: 52, lng: 17 }
  ]);
  assert.equal(snapshot.sourceUrl, "https://app.hogs.live/map");
});

test("joins route sections, reverses an adjoining section, and removes its duplicate boundary", () => {
  const routeLayer = {};
  const first = new FakePolyline(line([[18, 54], [18.1, 54.1]]), { parent: routeLayer });
  const secondReversed = new FakePolyline(line([[18.2, 54.2], [18.1, 54.1]]), { parent: routeLayer });
  const snapshot = findActiveRoute([new FakeMap([first, secondReversed])], H);

  assert.deepEqual(snapshot.points, [
    { lat: 54, lng: 18 },
    { lat: 54.1, lng: 18.1 },
    { lat: 54.2, lng: 18.2 }
  ]);
  assert.equal(snapshot.orderMethod, "geometry-fallback");
});

test("deduplicates a shadow polyline with identical geometry", () => {
  const geometry = line([[18, 54], [18.1, 54.1], [18.2, 54.2]]);
  const snapshot = findActiveRoute([
    new FakeMap([
      new FakePolyline(geometry, { style: { lineWidth: 10 } }),
      new FakePolyline(geometry, { style: { lineWidth: 6 } })
    ])
  ], H);

  assert.equal(snapshot.points.length, 3);
});

test("ignores a short uniquely-colored overlay before selecting a full route", () => {
  const start = [19.05, 54.04];
  const end = [13.42, 52.51];
  const routes = [
    [start, [17.8, 53.8], [15.7, 53.2], end],
    [start, [18.1, 53.4], [16.2, 52.9], end],
    [start, [17.5, 53.5], [15.4, 52.7], end],
    [start, [18.3, 53.2], [16.7, 52.5], end],
    [start, [17.9, 53.0], [15.8, 52.4], end]
  ];
  const inactive = { lineWidth: 8, strokeColor: "rgba(140, 140, 140, 0.55)" };
  const active = { lineWidth: 8, strokeColor: "rgb(126, 160, 255)" };
  const overlay = { lineWidth: 8, strokeColor: "rgba(255, 116, 63, 0.4)" };

  for (let selectedIndex = 0; selectedIndex < routes.length; selectedIndex += 1) {
    const objects = routes.map((coordinates, index) => new FakePolyline(line(coordinates), {
      style: index === selectedIndex ? active : inactive
    }));
    objects.push(new FakePolyline(line([
      [13.41768, 52.51382],
      [13.41647, 52.51103]
    ]), { style: overlay }));

    const snapshot = findActiveRoute([new FakeMap(objects)], H);
    assert.deepEqual(snapshot.points, routes[selectedIndex].map(([lng, lat]) => ({ lat, lng })));
    assert.ok(snapshot.distanceMeters > 350_000);
    assert.equal(snapshot.selectedStyle.strokeColor, "#7ea0ff");
  }
});

test("keeps scale filtering relative so a legitimate short route beats a tiny overlay", () => {
  const route = line([[13.4, 52.5], [13.48, 52.54], [13.56, 52.56]]);
  const overlay = line([[13.44, 52.52], [13.445, 52.522]]);
  const snapshot = findActiveRoute([new FakeMap([
    new FakePolyline(route, { style: { lineWidth: 8, strokeColor: "#2d55e1" } }),
    new FakePolyline(overlay, { style: { lineWidth: 8, strokeColor: "#ff743f" } })
  ])], H);

  assert.equal(snapshot.points.length, 3);
  assert.ok(snapshot.distanceMeters > 10_000);
  assert.equal(snapshot.selectedStyle.detectionMethod, "single-full-route");
});

test("prefers the multi-alternative endpoint family over an unrelated long line", () => {
  const start = [18, 54];
  const end = [14, 52];
  const gray = { lineWidth: 8, strokeColor: "#888888" };
  const blue = { lineWidth: 8, strokeColor: "#2d55e1" };
  const objects = [
    new FakePolyline(line([start, [17, 53], end]), { style: gray }),
    new FakePolyline(line([start, [16.5, 53.5], end]), { style: gray }),
    new FakePolyline(line([start, [16, 53], end]), { style: blue }),
    new FakePolyline(line([[-5, 50], [2, 55], [10, 58]]), {
      style: { lineWidth: 8, strokeColor: "#ff743f" }
    })
  ];

  const snapshot = findActiveRoute([new FakeMap(objects)], H);
  assert.equal(snapshot.selectedStyle.strokeColor, "#2d55e1");
  assert.deepEqual(snapshot.points[0], { lat: 54, lng: 18 });
  assert.deepEqual(snapshot.points.at(-1), { lat: 52, lng: 14 });
});

test("exports every selected leg of a multipoint route in HOGS waypoint order", () => {
  const pointA = [19.04, 54.02];
  const pointB = [16.36842, 48.20263];
  const pointC = [13.377, 52.51603];
  const active = { lineWidth: 8, strokeColor: "#7392ff" };
  const inactive = { lineWidth: 8, strokeColor: "rgba(140, 140, 140, 0.55)" };
  const markerGroup = new FakeMarkerGroup();
  const markers = [pointA, pointB, pointC].map(([lng, lat]) =>
    new FakeMarker({ lat, lng }, markerGroup)
  );
  markerGroup.objects = markers;

  const objects = [
    new FakePolyline(line([pointA, [18, 51], pointB]), { style: inactive }),
    new FakePolyline(line([pointA, [17.5, 50], pointB]), { style: inactive }),
    new FakePolyline(line([pointB, [17, 51], pointA]), { style: active }),
    new FakePolyline(line([pointB, [15, 50], pointC]), { style: inactive }),
    new FakePolyline(line([pointB, [14.5, 51], pointC]), { style: inactive }),
    new FakePolyline(line([pointC, [14.2, 50.5], pointB]), { style: active }),
    ...markers
  ];

  const snapshot = findActiveRoute([new FakeMap(objects)], H);

  assert.deepEqual(snapshot.points, [
    { lat: 54.02, lng: 19.04 },
    { lat: 51, lng: 17 },
    { lat: 48.20263, lng: 16.36842 },
    { lat: 50.5, lng: 14.2 },
    { lat: 52.51603, lng: 13.377 }
  ]);
  assert.equal(snapshot.points.filter((point) => point.lat === 48.20263).length, 1);
  assert.deepEqual(snapshot.stops, [
    { lat: 54.02, lng: 19.04 },
    { lat: 48.20263, lng: 16.36842 },
    { lat: 52.51603, lng: 13.377 }
  ]);
  assert.equal(snapshot.waypointCount, 3);
  assert.equal(snapshot.orderMethod, "map-waypoints");
  assert.equal(snapshot.selectedStyle.detectionMethod, "selected-color-chain");
});

test("rejects a larger overlay marker group that does not span the active route", () => {
  const pointA = [13.377, 52.51603];
  const pointB = [18.6466, 54.352];
  const pointC = [9.1818, 45.468];
  const active = { lineWidth: 8, strokeColor: "#7392ff" };
  const inactive = { lineWidth: 8, strokeColor: "rgba(140, 140, 140, 0.55)" };
  const waypointGroup = new FakeMarkerGroup();
  const waypoints = [pointA, pointB, pointC].map(([lng, lat]) =>
    new FakeDomMarker({ lat, lng }, waypointGroup)
  );
  waypointGroup.objects = waypoints;

  const overlayGroup = new FakeMarkerGroup();
  const overlayPoints = [
    [7, 50],
    [7.1, 50.1],
    [7.2, 50.2],
    [7.3, 50.3],
    [7.4, 50.4],
    [7.5, 50.5]
  ];
  const overlayMarkers = overlayPoints.map(([lng, lat]) =>
    new FakeMarker({ lat, lng }, overlayGroup)
  );
  overlayGroup.objects = overlayMarkers;
  const overlayLines = overlayPoints.map(([lng, lat]) =>
    new FakePolyline(line([[lng, lat], [lng + 0.01, lat + 0.01]]), {
      style: { lineWidth: 8, strokeColor: "#ff743f" }
    })
  );

  const objects = [
    new FakePolyline(line([pointA, [15, 53], pointB]), { style: inactive }),
    new FakePolyline(line([pointB, [14.5, 53], pointA]), { style: active }),
    new FakePolyline(line([pointB, [14, 50], pointC]), { style: inactive }),
    new FakePolyline(line([pointC, [13, 49], pointB]), { style: active }),
    ...overlayLines,
    ...waypoints,
    ...overlayMarkers
  ];

  const snapshot = findActiveRoute([new FakeMap(objects)], H);

  assert.deepEqual(snapshot.stops, [
    { lat: 52.51603, lng: 13.377 },
    { lat: 54.352, lng: 18.6466 },
    { lat: 45.468, lng: 9.1818 }
  ]);
  assert.equal(snapshot.waypointCount, 3);
  assert.equal(snapshot.orderMethod, "map-waypoints");
});

test("prefers ordered URL waypoints over unrelated map marker groups", () => {
  const pointA = [10, 50];
  const pointB = [11, 50.5];
  const pointC = [12, 51];
  const style = { lineWidth: 8, strokeColor: "#2d55e1" };
  const overlayGroup = new FakeMarkerGroup();
  const overlayMarkers = [
    new FakeMarker({ lat: 50, lng: 10 }, overlayGroup),
    new FakeMarker({ lat: 50.25, lng: 10.5 }, overlayGroup),
    new FakeMarker({ lat: 51, lng: 12 }, overlayGroup),
    new FakeMarker({ lat: 51, lng: 12 }, overlayGroup)
  ];
  overlayGroup.objects = overlayMarkers;

  const snapshot = findActiveRoute([new FakeMap([
    new FakePolyline(line([pointC, pointB]), { style }),
    new FakePolyline(line([pointB, pointA]), { style }),
    ...overlayMarkers
  ])], H, {
    orderedWaypoints: [
      { lat: 50, lng: 10 },
      { lat: 50.5, lng: 11 },
      { lat: 51, lng: 12 }
    ]
  });

  assert.deepEqual(snapshot.stops, [
    { lat: 50, lng: 10 },
    { lat: 50.5, lng: 11 },
    { lat: 51, lng: 12 }
  ]);
  assert.equal(snapshot.orderMethod, "url-waypoints");
});

test("uses ordered URL waypoints when map markers are unavailable", () => {
  const pointA = [10, 50];
  const pointB = [11, 50.5];
  const pointC = [12, 51];
  const style = { lineWidth: 8, strokeColor: "#2d55e1" };
  const map = new FakeMap([
    new FakePolyline(line([pointC, [11.5, 50.8], pointB]), { style }),
    new FakePolyline(line([pointB, [10.5, 50.2], pointA]), { style })
  ]);

  const snapshot = findActiveRoute([map], H, {
    orderedWaypoints: [
      { lat: 50, lng: 10 },
      { lat: 50.5, lng: 11 },
      { lat: 51, lng: 12 }
    ]
  });

  assert.deepEqual(snapshot.points[0], { lat: 50, lng: 10 });
  assert.deepEqual(snapshot.points.at(-1), { lat: 51, lng: 12 });
  assert.deepEqual(snapshot.stops, [
    { lat: 50, lng: 10 },
    { lat: 50.5, lng: 11 },
    { lat: 51, lng: 12 }
  ]);
  assert.equal(snapshot.waypointCount, 3);
  assert.equal(snapshot.orderMethod, "url-waypoints");
});

test("keeps a short selected leg and excludes a disconnected same-color overlay", () => {
  const pointA = [10, 50];
  const pointB = [10.02, 50.01];
  const pointC = [17, 53];
  const style = { lineWidth: 8, strokeColor: "#2d55e1" };
  const map = new FakeMap([
    new FakePolyline(line([pointB, pointA]), { style }),
    new FakePolyline(line([pointC, [14, 51.5], pointB]), { style }),
    new FakePolyline(line([[30, 60], [30.01, 60.01]]), { style })
  ]);

  const snapshot = findActiveRoute([map], H, {
    orderedWaypoints: [
      { lat: 50, lng: 10 },
      { lat: 50.01, lng: 10.02 },
      { lat: 53, lng: 17 }
    ]
  });

  assert.deepEqual(snapshot.points[0], { lat: 50, lng: 10 });
  assert.deepEqual(snapshot.points.at(-1), { lat: 53, lng: 17 });
  assert.equal(snapshot.points.some((point) => point.lng === 30), false);
});

test("uses route endpoints as stops when ordered HOGS waypoints are unavailable", () => {
  const snapshot = findActiveRoute([new FakeMap([
    new FakePolyline(line([[10, 50], [11, 50.5], [12, 51]]))
  ])], H);

  assert.deepEqual(snapshot.stops, [
    { lat: 50, lng: 10 },
    { lat: 51, lng: 12 }
  ]);
  assert.equal(snapshot.waypointCount, 2);
  assert.equal(snapshot.orderMethod, "geometry-fallback");
});

test("reports explicit readiness and no-route errors", () => {
  assert.throws(
    () => findActiveRoute([], null),
    (error) => error instanceof RouteExportError && error.code === "HERE_NOT_READY"
  );
  assert.throws(
    () => findActiveRoute([], H),
    (error) => error instanceof RouteExportError && error.code === "MAP_NOT_FOUND"
  );
  assert.throws(
    () => findActiveRoute([new FakeMap([])], H),
    (error) => error instanceof RouteExportError && error.code === "NO_ACTIVE_ROUTE"
  );
});

test("computes a realistic haversine distance", () => {
  const distance = calculateDistance([
    { lat: 52.2297, lng: 21.0122 },
    { lat: 52.52, lng: 13.405 }
  ]);
  assert.ok(distance > 500_000 && distance < 525_000);
});
