"""CreatorBrio Brand Identity v1.0 (#189): generate the logo system as SVG.

Usage, from the repository root, with throwaway tooling (not a project dependency):

    python3 -m venv /tmp/brand-venv
    /tmp/brand-venv/bin/pip install fonttools brotli uharfbuzz
    npm run build   # self-hosts Instrument Sans under .next/static/media
    /tmp/brand-venv/bin/python scripts/brand/make-logo.py .next/static/media docs/brand/assets
    node scripts/brand/raster-icons.mjs

The first argument is either an Instrument Sans font file or a folder of them.
Given a folder, the script opens each font (the build's WOFF2 files compress
their names, so a text search cannot find it) and uses the Instrument Sans
subset that has every letter of the wordmark. Instrument Sans is licensed under the SIL
Open Font License, which allows outlining glyphs in a logo.

The wordmark is Instrument Sans at the interface's display-md setting
(width 82, weight 600), shaped with the font's own kerning and outlined to
paths so the files need no installed font. The mark is the existing in-app
mark (#175) unchanged: a 16 x 20 ink sheet inside four coral crop corners on
a 30-unit grid.
"""
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

INK = "#1C1B29"
CORAL = "#E94560"
PAPER = "#FFFFFF"

WORD = "CreatorBrio"


def is_wordmark_font(font: TTFont) -> bool:
    family = font["name"].getDebugName(1) or ""
    cmap = font.getBestCmap() or {}
    return family.startswith("Instrument Sans") and all(ord(c) in cmap for c in WORD)


def find_font(src: Path) -> TTFont:
    candidates = sorted(src.glob("*.woff2")) + sorted(src.glob("*.ttf")) if src.is_dir() else [src]
    for path in candidates:
        try:
            font = TTFont(path)
        except Exception:
            continue
        if is_wordmark_font(font):
            print(f"using {path}")
            return font
    sys.exit(f"no Instrument Sans font with the letters of {WORD!r} in {src}")


if len(sys.argv) != 3:
    sys.exit("usage: make-logo.py <font file or folder> <output folder>")
src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)

font = find_font(src)
inst = instantiateVariableFont(font, {"wdth": 82, "wght": 600})
inst.flavor = None
import tempfile

ttf = Path(tempfile.mkdtemp()) / "instrument-82-600.ttf"
inst.save(ttf)

blob = hb.Blob.from_file_path(str(ttf))
face = hb.Face(blob)
hbfont = hb.Font(face)
buf = hb.Buffer()
buf.add_str(WORD)
buf.guess_segment_properties()
hb.shape(hbfont, buf, {"kern": True, "liga": True})

upm = inst["head"].unitsPerEm
cap = inst["OS/2"].sCapHeight
glyphset = inst.getGlyphSet()
order = inst.getGlyphOrder()


def wordmark(cap_px: float, x0: float, baseline: float) -> tuple[str, float]:
    """Path data for the wordmark with its cap height `cap_px`, and its width."""
    s = cap_px / cap
    pen = SVGPathPen(glyphset, lambda v: f"{v:.2f}".rstrip("0").rstrip("."))
    x = 0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        name = order[info.codepoint]
        tp = TransformPen(pen, (s, 0, 0, -s, x0 + (x + pos.x_offset) * s, baseline - pos.y_offset * s))
        glyphset[name].draw(tp)
        x += pos.x_advance
    # Width to the right edge of the last glyph's ink, not its advance.
    last = order[buf.glyph_infos[-1].codepoint]
    glyf_bounds = inst["glyf"][last]
    glyf_bounds.recalcBounds(inst["glyf"])
    ink_right = (x - buf.glyph_positions[-1].x_advance + glyf_bounds.xMax) * s
    return pen.getCommands(), ink_right


