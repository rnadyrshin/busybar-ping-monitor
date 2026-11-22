#!/usr/bin/env python3
"""
Builds the app icons: dev/tools/.venv/bin/python dev/tools/make_icons.py
  icon_front_8x8.png    colour, the graph in miniature: a low green line with a yellow and a red spike
  icon_back_11x11.png   the same shape in the single grey (#888888) the back screen expects
"""
from pathlib import Path

from PIL import Image

OUT = Path(__file__).resolve().parents[2] / "src" / "appmeta"
GREEN, YELLOW, RED, GREY = (0, 210, 106), (255, 196, 0), (255, 59, 48), (136, 136, 136)


def bars(size, heights, colors, name):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    for x, (h, c) in enumerate(zip(heights, colors)):
        for y in range(size - h, size):
            img.putpixel((x, y), (*c, 255))
    img.save(OUT / name)


G, Y, R = GREEN, YELLOW, RED
bars(8, [2, 3, 2, 3, 2, 5, 8, 3], [G, G, G, G, G, Y, R, G], "icon_front_8x8.png")
bars(11, [3, 4, 3, 4, 3, 3, 7, 11, 4, 3, 4], [GREY] * 11, "icon_back_11x11.png")
