(function installPageBridge() {
  "use strict";

  const CHANNEL = "here-maps-route-export/v1";
  const INSTALL_KEY = "__hereMapsRouteExportBridgeInstalled";
  const PATCH_KEY = "__hereMapsRouteExportPatched";
  const MUTATION_PATCH_KEY = "__hereMapsRouteExportMutationPatched";
  const CHANGE_EVENT_DEBOUNCE_MS = 120;
  const MAP_QUIET_MS = 300;
  const MAP_SETTLE_TIMEOUT_MS = 2000;
  const IS_WEBFLEET = window.location.hostname === "live-wf.webfleet.com";
  const maps = new Set();
  let mapRevision = 0;
  let lastMutationAt = 0;
  let changeEventTimer = null;

  if (window[INSTALL_KEY]) {
    return;
  }
  window[INSTALL_KEY] = true;

  function postRouteChanged() {
    changeEventTimer = null;
    window.postMessage({
      channel: CHANNEL,
      direction: "from-page",
      type: "ROUTE_MAP_CHANGED",
      revision: mapRevision
    }, window.location.origin);
  }

  function recordMapMutation() {
    mapRevision += 1;
    lastMutationAt = Date.now();
    if (changeEventTimer !== null) {
      window.clearTimeout(changeEventTimer);
    }
    changeEventTimer = window.setTimeout(postRouteChanged, CHANGE_EVENT_DEBOUNCE_MS);
  }

  function registerMap(map) {
    if (map && (typeof map.getObjects === "function" || typeof map.eachLayer === "function")) {
      maps.add(map);
    }
  }

  function wrapMapPrototype(MapConstructor) {
    const prototype = MapConstructor && MapConstructor.prototype;
    if (!prototype || prototype[PATCH_KEY]) {
      return;
    }

    Object.defineProperty(prototype, PATCH_KEY, { value: true });

    for (const methodName of ["addObject", "addObjects", "removeObject", "removeObjects", "removeAll"]) {
      const original = prototype[methodName];
      if (typeof original !== "function") {
        continue;
      }

      prototype[methodName] = function trackMapInstance(...args) {
        registerMap(this);
        const result = Reflect.apply(original, this, args);
        recordMapMutation();
        return result;
      };
    }

    const originalDispose = prototype.dispose;
    if (typeof originalDispose === "function") {
      prototype.dispose = function forgetMapInstance(...args) {
        maps.delete(this);
        return Reflect.apply(originalDispose, this, args);
      };
    }
  }

  function wrapMutationPrototype(Constructor, methodNames) {
    const prototype = Constructor && Constructor.prototype;
    if (!prototype || Object.prototype.hasOwnProperty.call(prototype, MUTATION_PATCH_KEY)) {
      return;
    }

    Object.defineProperty(prototype, MUTATION_PATCH_KEY, { value: true });
    for (const methodName of methodNames) {
      const original = prototype[methodName];
      if (typeof original !== "function") {
        continue;
      }

      prototype[methodName] = function trackRouteMutation(...args) {
        const result = Reflect.apply(original, this, args);
        registerMap(this);
        recordMapMutation();
        return result;
      };
    }
  }

  function wrapMapConstructor(hereApi) {
    const OriginalMap = hereApi.Map;
    if (typeof OriginalMap !== "function" || OriginalMap[PATCH_KEY]) {
      return;
    }

    let WrappedMap;
    WrappedMap = new Proxy(OriginalMap, {
      construct(target, args, newTarget) {
        const actualNewTarget = newTarget === WrappedMap ? target : newTarget;
        const map = Reflect.construct(target, args, actualNewTarget);
        registerMap(map);
        return map;
      }
    });

    Object.defineProperty(WrappedMap, PATCH_KEY, { value: true });
    try {
      hereApi.Map = WrappedMap;
    } catch (_error) {
      // The prototype wrappers still capture a map when the page adds objects.
    }
  }

  function patchHere() {
    const hereApi = window.H;
    if (!hereApi || typeof hereApi.Map !== "function") {
      return false;
    }

    wrapMapPrototype(hereApi.Map);
    wrapMapConstructor(hereApi);
    wrapMutationPrototype(hereApi.map && hereApi.map.Group, [
      "addObject",
      "addObjects",
      "removeObject",
      "removeObjects",
      "removeAll"
    ]);
    wrapMutationPrototype(hereApi.map && hereApi.map.Polyline, [
      "setStyle",
      "setGeometry",
      "setVisibility"
    ]);
    return true;
  }

  function patchLeafletPrototype(Constructor, methodNames, getMap) {
    const prototype = Constructor && Constructor.prototype;
    if (!prototype || Object.prototype.hasOwnProperty.call(prototype, MUTATION_PATCH_KEY)) {
      return;
    }

    Object.defineProperty(prototype, MUTATION_PATCH_KEY, { value: true });
    for (const methodName of methodNames) {
      const original = prototype[methodName];
      if (typeof original !== "function") {
        continue;
      }

      prototype[methodName] = function trackLeafletMutation(...args) {
        const result = Reflect.apply(original, this, args);
        registerMap(getMap(this, args));
        recordMapMutation();
        return result;
      };
    }
  }

  function patchLeaflet() {
    const leaflet = window.L;
    if (!leaflet || typeof leaflet.Map !== "function" || typeof leaflet.Polyline !== "function") {
      return false;
    }

    if (!Object.prototype.hasOwnProperty.call(leaflet.Map, PATCH_KEY)) {
      Object.defineProperty(leaflet.Map, PATCH_KEY, { value: true });
      if (typeof leaflet.Map.addInitHook === "function") {
        leaflet.Map.addInitHook(function rememberLeafletMap() {
          registerMap(this);
        });
      }
    }
    patchLeafletPrototype(leaflet.Map, ["addLayer", "removeLayer"], (map) => map);
    patchLeafletPrototype(leaflet.Polyline, ["setLatLngs", "setStyle"], (polyline) => polyline._map);
    return true;
  }

  const patchTimer = window.setInterval(() => {
    if (IS_WEBFLEET ? patchLeaflet() : patchHere()) {
      window.clearInterval(patchTimer);
    }
  }, 10);

  function delay(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function waitForMapToSettle() {
    const deadline = Date.now() + MAP_SETTLE_TIMEOUT_MS;
    while (lastMutationAt > 0 && Date.now() - lastMutationAt < MAP_QUIET_MS) {
      const remainingQuietTime = MAP_QUIET_MS - (Date.now() - lastMutationAt);
      const remainingDeadline = deadline - Date.now();
      if (remainingDeadline <= 0) {
        break;
      }
      await delay(Math.max(1, Math.min(remainingQuietTime, remainingDeadline)));
    }
  }

  function coordinateFromRouteValue(value) {
    if (!value || typeof value !== "object") {
      return null;
    }
    if (value.location) {
      return coordinateFromRouteValue(value.location);
    }
    if (value.position) {
      return coordinateFromRouteValue(value.position);
    }

    const lat = Number(value.lat ?? value.latitude);
    const lng = Number(value.lng ?? value.longitude);
    const alt = Number(value.alt ?? value.altitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return null;
    }
    return Number.isFinite(alt) ? { lat, lng, alt } : { lat, lng };
  }

  function parseRouteParameter(parameters, name) {
    const raw = parameters.get(name);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch (_error) {
      return null;
    }
  }

  function getOrderedUrlWaypoints() {
    const parameters = new URLSearchParams(window.location.search);
    const start = coordinateFromRouteValue(parseRouteParameter(parameters, "saddr"));
    const end = coordinateFromRouteValue(parseRouteParameter(parameters, "daddr"));
    const rawWaypoints = parseRouteParameter(parameters, "waypoints");
    const intermediates = Array.isArray(rawWaypoints)
      ? rawWaypoints.map(coordinateFromRouteValue).filter(Boolean)
      : [];
    return start && end ? [start, ...intermediates, end] : [];
  }

  function getWebfleetRouteName() {
    const exportButton = document.querySelector('[data-testid="route-action-export-button"]');
    const selectedRow = exportButton && exportButton.closest('[class*="compact-list-row"]');
    const routeRow = selectedRow && selectedRow.querySelector('[data-testid="route-row"]');
    return routeRow && routeRow.innerText
      ? routeRow.innerText.split(/\r?\n/, 1)[0].trim()
      : "";
  }

  async function scanStableRoute() {
    const deadline = Date.now() + MAP_SETTLE_TIMEOUT_MS;
    while (true) {
      await waitForMapToSettle();
      const revisionBeforeScan = mapRevision;
      const sourceUrl = `${window.location.origin}${window.location.pathname}`;
      let snapshot;
      if (IS_WEBFLEET) {
        if (!window.WebfleetRouteCore || !window.L) {
          const error = new Error("Webfleet's map has not finished loading.");
          error.code = "LEAFLET_NOT_READY";
          throw error;
        }
        snapshot = window.WebfleetRouteCore.findActiveRoute(maps, {
          sourceUrl,
          capturedAt: new Date().toISOString(),
          routeName: getWebfleetRouteName()
        });
      } else {
        snapshot = window.HereRouteCore.findActiveRoute(maps, window.H, {
          sourceUrl,
          capturedAt: new Date().toISOString(),
          orderedWaypoints: getOrderedUrlWaypoints()
        });
      }

      if (revisionBeforeScan === mapRevision || Date.now() >= deadline) {
        return { snapshot, revision: mapRevision };
      }
    }
  }

  window.addEventListener("message", async (event) => {
    const message = event.data;
    if (
      event.source !== window ||
      !message ||
      message.channel !== CHANNEL ||
      message.direction !== "to-page" ||
      message.type !== "SCAN_ACTIVE_ROUTE"
    ) {
      return;
    }

    let response;
    try {
      const result = await scanStableRoute();
      response = { ok: true, snapshot: result.snapshot, revision: result.revision };
    } catch (error) {
      response = {
        ok: false,
        revision: mapRevision,
        error: {
          code: error && error.code ? error.code : "EXTRACTION_FAILED",
          message: error && error.message ? error.message : "The active route could not be read."
        }
      };
    }

    window.postMessage({
      channel: CHANNEL,
      direction: "from-page",
      requestId: message.requestId,
      response
    }, window.location.origin);
  });
})();
