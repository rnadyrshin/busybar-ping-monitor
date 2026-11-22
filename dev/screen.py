#!/usr/bin/env python3
"""Fetch the BUSY Bar front screen; print it as coloured ASCII and save a scaled PNG."""
import base64, json, sys, urllib.request, zlib, struct
B = "http://10.0.4.20"
raw = urllib.request.urlopen(B + "/api/screen?display=0", timeout=5).read()
try:
    data = base64.b64decode(raw.strip().strip(b'"'))
except Exception:
    data = raw
W, H = 72, 16
if len(data) < W * H * 3:
    sys.exit(f"unexpected screen size {len(data)}")
def px(x, y):
    i = (y * W + x) * 3
    b, g, r = data[i], data[i + 1], data[i + 2]
    return r, g, b
for y in range(H):
    line = ""
    for x in range(W):
        r, g, b = px(x, y)
        if r + g + b == 0: line += "."
        elif r > 150 and g > 150 and b > 150: line += "#"
        elif r > 150 and g > 100: line += "Y"
        elif r > 150: line += "R"
        elif g > 100: line += "G"
        else: line += "+"
    print(line)
if len(sys.argv) > 1:
    S = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    rows = b""
    for y in range(H * S):
        rows += b"\0" + b"".join(bytes(px(x // S, y // S)) for x in range(W * S))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", W * S, H * S, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    open(sys.argv[1], "wb").write(png)
