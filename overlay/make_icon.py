"""Builds icon.ico (and icon.png, a 256 px preview) for the Dwarfwatch overlay.

The icon is the lead dwarf from the mine (mine.js, BODY): head and shoulders, facing right, with the
miner's helmet and its lamp and the big ginger beard, in the game's colours and with its dark outline,
on a 16 x 16 grid. Each size in the .ico is that grid scaled up by a whole number, so the pixels stay
crisp. No dependencies: PNG and ICO are written by hand.  Run:  python make_icon.py
"""
import struct
import zlib
from pathlib import Path

# The dwarf's body rows from mine.js (helmet, face, beard, arms and the tunic hem); the legs are left
# out, so it reads as a portrait.
BODY = [
    ".....qq...",
    "...HhLlq..",
    "..HHHYYH..",
    "..HhhhhhH.",
    "..BseseB..",
    "..BBbubB..",
    "..BbbBBbB.",
    ".TTBbbbbT.",
    "TtTBbbbbBT",
    "TtTTBbbBtT",
    "TSSTTBBTST",
    ".TTkkkkkT.",
]


def build_grid():
    """BODY with a one-pixel dark outline, placed on a 16 x 16 grid."""
    size, ox, oy = 16, 3, 2
    grid = [["."] * size for _ in range(size)]
    filled = lambda x, y: 0 <= y < len(BODY) and 0 <= x < len(BODY[y]) and BODY[y][x] != "."
    for y in range(-1, len(BODY) + 1):
        for x in range(-1, len(BODY[0]) + 1):
            gx, gy = x + ox, y + oy
            if not (0 <= gx < size and 0 <= gy < size):
                continue
            if filled(x, y):
                grid[gy][gx] = BODY[y][x]
            elif any(filled(x + a, y + b) for a, b in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                grid[gy][gx] = "K"
    return ["".join(r) for r in grid]


GRID = build_grid()

# the game's default colours (a steel helmet, so it shows on a dark taskbar)
PALETTE = {
    "K": "#140d09",  # outline
    "H": "#58606c",  # helmet
    "h": "#8a929e",  # helmet brim and highlight
    "q": "#8a8d8f",  # lamp housing
    "L": "#fdea46",  # lamp
    "l": "#fcf59f",  # lamp glint
    "Y": "#edbc36",  # lamp rim
    "s": "#d5a076",  # skin
    "S": "#bb8565",  # hands
    "e": "#212b33",  # eyes
    "u": "#d48e69",  # nose, a little redder than the skin
    "b": "#c96e26",  # beard
    "B": "#a1581e",  # beard shadow
    "t": "#6a5f53",  # tunic
    "T": "#49423a",  # tunic shadow
    "k": "#6f6457",  # tunic hem
}

SIZES = [16, 32, 48, 64, 128, 256]


def rgba(ch):
    if ch == ".":
        return (0, 0, 0, 0)
    c = PALETTE[ch]
    return (int(c[1:3], 16), int(c[3:5], 16), int(c[5:7], 16), 255)


def png(size):
    k = size // len(GRID)
    rows = []
    for y in range(size):
        line = GRID[y // k]
        row = bytearray([0])  # filter: none
        for x in range(size):
            row += bytes(rgba(line[x // k]))
        rows.append(bytes(row))

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(b"".join(rows), 9)) + chunk(b"IEND", b""))


def ico(images):
    out = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    for size, data in images:
        dim = 0 if size >= 256 else size  # 0 means 256 in an ICO directory entry
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return out + b"".join(data for _, data in images)


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    images = [(s, png(s)) for s in SIZES]
    (here / "icon.ico").write_bytes(ico(images))
    (here / "icon.png").write_bytes(images[-1][1])
    print("\n".join(GRID))
    print("wrote icon.ico (" + ", ".join(map(str, SIZES)) + " px) and icon.png")
