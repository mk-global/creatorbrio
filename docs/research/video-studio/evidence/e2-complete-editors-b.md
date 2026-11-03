[← Research index](../README.md) · Evidence appendix

> **About this appendix.** These are the working notes of one research slice, kept close to how they were written so a reviewer can trace each conclusion in the main documents to its source. Every repository was cloned and **read only**: nothing was installed, built or executed. Dates and commit SHAs come from `git log` of fresh clones taken on 2026-11-03, and package versions from the npm and PyPI registries. Labels such as *implemented*, *claimed*, *unverified* and *[web]* mark how each claim was established. Paths shown as `<local clone>/…` refer to the researcher's temporary clone, not to anything in this repository.

# 02 — Complete open-source editors, set B (+ discovery)

Research date: 2026-11-03. Every repo was cloned with `git clone --filter=blob:none` (or `--depth 300` for SynthCut, MakeMyClip and Monet, after the partial clone failed; each has fewer than 300 commits, so their counts are complete) into `<local clone>/<name>`. I read the code only. Nothing was installed, built or executed. Star counts come from WebFetch of the github.com page on 2026-11-03 and are approximate. "Contributors" counts distinct author identities in `git shortlog`.

Context for CreatorBrio: Next.js 16 / React 19 local app. It drives the Claude Code CLI as a subprocess, renders HTML slides in sandboxed iframes and exports them with Puppeteer. The questions throughout are: can we fork or extract the piece, does it need paid or cloud keys, and does it fit an HTML-first, Claude-CLI-driven pipeline on Apple Silicon.

---

## Summary table

| Project | License | HEAD / last commit | Commits (90 d) | Contribs | Stack | Render path | Transcription | AI / keys | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| Ghost Editor | MIT (code); Mixkit media terms | ce17272 / 2026-10-30 | 12 | 1 person (3 identities) | Claude Code skill: Python + Node scripts | HyperFrames (HTML+GSAP → headless Chrome) + FFmpeg | openai-whisper / mlx-whisper (local) | Claude Code (subscription). Gemini key for B-roll QA and reference study (optional, cloud); ElevenLabs for explainer only | **Extract + learn-from** (highest relevance) |
| OpenEdit (VEED) | Apache-2.0 | 74b7240 / 2026-11-03 | 18 (bot mirror) | bots only (mirror of private repo) | Node/TS CLI + Claude skill; playwright-core | Own frame-exact HTML→video renderer (virtual clock, CDP screenshots) + FFmpeg | WhisperX local, or VEED cloud (credits) | VEED login / fal key for bg removal, lipsync, generation | **Extract** (renderer, EDL, review checks); do not adopt VEED paths |
| Concat | **AGPL-3.0+**, CLA, trademark policy, dual commercial | eda5e0a / 2026-11-03 | 1306 | 51 (one dominant) | Rust (153k LOC), Slint UI, wgpu, FFmpeg libs, ort | Native wgpu compositor; preview = export | whisper.cpp in-process (Metal) + Silero VAD | MCP server (`concat --mcp`); no keys | **Learn-from / external tool via MCP**; do not fork into CreatorBrio |
| AutoBroll | MIT (but **Remotion license** applies) | 4aef3af / 2026-09-29 | 12 | 1 | Vite React + Remotion 4.0.380 + Node server + MCP | Remotion player preview = Remotion render | WhisperX (CUDA or CPU; no MPS) | **Gemini key required** for arrange/captions/B-roll; Pexels key | **Learn-from** (small, clear model); exclude as base |
| Nuzky | **GPL-3.0+** | 45004221 / 2026-11-03 | 1031 | ~2 people | Tauri 2 + React 19 + Rust engine (wgpu, FFmpeg) | Rust wgpu renderer streams frames to webview; export same renderer | whisper.cpp (whisper-rs, Metal) | Runs user's **own Claude Code CLI** (`claude -p` + MCP); no API key | **Learn-from (architecture model)**; GPL blocks code reuse into a non-GPL app |
| OpenCut (main) | MIT | e668010 / 2026-09-24 | 1 | 116 | Rewrite scaffold (Rust GPUI + web stub) | n/a (scaffold) | n/a | n/a | **Exclude** (no editor code today) |
| OpenCut classic | MIT | cf5e79e / 2026-05-17 (archived) | 0 | 114 | Next.js 16 + React 19 + Rust/WASM compositor | Canvas/WebGPU node renderer + mediabunny export (browser) | transformers.js Whisper (ONNX, in browser) | none required | **Extract (selectively)**: timeline UI and model, browser transcription |
| Omniclip | MIT | cbe581a / 2025-08-07 | 0 | 4 | Lit-style web components, PixiJS 7, WebCodecs, ffmpeg.wasm | PixiJS canvas + WebCodecs encode | none | none | **Exclude** (stale; no captions/AI) |
| SynthCut (relo-video) | **GPL-3.0** | 96b1ca0 / 2026-07-21 | 0 | 1 | Electron + React + TS core + MCP | FFmpeg filter-graph export; **separate Canvas2D preview approximation** | whisper.cpp CLI (downloaded) | MCP (85 tools claimed); no keys | **Learn-from** (FFmpeg graph builder, OTIO); exclude as base |
| MakeMyClip Editor | MIT | 7820598 / 2026-10-29 | 21 | 1 (+1) | Node 24 CLI + MCP + Hono/Vite UI; zod schema | FFmpeg segment-and-concat; v1 single video track only | **none** (captions are agent-supplied cues) | Claude Code skill / MCP; no keys | **Learn-from** (zod doc + op log + pure compiler); too limited |
| Monet | MIT | 74fcb16 / 2026-07-06 | 0 | 1 | Electron 33 + React + Remotion + embedded PTY | FFmpeg `filter_complex_script` export; Remotion player preview | faster-whisper local | Claude Code/Codex in embedded terminal; OpenAI key optional (embeddings, image gen) | **Exclude** (stale single-dev; Remotion license) |

