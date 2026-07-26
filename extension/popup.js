(function initializePopup() {
  "use strict";

  const statusCard = document.getElementById("status-card");
  const statusTitle = document.getElementById("status-title");
  const statusMessage = document.getElementById("status-message");
  const routeDetails = document.getElementById("route-details");
  const pointCount = document.getElementById("point-count");
  const routeDistance = document.getElementById("route-distance");
  const routeEndpoints = document.getElementById("route-endpoints");
  const routeColor = document.getElementById("route-color");
  const routeColorSwatch = document.getElementById("route-color-swatch");
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

  function renderSnapshot(nextSnapshot) {
    snapshot = nextSnapshot;
    lastRouteSignature = snapshot.routeSignature || null;
    const first = snapshot.points[0];
    const last = snapshot.points[snapshot.points.length - 1];

    pointCount.textContent = snapshot.points.length.toLocaleString();
    routeDistance.textContent = formatDistance(snapshot.distanceMeters);
    routeEndpoints.textContent = `A ${formatPoint(first)}  →  B ${formatPoint(last)}`;
    const strokeColor = snapshot.selectedStyle?.strokeColor || "transparent";
    routeColor.textContent = strokeColor;
    routeColorSwatch.style.backgroundColor = strokeColor;
    routeDetails.hidden = false;
    setButtonsEnabled(true);
    setStatus("ready", "Active route found", "Download the selected HOGS route as GPX.");
  }

  function errorCopy(code, fallbackMessage) {
    switch (code) {
      case "NOT_HOGS":
        return ["Open HOGS", "This version works on app.hogs.live only."];
      case "NO_ACTIVE_ROUTE":
        return ["No active route", "Calculate or select a route in HOGS, then scan again."];
      case "HERE_NOT_READY":
      case "MAP_NOT_FOUND":
        return ["Map not ready", "Wait for the HOGS map to finish loading, then scan again."];
      case "BRIDGE_UNAVAILABLE":
        return ["Reload HOGS", "Reload the HOGS tab once after installing or updating the extension."];
      case "AMBIGUOUS_ROUTE_STYLE":
        return ["Selected route is ambiguous", "The visible routes use the same color, so nothing was exported."];
      default:
        return ["Route unavailable", fallbackMessage || "The active route could not be read."];
    }
  }

  function setRefreshControl(refreshing) {
    rescanButton.disabled = refreshing;
    rescanButton.textContent = refreshing ? "Refreshing…" : "Refresh route";
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
    if (!tab || !tab.id || !tab.url || !tab.url.startsWith("https://app.hogs.live/")) {
      activeTabId = null;
      return {
        tabId: null,
        response: {
          ok: false,
          error: { code: "NOT_HOGS", message: "Open a HOGS map tab." }
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
            message: "Reload the HOGS tab once after installing or updating the extension."
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
        setStatus("ready", "Active route found", "Download the selected HOGS route as GPX.");
      }
      setRefreshControl(false);
      return;
    }

    if (reason === "fallback" && snapshot) {
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
    if (reason === "fallback" && snapshot) {
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

  function timestampForFilename(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate()),
      "-",
      pad(date.getHours()),
      pad(date.getMinutes()),
      pad(date.getSeconds())
    ].join("");
  }

  function downloadGpx() {
    if (!snapshot) {
      return;
    }

    try {
      const output = window.HereRouteExporters.serialize(snapshot);
      const blob = new Blob([output.content], { type: output.mimeType });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `hogs-active-route-${timestampForFilename(new Date())}.gpx`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus("ready", "GPX downloaded", "The active route and all ordered stops were exported locally.");
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
