"""Cuts the four reference characters out of their grey studio backgrounds into assets/*.png.

The background is a smooth gradient, so each row is modelled from the image's left and right
edges, and everything that differs from it and is connected to the border is made transparent.
"""
import sys
import numpy as np
from PIL import Image, ImageFilter

THRESH = 16

def cut(src, dst):
    im = np.asarray(Image.open(src).convert("RGB")).astype(np.float32)
    h, w, _ = im.shape
    left = im[:, 4:40].mean(axis=1)
    right = im[:, w - 40:w - 4].mean(axis=1)
    t = np.linspace(0, 1, w)[None, :, None]
    bg = left[:, None, :] * (1 - t) + right[:, None, :] * t
    near = np.abs(im - bg).max(axis=2) < THRESH
    # The studio floor and the gap between the legs are lit unevenly; treat pale grey in the
    # lower half as background. Skipped for the boy, whose white shirt reaches the bottom half.
    floor = (im.min(axis=2) > 165) & (np.ptp(im, axis=2) < 20)
    floor[: int(h * 0.5)] = False
    if "boy" in src:
        floor[:] = False
    near |= floor

    # Grow the background region inward from the border, through near-background pixels only.
    seen = np.zeros_like(near)
    seen[0, :] = near[0, :]; seen[-1, :] = near[-1, :]; seen[:, 0] = near[:, 0]; seen[:, -1] = near[:, -1]
    while True:
        grown = seen.copy()
        grown[1:] |= seen[:-1]; grown[:-1] |= seen[1:]; grown[:, 1:] |= seen[:, :-1]; grown[:, :-1] |= seen[:, 1:]
        grown &= near
        if (grown == seen).all():
            break
        seen = grown

    # Pale grey in the lower half is floor even where the legs enclose it.
    # Opening the mask first keeps small metal highlights (buckles, zips, watches) opaque.
    big = Image.fromarray((floor * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(15)).filter(ImageFilter.MaxFilter(15))
    seen |= np.asarray(big) > 0
    alpha = Image.fromarray(np.where(seen, 0, 255).astype(np.uint8))
    alpha = alpha.filter(ImageFilter.MinFilter(5)).filter(ImageFilter.GaussianBlur(1.2))
    out = Image.open(src).convert("RGB")
    out.putalpha(alpha)
    out.crop(out.getbbox()).save(dst)
    print(dst, out.getbbox())

for name in sys.argv[1:]:
    cut(f"refs/{name}.jpg", f"assets/{name}.png")
