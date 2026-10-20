#!/usr/bin/env python3
"""Build the Route Exporter vector mark and crisp icons for each browser size."""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
BACKGROUND = "#174f3b"
ROUTE = "#ffffff"
START = "#d8ed9d"
SCALE = 8

# A straight stem below a solid arrowhead keeps it distinct from the bend at 16px.
ROUTE_PATH = "M32 94V90C32 81 40 74 50 74H70C81 74 90 65 90 54V34"
ARROW_POINTS = ((76, 40), (90, 26), (104, 40))


def main() -> None:
    artwork = Image.new("RGBA", (128 * SCALE, 128 * SCALE))
    draw = ImageDraw.Draw(artwork)
    draw.rounded_rectangle((0, 0, 128 * SCALE - 1, 128 * SCALE - 1), radius=29 * SCALE, fill=BACKGROUND)
    points = [(32, 94), (32, 90)]
    for start, control1, control2, end in [
        ((32, 90), (32, 81), (40, 74), (50, 74)),
        ((70, 74), (81, 74), (90, 65), (90, 54)),
    ]:
        points.append(start)
        for step in range(1, 49):
            t = step / 48
            points.append(tuple((1 - t) ** 3 * start[i] + 3 * (1 - t) ** 2 * t * control1[i]
                                + 3 * (1 - t) * t ** 2 * control2[i] + t ** 3 * end[i] for i in range(2)))
    points.append((90, 34))

    def stroke(path: list[tuple[float, float]]) -> None:
        draw.line([(round(x * SCALE), round(y * SCALE)) for x, y in path], fill=ROUTE, width=9 * SCALE, joint="curve")
        for x, y in path:
            draw.ellipse(((x - 4.5) * SCALE, (y - 4.5) * SCALE, (x + 4.5) * SCALE, (y + 4.5) * SCALE), fill=ROUTE)

    stroke(points)
    draw.polygon([(x * SCALE, y * SCALE) for x, y in ARROW_POINTS], fill=ROUTE)
    draw.ellipse((21 * SCALE, 83 * SCALE, 43 * SCALE, 105 * SCALE), fill=START)
    for size in (16, 32, 48, 128):
        output = ROOT / "extension" / "icons" / f"route-exporter-{size}.png"
        artwork.resize((size, size), Image.Resampling.LANCZOS).save(output, optimize=True)

    artwork.resize((512, 512), Image.Resampling.LANCZOS).save(ROOT / "assets" / "route-exporter.png", optimize=True)
    artwork.save(ROOT / "assets" / "route-exporter.ico", sizes=[(16, 16), (32, 32), (48, 48), (128, 128), (256, 256)])
    store_icon = Image.new("RGBA", (128, 128))
    store_icon.alpha_composite(artwork.resize((96, 96), Image.Resampling.LANCZOS), (16, 16))
    store_icon.save(ROOT / "assets" / "chrome-web-store" / "route-exporter-icon-128.png", optimize=True)
    (ROOT / "assets" / "route-exporter.svg").write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="29" fill="{BACKGROUND}"/>
  <path d="{ROUTE_PATH}" fill="none" stroke="{ROUTE}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
  <polygon points="{' '.join(f'{x},{y}' for x, y in ARROW_POINTS)}" fill="{ROUTE}"/>
  <circle cx="32" cy="94" r="11" fill="{START}"/>
</svg>
''')


if __name__ == "__main__":
    main()
