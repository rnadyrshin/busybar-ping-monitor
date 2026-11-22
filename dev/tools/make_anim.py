#!/usr/bin/env python3
"""
Builds src/animations/link.anim, the intro animation: a link between the bar and the host with a packet running
along it. Run with the venv that has Pillow:  dev/tools/.venv/bin/python dev/tools/make_anim.py

Sections (30 fps, 72x16, ARGB):
  connect  a round trip, looped: a white packet out to the host, a green one back
  ok       the link flashes green and fades, then a scan line wipes from left to right; left of it the frame is
           transparent, so the graph drawn under the animation shows through
  fail     the same in red
The format and the converter come from github.com/busy-app/busybar-firmware: scripts/seq2anim.py and
scripts/flipper/rle.py are downloaded next to this script on the first run and are not part of this repository.
"""
import json
import math
import sys
import urllib.request
from pathlib import Path
from tempfile import TemporaryDirectory

from PIL import Image

HERE = Path(__file__).resolve().parent
FIRMWARE_RAW = "https://raw.githubusercontent.com/busy-app/busybar-firmware/dev/scripts/"
for name in ("seq2anim.py", "flipper/rle.py"):
    target = HERE / name
    if not target.exists():
        print(f"downloading {name} from busybar-firmware")
        target.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(FIRMWARE_RAW + name) as response:
            target.write_bytes(response.read())

sys.path.insert(0, str(HERE))
from seq2anim import BSBAnimConverter  # noqa: E402

W, H = 72, 16
FPS = 30
OUT = Path(__file__).resolve().parents[2] / "src" / "animations" / "link.anim"

LINK_Y = 14
DASH_X, DASH_W, DASH_STEP, DASHES = 5, 10, 13, 5
TRIP = 18  # frames each way
FLASH = 10
WIPE = 14

WHITE = (255, 255, 255)
GREEN = (0, 210, 106)
RED = (255, 59, 48)
DIM = (58, 58, 58)
NODE = (160, 160, 160)


def ease(p):
    return p * p * (3 - 2 * p)


def mix(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def scale(c, f):
    return tuple(round(v * f) for v in c)


class Frame:
    def __init__(self):
        self.px = [[(0, 0, 0, 255)] * W for _ in range(H)]

    def set(self, x, y, c, a=255):
        if 0 <= x < W and 0 <= y < H:
            self.px[y][x] = (*c, a)

    def add(self, x, y, c, k):
        """Blends colour c over the pixel with weight k (0..1)."""
        if 0 <= x < W and 0 <= y < H:
            r, g, b, a = self.px[y][x]
            self.px[y][x] = (*mix((r, g, b), c, k), a)

    def image(self):
        img = Image.new("RGBA", (W, H))
        img.putdata([p for row in self.px for p in row])
        return img


def is_dash(x):
    k = (x - DASH_X) // DASH_STEP
    return x >= DASH_X and k < DASHES and (x - DASH_X) % DASH_STEP < DASH_W


def link(f, dash=DIM, node_a=NODE, node_b=NODE):
    for x in range(W):
        if is_dash(x):
            f.set(x, LINK_Y, dash)
    for y in range(LINK_Y - 1, LINK_Y + 2):
        for x in (0, 1):
            f.set(x, y, node_a)
        for x in (W - 2, W - 1):
            f.set(x, y, node_b)


def packet(f, head, direction, color):
    """A comet with a bright head at float position `head`, a tail fading behind it, anti-aliased."""
    tail = 9
    for i in range(tail + 2):
        pos = head - direction * i
        k = max(0.0, 1 - i / tail) ** 1.6
        x0 = math.floor(pos)
        frac = pos - x0
        for x, w in ((x0, 1 - frac), (x0 + 1, frac)):
            if 2 <= x < W - 2:
                f.add(x, LINK_Y, color, min(1.0, k * w * 1.6))


def connect_frames():
    frames = []
    start, end = 2.0, W - 3.0
    for i in range(2 * TRIP):
        f = Frame()
        out = i < TRIP
        p = ease((i if out else i - TRIP) / (TRIP - 1))
        # A node lights up for a few frames when the packet reaches it.
        hit_b = max(0.0, 1 - abs(i - (TRIP - 1)) / 3)
        hit_a = max(0.0, 1 - min(i, 2 * TRIP - i) / 3)
        link(f, node_a=mix(NODE, GREEN, hit_a), node_b=mix(NODE, WHITE, hit_b))
        if out:
            packet(f, start + (end - start) * p, 1, WHITE)
        else:
            packet(f, end - (end - start) * p, -1, GREEN)
        frames.append(f)
    return frames


def result_frames(color):
    frames = []
    for i in range(FLASH):
        f = Frame()
        c = mix(WHITE, color, min(1.0, i / 2)) if i < 3 else scale(color, 1 - 0.5 * (i - 2) / (FLASH - 3))
        link(f, dash=c, node_a=c, node_b=c)
        frames.append(f)
    last = scale(color, 0.5)
    for i in range(1, WIPE + 1):
        f = Frame()
        fade = 1 - i / WIPE
        c = scale(last, fade)
        link(f, dash=c, node_a=c, node_b=c)
        scan = ease(i / WIPE) * W
        for x in range(W):
            d = x - scan
            for y in range(H):
                if d < -2:
                    f.set(x, y, (0, 0, 0), 0)
                elif d < 1:
                    # The scan line: a bright edge with a short soft trail on the revealed side.
                    k = 1.0 if d >= 0 else (d + 2) / 2
                    f.set(x, y, (255, 255, 255), round(255 * k * (0.9 if d < 0 else 1)))
        frames.append(f)
    return frames


def main():
    connect = connect_frames()
    ok = result_frames(GREEN)
    fail = result_frames(RED)
    frames = connect + ok + fail
    n_c, n_r = len(connect), len(ok)
    meta = {
        "fps": FPS,
        "color_mode": "argb8888",
        "sections": [
            {"name": "connect", "start": 0, "end": n_c - 1},
            {"name": "ok", "start": n_c, "end": n_c + n_r - 1},
            {"name": "fail", "start": n_c + n_r, "end": n_c + 2 * n_r - 1},
        ],
    }
    with TemporaryDirectory() as tmp:
        d = Path(tmp)
        for i, f in enumerate(frames):
            f.image().save(d / f"frame_{i}.png")
        (d / "meta.json").write_text(json.dumps(meta))
        OUT.parent.mkdir(parents=True, exist_ok=True)
        info = BSBAnimConverter().convert_dir(d, OUT)
    print(f"{OUT}: {OUT.stat().st_size} bytes, {info.frame_cnt} frames; "
          f"connect {n_c / FPS:.2f}s loop, ok/fail {n_r / FPS:.2f}s ({FLASH / FPS:.2f}s flash)")


if __name__ == "__main__":
    main()
