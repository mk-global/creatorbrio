[← Research index](../README.md) · Evidence appendix

# E0 · Experiments and direct verification

Two small experiments were run to settle the rendering question that every architecture depends on: can HTML/CSS motion graphics be rendered frame-accurately and composited over footage, and can headless Chromium seek video precisely?
Both ran on 2026-11-03 in a temporary workspace outside the repository, on the research session's **Linux x86_64 cloud container, not on Apple Silicon**.
No CreatorBrio code, configuration or dependency was changed.

Environment: FFmpeg 6.1.1 (Ubuntu build), Playwright-bundled Chromium 153.0.8010.12 (headless), Node 22.23.4.

## E1 · Deterministic HTML/CSS overlay frames composited by FFmpeg

**Question.** Can a CreatorBrio-style HTML document with CSS animations be rendered frame by frame, without real-time playback, as transparent layers that FFmpeg composites over footage, giving the same pixels every time?

**Method.**

1. A 1080×1920 HTML overlay with a transparent background contained a caption that pops in (CSS keyframes, overshoot easing), per-word colour highlights with staggered delays, and two SVG rectangles drawn by an animated `stroke-dashoffset`.
2. For each of 90 frames at 30 fps, every animation returned by `document.getAnimations()` was paused and its `currentTime` set to `frame × 1000 / 30` ms, and the page was captured with `page.screenshot({ omitBackground: true })` as an RGBA PNG.
3. Frames 60, 15, 45, 0, 89 and 30 were re-rendered in that shuffled order and their SHA-256 hashes compared with the first pass.
4. FFmpeg composited the PNG sequence over a synthetic 3-second H.264 clip (`testsrc2`, 1080×1920, 30 fps, with a sine-tone AAC track) using `overlay=format=auto`, encoded with libx264 CRF 18 and copied the audio.

**Results.**

| Measure | Result |
|---|---|
| Frames rendered | 90 |
| Hash mismatches when re-rendered out of order | **0 of 6** |
| Capture time per 1080×1920 RGBA PNG frame | about 142 ms in this container (environment-specific; **not** a Mac figure) |
| FFmpeg composite and encode of 3 s | 6.6 s wall clock in this container |
| Output | 90 H.264 frames, 1080×1920, audio intact; the frame at t = 1.9 s showed the expected mid-animation state (two words highlighted, the third mid-transition, rectangles partly drawn) |

**Conclusion.** CSS and Web Animations API animations can be driven by an external clock and rendered deterministically as alpha layers.
This is the same principle HyperFrames, OpenFilm, OpenEdit and Remotion implement with more machinery: adapters for JS animation libraries, parallel workers, audio mixing and readiness gates.
It confirms that CreatorBrio's existing "HTML through headless Chromium" contract extends to time without a new rendering paradigm.

## E2 · Frame-accurate `<video>` seeking in headless Chromium

**Question.** If footage is composited inside the browser, does seeking a `<video>` element land on the requested frame?

**Method.** A page with one `<video>` (the same synthetic H.264 clip) was seeked to `(f + 0.5) / 30` seconds for f = 0, 1, 2, 29, 30, 31, 45, 59, 60, 89, then backwards to 44 and 13.
The presented frame was read from `requestVideoFrameCallback` metadata (`mediaTime`).
`canPlayType` was queried for H.264, VP9 and HEVC.

**Results.**

| Measure | Result |
|---|---|
| `mediaTime` equal to `f / 30` | **12 of 12**, including backward seeks |
| `canPlayType` H.264 / VP9 / HEVC | "probably" / "probably" / **"" (unsupported)** |

**Conclusion and caveats.**

- On constant-frame-rate H.264, browser seeking is exact, so an in-browser preview of a proxy can be frame-accurate.
- The clip was synthetic. **iPhone HEVC, variable frame rate and HDR footage were not tested.** This Linux Chromium build cannot decode HEVC at all; desktop Chrome on macOS uses VideoToolbox for HEVC, which was not verified here.
- Implication: the browser preview should play **normalised SDR H.264 proxies** created at ingest, and the final render should extract frames from the originals with FFmpeg, as HyperFrames does (`videoFrameExtractor.ts`), rather than trust browser decoding of camera originals.

## Direct verification by the lead researcher

These facts were checked directly in source or in registry metadata, because the recommendation depends on them.

