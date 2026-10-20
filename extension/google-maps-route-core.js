(function exposeGoogleMapsRouteCore(root, factory) {
  const api = factory(typeof module === "object" && module.exports
    ? require("./route-core.js")
    : root.HereRouteCore);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.GoogleMapsRouteCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createGoogleMapsRouteCore(core) {
  "use strict";

  const { RouteExportError, calculateDistance, removeConsecutiveDuplicates } = core;

  function parseResponse(value) {
    if (typeof value !== "string") {
      return value;
    }
    return JSON.parse(value.replace(/^\)\]\}'\s*/, ""));
  }

  function initialResponse(state) {
    const directions = state && state[3];
    // Maps wraps its initial arrays in a protobuf object after hydration.
    const values = Array.isArray(directions)
      ? directions
      : Object.values(directions || {}).find(Array.isArray);
    return values && values[4];
  }

  function decodeGeometry(geometry) {
    const latitudes = geometry && geometry[0];
    const longitudes = geometry && geometry[1];
    if (!Array.isArray(latitudes) || !Array.isArray(longitudes)
      || latitudes.length !== longitudes.length || latitudes.length < 2) {
      throw new RouteExportError("GOOGLE_MAPS_FORMAT_CHANGED", "Google Maps route geometry is unavailable. Reload the map and try again.");
    }

    let latitude = 0;
    let longitude = 0;
    return removeConsecutiveDuplicates(latitudes.map((delta, index) => {
      if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(longitudes[index])) {
        throw new RouteExportError("GOOGLE_MAPS_FORMAT_CHANGED", "Google Maps returned invalid route coordinates.");
      }
      latitude += delta;
      longitude += longitudes[index];
      const lat = latitude / 1e7;
      const lng = longitude / 1e7;
      if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw new RouteExportError("GOOGLE_MAPS_FORMAT_CHANGED", "Google Maps returned out-of-range route coordinates.");
      }
      return { lat, lng };
    }));
  }

  function stopCoordinate(value) {
    const lat = value && value[2];
    const lng = value && value[3];
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      throw new RouteExportError("GOOGLE_MAPS_FORMAT_CHANGED", "Google Maps route stops could not be read safely.");
    }
    return { lat, lng };
  }

  function signature(points, stops, routeName, routeIndex) {
    let hash = 2166136261;
    for (const character of JSON.stringify([points, stops, routeName, routeIndex])) {
      hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    }
    return `google-maps:${points.length}:${(hash >>> 0).toString(16)}`;
  }

  function findActiveRoute(response, metadata = {}) {
    let data;
    try {
      data = parseResponse(response)?.[0];
    } catch (_error) {
      throw new RouteExportError("GOOGLE_MAPS_FORMAT_CHANGED", "Google Maps route data could not be read. Reload the map and try again.");
    }
    const routes = data && data[1];
    if (!Array.isArray(routes) || routes.length === 0) {
      throw new RouteExportError("NO_ACTIVE_ROUTE", "Calculate or select a Google Maps route first.");
    }
    const routeIndex = metadata.routeIndex ?? (routes.length === 1 ? 0 : null);
    if (!Number.isInteger(routeIndex) || routeIndex < 0 || routeIndex >= routes.length) {
      throw new RouteExportError("AMBIGUOUS_GOOGLE_ROUTE", "Select a Google Maps route before exporting it.");
    }
    const route = routes[routeIndex];
    if (![0, 1, 2].includes(route?.[0]?.[0])) {
      throw new RouteExportError("UNSUPPORTED_GOOGLE_MODE", "Choose driving, walking, or cycling directions for GPX export.");
    }
    const points = decodeGeometry(data[7]?.[routeIndex]);
    if (points.length < 2) {
      throw new RouteExportError("NO_ACTIVE_ROUTE", "The selected Google Maps route has no track geometry.");
    }
    const places = data[0]?.map((waypoint) => waypoint?.[0]?.[0]);
    const legs = route[1];
    if (!Array.isArray(places) || !Array.isArray(legs) || places.length !== legs.length + 1) {
      throw new RouteExportError("GOOGLE_MAPS_FORMAT_CHANGED", "Google Maps route stops could not be read safely.");
    }
    const stops = [stopCoordinate(places[0]?.[2])];
    legs.forEach((leg, index) => {
      for (const via of leg[7] || []) {
        stops.push(stopCoordinate(via?.[0]));
      }
      stops.push(stopCoordinate(places[index + 1]?.[2]));
    });
    const routeName = `${places[0][0]} to ${places[places.length - 1][0]}`;
    const orderedStops = removeConsecutiveDuplicates(stops);
    return {
      provider: "google-maps",
      routeName,
      points,
      stops: orderedStops,
      distanceMeters: calculateDistance(points),
      sourceUrl: metadata.sourceUrl || "",
      capturedAt: metadata.capturedAt || new Date().toISOString(),
      selectedStyle: { strokeColor: "#1a73e8", lineWidth: 0, detectionMethod: "google-maps-selected-trip" },
      waypointCount: orderedStops.length,
      orderMethod: "google-maps-legs",
      routeSignature: signature(points, orderedStops, routeName, routeIndex)
    };
  }

  return { RouteExportError, decodeGeometry, findActiveRoute, initialResponse, parseResponse };
});
