# HOGS Route Exporter

A privacy-focused Chromium extension that exports the route currently selected in HOGS as a standards-compliant GPX 1.1 file. It reads the exact geometry already rendered by HERE Maps; it does not call HOGS or HERE APIs and does not access authentication tokens.

## Install

1. Open `chrome://extensions` in Chrome, Brave, Edge, Opera, or Vivaldi.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the `extension` directory from this project.
4. Reload any HOGS tab that was already open.

## Use

1. Open `https://app.hogs.live/map` and calculate a route.
2. Select the desired route in the HOGS route panel.
3. Click **HOGS Route Exporter** in the browser toolbar.
4. Download the GPX file.

The popup exports only the active route. It identifies the distinct rendered color, excludes short map overlays, and joins every connected selected leg in a multipoint route. Ordered HOGS waypoint markers—or ordered URL coordinates when available—orient the output from A through each intermediate stop to the final point. Marker groups must match the selected track's endpoints and traversal order, preventing toll and timing overlays from being mistaken for stops. HERE map changes trigger a stabilized refresh, with a low-frequency fallback scan while the popup is open. The **Refresh route** control forces the same live scan without reloading HOGS. If alternatives cannot be distinguished safely, the extension stops instead of combining them. GPX includes every HOGS stop as a waypoint and a named position in the dense road-following track; it deliberately omits a separate route layer so viewers do not draw straight connector lines over the road geometry.

## Development

Run the dependency-free tests:

```sh
npm test
```

Create the distributable archive:

```sh
npm run package
```

The resulting file is `dist/hogs-route-exporter.zip`. Packaging starts inside `extension`, so `requests.txt` and other project files cannot be included.

## Privacy and scope

- Version 0.1.8 supports `app.hogs.live` only.
- Processing and file creation happen entirely in the browser.
- No analytics, storage, background network calls, or external conversion services are used.
- The public-facing extension policy is available in [`privacy-policy.html`](privacy-policy.html).
- `requests.txt` contains sensitive captured request headers. Keep it private and revoke or refresh the captured HOGS session before sharing this project.