| Fact | Evidence |
|---|---|
| HyperFrames is Apache-2.0; HEAD `faae6017dd6ab3ce2031489922e9a1750777e0e2` at 2026-11-03 16:25 UTC; first commit 2026-03-10 | Root `LICENSE`; `git log` |
| `@hyperframes/producer`, `engine`, `core`, `player`, `studio` 0.9.9 published to npm on 2026-11-03 | npm registry `time` field |
| `@hyperframes/producer` exposes `createRenderJob` / `executeRenderJob` and an HTTP render server | [`packages/producer/README.md`](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/producer/README.md) |
| `engine`, `producer` and `cli` declare `"node": ">=22"` and depend on Puppeteer | each `package.json` |
| `core`, `engine`, `producer`, `player`, `sdk` and `studio-server` do **not** depend on GSAP; `@hyperframes/studio` depends on `gsap ^3.13.0` | each `package.json` |
| `@hyperframes/sdk` exposes `openComposition()`, `createHistory`, `createPersistQueue`, memory, headless, iframe and fs adapters, and a typed `EditOp` union (`setStyle`, `setText`, `setAttribute`, `setTiming`, `addElement` without `<script>`, `removeElement`, variable ops, GSAP tween and keyframe ops, …) | [`packages/sdk/src/index.ts`](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/sdk/src/index.ts), [`packages/sdk/src/types.ts#L109`](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/sdk/src/types.ts#L109) |
| `@hyperframes/studio` is a full React NLE (about 166k lines of TS/TSX including tests) exporting `EditorShell`, `NLEPreview`, `TimelineProvider`, `AudioWaveform`, `PropertyPanel`, `AskAgentModal`, `StudioApp` and more | [`packages/studio/src/index.ts`](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/studio/src/index.ts) |
| HyperFrames core runtime ships frame adapters for WAAPI, Lottie, Three.js and TypeGPU, alongside GSAP and CSS | `packages/core/src/runtime/adapters/` |
| elah 1.0.0 (`@elah/core`, `timeline`, `editor`) published 2026-10-28, Apache-2.0; HEAD `d4e8b237778128ac453bbd93fd6cb85c758c9b91` (2026-10-30) | npm registry; `git log` |
| elah's own limitations file says one active video clip at a time is the tested path, backward scrubbing is unstable, and export is Chromium-only (WebCodecs, OffscreenCanvas and WebGL2 in a worker) | [`CURRENT_LIMITATIONS.md`](https://github.com/elahlabs/elah/blob/d4e8b237778128ac453bbd93fd6cb85c758c9b91/CURRENT_LIMITATIONS.md) |
| GSAP 3.15.0 (npm, 2026-04-13) declares `"Standard 'no charge' license: https://gsap.com/standard-license"`; README: "Copyright (c) 2008-2026, GreenSock. All rights reserved." | npm tarball `package.json` and `README.md` |
| GSAP licence clause restricting products that compete with Webflow's visual animation builder | **Unverified.** gsap.com is outside this session's allowed network, and search-result excerpts quote inconsistent wording ([licence mirror](https://open.windriver.com/info/uni-license-list/licenses/gsap-standard-no-charge-2025.html), [Pinegrow forum](https://forum.pinegrow.com/t/gsap-has-been-acquired-by-webflow/9906), [Webflow announcement](https://webflow.com/blog/gsap-becomes-free)) |
| Remotion 4.0.540 (npm 2026-11-02) declares "SEE LICENSE IN LICENSE.md"; mediabunny 1.65.1 (2026-11-03) is MPL-2.0; parakeet-mlx 0.6.0 is on PyPI | npm and PyPI registries |
| CreatorBrio refuses a state-changing API request whose `Origin` header differs from the app's own origin, including the literal `null` an opaque-origin sandboxed iframe sends | [`src/lib/request-guard.ts`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/lib/request-guard.ts) |

## Not tested, and why it matters

| Assumption | Why it could not be tested here | Significance | Validation task |
|---|---|---|---|
| HyperFrames screenshot-mode capture on macOS is deterministic and fast enough for 60–90 s 1080×1920 reels with footage | No Mac in the research environment; installing HyperFrames was out of scope | Highest: the renderer choice depends on it | [V1](../08-implementation-plan.md#validation-checkpoints) |
| `<hyperframes-player>` works inside an iframe sandboxed with `allow-scripts` but without `allow-same-origin` | Not installed | Determines the preview security model | V2 |
| iPhone HLG / Dolby Vision footage tone-maps to SDR acceptably | No sample footage | Washed-out footage would undermine every edit | V3 |
| Parakeet TDT transcribes filler words, or the VAD-gap classifier finds them | No models were run | Filler removal is a core talking-head feature | V4 |
| Apple Vision person masks are clean enough for text behind the speaker | No Mac | Signature effect; BiRefNet is the fallback | V5 |