def mark(sheet: str, crop: str, tx: float = 0, ty: float = 0, k: float = 1) -> str:
    """The mark on its 30-unit grid; visual bounds are 1..29 on both axes."""
    return (
        f'<g transform="translate({tx:g} {ty:g}) scale({k:g})">'
        f'<rect x="7" y="5" width="16" height="20" rx="1.5" fill="{sheet}"/>'
        f'<path d="M2 7V2h5M23 2h5v5M28 23v5h-5M7 28H2v-5" fill="none" stroke="{crop}" stroke-width="2"/>'
        "</g>"
    )


def svg(w: float, h: float, body: str, title: str) -> str:
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:g} {h:g}" width="{w * 4:g}" height="{h * 4:g}" role="img" aria-label="{title}">'
        f"<title>{title}</title>{body}</svg>\n"
    )


VARIANTS = {
    "": (INK, CORAL, INK),  # light backgrounds
    "-dark": (PAPER, CORAL, PAPER),  # dark backgrounds
    "-mono": (INK, INK, INK),  # one colour, ink
    "-mono-white": (PAPER, PAPER, PAPER),  # one colour, reversed
}

# Horizontal: the mark's visual box is 28 units (1..29); cap height 13,
# centred on the sheet; 9 units from the mark to the wordmark.
CAP, GAP = 13.0, 9.0
for suffix, (sheet, crop, text) in VARIANTS.items():
    d, width = wordmark(CAP, 29 + GAP, 15 + CAP / 2)
    body = mark(sheet, crop, -1, -1) + f'<path fill="{text}" d="{d}" transform="translate(-1 -1)"/>'
    (out / f"creatorbrio-logo{suffix}.svg").write_text(svg(28 + GAP + width, 28, body, "CreatorBrio"))

# Compact (stacked): the mark at 1.5x above the wordmark, centred.
K, SCAP, SGAP = 1.5, 13.0, 9.0
_, sw = wordmark(SCAP, 0, 0)
W = max(28 * K, sw)
for suffix, (sheet, crop, text) in VARIANTS.items():
    mx = (W - 28 * K) / 2 - 1 * K
    d, _ = wordmark(SCAP, (W - sw) / 2, 28 * K + SGAP + SCAP)
    body = mark(sheet, crop, mx, -1 * K, K) + f'<path fill="{text}" d="{d}"/>'
    (out / f"creatorbrio-logo-compact{suffix}.svg").write_text(svg(W, 28 * K + SGAP + SCAP, body, "CreatorBrio"))

# The mark alone.
for suffix, (sheet, crop, _) in VARIANTS.items():
    (out / f"creatorbrio-mark{suffix}.svg").write_text(svg(28, 28, mark(sheet, crop, -1, -1), "CreatorBrio"))

# App icon: a full-bleed ink square (platforms round it themselves) with the
# dark-background mark at 60% of the tile.
TILE = 64.0
k = TILE * 0.6 / 28
app = f'<rect width="{TILE:g}" height="{TILE:g}" fill="{INK}"/>' + mark(PAPER, CORAL, (TILE - 28 * k) / 2 - k, (TILE - 28 * k) / 2 - k, round(k, 4))
(out / "creatorbrio-app-icon.svg").write_text(svg(TILE, TILE, app, "CreatorBrio"))

# Favicon: a separate drawing on a 16-pixel grid, every edge on a whole pixel,
# so it stays sharp at 16 and 32 px. Corners 2 px thick with 5 px arms; the
# sheet 8 x 10 (4:5). In a dark browser theme the sheet turns paper.
fav = (
    '<style>.s{fill:#1C1B29}@media (prefers-color-scheme:dark){.s{fill:#FFFFFF}}</style>'
    '<rect class="s" x="4" y="3" width="8" height="10"/>'
    f'<path d="M1 5V1h4M11 1h4v4M15 11v4h-4M5 15H1v-4" fill="none" stroke="{CORAL}" stroke-width="2"/>'
)
(out / "creatorbrio-favicon.svg").write_text(
    f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="32" height="32"><title>CreatorBrio</title>{fav}</svg>\n'
)
print("wordmark width at cap 13:", round(sw, 2))
