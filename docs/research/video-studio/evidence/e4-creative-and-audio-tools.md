[← Research index](../README.md) · Evidence appendix

> **About this appendix.** These are the working notes of one research slice, kept close to how they were written so a reviewer can trace each conclusion in the main documents to its source. Every repository was cloned and **read only**: nothing was installed, built or executed. Dates and commit SHAs come from `git log` of fresh clones taken on 2026-11-03, and package versions from the npm and PyPI registries. Labels such as *implemented*, *claimed*, *unverified* and *[web]* mark how each claim was established. Paths shown as `<local clone>/…` refer to the researcher's temporary clone, not to anything in this repository.

# 04 — Specialist creative, animation and audio tools

Research slice for the CreatorBrio "Video Studio" architecture study. Date of research: 2026-11-03.
Method: every repo was cloned with `git clone --filter=blob:none` into
`<local clone>/<owner>_<repo>` and **read only**
(nothing installed, nothing executed). Metadata comes from `git log`. "90d" = `git log --since=2026-08-05 --oneline | wc -l`.
Licences were read from the actual files. Claims in READMEs are marked **claimed** unless the code was read and confirms them
(**implemented**). WebFetch could not reach gsap.com or scancode-licensedb (DNS blocked in this session), so the GSAP licence
clause text below comes from search-result summaries plus the GSAP repo's own `package.json`/README; treat its exact wording as
**unverified** until someone reads https://gsap.com/standard-license directly.

---

## Summary table (metadata)

| Tool | HEAD SHA | First commit | Last commit | Total commits | 90d | Licence (file read) |
|---|---|---|---|---|---|---|
| HyperFrames (heygen-com/hyperframes) | `faae6017dd6ab3ce2031489922e9a1750777e0e2` | 2026-03-10 | 2026-11-03 | 6706 | 2989 | Apache-2.0 (root `LICENSE`); only `packages/cli/package.json` declares `"license"`, engine/producer/core package.json have no licence field |
| Lemo-Opuscar (lemomo-ai/lemo-opuscar) | `bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00` | 2026-09-26 | 2026-11-01 | 80 | 80 | MIT (code); demo films CC BY 4.0 (README); 3 voice tracks excluded |
| OneTake (feitangyuan/onetake) | `013a61ac8d98883c73733f59c06e49e9ba444f14` | 2026-09-25 | 2026-10-21 | 20 | 20 | **PolyForm Noncommercial 1.0.0** |
| Claude Animation Base (windpipe/claudeanimationbase) | `0ac8bf2b31942376cb6b8c4074715595d512acd2` | 2026-09-23 | 2026-09-24 | 15 | 15 | MIT |
| gbro-collage-broll (pyang5166) | `a1a4ee2e2abf7d44e460026b706d0c72c2cf8a91` | 2026-07-15 | 2026-07-15 | 3 | 0 | MIT |
| VOX-COLLAGE-BROLL (MegaTroll222) | `2e9b8a93a2834e4d670700ab9e4827a8baf3b668` | 2026-07-17 | 2026-07-17 | 2 | 0 | MIT (credits gbro-collage-broll) |
| gbro-collage-info (pyang5166) | `0b97a817a6b65285d8aa90431079500a29092eab` | 2026-08-01 | 2026-08-01 | 1 | 0 | MIT; bundles `gsap.min.js` 3.14.2 (GSAP Standard Licence) and Mixkit SFX |
| OpenHiggsfield (thehiggsfieldai) | `a9507962df442b72c84f01d27565108b6724cc83` | 2026-09-21 | 2026-09-26 | 6 | 6 | MIT, but imported frontend has **unverified provenance** (see below) |
| Clipwing skills / Real SFX | `edbefcbc3474869e6cc1e8a7ca583b0efd0dab7e` | 2026-10-13 | 2026-10-21 | 6 | 6 | **No LICENSE file** in repo; real-sfx README says "Scripts: MIT"; bundled `uisfx` MIT code + CC0 audio |
| Earshot (Leonxlnx/earshot) | `591fa3e028032e6dce56620a20e932e35667e8d8` | 2026-10-16 | 2026-10-22 | 40 | 40 | MIT (code); downloads CLAP (Apache-2.0) and AST (BSD-3, per README) weights |

All ten repositories exist and cloned successfully (no 404s).

---

## 1. HyperFrames — heygen-com/hyperframes (MOST IMPORTANT)

