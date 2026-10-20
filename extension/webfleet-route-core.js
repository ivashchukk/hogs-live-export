(function exposeWebfleetRouteCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.WebfleetRouteCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createWebfleetRouteCore() {
  "use strict";

  const ROUTE_LAYER_CLASS = "t3sel-map-my-route-trace";
  const ROUTE_MARKER_CLASS = "t3sel-routing-marker-icon";
  const MARKER_TOLERANCE_METERS = 250;
  const EARTH_RADIUS_METERS = 6371008.8;

  class RouteExportError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "RouteExportError";
      this.code = code;
    }
  }

  function coordinateFromLatLng(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    const lat = Number(value && value.lat);
    const lng = Number(value && (value.lng ?? value.lon));
    const alt = Number(value && value.alt);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return null;
    }
    return Number.isFinite(alt) ? { lat, lng, alt } : { lat, lng };
  }

  function flattenLatLngs(value, result = []) {
    if (Array.isArray(value)) {
      for (const item of value) {
        flattenLatLngs(item, result);
      }
      return result;
    }

    const point = coordinateFromLatLng(value);
    if (point) {
      result.push(point);
    }
    return result;
  }

  function removeConsecutiveDuplicates(points) {
    return points.filter((point, index) => {
      const previous = points[index - 1];
      return !previous || point.lat !== previous.lat || point.lng !== previous.lng || point.alt !== previous.alt;
    });
  }

  function distanceBetween(first, second) {
    const toRadians = (value) => value * Math.PI / 180;
    const latitudeDelta = toRadians(second.lat - first.lat);
    const longitudeDelta = toRadians(second.lng - first.lng);
    const firstLatitude = toRadians(first.lat);
    const secondLatitude = toRadians(second.lat);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  }

  function calculateDistance(points) {
    let distance = 0;
    for (let index = 1; index < points.length; index += 1) {
      distance += distanceBetween(points[index - 1], points[index]);
    }
    return distance;
  }

  function hasClass(layer, className) {
    return String(layer && layer.options && layer.options.className || "")
      .split(/\s+/)
      .includes(className);
  }

  function mapLayers(map) {
    const layers = [];
    if (map && typeof map.eachLayer === "function") {
      map.eachLayer((layer) => layers.push(layer));
    }
    return layers;
  }

  function markerKind(layer) {
    if (!hasClass(layer && layer.options && layer.options.icon, ROUTE_MARKER_CLASS)) {
      return null;
    }

    const element = typeof layer.getElement === "function" ? layer.getElement() : layer._icon;
    if (element && typeof element.querySelector === "function") {
      if (element.querySelector(".t3sel-start-position-icon")) {
        return "start";
      }
      if (element.querySelector(".t3sel-end-position-icon")) {
        return "end";
      }
    }
    return "base";
  }

  function nearestPoint(points, marker) {
    let index = -1;
    let distanceMeters = Infinity;
    for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
      const distance = distanceBetween(points[pointIndex], marker);
      if (distance < distanceMeters) {
        index = pointIndex;
        distanceMeters = distance;
      }
    }
    return { index, distanceMeters };
  }

  function orientPoints(points, markers) {
    const start = markers.find((marker) => marker.kind === "start");
    const end = markers.find((marker) => marker.kind === "end");
    if (!start || !end) {
      return points;
    }

    const direct = distanceBetween(points[0], start.point)
      + distanceBetween(points[points.length - 1], end.point);
    const reverse = distanceBetween(points[0], end.point)
      + distanceBetween(points[points.length - 1], start.point);
    return reverse < direct ? [...points].reverse() : points;
  }

  function orderedStops(points, layers) {
    const markers = layers.map((layer) => {
      const kind = markerKind(layer);
      const point = kind && typeof layer.getLatLng === "function"
        ? coordinateFromLatLng(layer.getLatLng())
        : null;
      return kind && point ? { kind, point } : null;
    }).filter(Boolean);

    const ordered = markers.map((marker) => ({
      ...marker,
      nearest: nearestPoint(points, marker.point)
    })).filter((marker) => marker.nearest.distanceMeters <= MARKER_TOLERANCE_METERS);

    ordered.sort((first, second) => {
      const firstIndex = first.kind === "start" ? -1 : first.kind === "end" ? Infinity : first.nearest.index;
      const secondIndex = second.kind === "start" ? -1 : second.kind === "end" ? Infinity : second.nearest.index;
      return firstIndex - secondIndex;
    });

    const stops = removeConsecutiveDuplicates(ordered.map((marker) => marker.point));
    return stops.length >= 2
      ? stops
      : [points[0], points[points.length - 1]].map((point) => ({ ...point }));
  }

  function createRouteSignature(points, stops, distanceMeters, routeName) {
    let hash = 2166136261;
    const updateHash = (value) => {
      for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
    };

    for (const point of points) {
      updateHash(`${point.lat.toFixed(7)},${point.lng.toFixed(7)},${point.alt ?? ""};`);
    }
    for (const stop of stops) {
      updateHash(`${stop.lat.toFixed(7)},${stop.lng.toFixed(7)},${stop.alt ?? ""};`);
    }
    updateHash(routeName);
    return `${points.length}:${Math.round(distanceMeters)}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function findActiveRoute(maps, metadata = {}) {
    const mapList = Array.from(maps || []).filter(Boolean);
    if (mapList.length === 0) {
      throw new RouteExportError("MAP_NOT_FOUND", "The Webfleet map has not been detected.");
    }

    const candidates = mapList.flatMap((map) => {
      const layers = mapLayers(map);
      return layers.filter((layer) => hasClass(layer, ROUTE_LAYER_CLASS)).map((layer) => ({
        layer,
        layers,
        points: removeConsecutiveDuplicates(flattenLatLngs(
          typeof layer.getLatLngs === "function" ? layer.getLatLngs() : []
        ))
      }));
    }).filter((candidate) => candidate.points.length >= 2);

    if (candidates.length === 0) {
      throw new RouteExportError("NO_ACTIVE_ROUTE", "No selected Webfleet route is visible on the map.");
    }

    candidates.sort((first, second) => second.points.length - first.points.length);
    const active = candidates[0];
    const markerLayers = active.layers.filter((layer) => markerKind(layer));
    const points = orientPoints(active.points, markerLayers.map((layer) => ({
      kind: markerKind(layer),
      point: coordinateFromLatLng(typeof layer.getLatLng === "function" ? layer.getLatLng() : null)
    })).filter((marker) => marker.point));
    const stops = orderedStops(points, markerLayers);
    const distanceMeters = calculateDistance(points);
    const routeName = typeof metadata.routeName === "string" ? metadata.routeName.trim() : "";

    return {
      provider: "webfleet",
      routeName,
      points: points.map((point) => ({ ...point })),
      stops,
      distanceMeters,
      sourceUrl: metadata.sourceUrl || "",
      capturedAt: metadata.capturedAt || new Date().toISOString(),
      selectedStyle: {
        strokeColor: active.layer.options && active.layer.options.color || "#00a2bd",
        lineWidth: Number(active.layer.options && active.layer.options.weight) || 0,
        detectionMethod: "webfleet-route-layer"
      },
      waypointCount: stops.length,
      orderMethod: markerLayers.length >= 2 ? "webfleet-markers" : "geometry-fallback",
      routeSignature: createRouteSignature(points, stops, distanceMeters, routeName)
    };
  }

  return {
    RouteExportError,
    calculateDistance,
    findActiveRoute,
    flattenLatLngs,
    removeConsecutiveDuplicates
  };
});
