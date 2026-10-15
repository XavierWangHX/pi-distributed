#!/usr/bin/env python3
"""Generate assets/logo.svg — the "Pi-Distributed" wordmark.

Style: heavy grotesque letters in the foreground color, with single strokes
recolored in the brand purple (P stem, D stem, the i dots, the t crossbars)
and the hyphen replaced by a slanted purple bar. Recoloring is done by
re-drawing the glyph clipped to a measured band, so the purple always lands
exactly on a real stroke.

Usage: python3 scripts/generate-logo.py
"""

import os

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont

FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
TEXT = "Pi-Distributed"
EM = 100.0  # final svg units per em
SAMPLES = 24  # polyline segments per curve

INK_LIGHT, INK_DARK = "#101014", "#f5f5f7"
ACC_LIGHT, ACC_DARK = "#9c27b0", "#c084fc"

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "assets", "logo.svg")


def flatten(ops):
    """RecordingPen ops -> list of subpaths, each a list of (x, y) font units."""
    subs, cur = [], []

    def seg(p0, p1, p2, n=SAMPLES):
        return [
            (
                (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
                (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
            )
            for t in [i / n for i in range(1, n + 1)]
        ]

    for op, args in ops:
        if op == "moveTo":
            cur = [args[0]]
            subs.append(cur)
        elif op == "lineTo":
            cur.append(args[0])
        elif op == "qCurveTo":
            *offs, on = args
            pts = [cur[-1]] + list(offs) + [on]
            # implicit on-points between consecutive off-points
            while len(pts) > 3:
                p0, p1, p2 = pts[0], pts[1], (
                    (pts[1][0] + pts[2][0]) / 2,
                    (pts[1][1] + pts[2][1]) / 2,
                )
                cur.extend(seg(p0, p1, p2))
                pts = [p2] + pts[2:]
            cur.extend(seg(*pts[:3]))
        elif op == "curveTo":
            p0, p1, p2, p3 = cur[-1], *args
            for i in range(1, SAMPLES + 1):
                t = i / SAMPLES
                cur.append(
                    (
                        (1 - t) ** 3 * p0[0]
                        + 3 * (1 - t) ** 2 * t * p1[0]
                        + 3 * (1 - t) * t * t * p2[0]
                        + t**3 * p3[0],
                        (1 - t) ** 3 * p0[1]
                        + 3 * (1 - t) ** 2 * t * p1[1]
                        + 3 * (1 - t) * t * t * p2[1]
                        + t**3 * p3[1],
                    )
                )
        elif op in ("closePath", "endPath"):
            if cur and cur[0] != cur[-1]:
                cur.append(cur[0])
    return [s for s in subs if len(s) > 1]


def runs_at(subs, y):
    """Ink intervals [x0, x1] on the horizontal line y (even-odd rule)."""
    xs = []
    for sub in subs:
        for (x0, y0), (x1, y1) in zip(sub, sub[1:]):
            if (y0 <= y < y1) or (y1 <= y < y0):
                xs.append(x0 + (x1 - x0) * (y - y0) / (y1 - y0))
    xs.sort()
    return list(zip(xs[0::2], xs[1::2]))


def main():
    font = TTFont(FONT_PATH)
    upm = font["head"].unitsPerEm
    ascent = font["hhea"].ascent
    cmap = font.getBestCmap()
    glyphs = font.getGlyphSet()
    xheight = getattr(font["OS/2"], "sxHeight", None)
    if not xheight:  # old OS/2 versions: measure from the x glyph
        bp = BoundsPen(glyphs)
        glyphs[cmap[ord("x")]].draw(bp)
        xheight = bp.bounds[3]
    hmtx = font["hmtx"]
    kern = {}
    if "kern" in font:
        kern = font["kern"].kernTables[0].kernTable

    def tx(x, pen):  # font units -> svg units
        return round((pen + x) / upm * EM, 2)

    def ty(y):
        return round((ascent - y) / upm * EM, 2)

    # lay out glyphs
    laid = []  # (char, pen, subpaths in font units, bounds)
    pen = 0.0
    prev = None
    for ch in TEXT:
        name = cmap[ord(ch)]
        if prev is not None:
            pen += kern.get((prev, name), 0)
        rec = RecordingPen()
        glyphs[name].draw(rec)
        bp = BoundsPen(glyphs)
        glyphs[name].draw(bp)
        laid.append((ch, pen, flatten(rec.value), bp.bounds))
        pen += hmtx[name][0]
        prev = name

    def sub_svg(subs, pen):
        d = "M" + " L".join(
            f"{tx(x, pen)} {ty(y)}" for x, y in [subs[0][0]] + [p for p in subs[0][1:]]
        )
        out = [d]
        for sub in subs[1:]:
            out.append(
                "M"
                + " L".join(f"{tx(x, pen)} {ty(y)}" for x, y in sub)
            )
        return " ".join(out) + " Z"

    # --- measure accent bands (font units, local to each glyph) ---
    bands = []  # (glyph index, rect x0, y0, x1, y1)

    def stem_band(subs, bounds):
        best = None
        y = bounds[1] + 0.02 * upm
        while y < bounds[3] - 0.02 * upm:
            r = runs_at(subs, y)
            if r:
                w = r[0][1] - r[0][0]
                if best is None or w < best[0]:
                    best = (w, r[0][0])
            y += upm / 200
        w, x0 = best
        return (x0 - 1, bounds[1] - upm, x0 + w + 1, bounds[3] + upm)

    def dot_band(subs, bounds):
        y = xheight + 0.02 * upm
        while y < bounds[3] and not runs_at(subs, y):
            y += upm / 400
        return (bounds[0] - upm, y - 2, bounds[2] + upm, bounds[3] + upm)

    def crossbar_band(subs, bounds):
        stem = stem_band(subs, bounds)
        stem_w = stem[2] - stem[0]
        spans = []
        y = bounds[1] + 0.02 * upm
        while y < bounds[3]:
            r = runs_at(subs, y)
            if r:
                spans.append((y, r[0][0], r[-1][1]))
            y += upm / 400
        maxspan = max(x1 - x0 for _, x0, x1 in spans)
        bar = [s for s in spans if s[2] - s[1] >= 0.85 * maxspan]
        return (
            min(x0 for _, x0, _ in bar) - 1,
            bar[0][0] - 1,
            max(x1 for _, _, x1 in bar) + 1,
            bar[-1][0] + 1,
        ), stem_w

    for i, (ch, pen, subs, bounds) in enumerate(laid):
        if ch in "PD":
            bands.append((i, *stem_band(subs, bounds)))
        elif ch == "i":
            bands.append((i, *dot_band(subs, bounds)))
        elif ch == "t":
            (x0, y0, x1, y1), _ = crossbar_band(subs, bounds)
            bands.append((i, x0, y0, x1, y1))

    # --- hyphen: slanted purple bar in the hyphen's slot ---
    hi = [i for i, (ch, *_) in enumerate(laid) if ch == "-"][0]
    hx0, hy0, hx1, hy1 = laid[hi][3]
    sl = 0.10 * upm  # italic-ish slant, top edge shifted right
    hyphen_pts = [
        (hx0, hy0),
        (hx1, hy0),
        (hx1 + sl, hy1),
        (hx0 + sl, hy1),
    ]

    # --- emit svg ---
    paths = [
        (i, sub_svg(subs, pen))
        for i, (ch, pen, subs, _) in enumerate(laid)
        if ch != "-"
    ]
    # viewBox from ink bounds + hyphen shape
    allx, ally = [], []
    for ch, pen, subs, b in laid:
        if ch == "-":
            pts = hyphen_pts
        else:
            pts = [(b[0], b[1]), (b[2], b[3])]
        allx += [tx(x, pen) for x, _ in pts]
        ally += [ty(y) for _, y in pts]
    pad = 4
    vx, vy = min(allx) - pad, min(ally) - pad
    vw, vh = max(allx) - min(allx) + 2 * pad, max(ally) - min(ally) + 2 * pad

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vx} {vy} {round(vw,2)} {round(vh,2)}" role="img" aria-label="{TEXT}">',
        "<style>",
        f".ink{{fill:{INK_LIGHT}}}.acc{{fill:{ACC_LIGHT}}}",
        f"@media (prefers-color-scheme: dark){{.ink{{fill:{INK_DARK}}}.acc{{fill:{ACC_DARK}}}}}",
        "</style>",
        f'<g class="ink">',
    ]
    out += [f'<path d="{d}"/>' for i, d in paths]
    out.append("</g>")
    for n, (i, x0, y0, x1, y1) in enumerate(bands):
        pen = laid[i][1]
        rx, ry = tx(x0, pen), ty(y1)
        rw, rh = round((x1 - x0) / upm * EM, 2), round((y1 - y0) / upm * EM, 2)
        out.append(f'<clipPath id="a{n}"><rect x="{rx}" y="{ry}" width="{rw}" height="{rh}"/></clipPath>')
    for n, (i, x0, y0, x1, y1) in enumerate(bands):
        d = [d for j, d in paths if j == i][0]
        out.append(f'<g class="acc" clip-path="url(#a{n})"><path d="{d}"/></g>')
    out.append(
        '<path class="acc" d="M'
        + " L".join(f"{tx(x, laid[hi][1])} {ty(y)}" for x, y in hyphen_pts)
        + ' Z"/>'
    )
    out.append("</svg>")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        f.write("\n".join(out) + "\n")
    print(f"wrote {os.path.normpath(OUT)}  viewBox={vx} {vy} {round(vw,2)} {round(vh,2)}")


if __name__ == "__main__":
    main()
