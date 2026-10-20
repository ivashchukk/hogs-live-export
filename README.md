# Route Exporter

A privacy-focused Chromium extension that exports the route currently selected in Google Maps, HOGS, IMPARGO, or Webfleet as a standards-compliant GPX 1.1 file. It reads the route geometry already loaded by the map, preserves ordered stops, and generates a road-following track locally. It does not send routing requests or access authentication tokens.

## Install

1. Open `chrome://extensions` in Chrome, Brave, Edge, Opera, or Vivaldi.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select the `extension` directory from this project.
4. Reload any supported route-planner tab that was already open.

## Use

1. Open Google Maps at `https://www.google.com/maps/` or `https://www.google.pl/maps/`, HOGS at `https://app.hogs.live/map`, IMPARGO at `https://apps.impargo.de/`, or Webfleet at `https://live-wf.webfleet.com/web/map` and calculate or select a route.
2. Select the desired route in the route planner.
3. Click **Route Exporter** in the browser toolbar.
4. Download the GPX file.

The popup exports only the active route. On HOGS and IMPARGO it identifies the selected HERE geometry, excludes overlays, and joins every connected selected leg. On Webfleet it reads the dedicated selected-route Leaflet layer and orders its start, intermediate, and end markers along the dense track. Map changes trigger a stabilized refresh, with a low-frequency fallback scan while the popup is open. The **Refresh route** control forces the same live scan. If the active route cannot be identified safely, the extension stops instead of combining unrelated lines. GPX includes every detected stop as a waypoint and a named position in the dense road-following track; it deliberately omits a separate route layer so viewers do not draw straight connector lines over the road geometry. Webfleet downloads use the selected route's name, such as `1739.gpx`.

Google Maps supports driving, walking, and cycling directions on `www.google.com` and `www.google.pl`. Select the desired alternative in the directions panel before exporting. The extension reads that route's full coordinate sequence from Maps' loaded directions data, including intermediate destinations and dragged via points. It observes route recalculation and checks the selected route again before download. Transit directions and Google My Maps are outside this release's scope. Google Maps downloads use the start and destination names. If Google changes its internal data format, export stops with an error instead of guessing a track.

The popup shows a local preview of the selected route, its track distance, stop and point counts, and start and destination. Preview geometry is simplified only for display; the GPX keeps the full coordinate sequence. No map tiles or external fonts are downloaded.

## Version 1.0.0

- Added Google Maps GPX export with selected alternatives, intermediate stops, and dragged via points.
- Retained HOGS, IMPARGO, and Webfleet support.
- Refreshed the popup with a route preview, readable endpoints, and matching icons at every browser size.
- Major version bump from 0.2.0 to 1.0.0.

## Development

Run the dependency-free tests:

```sh
npm test
```

Create the distributable archive:

```sh
npm run package
```

The resulting file is `dist/route-exporter.zip`. Packaging starts inside `extension`, so project files outside that directory cannot be included.

Rebuild the vector artwork, browser icons, and Chrome Web Store icon with `python3 scripts/build-store-icon.py` (requires Pillow). The generated master artwork is in `assets/route-exporter.svg` and `assets/route-exporter.png`.

The interface uses original artwork and layouts informed by the route summaries in [Waymo](https://mobbin.com/screens/1514b2bd-77c3-49c4-bcd8-27f22d46fe42) and [inDrive](https://mobbin.com/screens/7f7c7ccb-96f7-4e90-b3f1-1c60be362dca), and the export hierarchy in [Arcade](https://mobbin.com/screens/62d933ba-86b9-412a-87f8-17af42f21fd3), viewed on Mobbin.

## Privacy and scope

- Version 1.0.0 supports `www.google.com/maps/`, `www.google.pl/maps/`, `app.hogs.live`, `apps.impargo.de`, and `live-wf.webfleet.com`.
- Processing and file creation happen entirely in the browser.
- No analytics, storage, background network calls, or external conversion services are used.
- The public-facing extension policy is available in [`privacy-policy.html`](privacy-policy.html).
- `requests.txt` contains sensitive captured request headers. Keep it private and revoke or refresh the captured HOGS session before sharing this project.
