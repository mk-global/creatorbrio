# G1: renderer qualification on the target Mac

**Gate:** [#97](https://github.com/mk-global/creatorbrio/issues/97).
**Campaign:** [#135](https://github.com/mk-global/creatorbrio/issues/135).
**Measured:** 2026-11-05 and 2026-11-06 on the founder's MacBook Pro (Mac17,6, Apple M5 Max, 18 cores, 128 GB), macOS 27.2 (26B123).

## Result

| Candidate | Result | Reason |
|---|---|---|
| HyperFrames 0.9.16 | **FAIL** (precondition) | Its documented composition contract requires GSAP in every composition, and spec/08 excludes the GSAP Standard licence |
| OpenFilm 0.2.7 | **Not adopted**, kept as the documented fallback | Renders the fixture correctly, but its page contract requires page JavaScript, so it cannot give the script-free, strict-CSP preview #97 asks for, and it needs Node 22.2 while the app and CI run Node 20 |
| CreatorBrio overlay renderer + FFmpeg | **PASS** | 60 s reel in about 60 s at 4 workers, frame-identical across 15 runs, A/V within one frame, script-free and network-free |

The adopted renderer is the "own Puppeteer renderer for overlays plus FFmpeg compositing" fallback pre-agreed in [research 04](../../../research/video-studio/04-architecture-alternatives.md#final-recommendation).
The architecture change is recorded in the [ADR](../../../architecture/adr-creatorbrio-video-studio.md).

## HyperFrames: why the gate could not be run as approved

- The core documentation states: "Every composition must have at least a script to create and register its GSAP timeline" and "The only rule: it must be driven by a GSAP timeline."
- The runtime (`@hyperframes/core` `dist/hyperframe.runtime.iife.js`) builds its master timeline with `window.gsap.timeline({ paused: true })` and uses `getChildren`, `parseEase` and `globalTimeline`.
- The research table that found no GSAP dependency in `core`, `engine`, `producer` or `player` was correct about the package manifests; the runtime contract still requires GSAP as a page global.
- GSAP 3.15.1 is published under the "Standard 'no charge' license" (Webflow): proprietary, revocable at Webflow's discretion, changeable by posting new terms, and prohibiting use "in tools that allow users to build visual animations without code" that compete with Webflow's visual animation building.
- [spec/08](../../../research/video-studio/spec/08-licensing-and-commercial.md) excludes the GSAP Standard licence from CreatorBrio-authored output, and risk R4 requires reading the licence before any GSAP use.
- Writing the fixture as a HyperFrames composition would itself be the excluded use, so it was not rendered.
- Reopening HyperFrames is a founder decision: written consent from Webflow or a change to spec/08.

## Fixture

- Three synthetic 22 s source clips, 1080×1920 at 30 fps, `testsrc2` colour bars with a full-frame white flash on the first frame of every source second and a one-frame 1 kHz beep at the same instant: two H.264 (libx264) and one HEVC (`hevc_videotoolbox`), all tagged BT.709.
- A 62 s two-tone music bed with 2 s fades and gain 0.5 (the gain envelope).
- A 60 s timeline cutting source seconds 1-21 of each clip back to back (`scripts/gates/g1/timeline.json`).
- A script-free overlay: 12 caption phrases with per-word pop and highlight, a self-drawing SVG diagram, a waving stick figure, an animated circular mask and a sliding lower third, all CSS animations on one clock.
- Fixture media SHA-256 (tagged set): clipA `ffee4ade4773782a…`, clipB `03599f587c6cf602…`, clipC `f6e96b817e72cf56…`, music `77783890f127078f…`.
- An earlier untagged set (clipA `0d7b2d33b4b019cc…`) was replaced because untagged footage made the colour comparison depend on each decoder's default matrix.

## Versions

| Component | Version |
|---|---|
| Node | 20.20.2 (app and in-house renderer), 26.13.0 (OpenFilm) |
| Puppeteer / Chrome | 24.40.0 / 146.0.7680.153 |
| OpenFilm / playwright-core / headless shell | 0.2.7 (tarball `0c55933281cff18f…`) / 1.61.1 / chromium_headless_shell-1228 |
| HyperFrames tarballs | core `edc0c0e72ecbf005…`, engine `7c6b9beab8629fe9…`, player `d0d10ed02b515818…`, producer `728fa820ed0c9732…` (0.9.16) |
| GSAP tarball | `c70a3bcf656015f3…` (3.15.1) |
| FFmpeg | 9.0.2 (Homebrew, GPL build, run as a separate process) |

## Measurements

All numbers are measured on the target Mac unless marked otherwise.
Background load from Spotlight indexing was present during most runs; the comparison pair below was interleaved so both candidates saw the same conditions, with output in a folder Spotlight skips.

| Run (60 s reel) | Total | Peak memory (process tree) |
|---|---|---|
| In-house, 4 browsers, interleaved pair | 60.3 s and 57.7 s | 4.3 GB |
| OpenFilm, 4 workers, interleaved pair (libx264 for parity) | 23.2 s and 23.0 s | 6.2 GB |
| In-house, 8 browsers (load average 13) | 96.0 s | 8.3 GB |
| In-house, 8 pages in one browser (load average 16) | 178.8 s | 2.4 GB |
| OpenFilm, 8 / 1 workers | 30.3 s / 83.9 s | 11.8 GB / 2.0 GB |

- Pages in one shared browser do not scale: 4 and 8 pages took about the same time, because they share one compositor.
- One browser per worker roughly doubles throughput; 4 browsers give most of the speed at half the memory of 8.
- OpenFilm's default VideoToolbox encoder was disabled for parity, so its default is faster still.
- The #97 target is under 5 minutes for 60 s; the adopted renderer uses about a fifth of it.

### Determinism

- With default GPU rasterization, 5 of 7 full runs were identical and 2 (at 4 and 1 workers) differed in 1 and 3 frames, by at most 12 anti-aliased edge pixels.
- With the pinned software-raster flags (`scripts/gates/g1/chrome-args.mjs`), 15 of 15 full runs were identical frame by frame: 1, 4 and 8 workers, shared and per-worker browsers, both fixture sets and the committed script.
- Overlay frames do not depend on the footage, which is why both fixture sets give one hash set.
- OpenFilm was repeatable at a fixed worker count; its encoded output differs between worker counts at about 45 dB, consistent with per-chunk encoding rather than different rendering.

### A/V sync

- All 60 flashes have their beep within one frame (33.3 ms) in the in-house output; the worst offset is 18.7 ms, identical to the worst offset measured in the source clip itself, so the render adds no offset.
- The offsets form a 0-19 ms sawtooth with an 8 s period in both source and output: the resolution of the beep detector against AAC's 21.3 ms frames, not drift.
- OpenFilm's output has the same sawtooth and the same result.

### Footage fidelity

PSNR in a strip no overlay covers, against the source frame the timeline names, on five frames across the three clips:

| | H.264 clips | HEVC clip |
|---|---|---|
| In-house | 40.0-40.1 dB | 43.5-45.8 dB |
| OpenFilm | 33.4-40.2 dB | 31.1-32.7 dB |

OpenFilm decodes footage in Chromium and re-encodes screenshots; the in-house path never sends footage through the browser.
The exported MP4 is H.264 High, yuv420p, 1080×1920, 30 fps, AAC-LC 48 kHz stereo, exactly 60.000 s, `+faststart`, tagged BT.709 (`tv,bt709,bt709,bt709`).

### Preview: sandbox, CSP and parity

- The compiled overlay document expresses every animation delay relative to one CSS variable, `--t`.
- Preview loads it as `srcdoc` in an `<iframe sandbox="">` (opaque origin, no script) with a document CSP of `default-src 'none'`; to show time *t* it rebuilds the document with `--t: t` and all animations paused.
- The host page cannot reach into the iframe (`contentDocument` is null), and no request was made by either the preview or the export page.
- At 3.2, 21.7, 26.9, 41.5, 50.4 and 59.9 s, preview and export show the same animation state; they differ only on anti-aliased edges, in 0.003-0.04 % of pixels, because the iframe is rasterized as its own layer.
- Rebuilding the preview document took 21-27 ms per seek (median 24.6 ms) in headless Chrome.

### Security posture of the measured renderer

- Page JavaScript disabled; slide-style `<script>` does not run (probed).
- Every request other than `data:` and `about:blank` aborted; 0 requests attempted by the fixture.
- One browser and one isolated context per worker; no state shared with the carousel export browser.
- Puppeteer launched without `--no-sandbox`, so Chromium's process sandbox stayed on (relevant to [#130](https://github.com/mk-global/creatorbrio/issues/130)).
- No upload bytes are inlined into the page.

## Not measured

- Real iPhone footage, Dolby Vision metadata and HDR originals in the final render: see [G2](g2-hdr-proxies.md).
- Motion blur, sub-compositions and alpha (ProRes 4444) export, which the slice does not need.
- Preview in Safari or Firefox; only Chromium was measured.
- Creator review of visual quality: pending the founder.

## Reproduce

See `scripts/gates/g1/README.md`.
