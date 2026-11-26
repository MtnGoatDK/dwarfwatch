"""Turns the recorded frames (tools/demo/frames/*.png) into the README's demo.gif.

    python tools/demo/make_gif.py [crop]      crop: share of the frame height to keep (default 0.9)

Crops off the empty rock below the tunnels, halves the size (the browser records at 2x; nearest
neighbour, so the pixel art stays crisp), and quantizes every frame with one shared palette so the
colours don't flicker. Needs Pillow (pip install pillow).
"""
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / "demo.gif"
FPS = 12

files = sorted((HERE / "frames").glob("*.png"))
if not files:
    sys.exit("no frames in " + str(HERE / "frames") + " - record some first (see serve.py)")
keep = float(sys.argv[1]) if len(sys.argv) > 1 else 0.9
W, H = Image.open(files[0]).size
crop = (0, 0, W, int(H * keep))
size = (W // 2, crop[3] // 2)
frames = [Image.open(f).convert("RGB").crop(crop).resize(size, Image.NEAREST) for f in files]

# one palette from frames spread across the run (day, sunset, night and sunrise)
picks = frames[:: max(1, len(frames) // 14)]
sheet = Image.new("RGB", (size[0], size[1] * len(picks)))
for i, frame in enumerate(picks):
    sheet.paste(frame, (0, i * size[1]))
palette = sheet.quantize(colors=255, method=Image.Quantize.MEDIANCUT)

gif = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames]
gif[0].save(OUT, save_all=True, append_images=gif[1:], duration=round(1000 / FPS), loop=0, optimize=True, disposal=1)
print(f"{len(gif)} frames, {size[0]}x{size[1]}, {OUT.stat().st_size / 1e6:.1f} MB -> {OUT}")
