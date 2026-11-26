"""Builds icon.ico (and icon.png, a 256 px preview) for the Dwarfwatch overlay.

The icon is a 16 x 16 pixel-art dwarf head in the mine's style: miner's helmet with a lamp, ginger
beard. Each size in the .ico is that grid scaled up by a whole number, so the pixels stay crisp.
No dependencies: PNG and ICO are written by hand.  Run:  python make_icon.py
"""
import struct
import zlib
from pathlib import Path

GRID = [
    "......KKKK......",
    "....KKhLLhKK....",
    "...KhhhLLhhHK...",
    "..KhHHHHHHHHHK..",
    ".KDDDDDDDDDDDDK.",
    ".KKSSSSSSSSSSKK.",
    "..KSEESSSSEESK..",
    "..KSSSSNNSSSSK..",
    "..KBSSNNNNSSBK..",
    ".KBBBwBNNBwBBBK.",
    ".KBBwBBBBBBwBBK.",
    ".KbBBBBwwBBBBbK.",
    "..KbBBBBBBBBbK..",
    "...KbBBBBBBbK...",
    "....KKbBBbKK....",
    "......KKKK......",
]

PALETTE = {
    "K": "#1b1410",  # outline
    "h": "#b8bec7",  # helmet highlight
    "H": "#8d939d",  # helmet
    "D": "#5f646d",  # brim
    "L": "#ffd75e",  # lamp
    "S": "#f0c08a",  # skin
    "E": "#2b1d14",  # eyes
    "N": "#e1a067",  # nose
    "B": "#b5652b",  # beard
    "b": "#8a4a1d",  # beard shade
    "w": "#d98a45",  # beard highlight
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
    print("wrote icon.ico (" + ", ".join(map(str, SIZES)) + " px) and icon.png")
