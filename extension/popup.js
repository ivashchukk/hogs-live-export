(function initializePopup() {
  "use strict";

  const statusCard = document.getElementById("status-card");
  const statusTitle = document.getElementById("status-title");
  const statusMessage = document.getElementById("status-message");
  const routeDetails = document.getElementById("route-details");
  const pointCount = document.getElementById("point-count");
  const routeDistance = document.getElementById("route-distance");
  const emptyState = document.getElementById("empty-state");
  const routeProvider = document.getElementById("route-provider");
  const routeTitle = document.getElementById("route-title");
  const stopCount = document.getElementById("stop-count");
  const originName = document.getElementById("route-origin-name");
  const destinationName = document.getElementById("route-destination-name");
  const originCoordinates = document.getElementById("route-origin-coordinates");
  const destinationCoordinates = document.getElementById("route-destination-coordinates");
  const rescanButton = document.getElementById("rescan");
  const downloadButton = document.getElementById("download-gpx");
  let snapshot = null;
  let activeTabId = null;
  let lastRouteSignature = null;
  let refreshController = null;

  function setStatus(kind, title, message) {
    statusCard.className = `status-card ${kind}`;
    statusTitle.textContent = title;
    statusMessage.textContent = message;
    emptyState.hidden = Boolean(snapshot);
  }

  function setButtonsEnabled(enabled) {
    downloadButton.disabled = !enabled;
  }

  function formatDistance(distanceMeters) {
    if (distanceMeters >= 1000) {
      return `${(distanceMeters / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;
    }
    return `${Math.round(distanceMeters)} m`;
  }

  function formatPoint(point) {
    return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  }

  function renderRoutePreview(points) {
    let longitude = points[0].lng;
    const latitudeScale = Math.cos(points[0].lat * Math.PI / 180);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const projected = points.map((point) => {
      longitude += ((point.lng - longitude + 540) % 360) - 180;
      const x = longitude * latitudeScale;
      const y = -point.lat;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      return { x, y };
    });
    const width = maxX - minX;
    const height = maxY - minY;
    const scale = Math.min(280 / Math.max(width, 0.000001), 60 / Math.max(height, 0.000001));
    const positions = projected.map((point) => ({
      x: ((point.x - minX) * scale + (328 - width * scale) / 2).toFixed(1),
      y: ((point.y - minY) * scale + (108 - height * scale) / 2).toFixed(1)
    }));
    const stride = Math.max(1, Math.ceil(points.length / 500));
    const path = positions.filter((_point, index) => index % stride === 0 || index === positions.length - 1)
      .map((point) => `${point.x},${point.y}`).join(" ");
    for (const id of ["route-preview-track", "route-preview-halo"]) {
      document.getElementById(id).setAttribute("points", path);
    }
    for (const [id, point] of [["route-preview-start", positions[0]], ["route-preview-end", positions[positions.length - 1]]]) {
      document.getElementById(id).setAttribute("cx", point.x);
      document.getElementById(id).setAttribute("cy", point.y);
    }
  }

  function renderSnapshot(nextSnapshot) {
    snapshot = nextSnapshot;
    lastRouteSignature = snapshot.routeSignature || null;
    const first = snapshot.points[0];
    const last = snapshot.points[snapshot.points.length - 1];

    pointCount.textContent = snapshot.points.length.toLocaleString();
    routeDistance.textContent = formatDistance(snapshot.distanceMeters);
    stopCount.textContent = (snapshot.stops?.length || snapshot.waypointCount || 2).toLocaleString();
    routeProvider.textContent = snapshot.provider === "google-maps" ? "Google Maps"
      : snapshot.provider === "webfleet" ? "Webfleet"
      : snapshot.sourceUrl?.startsWith("https://apps.impargo.de/") ? "IMPARGO"
      : snapshot.sourceUrl?.startsWith("https://app.hogs.live/") ? "HOGS" : "Route planner";
    routeTitle.textContent = snapshot.provider === "google-maps" ? "Your route" : snapshot.routeName || "Your route";
    routeTitle.title = routeTitle.textContent;
    const names = snapshot.provider === "google-maps" && snapshot.routeName ? snapshot.routeName.split(" to ") : [];
    originName.textContent = names.length === 2 ? names[0] : "Starting point";
    destinationName.textContent = names.length === 2 ? names[1] : "Destination";
    originName.title = originName.textContent;
    destinationName.title = destinationName.textContent;
    originCoordinates.textContent = formatPoint(first);
    destinationCoordinates.textContent = formatPoint(last);
    renderRoutePreview(snapshot.points);
    routeDetails.hidden = false;
    setButtonsEnabled(true);
    setStatus("ready", "Ready to export", "Download the selected route as GPX.");
  }

  function errorCopy(code, fallbackMessage) {
    switch (code) {
      case "NOT_HOGS":
        return ["Open route planner", "Open Google Maps, HOGS, IMPARGO, or Webfleet to export a route."];
      case "NO_ACTIVE_ROUTE":
        return ["No active route", "Calculate or select a route, then scan again."];
      case "HERE_NOT_READY":
      case "LEAFLET_NOT_READY":
      case "GOOGLE_MAPS_NOT_READY":
      case "MAP_NOT_FOUND":
        return ["Map not ready", "Wait for the route map to finish loading, then scan again."];
      case "BRIDGE_UNAVAILABLE":
        return ["Reload page", "Reload the route-planner tab once after installing or updating the extension."];
      case "AMBIGUOUS_ROUTE_STYLE":
        return ["Selected route is ambiguous", "The visible routes use the same color, so nothing was exported."];
      default:
        return ["Route unavailable", fallbackMessage || "The active route could not be read."];
    }
  }

  function setRefreshControl(refreshing) {
    rescanButton.disabled = refreshing;
    rescanButton.title = refreshing ? "Refreshing route…" : "Refresh route";
    rescanButton.setAttribute("aria-label", rescanButton.title);
  }

  function beginRefresh(reason) {
    if (reason === "fallback") {
      return;
    }

    setRefreshControl(true);
    setButtonsEnabled(false);
    if (!snapshot) {
      routeDetails.hidden = true;
    }
    const message = reason === "change"
      ? "Waiting for the selected route to finish updating."
      : "Reading the current selected route from the map.";
    setStatus("loading", "Refreshing route…", message);
  }

  async function requestRouteSnapshot() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !tab.url || ![
      "https://app.hogs.live/",
      "https://apps.impargo.de/",
      "https://live-wf.webfleet.com/",
      "https://www.google.com/maps/",
      "https://www.google.pl/maps/"
    ].some((origin) => tab.url.startsWith(origin))) {
      activeTabId = null;
      return {
        tabId: null,
        response: {
          ok: false,
          error: { code: "NOT_HOGS", message: "Open a supported route-planner tab." }
        }
      };
    }

    activeTabId = tab.id;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_ACTIVE_ROUTE" });
      return { tabId: tab.id, response };
    } catch (_error) {
      return {
        tabId: tab.id,
        response: {
          ok: false,
          error: {
            code: "BRIDGE_UNAVAILABLE",
            message: "Reload the route-planner tab once after installing or updating the extension."
          }
        }
      };
    }
  }

  function handleScanResult(result, reason) {
    if (result.tabId !== activeTabId) {
      return;
    }

    const response = result.response;
    if (response && response.ok) {
      const nextSnapshot = response.snapshot;
      const nextSignature = nextSnapshot.routeSignature || null;
      if (!snapshot || !nextSignature || nextSignature !== lastRouteSignature) {
        renderSnapshot(nextSnapshot);
      } else {
        snapshot = nextSnapshot;
        setButtonsEnabled(true);
        setStatus("ready", "Ready to export", "Download the selected route as GPX.");
      }
      setRefreshControl(false);
      return;
    }

    if (reason === "fallback" && snapshot && snapshot.provider !== "google-maps") {
      return;
    }

    snapshot = null;
    lastRouteSignature = null;
    routeDetails.hidden = true;
    setButtonsEnabled(false);
    setRefreshControl(false);
    const error = response && response.error ? response.error : {};
    const [title, message] = errorCopy(error.code, error.message);
    setStatus("error", title, message);
  }

  function handleScanError(error, reason) {
    if (reason === "fallback" && snapshot && snapshot.provider !== "google-maps") {
      return;
    }
    snapshot = null;
    lastRouteSignature = null;
    routeDetails.hidden = true;
    setButtonsEnabled(false);
    setRefreshControl(false);
    const [title, message] = errorCopy(error && error.code, error && error.message);
    setStatus("error", title, message);
  }

  async function downloadGpx() {
    if (!snapshot) {
      return;
    }

    try {
      if (snapshot.provider === "google-maps") {
        setButtonsEnabled(false);
        const result = await requestRouteSnapshot();
        handleScanResult(result, "download");
        if (!snapshot) {
          return;
        }
      }
      const output = window.HereRouteExporters.serialize(snapshot);
      const blob = new Blob([output.content], { type: output.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = window.HereRouteExporters.filenameForSnapshot(snapshot, new Date());
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("ready", "GPX downloaded", "The active route and its ordered stops were exported locally.");
    } catch (error) {
      setStatus("error", "Export failed", error.message || "The file could not be created.");
    }
  }

  downloadButton.addEventListener("click", downloadGpx);

  refreshController = window.HereRouteRefresh.createRefreshController({
    scan: requestRouteSnapshot,
    onPending: beginRefresh,
    onStart: beginRefresh,
    onResult: handleScanResult,
    onError: handleScanError,
    changeDebounceMs: 250,
    fallbackMs: 3000
  });

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (
      message &&
      message.type === "ROUTE_MAP_CHANGED" &&
      sender.tab &&
      sender.tab.id === activeTabId
    ) {
      refreshController.notifyChanged();
    }
  });

  rescanButton.addEventListener("click", () => refreshController.refreshNow());
  window.addEventListener("unload", () => refreshController.stop(), { once: true });
  refreshController.start();
})();