---

## 1. Ghost Editor — kurbaitaev/ghost-editor

| Field | Value |
|---|---|
| URL | https://github.com/kurbaitaev/ghost-editor |
| HEAD | `ce172726c36293722b08eb57b5b307d4f06389e8` |
| First / last commit | 2026-09-23 / 2026-10-30 |
| Commits total / last 90 d | 12 / 12 |
| Contributors | 3 identities: 9 commits by "Your Name <your.email@example.com>" (unset git identity), 3 by kurbaitaev. In practice one author |
| Stars / forks | ~187 / 29 |
| License | MIT ([LICENSE](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/LICENSE)). README: "The demo clips are me and my reels: watch, don't reuse." Mixkit SFX/music are downloaded, not shipped; their terms forbid Content ID registration and TV/radio/games use. Bundled Paper Shaders (Apache-2.0) and xfade-easing (MIT). Take selection is adapted from mariagorskikh/talking-head-reel (MIT) |
| Size | 382 files, ~24k lines of scripts (Python + .mjs), 513-line SKILL.md, 19 named "recipes" |
| Platform | Claude Code skill installed into `~/.claude/skills/ghost-editor`. Apple Silicon Mac stated; Linux and Intel untested |

### What it is
This is not a GUI editor. It is a **Claude Code skill plus about 80 scripts** that turn a raw talking-head phone take into a 1080x1920 reel. The agent picks takes and plans "beats". Deterministic scripts do the rest. It is the closest match in this set to CreatorBrio's target workflow: a talking-head creator, Claude Code subscription, a Mac, and HTML-rendered motion graphics.

