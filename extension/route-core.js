(function exposeRouteCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.HereRouteCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createRouteCore() {
  "use strict";

  const JOIN_TOLERANCE_METERS = 30;
  const LEG_JOIN_TOLERANCE_METERS = 250;
  const ROUTE_ENDPOINT_TOLERANCE_METERS = 250;
  const WAYPOINT_MATCH_TOLERANCE_METERS = 2000;
  const MIN_FULL_ROUTE_RATIO = 0.2;
  const MIN_ROUTE_LENGTH_METERS = 10;
  const MIN_ROUTE_LINE_WIDTH = 4;
  const EARTH_RADIUS_METERS = 6371008.8;

  class RouteExportError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "RouteExportError";
      this.code = code;
    }
  }

  function toFiniteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  function coordinateFromGeoJson(value) {
    if (!Array.isArray(value) || value.length < 2) {
      return null;
    }

    const lng = toFiniteNumber(value[0]);
    const lat = toFiniteNumber(value[1]);
    const alt = toFiniteNumber(value[2]);

    if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return null;
    }

    return alt === undefined ? { lat, lng } : { lat, lng, alt };
  }

  function normalizeLine(coordinates) {
    if (!Array.isArray(coordinates)) {
      return [];
    }

    const points = coordinates.map(coordinateFromGeoJson).filter(Boolean);
    return removeConsecutiveDuplicates(points);
  }

  function geometryToSegments(geometry) {
    if (!geometry || typeof geometry !== "object") {
      return [];
    }

    if (geometry.type === "LineString") {
      const points = normalizeLine(geometry.coordinates);
      return points.length >= 2 ? [points] : [];
    }

    if (geometry.type === "MultiLineString") {
      return geometry.coordinates
        .map(normalizeLine)
        .filter((points) => points.length >= 2);
    }

    return [];
  }

  function extractPolylineSegments(polyline) {
    if (polyline && typeof polyline.toGeoJSON === "function") {
      try {
        const feature = polyline.toGeoJSON(() => null);
        const segments = geometryToSegments(feature && feature.geometry);
        if (segments.length > 0) {
          return segments;
        }
      } catch (_error) {
        // Some HERE objects contain data that cannot be serialized. The callback
        // above normally avoids that; geometry access below is the safe fallback.
      }
    }

    if (!polyline || typeof polyline.getGeometry !== "function") {
      return [];
    }

    const geometry = polyline.getGeometry();
    if (!geometry || typeof geometry.getLatLngAltArray !== "function") {
      return [];
    }

    const raw = geometry.getLatLngAltArray();
    if (!Array.isArray(raw) && !ArrayBuffer.isView(raw)) {
      return [];
    }

    const points = [];
    for (let index = 0; index + 1 < raw.length; index += 3) {
      const lat = toFiniteNumber(raw[index]);
      const lng = toFiniteNumber(raw[index + 1]);
      const alt = toFiniteNumber(raw[index + 2]);
      if (lat === undefined || lng === undefined) {
        continue;
      }
      points.push(alt === undefined ? { lat, lng } : { lat, lng, alt });
    }

    const normalized = removeConsecutiveDuplicates(points);
    return normalized.length >= 2 ? [normalized] : [];
  }

  function isPolyline(object, hereApi) {
    const Polyline = hereApi && hereApi.map && hereApi.map.Polyline;
    if (typeof Polyline === "function") {
      try {
        return object instanceof Polyline;
      } catch (_error) {
        // Fall through to feature detection for wrapped HERE constructors.
      }
    }

    return Boolean(
      object &&
      typeof object.getGeometry === "function" &&
      typeof object.getStyle === "function"
    );
  }

  function isEffectivelyVisible(object) {
    if (!object || typeof object.getVisibility !== "function") {
      return true;
    }

    try {
      return object.getVisibility(true) !== false;
    } catch (_error) {
      return object.getVisibility() !== false;
    }
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function normalizedAlpha(value) {
    return Math.round(clamp(value, 0, 1) * 1000) / 1000;
  }

  function colorDetails(red, green, blue, alpha) {
    const r = Math.round(clamp(red, 0, 255));
    const g = Math.round(clamp(green, 0, 255));
    const b = Math.round(clamp(blue, 0, 255));
    const a = normalizedAlpha(alpha);
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
    const hex = (value) => value.toString(16).padStart(2, "0");

    return {
      key: `${r},${g},${b},${a}`,
      display: a === 1 ? `#${hex(r)}${hex(g)}${hex(b)}` : `rgba(${r}, ${g}, ${b}, ${a})`,
      alpha: a,
      saturation,
      known: true
    };
  }

  function normalizeStrokeColor(value) {
    if (typeof value !== "string" || value.trim() === "") {
      return {
        key: "unknown",
        display: "transparent",
        alpha: 0,
        saturation: 0,
        known: false
      };
    }

    const input = value.trim().toLowerCase();
    const hexMatch = input.match(/^#([0-9a-f]{3,8})$/i);
    if (hexMatch) {
      let hex = hexMatch[1];
      if (hex.length === 3 || hex.length === 4) {
        hex = [...hex].map((character) => character + character).join("");
      }
      if (hex.length === 6 || hex.length === 8) {
        return colorDetails(
          parseInt(hex.slice(0, 2), 16),
          parseInt(hex.slice(2, 4), 16),
          parseInt(hex.slice(4, 6), 16),
          hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
        );
      }
    }

    const rgbMatch = input.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+)\s*)?\)$/i);
    if (rgbMatch) {
      return colorDetails(
        Number(rgbMatch[1]),
        Number(rgbMatch[2]),
        Number(rgbMatch[3]),
        rgbMatch[4] === undefined ? 1 : Number(rgbMatch[4])
      );
    }

    return {
      key: `raw:${input}`,
      display: input,
      alpha: 1,
      saturation: 0,
      known: true
    };
  }

  function getPolylineStyle(object) {
    let style = null;
    try {
      style = object && typeof object.getStyle === "function" ? object.getStyle() : null;
    } catch (_error) {
      style = null;
    }

    let zIndex = 0;
    try {
      zIndex = object && typeof object.getZIndex === "function"
        ? toFiniteNumber(object.getZIndex()) || 0
        : 0;
    } catch (_error) {
      zIndex = 0;
    }

    return {
      color: normalizeStrokeColor(style && style.strokeColor),
      lineWidth: toFiniteNumber(style && style.lineWidth) || 0,
      zIndex
    };
  }

  function hasRouteDataHint(object) {
    if (!object || typeof object.getData !== "function") {
      return false;
    }

    try {
      const data = object.getData();
      if (!data || typeof data !== "object") {
        return false;
      }

      return Object.entries(data).some(([key, value]) => {
        const text = `${key} ${typeof value === "string" ? value : ""}`.toLowerCase();
        return text.includes("route") || text.includes("section") || text.includes("track");
      });
    } catch (_error) {
      return false;
    }
  }

  function radians(degrees) {
    return degrees * Math.PI / 180;
  }

  function distanceBetween(first, second) {
    if (!first || !second) {
      return Infinity;
    }

    const deltaLat = radians(second.lat - first.lat);
    const deltaLng = radians(second.lng - first.lng);
    const lat1 = radians(first.lat);
    const lat2 = radians(second.lat);
    const a = Math.sin(deltaLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  function calculateDistance(points) {
    let distance = 0;
    for (let index = 1; index < points.length; index += 1) {
      distance += distanceBetween(points[index - 1], points[index]);
    }
    return distance;
  }

  function sameCoordinate(first, second) {
    return Boolean(first && second && first.lat === second.lat && first.lng === second.lng);
  }

  function removeConsecutiveDuplicates(points) {
    const result = [];
    for (const point of points) {
      if (!sameCoordinate(result[result.length - 1], point)) {
        result.push(point);
      }
    }
    return result;
  }

  function endpointDistances(first, second) {
    const firstStart = first.points[0];
    const firstEnd = first.points[first.points.length - 1];
    const secondStart = second.points[0];
    const secondEnd = second.points[second.points.length - 1];

    return [
      distanceBetween(firstStart, secondStart),
      distanceBetween(firstStart, secondEnd),
      distanceBetween(firstEnd, secondStart),
      distanceBetween(firstEnd, secondEnd)
    ];
  }

  function segmentsConnect(first, second, toleranceMeters = JOIN_TOLERANCE_METERS) {
    return Math.min(...endpointDistances(first, second)) <= toleranceMeters;
  }

  function fingerprint(points) {
    const forward = points.map((point) => {
      return `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`;
    }).join("|");
    const reverse = [...points].reverse().map((point) => {
      return `${point.lat.toFixed(7)},${point.lng.toFixed(7)}`;
    }).join("|");
    return `${points.length}:${forward < reverse ? forward : reverse}`;
  }

  function createRouteSignature(points, stops, distanceMeters, selectedStyle) {
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
    updateHash("|stops|");
    for (const stop of stops) {
      updateHash(`${stop.lat.toFixed(7)},${stop.lng.toFixed(7)},${stop.alt ?? ""};`);
    }
    updateHash(selectedStyle && selectedStyle.strokeColor ? selectedStyle.strokeColor : "");

    return `${points.length}:${Math.round(distanceMeters)}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }

  function deduplicateSegments(segments) {
    const seen = new Set();
    return segments.filter((segment) => {
      const key = fingerprint(segment.points);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function connectedComponents(segments, toleranceMeters = JOIN_TOLERANCE_METERS) {
    const visited = new Set();
    const components = [];

    for (let start = 0; start < segments.length; start += 1) {
      if (visited.has(start)) {
        continue;
      }

      const component = [];
      const queue = [start];
      visited.add(start);

      while (queue.length > 0) {
        const current = queue.shift();
        component.push(segments[current]);

        for (let candidate = 0; candidate < segments.length; candidate += 1) {
          if (
            !visited.has(candidate) &&
            segmentsConnect(segments[current], segments[candidate], toleranceMeters)
          ) {
            visited.add(candidate);
            queue.push(candidate);
          }
        }
      }

      components.push(component);
    }

    return components;
  }

  function isSimpleComponent(component, toleranceMeters = JOIN_TOLERANCE_METERS) {
    if (component.length === 1) {
      return true;
    }

    const nodes = [];
    const degrees = [];
    const findNode = (point) => {
      let nodeIndex = nodes.findIndex((node) => distanceBetween(node, point) <= toleranceMeters);
      if (nodeIndex === -1) {
        nodeIndex = nodes.length;
        nodes.push(point);
        degrees.push(0);
      }
      return nodeIndex;
    };

    for (const segment of component) {
      const startNode = findNode(segment.points[0]);
      const endNode = findNode(segment.points[segment.points.length - 1]);
      degrees[startNode] += 1;
      degrees[endNode] += 1;
    }

    return degrees.filter((degree) => degree === 1).length === 2 &&
      degrees.every((degree) => degree <= 2);
  }

  function attachmentOptions(routePoints, segment) {
    const routeStart = routePoints[0];
    const routeEnd = routePoints[routePoints.length - 1];
    const segmentStart = segment.points[0];
    const segmentEnd = segment.points[segment.points.length - 1];

    return [
      { side: "end", reverse: false, distance: distanceBetween(routeEnd, segmentStart) },
      { side: "end", reverse: true, distance: distanceBetween(routeEnd, segmentEnd) },
      { side: "start", reverse: false, distance: distanceBetween(routeStart, segmentEnd) },
      { side: "start", reverse: true, distance: distanceBetween(routeStart, segmentStart) }
    ];
  }

  function joinComponent(component, toleranceMeters = JOIN_TOLERANCE_METERS) {
    const remaining = [...component].sort((first, second) => first.order - second.order);
    const seed = remaining.shift();
    let routePoints = [...seed.points];
    let maxLineWidth = seed.lineWidth;

    while (remaining.length > 0) {
      let best = null;

      remaining.forEach((segment, segmentIndex) => {
        for (const option of attachmentOptions(routePoints, segment)) {
          if (!best || option.distance < best.option.distance) {
            best = { segment, segmentIndex, option };
          }
        }
      });

      if (!best || best.option.distance > toleranceMeters) {
        break;
      }

      let points = best.option.reverse ? [...best.segment.points].reverse() : [...best.segment.points];
      maxLineWidth = Math.max(maxLineWidth, best.segment.lineWidth);

      if (best.option.side === "end") {
        if (sameCoordinate(routePoints[routePoints.length - 1], points[0])) {
          points = points.slice(1);
        }
        routePoints = routePoints.concat(points);
      } else {
        if (sameCoordinate(points[points.length - 1], routePoints[0])) {
          points = points.slice(0, -1);
        }
        routePoints = points.concat(routePoints);
      }

      remaining.splice(best.segmentIndex, 1);
    }

    routePoints = removeConsecutiveDuplicates(routePoints);
    return {
      points: routePoints,
      distanceMeters: calculateDistance(routePoints),
      maxLineWidth
    };
  }

  function mapDisplayArea(map) {
    try {
      const element = map.getElement();
      const rect = element.getBoundingClientRect();
      return Math.max(0, rect.width) * Math.max(0, rect.height);
    } catch (_error) {
      return 0;
    }
  }

  function uniqueMaximum(groups, selector, minimumGap) {
    const ranked = [...groups].sort((first, second) => selector(second) - selector(first));
    if (ranked.length < 2 || selector(ranked[0]) - selector(ranked[1]) < minimumGap) {
      return null;
    }
    return ranked[0];
  }

  function selectActiveColorGroup(groups) {
    if (groups.length === 0) {
      return null;
    }

    if (groups.length === 1) {
      if (!groups[0].simple) {
        throw new RouteExportError(
          "AMBIGUOUS_ROUTE_STYLE",
          "Several same-color route alternatives are visible, so the selected route cannot be identified safely."
        );
      }
      return { group: groups[0], detectionMethod: "single-color" };
    }

    const simpleGroups = groups.filter((group) => group.simple);
    if (simpleGroups.length === 1) {
      return { group: simpleGroups[0], detectionMethod: "color-outlier" };
    }

    const byCount = [...groups].sort((first, second) => first.objectCount - second.objectCount);
    if (byCount.length > 1 && byCount[0].objectCount < byCount[1].objectCount && byCount[0].simple) {
      return { group: byCount[0], detectionMethod: "color-outlier" };
    }

    const prominenceRules = [
      [(group) => group.maxZIndex, 1],
      [(group) => group.maxLineWidth, 0.5],
      [(group) => group.color.alpha, 0.1],
      [(group) => group.color.saturation, 0.15]
    ];

    for (const [selector, minimumGap] of prominenceRules) {
      const winner = uniqueMaximum(simpleGroups, selector, minimumGap);
      if (winner) {
        return { group: winner, detectionMethod: "color-prominence" };
      }
    }

    const lastDrawn = uniqueMaximum(simpleGroups, (group) => group.lastDrawOrder, 1);
    if (lastDrawn) {
      const notLessProminent = simpleGroups.every((group) =>
        group === lastDrawn ||
        (lastDrawn.maxZIndex >= group.maxZIndex &&
          lastDrawn.maxLineWidth >= group.maxLineWidth &&
          lastDrawn.color.alpha >= group.color.alpha &&
          lastDrawn.color.saturation >= group.color.saturation)
      );
      if (notLessProminent) {
        return { group: lastDrawn, detectionMethod: "color-draw-order" };
      }
    }

    throw new RouteExportError(
      "AMBIGUOUS_ROUTE_STYLE",
      "The selected route does not have a uniquely identifiable color."
    );
  }

  function getParentId(object, objectOrder, parentIds) {
    let parent = null;
    try {
      parent = object && typeof object.getParentGroup === "function"
        ? object.getParentGroup()
        : null;
    } catch (_error) {
      parent = null;
    }

    if (!parent || (typeof parent !== "object" && typeof parent !== "function")) {
      return `object:${objectOrder}`;
    }

    if (!parentIds.has(parent)) {
      parentIds.set(parent, `parent:${parentIds.size + 1}`);
    }
    return parentIds.get(parent);
  }

  function candidateFromComponent(component, properties, toleranceMeters = JOIN_TOLERANCE_METERS) {
    const joined = joinComponent(component, toleranceMeters);
    return {
      ...joined,
      color: properties.color,
      zIndex: properties.zIndex,
      objectOrder: properties.objectOrder,
      parentId: properties.parentId,
      routeHint: properties.routeHint,
      sourceObjectCount: properties.sourceObjectCount || 1
    };
  }

  function candidateIsMoreVisible(candidate, current) {
    const comparisons = [
      [candidate.color.known ? 1 : 0, current.color.known ? 1 : 0],
      [candidate.zIndex, current.zIndex],
      [candidate.color.saturation, current.color.saturation],
      [candidate.color.alpha, current.color.alpha],
      [candidate.objectOrder, current.objectOrder],
      [candidate.maxLineWidth, current.maxLineWidth]
    ];

    for (const [candidateValue, currentValue] of comparisons) {
      if (candidateValue !== currentValue) {
        return candidateValue > currentValue;
      }
    }
    return false;
  }

  function deduplicateCandidates(candidates) {
    const unique = new Map();

    for (const candidate of candidates) {
      const key = fingerprint(candidate.points);
      const current = unique.get(key);
      if (!current) {
        unique.set(key, candidate);
        continue;
      }

      const winner = candidateIsMoreVisible(candidate, current) ? candidate : current;
      winner.maxLineWidth = Math.max(candidate.maxLineWidth, current.maxLineWidth);
      winner.sourceObjectCount = Math.max(candidate.sourceObjectCount, current.sourceObjectCount);
      unique.set(key, winner);
    }

    return [...unique.values()];
  }

  function assembleObjectCandidates(routeSegments) {
    const byObject = new Map();
    for (const segment of routeSegments) {
      if (!byObject.has(segment.objectOrder)) {
        byObject.set(segment.objectOrder, []);
      }
      byObject.get(segment.objectOrder).push(segment);
    }

    const candidates = [];
    for (const segments of byObject.values()) {
      const first = segments[0];
      for (const component of connectedComponents(deduplicateSegments(segments))) {
        if (!isSimpleComponent(component)) {
          continue;
        }
        candidates.push(candidateFromComponent(component, {
          color: first.color,
          zIndex: first.zIndex,
          objectOrder: first.objectOrder,
          parentId: first.parentId,
          routeHint: first.routeHint
        }));
      }
    }
    return candidates;
  }

  function assembleSectionChainCandidates(routeSegments) {
    const groups = new Map();
    for (const segment of routeSegments) {
      const key = `${segment.parentId}|${segment.color.key}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key).push(segment);
    }

    const candidates = [];
    for (const segments of groups.values()) {
      const objectOrders = new Set(segments.map((segment) => segment.objectOrder));
      if (objectOrders.size < 2) {
        continue;
      }

      for (const component of connectedComponents(deduplicateSegments(segments))) {
        const componentObjects = new Set(component.map((segment) => segment.objectOrder));
        if (componentObjects.size < 2 || !isSimpleComponent(component)) {
          continue;
        }

        candidates.push(candidateFromComponent(component, {
          color: component[0].color,
          zIndex: Math.max(...component.map((segment) => segment.zIndex)),
          objectOrder: Math.max(...component.map((segment) => segment.objectOrder)),
          parentId: component[0].parentId,
          routeHint: component.some((segment) => segment.routeHint),
          sourceObjectCount: componentObjects.size
        }));
      }
    }
    return candidates;
  }

  function endpointsMatch(first, second) {
    const firstStart = first.points[0];
    const firstEnd = first.points[first.points.length - 1];
    const secondStart = second.points[0];
    const secondEnd = second.points[second.points.length - 1];
    const direct = distanceBetween(firstStart, secondStart) <= ROUTE_ENDPOINT_TOLERANCE_METERS &&
      distanceBetween(firstEnd, secondEnd) <= ROUTE_ENDPOINT_TOLERANCE_METERS;
    const reverse = distanceBetween(firstStart, secondEnd) <= ROUTE_ENDPOINT_TOLERANCE_METERS &&
      distanceBetween(firstEnd, secondStart) <= ROUTE_ENDPOINT_TOLERANCE_METERS;
    return direct || reverse;
  }

  function groupRouteFamilies(candidates) {
    const visited = new Set();
    const families = [];

    for (let start = 0; start < candidates.length; start += 1) {
      if (visited.has(start)) {
        continue;
      }

      const family = [];
      const queue = [start];
      visited.add(start);
      while (queue.length > 0) {
        const current = queue.shift();
        family.push(candidates[current]);
        for (let candidate = 0; candidate < candidates.length; candidate += 1) {
          if (!visited.has(candidate) && endpointsMatch(candidates[current], candidates[candidate])) {
            visited.add(candidate);
            queue.push(candidate);
          }
        }
      }
      families.push(family);
    }
    return families;
  }

  function groupCandidatesByColor(candidates) {
    const groups = new Map();
    for (const candidate of candidates) {
      let group = groups.get(candidate.color.key);
      if (!group) {
        group = {
          color: candidate.color,
          candidates: [],
          simple: true,
          objectCount: 0,
          maxLineWidth: 0,
          maxZIndex: -Infinity,
          lastDrawOrder: 0
        };
        groups.set(candidate.color.key, group);
      }
      group.candidates.push(candidate);
      group.objectCount += 1;
      group.maxLineWidth = Math.max(group.maxLineWidth, candidate.maxLineWidth);
      group.maxZIndex = Math.max(group.maxZIndex, candidate.zIndex);
      group.lastDrawOrder = Math.max(group.lastDrawOrder, candidate.objectOrder);
    }
    return [...groups.values()];
  }

  function getParentGroup(object) {
    try {
      return object && typeof object.getParentGroup === "function"
        ? object.getParentGroup()
        : null;
    } catch (_error) {
      return null;
    }
  }

  function isMarker(object, hereApi) {
    const constructors = [
      hereApi && hereApi.map && hereApi.map.Marker,
      hereApi && hereApi.map && hereApi.map.DomMarker
    ].filter((Constructor) => typeof Constructor === "function");
    for (const Constructor of constructors) {
      try {
        if (object instanceof Constructor) {
          return true;
        }
      } catch (_error) {
        // Try the other marker constructor.
      }
    }
    return false;
  }

  function markerCoordinate(marker) {
    try {
      const geometry = marker && typeof marker.getGeometry === "function"
        ? marker.getGeometry()
        : null;
      const lat = toFiniteNumber(geometry && (geometry.lat ?? geometry.latitude));
      const lng = toFiniteNumber(geometry && (geometry.lng ?? geometry.longitude));
      const alt = toFiniteNumber(geometry && (geometry.alt ?? geometry.altitude));
      if (lat === undefined || lng === undefined || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return null;
      }
      return alt === undefined ? { lat, lng } : { lat, lng, alt };
    } catch (_error) {
      return null;
    }
  }

  function collectMarkerWaypointGroups(objects, hereApi) {
    const groups = new Map();
    objects.forEach((object, order) => {
      if (!isMarker(object, hereApi) || !isEffectivelyVisible(object)) {
        return;
      }
      const parent = getParentGroup(object);
      const point = markerCoordinate(object);
      if (!parent || !point) {
        return;
      }
      if (!groups.has(parent)) {
        groups.set(parent, []);
      }
      groups.get(parent).push({ object, point, order });
    });

    const waypointGroups = [];
    for (const [parent, records] of groups) {
      let orderedRecords = records;
      try {
        const children = typeof parent.getObjects === "function" ? parent.getObjects() : null;
        if (Array.isArray(children)) {
          const childOrder = new Map(children.map((child, index) => [child, index]));
          orderedRecords = [...records].sort((first, second) =>
            (childOrder.get(first.object) ?? first.order) - (childOrder.get(second.object) ?? second.order)
          );
        }
      } catch (_error) {
        orderedRecords = records;
      }

      if (orderedRecords.length < 2) {
        continue;
      }
      waypointGroups.push(orderedRecords.map((record) => record.point));
    }
    return waypointGroups;
  }

  function normalizeOrderedWaypoints(points) {
    if (!Array.isArray(points)) {
      return [];
    }
    return points.map((point) => {
      const lat = toFiniteNumber(point && (point.lat ?? point.latitude));
      const lng = toFiniteNumber(point && (point.lng ?? point.longitude));
      const alt = toFiniteNumber(point && (point.alt ?? point.altitude));
      if (lat === undefined || lng === undefined) {
        return null;
      }
      return alt === undefined ? { lat, lng } : { lat, lng, alt };
    }).filter(Boolean);
  }

  function buildColorChains(routeSegments) {
    const byColor = new Map();
    for (const segment of routeSegments) {
      if (!byColor.has(segment.color.key)) {
        byColor.set(segment.color.key, []);
      }
      byColor.get(segment.color.key).push(segment);
    }

    const chains = [];
    for (const segments of byColor.values()) {
      const deduplicated = deduplicateSegments(segments);
      for (const component of connectedComponents(deduplicated, LEG_JOIN_TOLERANCE_METERS)) {
        if (!isSimpleComponent(component, LEG_JOIN_TOLERANCE_METERS)) {
          continue;
        }
        chains.push(candidateFromComponent(component, {
          color: component[0].color,
          zIndex: Math.max(...component.map((segment) => segment.zIndex)),
          objectOrder: Math.max(...component.map((segment) => segment.objectOrder)),
          parentId: "selected-color-chain",
          routeHint: component.some((segment) => segment.routeHint),
          sourceObjectCount: new Set(component.map((segment) => segment.objectOrder)).size
        }, LEG_JOIN_TOLERANCE_METERS));
      }
    }
    return chains;
  }

  function preferredColorFromFamilies(candidates) {
    const votes = new Map();
    for (const family of groupRouteFamilies(candidates)) {
      const groups = groupCandidatesByColor(family);
      if (family.length < 2 || groups.length < 2) {
        continue;
      }

      try {
        const selection = selectActiveColorGroup(groups);
        if (!selection || selection.group.candidates.length !== 1) {
          continue;
        }
        const key = selection.group.color.key;
        const vote = votes.get(key) || { color: selection.group.color, count: 0, evidence: 0 };
        vote.count += 1;
        vote.evidence += family.length;
        votes.set(key, vote);
      } catch (_error) {
        // An unrelated ambiguous family cannot invalidate a clear selected-color chain.
      }
    }

    const ranked = [...votes.values()].sort((first, second) =>
      second.count - first.count || second.evidence - first.evidence
    );
    if (
      ranked.length === 0 ||
      (ranked.length > 1 && ranked[0].count === ranked[1].count && ranked[0].evidence === ranked[1].evidence)
    ) {
      return null;
    }
    return ranked[0].color;
  }

  function nearestPointIndex(points, waypoint) {
    let bestIndex = -1;
    let bestDistance = Infinity;
    points.forEach((point, index) => {
      const distance = distanceBetween(point, waypoint);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return { index: bestIndex, distance: bestDistance };
  }

  function analyzeWaypointOrder(points, waypoints) {
    const matches = waypoints.map((waypoint) => nearestPointIndex(points, waypoint));
    const valid = matches.filter((match) => match.distance <= WAYPOINT_MATCH_TOLERANCE_METERS);
    const indexes = valid.map((match) => match.index);
    const forward = indexes.every((index, position) => position === 0 || index >= indexes[position - 1]);
    const reverse = indexes.every((index, position) => position === 0 || index <= indexes[position - 1]);
    return {
      matchedCount: valid.length,
      direction: reverse && !forward ? "reverse" : forward ? "forward" : null
    };
  }

  function selectOrderedMarkerWaypoints(groups, routePoints) {
    const routeEndIndex = routePoints.length - 1;
    const ranked = [];

    for (const points of groups) {
      const matches = points.map((point) => nearestPointIndex(routePoints, point));
      if (matches.some((match) => match.distance > WAYPOINT_MATCH_TOLERANCE_METERS)) {
        continue;
      }

      const indexes = matches.map((match) => match.index);
      const forward = indexes.every(
        (index, position) => position === 0 || index >= indexes[position - 1]
      );
      const reverse = indexes.every(
        (index, position) => position === 0 || index <= indexes[position - 1]
      );
      const forwardEndpointDistance = Math.max(
        distanceBetween(points[0], routePoints[0]),
        distanceBetween(points[points.length - 1], routePoints[routeEndIndex])
      );
      const reverseEndpointDistance = Math.max(
        distanceBetween(points[0], routePoints[routeEndIndex]),
        distanceBetween(points[points.length - 1], routePoints[0])
      );
      const matchesForward = forward && forwardEndpointDistance <= WAYPOINT_MATCH_TOLERANCE_METERS;
      const matchesReverse = reverse && reverseEndpointDistance <= WAYPOINT_MATCH_TOLERANCE_METERS;
      if (!matchesForward && !matchesReverse) {
        continue;
      }

      ranked.push({
        points,
        count: points.length,
        endpointDistance: Math.min(
          matchesForward ? forwardEndpointDistance : Infinity,
          matchesReverse ? reverseEndpointDistance : Infinity
        ),
        coverage: routeEndIndex > 0
          ? Math.abs(indexes[indexes.length - 1] - indexes[0]) / routeEndIndex
          : 0,
        totalDistance: matches.reduce((total, match) => total + match.distance, 0)
      });
    }

    ranked.sort((first, second) =>
      first.endpointDistance - second.endpointDistance ||
      second.coverage - first.coverage ||
      first.totalDistance - second.totalDistance ||
      second.count - first.count
    );
    return ranked.length > 0 ? ranked[0].points : [];
  }

  function selectCompleteRoute(routeSegments, routeCandidates, orderedWaypoints, orderMethod) {
    const chains = buildColorChains(routeSegments).filter(
      (candidate) => candidate.distanceMeters >= MIN_ROUTE_LENGTH_METERS
    );
    if (chains.length === 0) {
      throw new RouteExportError(
        "AMBIGUOUS_ROUTE_STYLE",
        "The selected route geometry branches into several same-color alternatives."
      );
    }

    const waypoints = normalizeOrderedWaypoints(orderedWaypoints);
    const preferredColor = preferredColorFromFamilies(routeCandidates);
    let pool = preferredColor
      ? chains.filter((candidate) => candidate.color.key === preferredColor.key)
      : chains;
    if (pool.length === 0) {
      pool = chains;
    }

    const analyses = new Map(pool.map((candidate) => [
      candidate,
      analyzeWaypointOrder(candidate.points, waypoints)
    ]));
    const maximumMatches = Math.max(0, ...[...analyses.values()].map((analysis) => analysis.matchedCount));
    if (waypoints.length >= 2 && maximumMatches >= 2) {
      pool = pool.filter((candidate) => analyses.get(candidate).matchedCount === maximumMatches);
    }

    const longestDistance = Math.max(...pool.map((candidate) => candidate.distanceMeters));
    pool = pool.filter((candidate) => candidate.distanceMeters >= longestDistance * MIN_FULL_ROUTE_RATIO);

    if (!preferredColor && pool.length > 1) {
      const selection = selectActiveColorGroup(groupCandidatesByColor(pool));
      if (selection) {
        pool = selection.group.candidates;
      }
    }

    pool.sort((first, second) =>
      (analyses.get(second)?.matchedCount || 0) - (analyses.get(first)?.matchedCount || 0) ||
      second.distanceMeters - first.distanceMeters ||
      second.sourceObjectCount - first.sourceObjectCount ||
      second.objectOrder - first.objectOrder
    );

    const active = pool[0];
    const analysis = analyses.get(active) || { matchedCount: 0, direction: null };
    if (analysis.direction === "reverse") {
      active.points = [...active.points].reverse();
    }
    active.distanceMeters = calculateDistance(active.points);
    active.selectedStyle = {
      strokeColor: active.color.display,
      lineWidth: active.maxLineWidth,
      detectionMethod: active.sourceObjectCount > 1 || waypoints.length > 2
        ? "selected-color-chain"
        : preferredColor ? "color-outlier" : "single-full-route"
    };
    active.orderMethod = analysis.direction && analysis.matchedCount >= 2
      ? orderMethod
      : "geometry-fallback";
    active.stops = waypoints.length > 0
      ? waypoints.map((waypoint) => ({ ...waypoint }))
      : [active.points[0], active.points[active.points.length - 1]].map((point) => ({ ...point }));
    active.waypointCount = active.stops.length;
    return active;
  }

  function collectMapCandidates(map, hereApi, mapOrder, metadata) {
    if (!map || typeof map.getObjects !== "function") {
      return [];
    }

    let objects;
    try {
      objects = map.getObjects(true);
    } catch (_error) {
      return [];
    }

    const allSegments = [];
    const parentIds = new Map();
    let segmentOrder = 0;
    let objectOrder = 0;

    for (const object of objects) {
      if (!isPolyline(object, hereApi) || !isEffectivelyVisible(object)) {
        continue;
      }

      objectOrder += 1;
      const style = getPolylineStyle(object);
      const routeHint = hasRouteDataHint(object);
      const parentId = getParentId(object, objectOrder, parentIds);
      for (const points of extractPolylineSegments(object)) {
        const distanceMeters = calculateDistance(points);
        if (distanceMeters < MIN_ROUTE_LENGTH_METERS) {
          continue;
        }

        allSegments.push({
          points,
          distanceMeters,
          lineWidth: style.lineWidth,
          color: style.color,
          zIndex: style.zIndex,
          routeHint,
          parentId,
          objectOrder,
          order: segmentOrder += 1
        });
      }
    }

    const explicitRouteSegments = allSegments.filter(
      (segment) => segment.routeHint || segment.lineWidth >= MIN_ROUTE_LINE_WIDTH
    );

    // A single visible line is safe to accept even if its style is unavailable.
    const routeSegments = explicitRouteSegments.length > 0
      ? explicitRouteSegments
      : allSegments.length === 1 ? allSegments : [];

    if (routeSegments.length === 0) {
      return [];
    }

    const rawCandidates = assembleObjectCandidates(routeSegments).concat(
      assembleSectionChainCandidates(routeSegments)
    );
    const routeCandidates = deduplicateCandidates(rawCandidates).filter(
      (candidate) => candidate.points.length >= 2 && candidate.distanceMeters >= MIN_ROUTE_LENGTH_METERS
    );
    if (routeCandidates.length === 0) {
      return [];
    }

    const urlWaypoints = normalizeOrderedWaypoints(metadata && metadata.orderedWaypoints);
    let active;
    if (urlWaypoints.length >= 2) {
      active = selectCompleteRoute(
        routeSegments,
        routeCandidates,
        urlWaypoints,
        "url-waypoints"
      );
    } else {
      const provisional = selectCompleteRoute(
        routeSegments,
        routeCandidates,
        [],
        "geometry-fallback"
      );
      const markerWaypoints = selectOrderedMarkerWaypoints(
        collectMarkerWaypointGroups(objects, hereApi),
        provisional.points
      );
      active = markerWaypoints.length >= 2
        ? selectCompleteRoute(
          routeSegments,
          routeCandidates,
          markerWaypoints,
          "map-waypoints"
        )
        : provisional;
    }
    return [{
      ...active,
      displayArea: mapDisplayArea(map),
      mapOrder
    }];
  }

  function findActiveRoute(maps, hereApi, metadata) {
    if (!hereApi || !hereApi.map || !hereApi.map.Polyline) {
      throw new RouteExportError("HERE_NOT_READY", "HERE Maps has not finished loading.");
    }

    const mapList = Array.from(maps || []).filter(Boolean);
    if (mapList.length === 0) {
      throw new RouteExportError("MAP_NOT_FOUND", "The HOGS map has not been detected.");
    }

    const candidates = mapList.flatMap((map, index) =>
      collectMapCandidates(map, hereApi, index, metadata)
    );
    const eligible = candidates.filter(
      (candidate) => candidate.points.length >= 2 && candidate.distanceMeters >= MIN_ROUTE_LENGTH_METERS
    );

    if (eligible.length === 0) {
      throw new RouteExportError("NO_ACTIVE_ROUTE", "No active route is visible on the map.");
    }

    eligible.sort((first, second) =>
      second.maxLineWidth - first.maxLineWidth ||
      second.distanceMeters - first.distanceMeters ||
      second.displayArea - first.displayArea ||
      first.mapOrder - second.mapOrder
    );

    const active = eligible[0];
    const capturedAt = metadata && metadata.capturedAt
      ? metadata.capturedAt
      : new Date().toISOString();

    const points = active.points.map((point) => ({ ...point }));
    const stops = active.stops.map((stop) => ({ ...stop }));
    return {
      points,
      stops,
      distanceMeters: active.distanceMeters,
      sourceUrl: metadata && metadata.sourceUrl ? metadata.sourceUrl : "",
      capturedAt,
      selectedStyle: active.selectedStyle,
      waypointCount: active.waypointCount,
      orderMethod: active.orderMethod,
      routeSignature: createRouteSignature(points, stops, active.distanceMeters, active.selectedStyle)
    };
  }

  return {
    JOIN_TOLERANCE_METERS,
    RouteExportError,
    calculateDistance,
    extractPolylineSegments,
    findActiveRoute,
    geometryToSegments,
    normalizeStrokeColor,
    joinComponent,
    removeConsecutiveDuplicates
  };
});
