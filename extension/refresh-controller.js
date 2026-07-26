(function exposeRefreshController(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.HereRouteRefresh = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createRefreshApi() {
  "use strict";

  function createRefreshController(options) {
    const scan = options.scan;
    const onPending = options.onPending || (() => {});
    const onStart = options.onStart || (() => {});
    const onResult = options.onResult || (() => {});
    const onError = options.onError || (() => {});
    const schedule = options.setTimeout || globalThis.setTimeout.bind(globalThis);
    const cancel = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    const changeDebounceMs = options.changeDebounceMs ?? 250;
    const fallbackMs = options.fallbackMs ?? 3000;

    let stopped = true;
    let running = false;
    let generation = 0;
    let queuedReason = null;
    let debounceTimer = null;
    let fallbackTimer = null;

    function clearTimer(timer) {
      if (timer !== null) {
        cancel(timer);
      }
    }

    function clearFallback() {
      clearTimer(fallbackTimer);
      fallbackTimer = null;
    }

    function clearDebounce() {
      clearTimer(debounceTimer);
      debounceTimer = null;
    }

    function reasonPriority(reason) {
      return { fallback: 0, initial: 1, change: 2, manual: 3 }[reason] ?? 0;
    }

    function queue(reason) {
      if (!queuedReason || reasonPriority(reason) > reasonPriority(queuedReason)) {
        queuedReason = reason;
      }
    }

    function scheduleFallback() {
      clearFallback();
      if (stopped || running || fallbackMs <= 0) {
        return;
      }
      fallbackTimer = schedule(() => {
        fallbackTimer = null;
        void execute("fallback");
      }, fallbackMs);
    }

    async function execute(reason) {
      if (stopped) {
        return;
      }
      if (running) {
        queue(reason);
        return;
      }

      running = true;
      clearFallback();
      const scanGeneration = generation;
      onStart(reason);

      try {
        const result = await scan(reason);
        if (!stopped && scanGeneration === generation) {
          onResult(result, reason);
        }
      } catch (error) {
        if (!stopped && scanGeneration === generation) {
          onError(error, reason);
        }
      } finally {
        running = false;
        if (stopped) {
          return;
        }

        if (queuedReason) {
          const nextReason = queuedReason;
          queuedReason = null;
          void execute(nextReason);
        } else {
          scheduleFallback();
        }
      }
    }

    function start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      generation += 1;
      onPending("initial");
      void execute("initial");
    }

    function notifyChanged() {
      if (stopped) {
        return;
      }
      generation += 1;
      onPending("change");
      clearDebounce();
      debounceTimer = schedule(() => {
        debounceTimer = null;
        void execute("change");
      }, changeDebounceMs);
    }

    function refreshNow() {
      if (stopped) {
        return;
      }
      generation += 1;
      onPending("manual");
      clearDebounce();
      clearFallback();
      void execute("manual");
    }

    function stop() {
      stopped = true;
      generation += 1;
      queuedReason = null;
      clearDebounce();
      clearFallback();
    }

    return { notifyChanged, refreshNow, start, stop };
  }

  return { createRefreshController };
});