### Architecture (verified in source)
- **Edit document**: `reel.json` holds takes (`{a, b}` in original-recording seconds), `zoom.snaps/pushes`, `captions`, `layout`, `mix`, `beats[]` (types `big`, `chips`, `strike`, `quote`, `list`, `emoji`, `logo`, `meme`, `endcard`, `broll`, `title`, `scene`, `textfx`, `behind`, ...) and `sfx[]`. Documented in [references/reel-json.md](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/references/reel-json.md#L1-L45). The build throws when a beat points at material that was cut ([build.mjs L6-L9](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/build.mjs#L1-L25)).
- **Timeline**: no timeline UI. `build.mjs` (1114 lines) compiles `reel.json` into a **HyperFrames** composition `index.html`. Takes become muted `<video data-start data-duration data-media-start data-track-index>` elements plus matching `<audio>` elements. Overlays are `div.clip` elements with timing attributes. Animation is a paused `gsap.timeline()` ([L317-L326](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/build.mjs#L317-L326), [L1051](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/build.mjs#L1051), [L1071](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/build.mjs#L1071)). GSAP 3.14.2 loads from the jsDelivr CDN ([L971](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/build.mjs#L971)).
- **Render**: `hf.sh` runs `npx -y hyperframes@0.8.159` (HeyGen HyperFrames, Apache-2.0), which renders HTML+GSAP in headless Chrome and muxes with FFmpeg ([hf.sh](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/hf.sh)). FFmpeg is wrapped to fix the audio-mix input order. Frame-grid rounding gets careful handling ([build.mjs L108-L111](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/build.mjs#L108-L111)).
- **Preview**: an approval sheet (`approval_sheet.py`, a frame at every cut and beat), then a 720p preview render. No interactive scrubbing.
- **Transcription**: openai-whisper CLI or **mlx-whisper large-v3-turbo** on Apple Silicon, using anti-merge decoding settings (no conditioning on previous text, hallucination silence threshold) ([transcribe.py L1-L17](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/transcribe.py#L1-L17)). The raw-cut pipeline also uses silero-vad (`vad_pauses.py`) and per-island transcription.
- **Face / layout**: OpenCV YuNet face track (`face_track.py`). Safe-zone placement keeps captions off the face and clear of platform UI (`lib/safezone.mjs`).
- **Text behind subject / cut-outs**: `matte.py` runs BiRefNet-portrait (torch-MPS fp16 or ONNX CPU), applies temporal median/EMA, a guided upsample and colour decontamination, then writes a VP9+alpha WebM. It explicitly refuses BRIA RMBG because of its licence ([matte.py L1-L30](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/matte.py#L1-L30)). `cutout_fx.py` (1782 lines) adds bg-swap, bg-blur, sticker, neon, clones, and "sandwich" words behind, in front of and through the speaker ([L1-L30](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/cutout_fx.py#L1-L30)).
- **Audio**: prep to -16 LUFS. SFX are levelled against the measured voice p95 (`mix.roleDb`). DeepFilterNet3 denoise, ClearerVoice superres and silero VAD. `qa.py` checks loudness, true peak and SFX-vs-voice.
- **AI integration**: Claude Code is the agent; SKILL.md is the program. It has a detailed cost and orchestration policy: one fresh helper per reel, Opus for planning, Sonnet for fixed recipes ([SKILL.md L14-L40](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/SKILL.md#L14-L40)). **Gemini is used through raw REST calls** with `GEMINI_API_KEY` for B-roll vision QA, image picking, own-footage checks and reference-video study ([lib/ai-tag.mjs L14](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/lib/ai-tag.mjs#L14), [image_sources.py L49](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/image_sources.py#L49)). The README calls it optional ("Without it, that check is skipped"), but SKILL.md says that with people rules set, a shot nobody could check fails QA. ElevenLabs is used only for the narrator explainer. Pexels and Mixkit provide stock.
- **Undo/redo, plugins**: none. Git history and per-reel generator scripts serve as state. Styles are extensible as "recipes" (README + SYSTEM.md + Python builder per style).
- **Tests**: 3 Python tests. [tests/test_assemble_sync.py](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/tests/test_assemble_sync.py#L1-L20) is a good synthetic lip-sync regression test (flash plus beep per segment).

### Implemented vs claimed
- Implemented (code present): take selection tooling, mlx transcription, face track, HyperFrames build, BiRefNet matte and cut-out effects, SFX levelling, QA scripts, 19 recipes.
- README claims I did not verify by running: "21 reels in 3 h 40 min", "2 of its own mistakes caught", the quality of the styles.
- Only one TODO marker in the scripts. No stubs found. Quality depends heavily on the agent following a 513-line prompt. The skill is strongly opinionated and Russian/English-centric.

### Reuse into CreatorBrio
- **Highly compatible concept**: CreatorBrio already renders HTML with Chromium. A `reel.json → HTML/GSAP composition → headless-Chrome frame render` pipeline is the natural extension of `wrapSlideHtml()` plus Puppeteer.
- Extractable (MIT): `transcribe.py` anti-merge settings, `matte.py` / `cutout_fx.py` (BiRefNet MPS pipeline for text-behind-subject), `lib/safezone.mjs`, `lib/caption-templates.mjs`, `lib/kinetic.mjs`, `lib/motion.mjs`, the take-selection algorithm and `plan_cut.py`, the `qa.py` loudness checks, the `reel.json` schema idea and the SKILL.md orchestration lessons.
- Risks: a one-person, five-week-old project. The code is script-shaped, not a library. It depends on a pinned HyperFrames version via `npx` (network on first run), a GSAP CDN, and Python venvs (torch, mlx). Gemini is cloud and conflicts with the "Claude subscription only" constraint, so replace it with Claude's own vision (the Read tool on frames). Mixkit licence limits apply.
- **Verdict: EXTRACT + LEARN-FROM.** Do not fork as an app because there is no app. It is the best reference for the talking-head reel workflow and the Claude Code skill design.

---

## 2. OpenEdit — veedstudio/open-edit

| Field | Value |
|---|---|
| URL | https://github.com/veedstudio/open-edit |
| HEAD | `74b724014e4ca0f6e158afe72671f94fc02e5734` |
| First / last commit | 2026-07-22 / 2026-11-03 |
| Commits total / last 90 d | 29 / 18 |
| Contributors | Bots only ("Mirror from veed-llm-editor (#N)"). Development happens in a **private VEED repo**; this repo is a publish mirror. No meaningful per-change history |
| Stars / forks | ~1.8k / 121 |
| License | Apache-2.0, `NOTICE` © 2026 VEED LIMITED. No trademark file was found. The "VEED" name is VEED's |
| Size | 233 files, ~24.6k lines of TS in `cli/src`, plus a Claude skill in `.claude/skills/open-edit` (SKILL.md, CUT.md, TRANSCRIPTION.md, FABRIC.md, VEED.md) |
| Platform | Node ≥20 CLI (`npx @veedstudio/openedit-cli`). macOS supported (FFmpeg via brew). Chrome Headless Shell is pinned |

### What it is
OpenEdit is a CLI toolkit and Claude skill for agent-driven video. There is no timeline GUI. The agent writes HTML compositions, and the CLI renders them frame-exactly, cuts footage from an EDL, mixes audio and runs delivery QA. VEED's cloud services (transcription credits, Fabric AI presenters, background removal, editor hand-off) are woven in, but they sit behind explicit commands.

### Architecture (verified)
- **Renderer (the most valuable piece)**: [`cli/src/render/page-runtime.ts`](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/render/page-runtime.ts#L1-L80) injects a script before page code that replaces `performance.now`, `Date`, timers and rAF with a **virtual clock** and seeds `Math.random`. Each frame it seeks Web Animations, the global GSAP timeline and an optional `window.__seek(t)` ([L135-L190](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/render/page-runtime.ts#L135-L190)). Frames are captured with CDP `Page.captureScreenshot` in a playwright-core Chromium ([session.ts L530](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/render/session.ts#L525-L535), [L592](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/render/session.ts#L588-L596)). It renders in parallel workers by segment with a cached manifest, and `--from/--to` re-renders a range and splices it with the concat demuxer ([encode.ts](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/render/encode.ts#L1-L10)). Output is H.264 or ProRes 4444 with alpha.
- **EDL / cutting**: [`cli/src/edl.ts`](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/edl.ts#L9-L24) defines `{sources: {id: path}, transcripts?, ranges: [{source, start, end, note?}]}` with frame-grid snapping. `apply-edl` cuts and `retime-transcript` maps word times onto the edit.
- **Text behind subject**: the renderer composites a speaker cut-out layer between "behind" and "front" layers (`render/speaker.ts`). `behind.ts` measures how much of each graphic stays visible frame by frame ([behind.ts L1-L12](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/commands/behind.ts#L1-L12)). **The cut-out itself comes from cloud background removal**: a free VEED route that needs a login, or fal (paid, own key) ([background-removal.ts L1-L9](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/commands/background-removal.ts#L1-L9)). No local matting model.
- **Reframe**: [`reframe.ts`](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/commands/reframe.ts#L1-L20) does 16:9→9:16 with an operator-style hold/pan on faces found by MediaPipe running inside a Chrome page (`faces/mediapipe.ts`).
- **Transcription**: local WhisperX (installed via uv/pipx), VEED cloud (credits), or import of any whisper-family JSON (`whisper-mapper.ts`, which has tests).
- **Audio**: `mix-audio` (ducking, loudness-matched SFX) and `mux-audio` (-14 LUFS / -1 dBTP).
- **QA**: `review` runs blank-frame, dead-tail, caption and text-legibility checks (`cli/src/verify/*`). `safe-zone` writes platform safe-area CSS for TikTok, Reels, Shorts, etc.
- **AI integration**: the Claude Code skill drives the CLI. The CLI itself calls no LLM. Paid paths (`generate`, `lipsync`, `fal run`) quote a cost and ask for a two-step approval.
- **Tests**: `cli/tests/*.test.ts` (node:test), about 20 files covering transcripts, whisper mapping and tokens. I found no renderer tests in the public tree.

### Implemented vs claimed
The source for every documented command exists. The VEED-dependent features (Fabric, VEED transcription, free background removal, veed-project) cannot be checked without an account. The local-only subset is render, EDL cut, WhisperX, mix and mux, review, safe-zone, fonts and reframe.

### Reuse into CreatorBrio
- **The renderer is directly applicable**: CreatorBrio already uses Puppeteer and HTML. The `page-runtime.ts` virtual-clock technique, GSAP and WAAPI seeking, segment cache and range re-render, `safe-zone.ts`, `verify/*`, `edl.ts` and `whisper-mapper.ts` are clean TypeScript under Apache-2.0. Attribution and NOTICE are required.
- Caveats: this is a mirror, so issues and PR flow are opaque and history cannot be bisected. It is built on playwright-core while CreatorBrio uses Puppeteer. Both speak CDP, so porting is moderate work. Strip `veed/*`, `providers/fal*`, the login and the update-notice code.
- **Verdict: EXTRACT** (renderer runtime, EDL, safe-zone, review checks, whisper mapper). Use it as a design reference for "HTML composition → frame-exact video". Do not depend on the VEED or fal paths.

---

## 3. Concat — jub0t/Concat

| Field | Value |
|---|---|
| URL | https://github.com/jub0t/Concat |
| HEAD | `eda5e0af75752cb479a018be85c798022c977070` |
| First / last commit | 2026-08-25 / 2026-11-03 |
| Commits total / last 90 d | 1306 / 1306 (Aug 155, Sep 606, Oct 520, Nov 25) |
| Contributors | 51 identities. Jareer Abdullah has about 1128 of them. **750 commit messages carry `Co-Authored-By: Claude`**, so this is very fast, heavily AI-assisted development |
| Stars / forks | ~14.0k / 1.7k. Version 0.2.8, beta |
| License | **AGPL-3.0-or-later**, plus a commercial dual licence from the owner ([LICENSING.md](https://github.com/jub0t/Concat/blob/eda5e0af75752cb479a018be85c798022c977070/LICENSING.md)). **A CLA assigns contributor copyright** to the owner. A **trademark policy** requires a rename for modified distributions ([TRADEMARK.md](https://github.com/jub0t/Concat/blob/eda5e0af75752cb479a018be85c798022c977070/TRADEMARK.md)). It bundles GPL items: Slint under its GPL option, GPL FFmpeg/x264, espeak-ng, and **Robust Video Matting weights (GPL-3.0)** |
| Size | 1269 files, ~153k lines of Rust across 17 crates, about 1158 `#[test]`s, no `todo!()` / `unimplemented!()` |
| Platform | Native: macOS (Intel + Apple Silicon, unsigned), Windows, Linux, Android, iOS (sideload) |

### Architecture (verified)
- Crates: `concat-core`, `-media` (FFmpeg bindings), `-project` (model and commands), `-render` (wgpu GPU compositor, 3.8k lines in `gpu.rs`), `-export`, `-speech` (whisper.cpp via `whisper-rs` with Metal on macOS, Silero VAD, Chatterbox TTS / voice cloning), `-vision` (ort: MediaPipe selfie segmentation, RVM matting, stabilise, upscale, enhance), `-text`, `-effects` (~100 effects), `-api` (JSON-RPC), `-server`, `-mcp`, and `concat` (the Slint UI) ([Cargo.toml](https://github.com/jub0t/Concat/blob/eda5e0af75752cb479a018be85c798022c977070/src/Cargo.toml#L1-L60)).
- **Project schema**: `Project { media, fonts, timelines: Vec<Arc<Timeline>>, active_timeline_id, extra }` ([model.rs L2842-L2862](https://github.com/jub0t/Concat/blob/eda5e0af75752cb479a018be85c798022c977070/src/crates/concat-project/src/model.rs#L2842-L2862)). `Clip { id, track_id, media_id, kind, start, duration, source_start, volume, fade_in/out, scale, offset_x/y, rotation, opacity, speed, speed_curve, keys, blend, crop, ... }` in seconds as `f64` ([L1915-L1990](https://github.com/jub0t/Concat/blob/eda5e0af75752cb479a018be85c798022c977070/src/crates/concat-project/src/model.rs#L1915-L1990)). There are multiple timelines per project, each with its own frame size (vertical and wide cuts of the same media). Undo works by `Arc` snapshot sharing.
- **Rendering**: a GPU compositor shares one wgpu device with the Slint renderer. Preview and export use the same engine.
- **Transcription**: whisper.cpp in-process, models downloaded from Hugging Face, and VAD-gated so whisper only hears speech ([transcribe.rs L4-L26](https://github.com/jub0t/Concat/blob/eda5e0af75752cb479a018be85c798022c977070/src/crates/concat-speech/src/transcribe.rs#L4-L26)).
- **AI integration**: no built-in LLM. It ships an **MCP server** (`concat --mcp`) in window or headless mode, with tools such as `project_create`, `timeline_read`, `clip_add`, `clips_split`, `captions_add`, `clip_mask`, `preview_frame` and `export_wait`. Schemas are generated from API types with schemars ([tools.rs L166-L240](https://github.com/jub0t/Concat/blob/eda5e0af75752cb479a018be85c798022c977070/src/crates/concat-mcp/src/tools.rs#L166-L240), [docs/MCP.md](https://github.com/jub0t/Concat/blob/eda5e0af75752cb479a018be85c798022c977070/docs/MCP.md)). An agent cannot edit the project open in the window ("live mode" is planned, issue #337). There is also JSON-RPC, gRPC and a CLI in source builds.
- **Captions, text, keyframes**: a curve editor and keyframes are in the model (`ClipKey`, `KeyEase`). I did not verify animated word-highlight caption styles beyond `captions_add`.

### Reuse into CreatorBrio
- **Not reusable as code** in a Next.js app. It is a native Rust/Slint app, and AGPL plus the CLA and trademark policy make vendoring or modification risky unless CreatorBrio itself goes AGPL. Even then, modified builds must be renamed.
- **It is usable as an external tool**: a user-installed Concat binary driven over MCP or JSON-RPC from CreatorBrio's Claude subprocess. A separate process keeps the AGPL boundary manageable, but we would need legal review before *bundling* it.
- Concerns: a beta, unsigned macOS app. Development pace (about 19 commits a day, mostly AI-co-authored) suggests a moving API with possible churn and regressions.
- **Verdict: LEARN-FROM / OPTIONAL EXTERNAL INTEGRATION.** Not fork, not extract.

---

## 4. AutoBroll — andriidrok1/autobroll

| Field | Value |
|---|---|
| URL | https://github.com/andriidrok1/autobroll |
| HEAD | `4aef3afb099c866bd2977c184f9912ba57318f77` |
| First / last commit | 2026-06-10 / 2026-09-29 |
| Commits total / last 90 d | 20 / 12 |
| Contributors | 1 |
| Stars / forks | ~25 / 3 |
| License | MIT for its own code. **Remotion 4.0.380 is under the Remotion License**, which requires a paid company license for for-profit companies with more than 3 people (custom terms; check the current text). That flows into any reuse of the render path |
| Size | 51 files, ~4k lines of real code (Editor.tsx 688, Timeline.tsx 422, server 473, mcp 405) |
| Platform | Browser (Vite on :5173) + Node server; Python venv for WhisperX |

### Architecture (verified)
- **Project model**: [`src/timeline.ts`](https://github.com/andriidrok1/autobroll/blob/4aef3afb099c866bd2977c184f9912ba57318f77/src/timeline.ts#L9-L56) is a simple sequential model: `Clip {id, src, inSec, outSec, sourceDurationSec, transform?: Keyframe[], volume, muted, speed}`, `Project {clips, music}`. Captions and B-roll are anchored to clips and remapped on reorder, trim or split. It is a single main track, not a multitrack NLE.
- **Render**: a Remotion composition (`src/MultiClipVideo.tsx`, `CaptionTrack.tsx`, `Broll.tsx`). `@remotion/player` previews it and `remotion render` exports it, so preview and export are consistent.
- **Undo**: zustand snapshot stacks (`past/future`, full editable state) ([editor/store.ts L28-L31](https://github.com/andriidrok1/autobroll/blob/4aef3afb099c866bd2977c184f9912ba57318f77/editor/store.ts#L28-L31)).
- **Transcription**: WhisperX in a Python venv, using CUDA float16 or CPU int8. **No Apple MPS path.** `@remotion/install-whisper-cpp` is listed as a dependency, but the scripts call whisperx.
- **AI**: **Gemini 2.5 Flash through REST with a required `GEMINI_API_KEY`** ([scripts/gemini.mjs L14-L18](https://github.com/andriidrok1/autobroll/blob/4aef3afb099c866bd2977c184f9912ba57318f77/scripts/gemini.mjs#L6-L18)). It orders takes, picks accent words, places captions face-aware (sends a frame) and plans B-roll. B-roll search uses the **Pexels API** ([broll-multiclip.mjs L111-L112](https://github.com/andriidrok1/autobroll/blob/4aef3afb099c866bd2977c184f9912ba57318f77/scripts/broll-multiclip.mjs#L111-L112)). Comments are partly in Russian.
- **MCP**: 24 tools (`mcp/server.mjs`). The browser reloads the project live when Claude writes it, and the last write wins.
- **Tests**: one tiny test (`editor/keys.test.mjs`).

### Verdict: LEARN-FROM
It is a small, readable, working example of "auto-arrange → autocut → captions → B-roll" with clip-anchored overlays and live MCP reload. The clip-anchored caption remapping (`remapCaptions`) is a good idea to copy. Its AI steps hard-require Gemini, and its rendering carries Remotion licensing. It is too thin to fork.

---

## 5. Nuzky — nuzkyapp/nuzky

| Field | Value |
|---|---|
| URL | https://github.com/nuzkyapp/nuzky |
| HEAD | `45004221d7ad4d6448c159df849363ebcbc6c78c` |
| First / last commit | 2026-10-06 / 2026-11-03 |
| Commits total / last 90 d | 1031 / 1031 (four weeks old) |
| Contributors | Tomáš Mach (two identities, about 1027 commits) plus Naman Arora (1). Only 14 commit messages mention Claude or Codex co-authorship, but the pace (about 37 commits a day) implies heavy agent use |
| Stars / forks | ~18 / 3. Version 0.1.5-alpha |
| License | **GPL-3.0-or-later**. Bundled sounds and stickers are CC0. Noto Emoji is Apache-2.0. The sample video is CC BY 3.0 |
| Size | 727 files, ~140k lines (Rust + TS), about 971 `#[test]`s, a 5.1k-line MCP stdio integration test |
| Platform | Tauri 2 desktop: **macOS 14+ Apple Silicon (notarized)**, Windows x64, Linux x86_64 |

### Architecture (verified)
- Crates: `engine` (model, edits and undo, FFmpeg decode, wgpu compositor, text, audio mix, MP4 export), `analysis` (whisper.cpp via whisper-rs with Metal, caption grouping, silence and scene analysis, **retake detection**, **style learning** from raw→final pairs, CapCut drafts or OTIO), `vision` (ort: YuNet faces, face landmarks and blendshapes, selfie segmenter, **BiRefNet-lite** for subject matte, reframe, thumbnails), `session` (single editing authority, runs, autosave, crash recovery), `mcp`, `agent`, `interchange` (CapCut, OTIO), `cli`, `chatgpt`.
- **Project schema**: `Project { version, name, canvas, assets, tracks, word_corrections, thumbnails, reel_candidates, imported }` ([model.rs L16-L37](https://github.com/nuzkyapp/nuzky/blob/45004221d7ad4d6448c159df849363ebcbc6c78c/crates/engine/src/model.rs#L16-L37)). `Clip { id, start_us, duration_us, content: ClipContent, anim_in/out, keyframes, transition_in, effects }`, with times in microseconds as `i64` ([L453-L484](https://github.com/nuzkyapp/nuzky/blob/45004221d7ad4d6448c159df849363ebcbc6c78c/crates/engine/src/model.rs#L453-L484)). `ClipContent::Media` carries voice processing (clean_voice, dereverb, normalize to -16 LUFS, leveler, ducking) ([L652-L700](https://github.com/nuzkyapp/nuzky/blob/45004221d7ad4d6448c159df849363ebcbc6c78c/crates/engine/src/model.rs#L652-L700)). TS types are generated with ts-rs (`src/lib/types.ts`, 2.3k lines).
- **Rendering**: offscreen wgpu frames are streamed to the webview over an authenticated loopback WebSocket. Export uses the same renderer, so preview matches export.
- **Transcript editing**: delete words or pauses from text, with cuts landing between words. MCP tools include `get_transcript`, `edit_transcript`, `correct_words`, `build_captions`, `apply_zooms`, `cut_to_beats`, `apply_motion`, `propose_reels`, `make_reels`, `reframe`, `segment_subject` and `search_sounds` (38 tools in total, listed in `crates/mcp/src/tools.rs`).
- **AI integration (key finding)**: the in-app AI panel **spawns the user's own Claude Code CLI**: `claude -p --input-format stream-json --output-format stream-json --strict-mcp-config --mcp-config {nuzky stdio} --tools WebSearch --allowedTools mcp__nuzky,WebSearch --permission-mode dontAsk --append-system-prompt ... --resume/--session-id` ([crates/agent/src/claude.rs L15-L44](https://github.com/nuzkyapp/nuzky/blob/45004221d7ad4d6448c159df849363ebcbc6c78c/crates/agent/src/claude.rs#L15-L44)). It disables hooks, CLAUDE.md and auto-memory through `--settings`. Codex, OpenCode and "Sign in with ChatGPT" are alternatives ([agent/src/lib.rs L1-L7](https://github.com/nuzkyapp/nuzky/blob/45004221d7ad4d6448c159df849363ebcbc6c78c/crates/agent/src/lib.rs#L1-L7)). This is the same pattern as CreatorBrio's `/api/chat`, but more locked down.
- **Undo for agents**: `begin_run` / `apply_edits(run_id, request_id, edits[])` / `end_run(keep|discard)` / `undo_run`. A whole agent turn is one undo entry. Requests are idempotent by `request_id`, and the UI is blocked while the AI edits ([docs/AI-ARCHITECTURE.md](https://github.com/nuzkyapp/nuzky/blob/45004221d7ad4d6448c159df849363ebcbc6c78c/docs/AI-ARCHITECTURE.md)).
- **Plugins**: JS plugins (`plugin.js` + `plugin.json`) with sandboxed, dry-run and full-access tiers, plus WGSL effect shaders (`skills/nuzky-plugin/examples/vhs/effects/vhs.wgsl`).
- **Text behind subject**: the model has `behind: bool` for **thumbnail** texts and `Background` replace or blur behind the person in video clips (model.rs L216-L218, L854-L866). **I did not verify text-behind-subject for video timeline text.**

### Verdict: LEARN-FROM (strongest architectural reference)
Its design of the agent loop (spawning the user's Claude CLI with a strict MCP config, run-scoped undo, idempotent batched edits, "deterministic primitives, creative agents") is exactly what CreatorBrio needs to copy *conceptually*. GPL-3.0 blocks lifting code into a non-GPL CreatorBrio. It is a native Rust/Tauri app, not embeddable in Next.js. It is also four weeks old and in alpha, with an effectively single maintainer. Users could optionally run it as an external MCP target.

---

## 6. OpenCut — OpenCut-app/OpenCut (main) and opencut-classic

### 6a. OpenCut main (rewrite)
| Field | Value |
|---|---|
| HEAD | `e668010778568641babef2cc40be4703ae6916d6` (2026-09-24) |
| First commit | 2025-06-22. 1599 commits total, **1 in the last 90 days**, 116 contributors |
| Stars / forks | ~97.2k / 9.7k (as shown on github.com) |
| License | MIT, © 2026 OpenCut. Brand assets live in `brand/`; no trademark file |
| State | **Rewrite scaffold**: 130 tracked files. A GPUI desktop shell with empty panels, a web "editor route stub", a Cloudflare worker API stub and an FFmpeg build workflow. The README says it is "being rewritten from the ground up" and promises an Editor API, plugins, MCP and headless mode, **none of which exist yet** ([README](https://github.com/OpenCut-app/OpenCut/blob/e668010778568641babef2cc40be4703ae6916d6/README.md)) |
| Verdict | **EXCLUDE** for now. Revisit when MCP or headless land |

### 6b. opencut-classic (the real editor; archived)
| Field | Value |
|---|---|
| URL | https://github.com/OpenCut-app/opencut-classic |
| HEAD | `cf5e79e919144200294fb9fed22a222592a0aeea` (2026-05-17, "docs: mark repo as archived legacy") |
| Commits / 90 d / contributors | 1567 / 0 / 114 |
| License | MIT |
| Stack | **Next.js 16.1.3 + React 19 + zustand + Rust→WASM compositor** (`rust/crates/{compositor,effects,gpu,masks,time,bridge}`), mediabunny for demux and export, `@huggingface/transformers` for in-browser Whisper, wavesurfer. Needs Postgres and Redis (docker-compose) for auth and site features; the editor is local-first |

- **Timeline**: in-house (`apps/web/src/timeline`, 105 files: snapping, group move and resize, placement, ripple). Types: `TScene` with tracks of kind `video | text | audio | graphic | effect`, plus `VideoElement`, `TextElement`, `StickerElement`, `GraphicElement`, `EffectElement` and retime config ([timeline/types.ts L19-L175](https://github.com/OpenCut-app/opencut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/timeline/types.ts#L19-L175)).
- **Rendering**: a scene-node renderer (`services/renderer/nodes/*`: video, text, image, sticker, graphic, effect-layer, blur-background) with canvas and WebGPU/WASM compositor paths. `scene-exporter.ts` exports in the browser through mediabunny, using the same node graph as preview.
- **Transcription**: transformers.js Whisper (tiny, small, medium, large-v3-turbo ONNX) in the browser, with WebGPU recommended ([transcription/models.ts L6-L30](https://github.com/OpenCut-app/opencut-classic/blob/cf5e79e919144200294fb9fed22a222592a0aeea/apps/web/src/transcription/models.ts#L6-L30)). Captions in `subtitles/`.
- **Undo**: command pattern (`commands/base-command.ts`, `batch-command.ts`, 53 command files).
- **AI agent**: none. Tests: 38 test files.
- **Reuse**: the only candidate in this set that is **the same framework as CreatorBrio** (Next.js 16 / React 19) and MIT. Its timeline UI components, snapping and ripple logic, command-based undo, mediabunny export and browser Whisper could be extracted. Downsides: it is archived and unmaintained, the Rust/WASM build adds toolchain weight, it is coupled to its own auth and DB, it has no agent API, and preview/export happens in the browser (WebCodecs), not a Puppeteer/HTML pipeline. Third-party forks (for example "OpenCut-AI", cloned by another slice at `repos/Ekaanth_OpenCut-AI`) are out of scope here.
- **Verdict: EXTRACT selectively** (timeline UI and model, command undo). Do not fork wholesale.

---

## 7. Omniclip — omni-media/omniclip
| Field | Value |
|---|---|
| HEAD | `cbe581a4a788d9982ffd4a10025c678f9e8707d6`, last commit **2025-08-07** (15 months ago), first 2023-11-05 |
| Commits / 90 d / contributors | 460 / 0 / 4 |
| License | MIT |
| Stack | @benev/slate web components, **PixiJS 7** compositor, **WebCodecs** + web-demuxer, ffmpeg.wasm, GSAP, WebRTC collaboration. Published to npm as embeddable components |
| Features | trim, split, text, transitions, filters, undo/redo, 4K export. The README lists "Speech to text" and "Keyframes" as **to be added**. "Omniclip 2.0 in development" has no public code |
| Verdict | **EXCLUDE**: stale, no captions, transcription or AI. Only a reference for WebCodecs + PixiJS browser export |

## 8. SynthCut — relo-video/synthcut
| Field | Value |
|---|---|
| HEAD | `96b1ca0e8b9935cc0d9561a3bc020f29bf9e88a0`, last commit 2026-07-21, first 2026-07-03 |
| Commits / 90 d / contributors | 21 / 0 / 1 (likely squashed import; a promo for hosted relo.video) |
| License | **GPL-3.0** |
| Stack | Electron + React desktop. TS core (`packages/core/src/engine.ts` 3.6k lines, `ffmpeg/graph.ts` 1.1k lines filter-graph builder, `interop/otio.ts`, `reframe/`). MCP package (85 tools claimed) |
| Key finding | Export is an FFmpeg filter graph, but **preview is a separate Canvas2D approximation**. The source says it "mirrors the FFmpeg compositor ... within reason" and "color is a CSS-filter proxy" ([apps/desktop/src/composite.ts L1-L10](https://github.com/relo-video/synthcut/blob/96b1ca0e8b9935cc0d9561a3bc020f29bf9e88a0/apps/desktop/src/composite.ts#L1-L10)), so preview and export can diverge. Transcription downloads a prebuilt whisper.cpp CLI and model at first use |
| Verdict | **LEARN-FROM** (FFmpeg graph builder, OTIO export). Exclude as a base: GPL, single dev, inactive since July, preview/export mismatch |

## 9. MakeMyClip Editor — MakeMyClip/editor
| Field | Value |
|---|---|
| HEAD | `782059842d3b2d3b15be55d5ec47035c1f4cbec5`, last commit 2026-10-29, first 2026-05-27 |
| Commits / 90 d / contributors | 91 / 21 / 2 (one main) |
| License | MIT |
| Stack | Node 24 CLI `clip`, MCP server, Claude Code skill, Hono + Vite UI. zod `CompositionSchema` (`src/timeline/composition.ts`). Op log (`doc-op-log.ts`) with undo and redo. Revisioned store. 36 test files (README claims 542 passing tests; not run) |
| Key finding | The export compiler is pure and testable, but **v1 handles only a single video-track sequence**. Multi-track, transforms, chroma key and gaps throw `CompileError` ([compile.ts L15-L37](https://github.com/MakeMyClip/editor/blob/782059842d3b2d3b15be55d5ec47035c1f4cbec5/src/timeline/compile.ts#L15-L37)). **No transcription**: `add-captions` takes agent-supplied cues ([add-captions.ts](https://github.com/MakeMyClip/editor/blob/782059842d3b2d3b15be55d5ec47035c1f4cbec5/src/tools/add-captions.ts#L18-L30)). Captions are FFmpeg drawtext |
| Verdict | **LEARN-FROM**: a nice pattern of a zod document, op log and arg-builder unit tests without FFmpeg in CI. Far too limited for reels with motion graphics |

## 10. Monet — Monet-AI-Editor/Monet
| Field | Value |
|---|---|
| HEAD | `74fcb1646a2329dfa35acfe7b3726491544fca18`, last commit 2026-07-06, first 2026-04-21 |
| Commits / 90 d / contributors | 59 / 0 / 1 |
| License | MIT, **but it depends on Remotion 4.0.457** (Remotion License) |
| Stack | Electron 33, React, an embedded PTY terminal running Claude Code or Codex, `editorctl` CLI, MCP server (1.5k lines), faster-whisper. Optional OpenAI key for embeddings and GPT image. Export is an FFmpeg `-filter_complex_script` ([export-service.ts L723](https://github.com/Monet-AI-Editor/Monet/blob/74fcb1646a2329dfa35acfe7b3726491544fca18/src/main/services/export-service.ts#L715-L730)). macOS app |
| Verdict | **EXCLUDE**: stale single developer, Electron, mixed Remotion licensing. The "agent in an embedded terminal" idea is noted |

---

## Cross-cutting conclusions for CreatorBrio

1. **No complete editor here is a clean fork base for a Next.js, MIT-compatible, Claude-CLI-driven Video Studio.** The mature engines (Concat, Nuzky, SynthCut) are native or Electron and GPL or AGPL. The MIT web ones are archived (opencut-classic), stale (Omniclip) or thin (AutoBroll, MakeMyClip).
2. **The "HTML composition → headless Chromium → FFmpeg" path is validated by two independent, serious projects**: Ghost Editor via HyperFrames, and VEED OpenEdit's own renderer. It maps directly onto CreatorBrio's existing `wrapSlideHtml()` + Puppeteer export. The best extraction targets are OpenEdit's `page-runtime.ts` (virtual clock, seeding WAAPI, GSAP and `__seek`, Apache-2.0) and Ghost Editor's `reel.json` → HTML compiler concepts, safe-zone and caption placement, and BiRefNet matte (MIT).
3. **The best agent-loop reference is Nuzky.** Its `claude -p` stream-json with strict MCP config, run-scoped undo and idempotent `apply_edits` show how to evolve CreatorBrio's `/api/chat` (today `--allowedTools Bash WebFetch Read` with curl) into a structured edit-operation API with one-step undo per agent turn. Reimplement it rather than copy it (GPL).
4. **Local Apple Silicon ASR options seen**: mlx-whisper large-v3-turbo (Ghost), whisper.cpp with Metal (Concat, Nuzky), transformers.js WebGPU (OpenCut classic) and WhisperX (OpenEdit, AutoBroll; no MPS in AutoBroll). The Ghost Editor anti-merge decode settings matter for retake-heavy talking-head footage.
5. **Watch the cloud keys**: Gemini appears in both Ghost Editor (optional QA) and AutoBroll (required). VEED and fal back OpenEdit's background removal and generation. Pexels and Mixkit supply stock. All must be optional or replaced by Claude vision and local models to meet the "Claude subscription only" constraint.
6. **Licence flags**: Concat (AGPL + CLA + trademark + GPL RVM weights), Nuzky and SynthCut (GPL-3.0), Remotion-based projects (AutoBroll, Monet: Remotion company licence), Mixkit audio terms (Ghost Editor), VEED NOTICE attribution (OpenEdit).

## Unverified items
- Star and fork counts come from a WebFetch summary of github.com pages.
- No project was built or run. Performance and quality claims (Ghost "21 reels in 3h40", Concat "4K scrubs smoothly", SynthCut "85 tools", MakeMyClip "542 tests") are unverified.
- Nuzky text-behind-subject on video timeline text (only thumbnails and background replace were confirmed).
- OpenEdit's private upstream history and test coverage.
- The current text of the Remotion License (check before any Remotion-based reuse).
- Velorn (GPLv3 desktop NLE with loopback MCP, mentioned in search results). I could not reach its source because hn.svelte.dev is outside the allowed network, and I did not find a repo URL.
