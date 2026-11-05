# G1 renderer harness

Gate harness for [G1 #97](https://github.com/mk-global/creatorbrio/issues/97), not product code.
Results and their interpretation are in [docs/roadmap/video-studio/gates/g1-renderer.md](../../../docs/roadmap/video-studio/gates/g1-renderer.md).
Requires FFmpeg on `PATH` (or `FFMPEG`/`FFPROBE`), with `libx264`, `hevc_videotoolbox` and `aac`, and the repository's installed Puppeteer Chrome.

## Build the fixture

```sh
F=/path/to/fixture; mkdir -p "$F/media"
scripts/gates/g1/make-footage.sh "$F/media"
node scripts/gates/g1/make-overlay.mjs "$F/overlay.html"
cp scripts/gates/g1/timeline.json "$F/"
```

Put the fixture in a folder whose name ends in `.noindex` on macOS, so Spotlight does not index thousands of frames during a run.

## Render and measure

```sh
node scripts/gates/g1/render.mjs "$F" out/w4 4              # out/w4/out.mp4, frame-hashes.txt, report.json
node scripts/gates/g1/render.mjs "$F" out/r 4 590 620        # a range render
node scripts/gates/g1/measure-av.mjs out/w4/out.mp4           # flash-and-beep offsets
cmp out/w4/frame-hashes.txt out/w1/frame-hashes.txt           # determinism across runs or worker counts
OUT=out/parity node scripts/gates/g1/preview-parity.mjs "$F/overlay.html"
```

`frame-psnr.py` compares two raw `rgb24` 1080-wide frames over a region, for footage fidelity against the source.

## OpenFilm comparison

`openfilm-render.mjs` renders the same fixture through OpenFilm 0.2.7's `render()` as a library.
It needs an `openfilm` install (Node 22.2 or later), Playwright's headless shell, a `film.html` describing the same timeline and an overlay page that defines `window.film.frame(t)`.
Run it with `HOME` and `PLAYWRIGHT_BROWSERS_PATH` pointed at a scratch folder so it leaves the user's home and browser caches alone.