### What it is
A Bun/TypeScript monorepo (15 packages, v0.9.9 tagged 2026-11-03, pre-1.0) that turns **plain HTML compositions** into
deterministic video. It is simultaneously:
- a set of **npm libraries** (`@hyperframes/core`, `engine`, `producer`, `player`, `sdk`, `lint`, `parsers`, `shader-transitions`, `studio`, `aws-lambda`, `gcp-cloud-run`);
- a **CLI** (`hyperframes`, `npx hyperframes init|preview|check|snapshot|render|add|remove-background|transcribe|tts|media-use|...`);
- a **Claude Code plugin / skills pack** (9 published skills: `/hyperframes`, `/hyperframes-cli`, `/hyperframes-registry`, `/media-use`, plus on-demand `/figma`, `/slideshow`, `/remotion-to-hyperframes`, `/reverse-any-video`, `/style-sampling` — the last two marked "HyperFrames Pro");
- a **catalog/registry** of ~450 blocks/components (registry/: 769 files under `blocks`, 856 under `components`), including `data-chart`, `flowchart`, `flowchart-vertical`, `bar-chart-race`, `animated-bar-chart`, `chart-story`, `paper-collage-reveal`, `nyt-graph` example.
- a hosted product layer (HeyGen sign-in, credits, cloud render, desktop app "Framey") wired into the CLI and skills.

