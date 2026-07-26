#!/usr/bin/env python3
"""Build the Chrome Web Store icon from the project artwork."""

from collections import deque
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "hogs-route-exporter.png"
OUTPUTS = (
    ROOT / "assets" / "chrome-web-store" / "hogs-route-exporter-icon-128.png",
    ROOT / "extension" / "icons" / "hogs-route-exporter-128.png",
)

ARTWORK_SIZE = 96
CANVAS_SIZE = 128
PADDING = (CANVAS_SIZE - ARTWORK_SIZE) // 2


def remove_connected_white_background(image: Image.Image) -> Image.Image:
    """Recover transparency from the white background around the rounded tile."""
    source = image.convert("RGBA")
    pixels = source.load()
    width, height = source.size
    queue = deque()
    visited = set()

    for x in range(width):
        queue.extend(((x, 0), (x, height - 1)))
    for y in range(height):
        queue.extend(((0, y), (width - 1, y)))

    while queue:
        x, y = queue.popleft()
        if (x, y) in visited:
            continue

        red, green, blue, _ = pixels[x, y]
        if red <= 8:
            continue

        visited.add((x, y))
        alpha = (255 - red) / 255
        if alpha <= 0:
            pixels[x, y] = (0, 0, 0, 0)
        else:
            # Undo the original blend against white to prevent a light halo.
            recovered_green = round((green - red) / alpha)
            recovered_blue = round((blue - red) / alpha)
            pixels[x, y] = (
                0,
                max(0, min(255, recovered_green)),
                max(0, min(255, recovered_blue)),
                round(alpha * 255),
            )

        for next_x, next_y in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
            if 0 <= next_x < width and 0 <= next_y < height:
                queue.append((next_x, next_y))

    return source


def main() -> None:
    source = remove_connected_white_background(Image.open(SOURCE))
    artwork = source.resize(
        (ARTWORK_SIZE, ARTWORK_SIZE),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    canvas.alpha_composite(artwork, (PADDING, PADDING))

    for output in OUTPUTS:
        output.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(output, optimize=True)


if __name__ == "__main__":
    main()
