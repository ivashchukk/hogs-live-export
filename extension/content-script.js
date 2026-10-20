(function installContentRelay() {
  "use strict";

  const CHANNEL = "here-maps-route-export/v1";
  const pending = new Map();

  function nextRequestId() {
    if (crypto && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (
      event.source !== window ||
      !message ||
      message.channel !== CHANNEL ||
      message.direction !== "from-page"
    ) {
      return;
    }

    if (message.type === "ROUTE_MAP_CHANGED") {
      try {
        chrome.runtime.sendMessage({
          type: "ROUTE_MAP_CHANGED",
          revision: message.revision
        }, () => void chrome.runtime.lastError);
      } catch (_error) {
        // The popup is normally closed; route changes need no persistent listener.
      }
      return;
    }

    const request = pending.get(message.requestId);
    if (!request) {
      return;
    }

    window.clearTimeout(request.timer);
    pending.delete(message.requestId);
    request.resolve(message.response);
  });

  function scanActiveRoute() {
    const requestId = nextRequestId();

    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pending.delete(requestId);
        resolve({
          ok: false,
          error: {
            code: "BRIDGE_UNAVAILABLE",
            message: "Reload the route-planner tab once after installing or updating the extension."
          }
        });
      }, 5000);

      pending.set(requestId, { resolve, timer });
      window.postMessage({
        channel: CHANNEL,
        direction: "to-page",
        requestId,
        type: "SCAN_ACTIVE_ROUTE"
      }, window.location.origin);
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "SCAN_ACTIVE_ROUTE") {
      return false;
    }

    scanActiveRoute().then(sendResponse);
    return true;
  });
})();
