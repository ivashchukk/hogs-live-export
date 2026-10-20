(function installGoogleMapsBridge() {
  "use strict";

  const CHANNEL = "here-maps-route-export/v1";
  const core = window.GoogleMapsRouteCore;
  let response = null;
  let requestRevision = 0;
  let revision = 0;
  let changeTimer;
  const xhrUrls = new WeakMap();

  function routeChanged() {
    revision += 1;
    window.clearTimeout(changeTimer);
    changeTimer = window.setTimeout(() => {
      window.postMessage({ channel: CHANNEL, direction: "from-page", type: "ROUTE_MAP_CHANGED", revision }, window.location.origin);
    }, 120);
  }

  function isDirectionsRequest(value) {
    try {
      const url = new URL(value, window.location.href);
      return url.origin === window.location.origin && url.pathname === "/maps/preview/directions";
    } catch (_error) {
      return false;
    }
  }

  function beginRequest() {
    requestRevision += 1;
    response = null;
    routeChanged();
    return requestRevision;
  }

  function receiveResponse(value, request) {
    if (request !== requestRevision) {
      return;
    }
    try {
      response = core.parseResponse(value);
    } catch (_error) {
      response = null;
    }
    routeChanged();
  }

  // Observe only the page's existing requests; never send a routing request ourselves.
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function observeDirectionsFetch(input, ...args) {
      if (!isDirectionsRequest(typeof input === "string" || input instanceof URL ? input : input?.url)) {
        return Reflect.apply(originalFetch, this, [input, ...args]);
      }
      const request = beginRequest();
      const pending = Reflect.apply(originalFetch, this, [input, ...args]);
      pending.then((result) => {
        if (result.ok) {
          return result.clone().text().then((value) => receiveResponse(value, request));
        }
      }).catch(() => {});
      return pending;
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function observeDirectionsOpen(method, url, ...args) {
    xhrUrls.set(this, isDirectionsRequest(url));
    return Reflect.apply(originalOpen, this, [method, url, ...args]);
  };
  XMLHttpRequest.prototype.send = function observeDirectionsSend(...args) {
    if (xhrUrls.get(this)) {
      const request = beginRequest();
      this.addEventListener("loadend", () => {
        if (this.status >= 200 && this.status < 300) {
          if (this.responseType === "json") {
            receiveResponse(this.response, request);
          } else if (!this.responseType || this.responseType === "text") {
            receiveResponse(this.responseText, request);
          }
        }
      }, { once: true });
    }
    return Reflect.apply(originalSend, this, args);
  };

  function selectedRouteIndex() {
    const cards = Array.from(document.querySelectorAll("[data-trip-index][role]"))
      .filter((card) => card.getClientRects().length > 0);
    const selected = cards.filter((card) => card.getAttribute("role") === "link"
      || card.getAttribute("aria-selected") === "true");
    const card = selected.length === 1 ? selected[0] : cards.length === 1 ? cards[0] : null;
    return card ? Number(card.getAttribute("data-trip-index")) : null;
  }

  const observer = new MutationObserver((mutations) => {
    if (mutations.some((mutation) => {
      const element = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      return element?.closest("[data-trip-index]")
        || Array.from(mutation.addedNodes).some((node) => node.nodeType === 1
          && (node.matches("[data-trip-index]") || node.querySelector("[data-trip-index]")))
        || Array.from(mutation.removedNodes).some((node) => node.nodeType === 1
          && (node.matches("[data-trip-index]") || node.querySelector("[data-trip-index]")));
    })) {
      routeChanged();
    }
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-selected"] });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || !message || message.channel !== CHANNEL
      || message.direction !== "to-page" || message.type !== "SCAN_ACTIVE_ROUTE") {
      return;
    }

    let result;
    try {
      const routeIndex = selectedRouteIndex();
      if (routeIndex === null) {
        throw new core.RouteExportError("NO_ACTIVE_ROUTE", "Select a Google Maps route, then try again.");
      }
      const data = requestRevision > 0 ? response : core.initialResponse(window.APP_INITIALIZATION_STATE);
      if (!data) {
        throw new core.RouteExportError("GOOGLE_MAPS_NOT_READY", "Wait for the Google Maps route to load, then refresh the route.");
      }
      const snapshot = core.findActiveRoute(data, {
        routeIndex,
        sourceUrl: `${window.location.origin}${window.location.pathname}`
      });
      result = { ok: true, snapshot, revision };
    } catch (error) {
      result = { ok: false, revision, error: { code: error.code || "EXTRACTION_FAILED", message: error.message } };
    }
    window.postMessage({ channel: CHANNEL, direction: "from-page", requestId: message.requestId, response: result }, window.location.origin);
  });
})();
