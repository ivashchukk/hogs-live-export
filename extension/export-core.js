(function exposeExportCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.HereRouteExporters = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createExportCore() {
  "use strict";

  function formatNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return "";
    }
    return String(number);
  }

  function escapeXml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  }

  function stopLabel(index) {
    let value = index + 1;
    let label = "";
    while (value > 0) {
      value -= 1;
      label = String.fromCharCode(65 + value % 26) + label;
      value = Math.floor(value / 26);
    }
    return label;
  }

  function routeName(snapshot) {
    return typeof snapshot.routeName === "string" && snapshot.routeName.trim()
      ? snapshot.routeName.trim()
      : "Active route";
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

  function filenameForSnapshot(snapshot, date = new Date()) {
    const name = typeof snapshot?.routeName === "string" ? snapshot.routeName.trim() : "";
    if (name) {
      return name.toLowerCase().endsWith(".gpx") ? name : `${name}.gpx`;
    }
    return `route-${timestampForFilename(date)}.gpx`;
  }

  function pointElevation(point, indentation) {
    return Number.isFinite(point.alt)
      ? `\n${indentation}<ele>${escapeXml(formatNumber(point.alt))}</ele>`
      : "";
  }

  function orderedStops(snapshot) {
    const stops = Array.isArray(snapshot.stops)
      ? snapshot.stops.filter((point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng))
      : [];
    if (stops.length >= 2) {
      return stops;
    }
    return [snapshot.points[0], snapshot.points[snapshot.points.length - 1]];
  }

  function distanceMeters(first, second) {
    const toRadians = (value) => value * Math.PI / 180;
    const latitudeDelta = toRadians(second.lat - first.lat);
    const longitudeDelta = toRadians(second.lng - first.lng);
    const firstLatitude = toRadians(first.lat);
    const secondLatitude = toRadians(second.lat);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return 6371008.8 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  }

  function trackPointsWithStops(points, stops) {
    const trackPoints = points.map((point) => ({ ...point }));
    if (stops.length === 0) {
      return trackPoints;
    }

    function applyStop(pointIndex, stopIndex) {
      const original = trackPoints[pointIndex];
      const stop = stops[stopIndex];
      trackPoints[pointIndex] = {
        ...original,
        lat: stop.lat,
        lng: stop.lng,
        alt: Number.isFinite(stop.alt) ? stop.alt : original.alt,
        stopIndex
      };
    }

    applyStop(0, 0);
    if (stops.length === 1) {
      return trackPoints;
    }

    let previousIndex = 0;
    for (let stopIndex = 1; stopIndex < stops.length - 1; stopIndex += 1) {
      const remainingStops = stops.length - stopIndex;
      const searchStart = previousIndex + 1;
      const searchEnd = trackPoints.length - remainingStops;

      if (searchStart > searchEnd) {
        trackPoints.splice(searchStart, 0, { ...stops[stopIndex], stopIndex });
        previousIndex = searchStart;
        continue;
      }

      let nearestIndex = searchStart;
      let nearestDistance = Infinity;
      for (let pointIndex = searchStart; pointIndex <= searchEnd; pointIndex += 1) {
        const candidateDistance = distanceMeters(stops[stopIndex], trackPoints[pointIndex]);
        if (candidateDistance < nearestDistance) {
          nearestDistance = candidateDistance;
          nearestIndex = pointIndex;
        }
      }

      if (nearestDistance <= 50) {
        applyStop(nearestIndex, stopIndex);
        previousIndex = nearestIndex;
      } else {
        trackPoints.splice(nearestIndex, 0, { ...stops[stopIndex], stopIndex });
        previousIndex = nearestIndex;
      }
    }

    applyStop(trackPoints.length - 1, stops.length - 1);
    return trackPoints;
  }

  function stopMetadata(stopIndex, indentation) {
    const label = escapeXml(stopLabel(stopIndex));
    return `\n${indentation}<name>${label}</name>
${indentation}<desc>Route stop ${label}</desc>
${indentation}<type>Route stop</type>`;
  }

  function toGpx(snapshot) {
    const stops = orderedStops(snapshot);
    const waypoints = stops.map((point, index) => {
      const label = escapeXml(stopLabel(index));
      return `  <wpt lat="${escapeXml(formatNumber(point.lat))}" lon="${escapeXml(formatNumber(point.lng))}">${pointElevation(point, "    ")}
    <name>${label}</name>
    <desc>Route stop ${label}</desc>
    <type>Route stop</type>
  </wpt>`;
    }).join("\n");
    const trackPoints = trackPointsWithStops(snapshot.points, stops).map((point) => {
      const elevation = Number.isFinite(point.alt)
        ? `\n        <ele>${escapeXml(formatNumber(point.alt))}</ele>`
        : "";
      const metadata = Number.isInteger(point.stopIndex)
        ? stopMetadata(point.stopIndex, "        ")
        : "";
      if (!elevation && !metadata) {
        return `      <trkpt lat="${escapeXml(formatNumber(point.lat))}" lon="${escapeXml(formatNumber(point.lng))}"></trkpt>`;
      }
      return `      <trkpt lat="${escapeXml(formatNumber(point.lat))}" lon="${escapeXml(formatNumber(point.lng))}">${elevation}${metadata}
      </trkpt>`;
    }).join("\n");

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Route Exporter" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <time>${escapeXml(snapshot.capturedAt)}</time>
  </metadata>
${waypoints}
  <trk>
    <name>${escapeXml(routeName(snapshot))}</name>
    <trkseg>
${trackPoints}
    </trkseg>
  </trk>
</gpx>
`;
  }

  function serialize(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.points) || snapshot.points.length < 2) {
      throw new Error("A route with at least two coordinates is required.");
    }

    return { content: toGpx(snapshot), mimeType: "application/gpx+xml;charset=utf-8" };
  }

  return { escapeXml, filenameForSnapshot, serialize, toGpx };
});