### Composition format (implemented)
`index.html` root composition; timed elements carry `class="clip"`, `data-start`, `data-duration`, `data-track-index`;
the root carries `data-composition-id`, `data-width`, `data-height`, `data-duration`. Sub-compositions live in
`compositions/*.html` inside `<template>`. Each composition builds **one paused GSAP (or other) timeline** and registers it:
`window.__timelines["<composition-id>"] = tl`. `<audio>`/`<video>` elements are declarative and must not be played/seeked
by script. Contract: https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/skills/hyperframes/SKILL.md#L17-L30
— rule 4 ("No `Date.now()`, unseeded `Math.random()`, network fetches, timers or `repeat: -1`. Everything visible is a
function of timeline time.") is line 23.

### Render mechanism (implemented — read in code)
1. **Seek protocol, not wall-clock recording.** The page (via the injected HyperFrames runtime) exposes
   `window.__hf = { duration, seek(t, opts) }`; the engine waits for
   `!!(window.__hf && typeof window.__hf.seek === "function" && window.__hf.duration > 0)`
   (https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/engine/src/services/frameCapture.ts#L1-L9,
   readiness at line 1923). For each frame it calls `__hf.seek(t)` (time quantised to the frame grid by
   `quantizeTimeToFrame`/`quantizeSeekTime` from core), then captures.
2. **Frame adapters** make third-party animation libraries seekable. Interface
   `FrameAdapter { init?, getDurationFrames, seekFrame(frame), destroy? }`
   (https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/core/src/adapters/types.ts#L9-L15).
   Runtime adapters exist for **GSAP** (575 lines; re-renders a paused timeline at `t` with careful same-time step ordering),
   **CSS animations** (pauses `document.getAnimations()` and sets `currentTime`), **WAAPI**, **anime.js**, **Lottie**,
   **Three.js**, **D3**, **TypeGPU**, Leaflet, MapLibre, Mapbox, Google Maps
   (`packages/core/src/runtime/adapters/*.ts`). There is **no** global monkey-patching of `requestAnimationFrame`/`Date.now`
   (grep found none); determinism depends on authors obeying the contract or using an adapter.
3. **Capture path depends on OS.** Chromium's `HeadlessExperimental.beginFrame` (deterministic compositor stepping with
   `--enable-begin-frame-control`, `--deterministic-mode`, `--run-all-compositor-stages-before-draw`, …) is used **only on
   Linux with chrome-headless-shell**:
   ```ts
   const requestedCaptureMode: CaptureMode =
     headlessShell && process.platform === "linux" && !launchConfig.forceScreenshot && beginFrameControlEnabled
       ? "beginframe" : "screenshot";
   ```
   (https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/engine/src/services/browserManager.ts#L871-L878;
   BeginFrame-only flags at L330-L340; BeginFrame liveness probe with fallback at ~L440-L540.)
   BeginFrame capture with damage-detection/frame cache:
   https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/engine/src/services/screenshotService.ts#L148-L222.
   **On macOS (our target) and Windows it uses seek + CDP `Page.captureScreenshot`** (`fromSurface: true`, clip to
   composition size) — https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/engine/src/services/screenshotService.ts#L243-L260.
   Producer README confirms: "macOS and Windows already use screenshot mode by default"
   (https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/producer/README.md#L98).
   So on Apple Silicon, frame accuracy comes from the **seek protocol + adapters + readiness gates**, not from BeginFrame.
   The chrome-headless-shell `mac-arm64` build is resolved (browserManager.ts L182).
4. **Video inside compositions**: `<video>` frames are pre-extracted with FFmpeg and injected per frame
   (`videoFrameExtractor.ts`, `videoFrameInjector.ts`), so embedded footage is frame-exact rather than played.
5. **Encoding/audio**: FFmpeg encoding (chunked or streaming; GPU encoder detection), `audioMixer.ts` mixes declared
   `<audio>`/`<video data-has-audio>` with volume envelopes; parallel workers split frame ranges (`parallelCoordinator.ts`).
   Outputs: mp4 (H.264/H.265, HDR10), **webm VP9 with true alpha**, **mov ProRes 4444 alpha**, png-sequence, gif, HLS
   (producer README). Also sub-frame motion blur (`motionBlur.ts`, `captureMotionBlur/`), shader transitions (WebGL, html2canvas).

### Programmatic use from Node (implemented, documented)
- `@hyperframes/producer`: `createRenderJob({fps, quality, format})` + `executeRenderJob(job, projectDir, outPath, onProgress)`;
  also `startServer({port})` exposing `POST /render` and `/render/stream`.
- `@hyperframes/engine`: low-level `acquireBrowser` / `createCaptureSession` / `captureFrame` for any page implementing `window.__hf`.
- `@hyperframes/cli` exports `./api` (e.g. `transcribe`, `removeBackground`, publish helpers).
- `@hyperframes/player`: embeddable `<hyperframes-player>` web component (useful for in-app preview).
- Requirements: Node ≥ 22, FFmpeg, Puppeteer-downloaded chrome-headless-shell. Engine depends on `puppeteer` + `puppeteer-core`.
  Note: CreatorBrio already uses Puppeteer for PNG export, so the browser dependency is not new.

### External / paid dependencies
- Core render path (core/engine/producer): **none** — local Chrome + FFmpeg.
- CLI: **PostHog telemetry** enabled by default, opt-out via `HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, or `hyperframes telemetry disable` (`packages/cli/src/telemetry/policy.ts`). Engine has render "telemetry" records but no PostHog import (grep of engine/producer/core found no posthog).
- `/media-use` skill steers agents to **HeyGen sign-in/credits** for music, SFX catalog, images, voice, avatars: "Use local tools only when the person asks, not as a fallback"
  (https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/skills/media-use/SKILL.md#L17-L32). Local alternatives exist in the CLI: Kokoro TTS, Parakeet (sherpa-onnx) / whisper transcription, `remove-background` (rembg `u2net_human_seg.onnx`, onnxruntime incl. CoreML temp path — `packages/cli/src/background-removal/manager.ts#L9-L14`), MusicGen, FLUX via mflux, LTX "if installed". 21 bundled SFX mp3s under `skills/media-use/audio/assets/sfx/` with a `CREDITS.md` (not audited).
- Compositions conventionally use **GSAP** (Standard "no charge" licence, see §Extras) — the licence issue transfers to anything we author with it.

### Text behind speaker
Documented recipe (implemented via CLI): stack footage, text, then an alpha cutout from `npx hyperframes remove-background`
(`.webm` VP9 alpha), shake the footage and cutout together; occlusion guidance 30–55% coverage; model ~2 fps at 1080p CPU, 168 MB download
(https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/skills/hyperframes/references/captions.md#L41-L46).

### Activity / risk
Extremely active (2989 commits in 90 days, release tag same day as this research) — great for bugs fixed, bad for API
stability: v0.x, fast churn, a skill pinned to `hyperframes@0.7.56` (gbro-collage-info) is already two minor lines behind.
Commercial vendor (HeyGen) with upsell paths in skills/CLI, but the render core is Apache-2.0 with no per-render fee.

### Integration fit with CreatorBrio
Very high. CreatorBrio slides are already HTML rendered in Puppeteer with a shared `wrapSlideHtml()` contract; a HyperFrames
composition is the natural "reel" analogue (HTML + `data-*` timing + a paused timeline). The design agent (Claude CLI) can
author compositions via curl to local API routes exactly as it now authors slides.
Caveats: (a) sandboxed preview iframes in CreatorBrio use `sandbox=""` (no JS) — a timeline preview needs JS, so preview
must go through `@hyperframes/player` in a separate, isolated origin/iframe policy, or server-rendered frames; this is a
security-design decision for the main study. (b) Pin exact versions; wrap behind our own `renderReel()` interface.

**Disposition: ADOPT AS DEPENDENCY** — `@hyperframes/producer` (+ `engine`, `core`, `player`) pinned, behind a CreatorBrio
adapter module; author our own Claude skill/system-prompt section for the composition contract rather than installing
the upstream `/media-use` skill (which pushes HeyGen sign-in). Use the CLI only as an optional tool with telemetry disabled.
Registry blocks (Apache-2.0 per repo licence) can be vendored selectively as templates (flowchart, data-chart, paper-collage-reveal).

---

## 2. Lemo-Opuscar — lemomo-ai/lemo-opuscar

**What it is:** a Claude Code plugin + style library: 66–68 "film styles" (`styles/<slug>/STYLE.md` prompt, `style.json`,
demo source, poster), long-form direction guides (`DIRECTOR.md`, `TECHNIQUE.md`, `MY-STYLES.md`) and a small shared toolkit
in `core/`. Explicitly "tuned for Claude Opus 5.5". Relevant styles: `blueprint`, `dataviz`, `iso-infographic`,
`circuit-board`, `transit-map`, `whiteboard`, `swiss-motion`, `news-package`, `visual-investigation`, `archive-lighttable`.

**Rendering mechanism (implemented):** page contract `window.READY`, `window.render(t)` (deterministic, draw frame at second t),
`window.DUR`, optional `window.EV` cue events and `window.TEXTS(t)` for a reading-time checker
(https://github.com/lemomo-ai/lemo-opuscar/blob/bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00/core/README.md#L19-L28).
`core/render/video.mjs` (72 lines) launches Playwright Chromium workers, calls `window.render(f/FPS)` then
`page.screenshot({type:'jpeg', quality:95})`, pipes to ffmpeg libx264, concatenates segments
(https://github.com/lemomo-ai/lemo-opuscar/blob/bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00/core/render/video.mjs#L48-L62).
Pictures are canvas/WebGL/three.js pages. Same seek-then-screenshot principle as HyperFrames but far simpler (no adapters,
no audio graph, no alpha).

**Audio:** `core/audio/sfx.py` procedural foley in numpy/scipy (click, whoosh, thump, ding, pop, rumble…, compressor, limiter,
`add(buf, sound, at, gain, pan)`); `sampler.py`/`pluck.py` for scores from free sample libraries fetched by `tools/fetch.sh`
(freepats, karoryfer, salamander, vcsl, vsco2ce — their licences not audited here); `mux.sh` two-pass loudnorm to −14 LUFS.
Voice: Kokoro (offline), **edge-tts (Microsoft online service)** for Chinese, faster-whisper ASR check.

**API deps:** none paid; edge-tts is a free online service (network). Local on macOS: yes (README sets `LEMO_ANGLE=metal` default on macOS).
**Programmatic API:** no — CLI scripts + prompts. **Output:** MP4 (+ SRT, contact sheets).

**Disposition: USE AS REUSABLE SKILL/TEMPLATE SOURCE (MIT)** — mine `STYLE.md` prompts (e.g. blueprint for "animated
technical architecture diagram") and DIRECTOR/TECHNIQUE guidance as style presets for our agent, with attribution;
reimplement `window.render(t)`-style canvas scenes inside HyperFrames compositions (a custom FrameAdapter or a tiny
`__hf`-compatible shim). Do not adopt its render scripts (duplicate of HyperFrames). `sfx.py` is a useful MIT reference for
procedural foley. Demo films are CC BY 4.0 (attribution needed if reused). Very young (5 weeks), single author.

---

## 3. OneTake — feitangyuan/onetake

**What it is:** a Claude Agent Skill (SKILL.md + references + `lib/motion.js` move library + `lib/ui_kit.js` + Python
scripts) for continuous-take product/launch motion films. Interesting **implemented** ideas: `scripts/render.py` seeks
`__seek(t)` per frame across a 180° shutter and averages captures in linear light for real motion blur, skips extra
samples on holds, and avoids exposing across cuts
(https://github.com/feitangyuan/onetake/blob/013a61ac8d98883c73733f59c06e49e9ba444f14/scripts/render.py#L14-L35);
`probe.py`/`verify_promo.py` "continuity oracle" scores what carries across beat boundaries; `sfx_palette.py` numpy/scipy
foley; Kokoro + faster-whisper for VO. Python + Playwright Chromium + ffmpeg; no paid APIs. Output MP4 (1080p30 drafts, 4K60 finals).

**Licence:** **PolyForm Noncommercial 1.0.0** with a "Required Notice" line; source headers carry a lineage tag
(`otk-7f3e1c`). README: "Commercial use is not permitted" — commercial licence sold as "onetake Pro"
(https://github.com/feitangyuan/onetake/blob/013a61ac8d98883c73733f59c06e49e9ba444f14/README.md#L170-L172). Case films ship without source.

**Disposition: EXCLUDE (code and prompts).** Incompatible with CreatorBrio's MIT-derived, potentially commercial use. The
general techniques (shutter-sampled motion blur, measuring continuity across cuts) are standard concepts that can be
**reimplemented clean-room from fundamentals** — HyperFrames already has its own motion blur (`engine/src/services/motionBlur.ts`).
Do not copy text or code from this repo into CreatorBrio.

---

## 4. Claude Animation Base — windpipe/claudeanimationbase

**What it is:** a tiny starter kit (18 files, 2 days of commits) for hand-painted character animation of **Clawd**
(Anthropic's mascot) in **p5.js + p5.brush**, with `ANIMATION_GUIDE.md` (rules/workflow for the model), `src/clawd.js`
(views, emotions), `src/core.js`, `src/timeline.js`, `render.mjs` (puppeteer-core; `window.renderAt(t)` then JPEG frames → ffmpeg),
`studio.html` scrubber. Watercolour fills need a GPU ("seconds per frame" on integrated graphics — Apple Silicon has a GPU, OK).
No API deps. MIT. Output MP4 / contact sheets.

**Concerns:** the character is Anthropic's mascot (trademark/brand use, not covered by the MIT code licence);
p5.js itself is LGPL-2.1 (not verified in this clone, dependency not installed); p5.brush licence not verified here.

**Disposition: USE AS REFERENCE ONLY (skill pattern).** The "storyboard → shot-by-shot → contact sheet self-check" guide
pattern is reusable. Not a fit for branded reels (single mascot, hand-painted style); exclude as dependency.

---

## 5. gbro-collage-broll — pyang5166/gbro-collage-broll

**What it is:** a Codex/Claude skill (Chinese) for 5-second 9:16 halftone paper-collage B-roll. Three approval gates:
metaphor → still (requires **Codex built-in `image_gen`**) → video via **Gemini Omni Flash first/last-frame generation**
(`scripts/generate_video.py`, google-genai Interactions/Files API) with ffmpeg QA.
Requires `GEMINI_API_KEY` billed per use
(https://github.com/pyang5166/gbro-collage-broll/blob/a1a4ee2e2abf7d44e460026b706d0c72c2cf8a91/README.md#L33-L40).
Output: silent 720×1280 24fps MP4. MIT. Dormant (3 commits, July 2026).

**Disposition: EXCLUDE as dependency** (mandatory paid generative API + Codex-only tool). The **visual language and
three-gate approval flow** (MIT) can inform a prompt template; the collage look itself should be **reimplemented
deterministically in HTML/CSS** (see gbro-collage-info and HyperFrames `paper-collage-reveal`).

## 6. VOX-COLLAGE-BROLL — MegaTroll222/VOX-COLLAGE-BROLL

English adaptation of #5 for Claude Code; single `SKILL.md` (396 lines) + example MP4s. All generation goes through the
**MaxFusion MCP** (hosted, account-based) — "No other video model is ever used"
(https://github.com/MegaTroll222/VOX-COLLAGE-BROLL/blob/2e9b8a93a2834e4d670700ab9e4827a8baf3b668/SKILL.md#L56-L59);
BYO path needs Google AI Studio + **ElevenLabs** keys (README L62-L67). MIT, correctly credits upstream. 2 commits, dormant.
**Disposition: EXCLUDE** (paid hosted MCP lock-in; prompt only). At most cite the English prompt wording as inspiration.

## 7. gbro-collage-info — pyang5166/gbro-collage-info

**What it is:** a Claude skill that produces 1080×1920 halftone paper-collage **info-graphic** animations with SFX,
**rendered locally with HyperFrames** (`npx --yes hyperframes@0.7.56 render`), "no image-generation models"
(https://github.com/pyang5166/gbro-collage-info/blob/0b97a817a6b65285d8aa90431079500a29092eab/README.md#L3-L5).
Assets: `collage.css` (paper fibre, halftone, torn edge, cardstock classes), vendored `gsap.min.js` 3.14.2, 10 SFX mp3s
"from Mixkit" (licence claim "royalty-free, commercial use" — Mixkit's licence typically forbids redistributing the raw files;
**unverified/risky to vendor**). References: `style-system.md`, `motion-grammar.md` (10 fps `steps()` stop-motion grid,
eight primary moves), `production.md`. Gate 2 renders sample stills with headless Chrome. Single commit (Aug 2026).

**Disposition: ADAPT AT SOURCE LEVEL (MIT) as a template/skill** — this is exactly the "documentary-style collage" pattern
in our target architecture and it already targets HyperFrames. Re-use `collage.css` and the motion grammar (with
attribution), translate prompts, bump to a current HyperFrames version, **drop the vendored Mixkit SFX and gsap.min.js**
(source SFX from CC0 sets / procedural generation; take GSAP from our own pinned dependency subject to the GSAP decision).

---

## 8. OpenHiggsfield — thehiggsfieldai/OpenHiggsfield

**What it is:** a self-hostable web app ("Story Studio": character → six scenes → generated clips → assembled MP4) with
auth (better-auth, Resend email), encrypted credential vault, and provider adapters. Generation is entirely **cloud**:
fal (`fal.ai/models/bytedance/seedance-2.0/...`), Higgsfield API (`api.higgsfield.ai`), OpenRouter LLM, getanyapi
(`deploy/story/films.mjs`, `deploy/beta/*.mjs`). FFmpeg for assembly. Node ≥ 24, Docker.
**Not affiliated with Higgsfield.ai** (README). MIT licence, but `apps/story-studio/UPSTREAM.json` says the frontend was
imported from `ilkerzg/storycast`, which "has no published license file; permission is recorded from this conversation,
not independently verified"
(https://github.com/thehiggsfieldai/OpenHiggsfield/blob/a9507962df442b72c84f01d27565108b6724cc83/apps/story-studio/UPSTREAM.json#L1-L6).
6 commits in 5 days, then silent.

**Disposition: EXCLUDE.** Paid-API-only, server-product architecture (auth, multi-tenant) irrelevant to a local-first app,
and a provenance red flag.

---

## 9. Real SFX — Clipwing/skills (`skills/real-sfx`)

**What it is:** a substantial Claude Code skill (38 Python scripts) that sound-designs a rendered motion video with **real
recorded SFX from the user's own library**: `look.py` (contact sheets), `find_moments.py` (frame analysis),
`from_hyperframes.py` (reads exact cue times from a HyperFrames composition: scene cuts, `data-start` onsets, GSAP tween
positions incl. relative `"<"`, `"+=0.3"`, labels — "anything it cannot resolve is reported, never guessed"),
`from_cues.py` (typed cue list), `ui_events.py` (screen recordings), `suggest_cues.py`, `mix.py`, `levels.py`, `tonal.py`
(tunes pitched sounds to the score), `beats.py`, `critique.py`, `verify.py`, `taste.py` (bans/preferences), `listen_page.py`
(blind A/B page for the human). Optional **YAMNet ONNX** (16 MB, Apache-2.0, from Hugging Face) for tagging on CPU.
Python 3.9+ + FFmpeg (macOS: `ffmpeg-full` for drawtext/rubberband). Ships 78 CC0 UI sounds (`uisfx`, MIT code / CC0 audio).
Output: `*_sfx.mp4`, `*_sfx_track.wav`, stems, cue report. No paid APIs; no synthesis.
Second skill: `hyperframes-to-after-effects` (needs Adobe AE; out of scope).

**Licence:** repo has **no LICENSE file**; only the README sentence "Scripts: MIT. uisfx (bundled mp3): code MIT, sounds CC0"
(https://github.com/Clipwing/skills/blob/edbefcbc3474869e6cc1e8a7ca583b0efd0dab7e/skills/real-sfx/README.md#L104-L107).
A README grant is weaker than a LICENSE file with copyright line — ask upstream to add one before copying code.
6 commits, Oct 2026.

**Disposition: INTEGRATE VIA SUPPORTED INTERFACE (optional skill) + adopt the CC0 `uisfx` pack.** The cue extraction from
HyperFrames timelines (`from_hyperframes.py`) is directly relevant to "add appropriate sound effects to these visual events";
CreatorBrio can instead emit a typed cue list itself (we own the composition) and use the mixing/critique ideas. Treat as an
optional user-installed skill; reimplement the minimal cue→SFX placement in our own code until the licence file exists.

---

## 10. Earshot — Leonxlnx/earshot

**What it is:** a Python package (v0.4.0, `earshot` CLI + Python API `from earshot import api` + **MCP server**) giving agents
"ears": `describe`, `match`, `rank`, `find`, `compare`, `realness`, `timeline` (sync of sound to picture cuts), `sheet`
(annotated PNG), `critique` (scorecard vs launch films), `measure` (LUFS/true peak, model-free), **`forge`** (procedural
physical-synthesis SFX recipes improved by a critic loop), `fit` (recording → synthesis recipe), **`sfx render ID`** from a
bank of **252 code-defined sounds that render with no models and no network**, `kit` (renders a film's whole SFX set with
measured onset/peak), `gallery`. Optional `llm` command uses **Gemini only with own key and `--yes-upload`** consent.
Models: CLAP `laion/larger_clap_general` (Apache-2.0) and AST `MIT/ast-finetuned-audioset-10-10-0.4593` (BSD-3 per README —
model-card licence not verified here), downloaded from Hugging Face; CPU; first load 20–40 s per CLI process.
Deps: torch ≥ 2.6, transformers, librosa, scikit-learn, etc. (heavy but local; Apple Silicon fine).
Also ships `skills/earshot` and `skills/real-sound`. MIT. 40 commits in 6 days (Oct 2026), alpha.

Honest-limits section in README admits Goodhart risk (forge optimises its own critic; realness model easy to fool).

**Disposition: INTEGRATE VIA SUPPORTED INTERFACE (optional sidecar).** Use `earshot sfx`/`kit` (model-free, MIT, CC-free
procedural bank) as the default **license-clean SFX source**, and the MCP server / `measure` / `timeline` as optional QA
for the agent. Run in a separate Python venv as a subprocess or MCP; pin version; do not make torch a hard dependency of
CreatorBrio's core install.

---

## Extras — other credible open-source systems

| System | Repo / HEAD | Last commit / 90d | Licence (file) | Fit for HTML/React pipeline | Disposition |
|---|---|---|---|---|---|
| **GSAP** | greensock/GSAP `13e2b790…` v3.15.0 | 2026-04-13 / 0 (repo is a dist mirror) | **Standard "no charge" licence** (`package.json`: `"Standard 'no charge' license: https://gsap.com/standard-license."`; README "All rights reserved") — not OSI. Free incl. former Club plugins since Webflow acquisition (2025), but a "Prohibited Uses" clause targets products that let users build animations visually in competition with Webflow ([summary](https://webflow.com/blog/gsap-becomes-free), [licence mirror](https://open.windriver.com/info/uni-license-list/licenses/gsap-standard-no-charge-2025.html)). Exact text **unverified here** (gsap.com blocked) | HyperFrames' primary timeline; best seek semantics | Usable for authored compositions, but **get legal sign-off**: an AI "creative studio" that generates animations could arguably be read as a competing animation builder. Keep an exit path: HyperFrames also supports WAAPI/CSS/anime.js adapters |
| **anime.js v4** | juliangarnier/anime `01b81be1…` | 2026-08-09 / 1 | MIT | HyperFrames adapter exists (`runtime/adapters/animejs.ts`) | **Adopt** as MIT fallback timeline library |
| **WAAPI / CSS animations** | browser built-ins | — | — | HyperFrames `css.ts`/`waapi.ts` adapters | **Adopt** (zero-licence baseline for simple motion) |
| **Lottie (lottie-web)** | airbnb/lottie-web `bede03d2…` | 2024-11-19 / 0 | MIT | HyperFrames `lottie.ts` adapter; huge asset ecosystem | Adopt for imported Lottie assets; note lottie-web is in maintenance |
| **dotLottie web** | LottieFiles/dotlottie-web `2f3693a1…` | 2026-11-02 / 31 | MIT | ThorVG/WASM renderer, `.lottie` format | Adopt if we need .lottie; check HyperFrames adapter coverage (only lottie adapter seen) |
| **Rive runtime (rive-wasm)** | rive-app/rive-wasm `ef7cbdfe…` | 2026-11-03 / 587 | MIT (runtime) | Canvas/WASM state machines; authoring editor is proprietary SaaS; no HyperFrames adapter found | Optional; would need a custom FrameAdapter (advance by fixed dt). Low priority |
| **Motion Canvas** | motion-canvas/motion-canvas `7b91435` | 2026-07-02 (docs) — last feature commit 2025-02 / 0 | MIT | TS generator-based scenes, own renderer/editor; Revideo fork (redotvideo/revideo `b5de67a`, MIT, last 2026-07-15, 0 in 90d) | Exclude as engine (stagnant, second renderer); good conceptual reference for code-driven diagrams |
| **Theatre.js** | theatre-js/theatre `6ea82b93` | 2024-04-11 / 0 | `@theatre/core` Apache-2.0, `@theatre/studio` **AGPL-3.0** (README) | Keyframe sequencer, seekable `sequence.position` | Exclude (public repo dormant; dev moved private per README) |
| **ManimCE** | ManimCommunity/manim `16ea443e…` | 2026-10-27 / 82 | MIT (`LICENSE` + `LICENSE.community`) | Python; renders MP4/PNG via Cairo/OpenGL; LaTeX optional | Optional external renderer for math/technical explainer clips, imported into a composition as `<video>`/alpha MOV. Not HTML-native |
| **Excalidraw-animate** | dai-shi/excalidraw-animate `cbd7a236…` | 2026-05-29 / 0 | MIT | Animates Excalidraw SVG stroke-drawing; exports SVG/WebM | Reference/adapt: hand-drawn "architecture diagram draws itself" via SVG stroke-dash; could be reproduced with GSAP/WAAPI on Excalidraw-exported SVG |
| **Mermaid** | mermaid-js/mermaid `ea53556f…` | 2026-11-03 / 953 | MIT | Text → SVG diagrams (flowchart, sequence, architecture) | **Adopt** for diagram layout; animate the emitted SVG nodes/edges with timeline (stroke-dashoffset reveal). HyperFrames also has `flowchart` registry blocks |
| **D3** | (not cloned) | — | ISC (well known; not re-verified) | HyperFrames `d3.ts` adapter | Adopt for data-viz scenes |
| **Text behind subject** | Image-only OSS apps (e.g. fansize/text-behind-image, archived 2025-11) use `@imgly/background-removal` (**AGPL**) | — | — | — | Do not adopt those. For video: per-frame alpha matte → stacked layers. HyperFrames already implements `remove-background` with rembg `u2net_human_seg.onnx` (MIT model per rembg; not re-verified). Stronger mattes (SAM 2 Apache-2.0, BiRefNet MIT, MediaPipe Apache-2.0; RobustVideoMatting is GPL-3.0) are covered by other study slices |

---

## Disposition table

| Tool | Nature | Paid / external API | Local macOS | Output | Licence | Disposition |
|---|---|---|---|---|---|---|
| HyperFrames | Libraries + CLI + Claude plugin/skills + registry | None for render core; CLI PostHog telemetry (opt-out); media-use skill steers to HeyGen credits | Yes (screenshot capture mode on macOS) | MP4/H.265/WebM-alpha/MOV-ProRes-alpha/PNG seq/GIF/HLS | Apache-2.0 | **Adopt as dependency** (`@hyperframes/producer`/`engine`/`core`/`player`, pinned, behind our adapter); write our own skill; selectively vendor registry blocks |
| Lemo-Opuscar | Claude plugin: style prompts + guides + small render/audio toolkit | None paid (edge-tts online optional) | Yes | MP4 | MIT code, CC BY 4.0 films | **Reusable skill/template source** (style prompts, e.g. blueprint/dataviz); reimplement scenes inside HyperFrames |
| OneTake | Claude skill + Python/JS scripts | None | Yes | MP4 | PolyForm Noncommercial | **Exclude**; clean-room reimplement generic ideas only |
| Claude Animation Base | Starter kit (p5.brush character) | None | Yes (GPU helps) | MP4 | MIT (mascot trademark issue) | **Exclude as dependency**; reference for agent workflow guide |
| gbro-collage-broll | Prompt skill + Gemini scripts | **Gemini API (paid)**, Codex image_gen | Partly | MP4 (generated) | MIT | **Exclude**; borrow aesthetic/gate ideas |
| VOX-COLLAGE-BROLL | Prompt-only skill | **MaxFusion MCP** (or Google + ElevenLabs keys) | No (hosted) | MP4 (generated) | MIT | **Exclude** |
| gbro-collage-info | Skill + CSS + motion grammar on HyperFrames | None | Yes | MP4 via HyperFrames | MIT (+ GSAP std licence, Mixkit SFX) | **Adapt at source level** as a collage template/skill; drop vendored GSAP & Mixkit files |
| OpenHiggsfield | Self-hosted web app | **fal, Higgsfield, OpenRouter** | Only as API client | MP4 (generated) | MIT, provenance unverified | **Exclude** |
| Real SFX (Clipwing) | Claude skill, 38 Python scripts | None (optional YAMNet ONNX) | Yes | MP4 + SFX WAV + stems | README-only "MIT" (no LICENSE file); uisfx CC0 | **Integrate as optional skill**; adopt CC0 uisfx; reimplement cue placement until a LICENSE file exists |
| Earshot | Python package + CLI + MCP + skills | None (optional Gemini with consent) | Yes (torch CPU) | WAV, JSON, PNG sheets | MIT (+ CLAP Apache-2.0, AST BSD-3 per README) | **Integrate via supported interface** (subprocess/MCP sidecar): model-free `sfx`/`kit` bank as default SFX; analysis as optional QA |

## Capability routing implications (for the main study)
- "Animated technical architecture diagram" → HyperFrames composition + Mermaid/registry `flowchart` SVG + timeline stroke reveals; style preset from Lemo-Opuscar `blueprint` (MIT).
- "Documentary-style collage B-roll" → HyperFrames composition from adapted gbro-collage-info CSS/motion grammar (+ HyperFrames `paper-collage-reveal`); generative-video collage variants (gbro/VOX) only as an opt-in paid provider.
- "Animated text behind the speaker" → matte (HyperFrames `remove-background` or a stronger local matting model) → stacked `<video>`, text, alpha cutout in one composition.
- "Sound effects for visual events" → cue list derived from our own composition timeline (exactly as Real SFX's `from_hyperframes.py` does) → Earshot `sfx render`/`kit` (procedural, licence-clean) or user library → mix in HyperFrames `<audio>` tracks or FFmpeg; optional Earshot `timeline`/`critique` QA.
- Nothing above needs to run for every video: each is a separately invoked capability on a shared HyperFrames render core.
