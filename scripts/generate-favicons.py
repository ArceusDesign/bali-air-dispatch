#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────────────────
# Favicon build script.
#
# Source artwork lives OUTSIDE this repo (the operator's own working directory,
# not committed). Pass its path via the FAVICON_SOURCE environment variable to
# regenerate. This script produces
# two distinct outputs from that one source, per owner decision 28 Aug 2026:
#
#   TAB ICONS (favicon.ico, favicon-16x16.png, favicon-32x32.png)
#     The pagoda+wind MARK ALONE, redrawn onto a fresh circular badge — no
#     wordmark. At 16-32px the full logo's "Bali Air Dispatch" text is an
#     illegible smudge and the original artwork's ~4px ring (relative to a
#     630px source) anti-aliases away to nothing at those sizes. The ring here
#     is redrawn at ~4.5% of canvas width specifically so it survives
#     downsampling to 16px, and the mark is re-centered on its own tight
#     content bbox with generous padding — naively cropping+scaling the
#     original left the mark closer to one edge of the circle than the other.
#
#   HOME-SCREEN ICONS (apple-touch-icon.png, icon-192.png, icon-512.png)
#     The complete original logo, wordmark included. These render at 180px+,
#     where the full lockup is legible and desirable.
#
# Re-run this whenever the source artwork changes. Requires Pillow + numpy.
# ─────────────────────────────────────────────────────────────────────────────
import os
import sys

import numpy as np
from PIL import Image, ImageDraw

# Path to the master logo PNG. Lives outside the repo and differs per machine,
# so it is taken from the environment rather than hardcoded:
#   FAVICON_SOURCE=/path/to/BaliAirFavicon.png python3 scripts/generate-favicons.py
SOURCE = os.environ.get('FAVICON_SOURCE')
OUT = 'public'

BG = (244, 237, 219, 255)          # the logo's own cream
INK = (13, 12, 6, 255)             # the logo's own near-black
GLYPH_BOX = (224, 88, 438, 315)    # ink bbox of the pagoda+wind mark within
                                    # SOURCE, excluding the circle ring and the
                                    # wordmark below it. Re-measure if the
                                    # source artwork changes.


def make_home_screen_icons(src):
    side = min(src.size)
    left = (src.width - side) // 2
    top = (src.height - side) // 2
    full = src.crop((left, top, left + side, top + side)).resize((1024, 1024), Image.LANCZOS)
    full.resize((180, 180), Image.LANCZOS).save(f'{OUT}/apple-touch-icon.png')
    full.resize((192, 192), Image.LANCZOS).save(f'{OUT}/icon-192.png')
    full.resize((512, 512), Image.LANCZOS).save(f'{OUT}/icon-512.png')


def make_tab_icons(src):
    glyph = src.crop(GLYPH_BOX)
    arr = np.array(glyph).astype(int)
    # Cream -> transparent, ink -> opaque, so the paste below composites onto
    # the ring instead of stamping a solid rectangle over part of it.
    dist = np.sqrt(((arr[:, :, :3] - np.array(BG[:3])) ** 2).sum(axis=2))
    arr[:, :, 3] = np.clip((dist - 15) * 8, 0, 255).astype('uint8')
    glyph_t = Image.fromarray(arr.astype('uint8'), 'RGBA')

    canvas_px = 1024
    ring_w = int(canvas_px * 0.045)
    pad_in = int(canvas_px * 0.11)

    canvas = Image.new('RGBA', (canvas_px, canvas_px), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.ellipse([0, 0, canvas_px - 1, canvas_px - 1], fill=BG)
    draw.ellipse([ring_w / 2, ring_w / 2, canvas_px - 1 - ring_w / 2, canvas_px - 1 - ring_w / 2],
                 outline=INK, width=ring_w)

    gw, gh = glyph_t.size
    avail = canvas_px - 2 * (ring_w + pad_in)
    scale = avail / max(gw, gh)
    nw, nh = int(gw * scale), int(gh * scale)
    glyph_r = glyph_t.resize((nw, nh), Image.LANCZOS)
    canvas.paste(glyph_r, ((canvas_px - nw) // 2, (canvas_px - nh) // 2), glyph_r)

    canvas.resize((16, 16), Image.LANCZOS).save(f'{OUT}/favicon-16x16.png')
    canvas.resize((32, 32), Image.LANCZOS).save(f'{OUT}/favicon-32x32.png')
    canvas.save(f'{OUT}/favicon.ico', format='ICO', sizes=[(16, 16), (32, 32), (48, 48)])


if __name__ == '__main__':
    if not SOURCE or not os.path.isfile(SOURCE):
        sys.exit('set FAVICON_SOURCE to the master logo PNG (see header comment)')
    src = Image.open(SOURCE).convert('RGBA')
    make_tab_icons(src)
    make_home_screen_icons(src)
    print('favicons written to', OUT)
