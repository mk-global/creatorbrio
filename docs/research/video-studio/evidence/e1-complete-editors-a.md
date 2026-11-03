[← Research index](../README.md) · Evidence appendix

> **About this appendix.** These are the working notes of one research slice, kept close to how they were written so a reviewer can trace each conclusion in the main documents to its source. Every repository was cloned and **read only**: nothing was installed, built or executed. Dates and commit SHAs come from `git log` of fresh clones taken on 2026-11-03, and package versions from the npm and PyPI registries. Labels such as *implemented*, *claimed*, *unverified* and *[web]* mark how each claim was established. Paths shown as `<local clone>/…` refer to the researcher's temporary clone, not to anything in this repository.

# Open-source AI video editors, set A: OpenFilm, OpenChatCut, BaoCut, vedit, QCut

Research date: 2026-11-03. Context: CreatorBrio (Next.js 16 / React 19 / TS / Tailwind v4, local-first, drives the Claude Code CLI
as a subprocess, renders HTML slides with Puppeteer) wants a short-form "Video Studio" for talking-head reels on Apple Silicon,
with no mandatory paid APIs and no separate Anthropic API key.

Method: each repo was cloned (`--filter=blob:none` for history; a `--depth 1` copy for reading at the same HEAD SHA) into
`<local clone>/<name>` and `<local clone>/<name>-src`. Nothing was installed, built or executed. Star and fork counts come
from github.com pages (WebFetch, 2026-11-03). "Contributors" means distinct `git log` author names, bots and aliases included.
Line references point at the HEAD SHA listed for each project.

---

## Summary table

| | OpenFilm | OpenChatCut | BaoCut | vedit (editorvideo-ai) | QCut |
|---|---|---|---|---|---|
| HEAD | `4d526294e0a7` | `7fa4b7903e7e` | `263aa691ba9d` | `6e94414c85dd` | `15e2f42f0c04` |
| Last commit | 2026-11-02 | 2026-10-21 | 2026-11-03 | 2026-11-02 | 2026-11-02 |
| First commit | 2026-10-10 | 2026-07-20 | 2026-10-07 (snapshot import) | 2026-08-03 | 2025-08-01 (OpenCut import) |
| Commits total / last 90 d | 216 / 216 | 1,100 / 855 | 1,387 / 1,387 | 94 / 93 | 19,473 / 12,517 |
| Authors (incl. bots, aliases) | 27 | 38 | 9 (1,318 commits by one person) | 2 (both the same person) | 5 (~1 human, 2 aliases) |
| Stars / forks | 4.4k / 417 | 2.9k / 432 | 1.7k / 168 | 17 / 2 | 45 / 6 |
| License | **MIT** + trademark policy | **AGPL-3.0-or-later** (and depends on Remotion's source-available license) | **BaoCut Community License 1.0** (source-available, not OSI) | **MIT** (optional extra `ultralytics` is AGPL) | **MIT** (OpenCut copyright line replaced, see below) |
| Language / shell | Node ESM + React/Vite UI; Electron desktop | TS/React/Vite; Electron | Rust (~500k LOC) + TS; Electron | Python (FastAPI) + React/Vite UI | TS/React/Vite + Electron (Bun) |
| Final render | Playwright Chromium screenshots per frame (CDP), FFmpeg for encoding and audio mixing only | Remotion `renderMedia` (headless Chrome + FFmpeg); also `@remotion/web-renderer` | Own Rust CPU compositor (tiny-skia); native encoder (AVFoundation) first, FFmpeg as fallback | FFmpeg `filter_complex` compositing (overlay/tpad/geq/zoompan) | 7 engines: canvas, WebCodecs/mediabunny, FFmpeg filter graphs, Remotion |
| Preview = export? | Yes: same Chromium page and same `frame(t)` | Yes: Remotion Player and Remotion renderer | Yes: same Rust raster compiled to WASM | Partly: preview is an FFmpeg-rendered slice, not real-time | No single path (several engines) |
| Local transcription | None built in (cloud providers, or a user-run HTTP service) | Yes: whisper via transformers.js (ONNX/WebGPU) and whisper.cpp | Yes: MLX / Core ML Whisper, Qwen3-ASR, whisper.cpp | Yes: faster-whisper (optional; CPU only on Mac) | No (ElevenLabs Scribe via fal, Gemini) |
| Claude Code without an API key | Yes (skill + CLI; desktop over ACP) | Yes (`claude -p` + MCP); also MCP server for an external Claude Code | Yes (`@anthropic-ai/claude-agent-sdk` driving the user's `claude`) | Yes (`claude -p` + MCP) | Yes (plugin + CLI) |
| Verdict | **Extract components / closest fit (learn and reuse)** | **Learn from** (AGPL + Remotion block reuse) | **Learn from** (license blocks reuse) | **Extract ideas / small parts** | **Exclude** |

---

## 1. OpenFilm (openfilm/openfilm)

### Metadata

| Field | Value |
|---|---|
| Repo | https://github.com/openfilm/openfilm |
| HEAD | `4d526294e0a7ad718cbf9bd27e2a562438819c73` (2026-11-02 22:43 +0800) |
| First commit | 2026-10-10 |
| Commits | 216 total, all in the last 90 days |
| Authors | 27 (riverisbuilding 113, WEBGRS 34, github-actions 11, ...) |
| Stars / forks | 4.4k / 417 |
| Releases / tags | tags v0.2.3 to v0.2.7; npm package `openfilm` 0.2.7 |
| License | MIT ([LICENSE](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/LICENSE)). [TRADEMARK.md](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/TRADEMARK.md) restricts use of the name and logo: a fork published as your own product needs its own name. Code reuse is unrestricted. The CLI depends on `playwright-core` (Apache-2.0). |
| Tests | 272 `*.test.*` files (node:test), covering the renderer, timeline, ops, undo and server |
| Platforms | Node 22+ CLI and web Studio (Chromium browser); Electron desktop app for macOS and Windows |

### Architecture

- **Format.** A film is a folder containing `film.html`. Each `<section>` is a track; each `<iframe>`, `<video>`, `<img>` or
  `<audio>` element is a clip. Trims are media fragments (`#t=12,18`), the start time is the `at` attribute, placement is the
  `left/top/width/height` style, and the look is plain CSS. Pages (`.html` clips) expose `window.film = { frame(t), duration,
  ready }`, and determinism is required: the same `t` must always draw the same picture
  ([SPEC.md](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/SPEC.md)).
- **Document schema**, parsed from the HTML
  ([film-doc.d.mts L44-L82](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/film-doc.d.mts#L44-L82)):
  `FilmDoc = { stage:{w,h}, tracks: FilmTrack[] }`, where `FilmTrack = { clips, locked?, hidden?, muted? }` and
  `FilmClip = { src, id, at?, time?:[start,end], box?:{x,y,w,h,r}, volume?, speed?, class?, style?, sound?, overrides?: FilmOverride[] }`.
  `FilmOverride = { at?: cssSelector, n?, t?, s?, r?, style?, text?, fade? }` stores a person's edit to an element inside a page.
  Overrides are applied after `frame(t)` runs, and agents are told to keep them.
- **Timeline.** Written in-house (`studio/ui/src/lib/timeline-*.ts`, `components/Timeline.tsx`); no timeline library. The
  playback engine is `src/timeline.mjs` (1,337 lines), which runs inside the page and drives the clips' DOM elements.
- **Rendering.** `render.mjs` opens N headless Chromium instances through playwright-core (one browser per worker). For each
  frame it calls `window.film.frame(t)`, waits for video `seeked` / `requestVideoFrameCallback` and two rAFs, then captures
  with CDP `Page.captureScreenshot`
  ([host.mjs L606-L653](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/host.mjs#L606-L653)).
  Frames are piped to FFmpeg as `image2pipe` PNG/JPEG
  ([render.mjs L435-L437](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/render.mjs#L435-L437)).
  The encoder is x264, a hardware H.264 or ProRes encoder (VideoToolbox when available), VP9, or ProRes 4444 for alpha. The
  per-worker parts are concatenated and muxed with an audio mix. Motion blur averages several frames per shutter interval
  ([render.mjs L1-L3](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/render.mjs#L1-L3)).
  **FFmpeg does encoding and audio mixing only. It does no visual compositing**; the browser composites every pixel.
- **Audio.** An FFmpeg `atrim/volume/adelay/amix` graph
  ([shared.mjs L274-L332](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/shared.mjs#L274-L332)),
  plus loudness normalization to a LUFS target (`loudness.mjs`, added 2026-11-02). There is no ducking engine and no noise
  removal.
- **Preview vs export.** Studio plays the same `film.html` with the same `timeline.mjs` in a Chromium browser, so the
  preview is effectively the export. The README requires Chrome or Edge for Studio for this reason. Slow-seeking videos get
  "fast-seeking copies" (`seekable.mjs`) for the render.
- **Captions.** Transcripts are WebVTT files stored beside each media file, with word timestamps as VTT timestamp tags
  ([transcripts.mjs L1-L30](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/studio/server/transcripts.mjs#L1-L30)).
  Studio cuts them into subtitle segments, has a subtitle inspector and styles, and burns them in by wrapping the film in a
  page (`burn.mjs`).
- **Transcription.** There is **no local ASR**. Providers are OpenAI `whisper-1`, Groq `whisper-large-v3(-turbo)`,
  ElevenLabs, Google and Doubao, all needing the user's own keys
  ([groq.mjs L15](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/studio/server/providers/groq.mjs#L15)).
  "Custom services" can call any HTTP endpoint, including a user-run local whisper server
  ([custom-services.mjs L1-L14](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/studio/server/custom-services.mjs#L1-L14)).
- **AI agent.** The primary mode needs no API key: `npx skills add openfilm/openfilm`, after which Claude Code or Codex
  reads MANUAL.md and runs `openfilm open/look/render/get`, writing `film.html` and pages as ordinary files. The agent's edits
  are file edits, not structured operations. Studio's own edits *are* structured operations (`set/move/insert/remove/split/props/stage/fields/track/reorder`;
  [ops.mjs L12-L25](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/studio/server/ops.mjs#L12-L25)),
  and the server and the UI share one implementation of them. The desktop app drives the user's own Claude Code or Codex over
  the **Agent Client Protocol** (`@agentclientprotocol/claude-agent-acp`)
  ([apps/desktop/src/agents.mjs L1-L12](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/apps/desktop/src/agents.mjs#L1-L12)),
  and also has a "pi" coding agent that uses your own key.
- **QA loop.** `openfilm look` renders contact sheets, draws every frame twice in shuffled orders to detect
  non-determinism, and reports page errors, failed fonts, missing audio and text clipped by the frame. This directly
  supports agent self-checking.
- **Undo/redo.** Undo is computed per clip from the before and after films, so undoing one person's edit does not revert
  concurrent agent edits ([undo.ts L1-L5](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/studio/ui/src/editor/undo.ts#L1-L5)).
  Named versions are git-backed (`history-store.mjs`).
- **Extensibility.** Skills (`packages/openfilm/skills/*`: long-to-short, presenter-pip, motion-graphics, lyric-video,
  keynote, ...); custom HTTP services; pages may use any web library (GSAP, three.js, canvas).
- **Export formats.** MP4, WebM/MOV with alpha, GIF, audio and stems, subtitles, stills, FCPXML / Premiere / Resolve
  timelines (`nle.mjs`, `fcpxml.mjs`), and Jianying drafts (`jianying.mjs`).

### Implemented vs claimed

- Implemented and tested in code: the HTML film format, parallel Chromium frame render with motion blur and alpha, the Studio
  editor (layers, overrides, timeline split/trim/move, fades, speed, volume), subtitles from VTT, NLE export, loudness, and
  provider integrations.
- Not present: local ASR, face tracking or auto-reframe, person segmentation (text-behind-subject), silence and filler
  removal as an algorithm, and audio ducking or noise reduction. The `long-to-short` skill delegates finding cut points and
  framing to the agent, with CSS framing written by hand
  ([skills/long-to-short/SKILL.md](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/skills/long-to-short/SKILL.md)).
- Only 4 TODO/FIXME/not-implemented hits across `.mjs/.ts/.tsx`. The code is unusually clean and densely commented.
- Young project: 3.5 weeks of public history.

### Reusable parts for CreatorBrio

- **The render core** (`src/host.mjs`, `src/render.mjs`, `src/encoders.mjs`, `src/seekable.mjs`, `src/rate.mjs`,
  `src/browser-pool.mjs`). This is the same paradigm CreatorBrio already uses (HTML through headless Chromium to pixels),
  extended to deterministic time-based frames, parallel workers and FFmpeg piping. The `openfilm` npm package exports
  `./render`, `./host`, `./film-doc` and `./look`, so it can be called from a Next.js route handler / Node runtime, or
  spawned as a CLI.
- **The `frame(t)` page contract and SPEC.md.** A ready-made, agent-friendly motion-graphics contract that matches how
  CreatorBrio's agent already writes HTML slides.
- **`film-doc.mjs` and `ops.mjs`**: a pure, dependency-free parser, serializer and edit-op layer for an HTML timeline format.
- **`look.mjs`**: determinism and QA checks for agent-made output.
- **`studio/server/transcripts.mjs`, `subtitle-segments.mjs` and `captions.mjs`**: WebVTT word-timing to subtitles.
- **The Studio UI** is the same stack as CreatorBrio (React 19, Vite, Tailwind v4, lucide). It is 76 components (~70k
  lines of UI TS/TSX), so extracting the timeline component is possible but tied to its own `lib/timeline-*` helpers.
- Missing pieces that CreatorBrio would have to add: local whisper (whisper.cpp / MLX), segmentation for text-behind-subject,
  face-tracked reframing, and transcript-driven cutting UI.

### Verdict: **extract components / use as a library (best fit in set A)**

MIT; the architecture is almost identical to CreatorBrio's (HTML, Chromium, FFmpeg encode; Claude Code CLI as the agent with
no key); preview equals export; strong tests. Weaknesses: very young, no local ASR, no talking-head automation (reframe,
segmentation, silence cutting), and per-frame screenshot rendering is slower than native compositing, especially for long
4K footage. The trademark policy only matters if the product would be called "OpenFilm".

---

## 2. OpenChatCut (0xsline/OpenChatCut)

### Metadata

| Field | Value |
|---|---|
| Repo | https://github.com/0xsline/OpenChatCut |
| HEAD | `7fa4b7903e7ebecf832a36249f0c0c755200cc17` (2026-10-21 21:08 +0800) |
| First commit | 2026-07-20 |
| Commits | 1,100 total / 855 in the last 90 days |
| Authors | 38 (0xsline 833 + alias "sline" 42, 刘金旺 73, ...) |
| Stars / forks | 2.9k / 432 |
| Version | 0.2.17 |
| License | **AGPL-3.0-or-later** ([package.json L6](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/package.json#L6), LICENSE). It also hard-depends on **Remotion 4.0.537** (`remotion`, `@remotion/renderer`, `@remotion/player`, `@remotion/web-renderer`; [package.json L118-L143](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/package.json#L118-L143)). Remotion's license is free only for individuals, non-profits and for-profit organizations with up to 3 employees; others need a paid Company License, and selling derivatives of Remotion is prohibited (Remotion LICENSE.md on GitHub). There is also a commercial "OpenChatCut Pro" desktop edition and sponsor links. |
| Tests | 632 `*.verify.*` scripts run with tsx (custom harness, not vitest/jest) |
| Platforms | Vite dev server (web) and Electron 43 desktop |

### Architecture

- **Schema** ([projectTypes.ts L8-L17](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/src/editor/projectTypes.ts#L8-L17)):
  `ProjectDoc = { version, assets: MediaAsset[], mediaFolders, timelines: Timeline[], activeTimelineId, designStyle? }`.
  `TimelineItem` ([clipTypes.ts L136-L200](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/src/editor/clipTypes.ts#L136-L200))
  is frame-based (`startFrame`, `durationInFrames`, `srcInFrame`) with
  `kind: 'motion-graphic'|'audio'|'video'|'image'|'text'|'gif'|'svg'|'solid'|'sequence'`, plus `transform`, `keyframes`,
  `filters`, `zoom` (ReframeCurveV1 focal-point keyframes), `effects` (WebGL), `playbackRate`, and a transcript carrier.
  Motion graphics are React/TSX template code (`code`, `props`) compiled with `@babel/standalone` in a sandbox.
- **Timeline and edits.** Its own immutable reducer and command layer (`src/editor/reduce.ts`, `reducer*.ts`,
  `storeCommands.ts`, `storeCommandBuilder.ts`); no timeline library. Undo/redo snapshots the whole project
  (`reducerHistory.ts`). The agent, the MCP and the UI all go through the same `EditorCore` commands. External agents work on
  an isolated draft with `begin_edit_session` → `review_edit_session` and approve or reject the proposal (README "Agent / MCP").
- **Rendering.** Preview uses the Remotion Player. Export uses Remotion `bundle → selectComposition → renderMedia` in headless
  Chrome (ANGLE/Metal on macOS), with a hardware H.264 ffmpeg override and AAC-delay compensation
  ([remotion/render.mjs L1-L6](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/remotion/render.mjs#L1-L6),
  [L31-L37](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/remotion/render.mjs#L31-L37)).
  Compositing is browser and WebGL; FFmpeg encodes via Remotion. Preview and export are consistent because the same React
  composition runs in both.
- **Transcription, local.** Whisper through `@huggingface/transformers` in a WebWorker (WebGPU or wasm), and a desktop
  whisper.cpp engine with GGML models, a downloadable model catalog and sha256 checks
  ([local-asr.ts L1-L3](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/src/transcript/local-asr.ts#L1-L3),
  [server/plugins/asr-models.ts](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/server/plugins/asr-models.ts)).
  Cloud options include AssemblyAI and Deepgram. Silero VAD, silence rebuild, pause compression and word-level transcript
  editing are present (`src/audio/silero-vad*`, `src/editor/silenceRebuild.ts`).
- **Visual geometry.** MediaPipe `selfie_segmenter` and `blaze_face_short_range`, run offline at 2 fps and 512 px, are used
  for caption collision avoidance, a face-safe zone and reframe targeting
  ([src/geometry/mediapipe.ts L1-L25](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/src/geometry/mediapipe.ts#L1-L25)).
  There is **no per-frame matte, so no text-behind-subject compositing** (grep found no occlusion or "behind" layer).
- **AI agent.** Vercel AI SDK 7 with many providers (API keys). It can also run the user's **Claude Code CLI**: each turn is a
  fresh `claude -p --output-format stream-json --mcp-config <own MCP endpoint>`, with built-in Bash, Read and Edit denied, so
  the only tools are the editor's MCP tools
  ([server/claude-code/turn-runner.ts L10-L18, L46-L60](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/server/claude-code/turn-runner.ts#L10-L60)).
  Codex app-server and GitHub Copilot SDK drivers also exist. A Streamable HTTP MCP server runs at
  `localhost:5199/api/external-mcp/mcp`.
- **Other.** WebGL effects, transitions and LUTs (`src/gl`, 164 files); motion tracking (template matching); multicam; scene
  detection; FCPXML and Jianying/CapCut draft export; Upload-Post publishing; fal/MiniMax/Kling generation; an extension
  center for community resources.

### Implemented vs claimed

- Most README rows have corresponding code directories and verify scripts. Only 14 TODO/FIXME hits. "Reframe follows the
  subject" exists as zoom/reframe curves with MediaPipe face detection (`src/reframe/detect.ts`), but the quality of the
  tracking was **not verified**.
- Codebase size: ~286k lines of TS across `src/server/remotion/desktop/shared/cli`. Feature sprawl is large (publishing,
  generation marketplaces, sponsor integrations).

### Reusable parts

- Conceptually: the draft, review and approve edit-session pattern for external agents; the restricted `claude -p`
  invocation pattern; the frame-based schema with ReframeCurveV1; the MediaPipe caption-placement geometry; and the local ASR
  model catalog and integrity flow.
- **Code reuse is blocked for CreatorBrio unless CreatorBrio itself becomes AGPL**, and the Remotion dependency adds a
  per-company license cost for organizations with more than 3 employees.

### Verdict: **learn from (do not fork, do not copy code)**

Feature-rich and active, with an architecture close to what CreatorBrio needs (Claude Code over MCP, local whisper,
transcript editing). But AGPL plus Remotion licensing makes it unsuitable as a base for a permissively licensed or commercial
CreatorBrio. Use it as a feature checklist and a design reference only.

---

## 3. BaoCut (JimLiu/baocut)

### Metadata

| Field | Value |
|---|---|
| Repo | https://github.com/JimLiu/baocut |
| HEAD | `263aa691ba9df2e6addc5c3be43e9f84bad3c360` (2026-11-03 08:51 UTC) |
| First commit | 2026-10-07, "Import BaoCut application source snapshot" (v3 code ported from a non-public v2) |
| Commits | 1,387, all in the last 90 days (about 45 per day; Jim Liu 1,318) |
| Authors | 9 |
| Stars / forks | 1.7k / 168 |
| License | **BaoCut Community License 1.0, source-available, NOT open source** ([LICENSE L1-L10](https://github.com/JimLiu/baocut/blob/263aa691ba9df2e6addc5c3be43e9f84bad3c360/LICENSE#L1-L10)). Personal and internal business use, and selling *content* made with it, are allowed. Prohibited without a written commercial license ([§3, L60-L90](https://github.com/JimLiu/baocut/blob/263aa691ba9df2e6addc5c3be43e9f84bad3c360/LICENSE#L60-L90)): (a) distributing the software or modified versions commercially, (b) running it as a commercial hosted service, (c) **"incorporating any Software code, binaries, or engine into a commercial software product, library, SDK, appliance, or service supplied to others."** Noncommercial redistribution only. Trademark use is restricted (§5). Bundled local TTS such as Fish Audio S2 Pro is research/non-commercial. |
| Tests | 861 `*.test.ts` files (vitest) and 675 Rust files containing `#[test]` |
| Platforms | Electron 44 desktop (macOS 14+ Apple Silicon signed and notarized; Windows CPU/CUDA/Vulkan), CLI, MCP, web client |

### Architecture (the most engineered of the five)

- **Rust workspace** (`crates/*`, ~500k LOC). Main pieces: `timeline` (pure timeline semantics, talking-head cut detection,
  word anchors, ducking), `video-engine` (single-writer store with transactions, receipts, undo and an outbox), `render-graph`
  (per-frame plan), `frame-render` + `render-raster` (CPU raster on tiny-skia, cosmic-text/swash text, effects, masks,
  transitions, Lottie), `subtitle-render` (73k LOC: caption layout, per-word animation, designed captions), `motion` (easing,
  springs, presets), `audio-dsp` (biquads, ducking, BS.1770 loudness, true-peak limiter), `face-detect` (YuNet ONNX on tract),
  `model-runtime` (local inference), and `export-worker`.
- **Schema.** `VideoSnapshot { format, schemaVersion, id, revision, rootSequenceId, sequences: Map<Id,Sequence>, assets, documents, fonts, localizationSets, canvasVariants, protections, checkpoints, ... }`.
  `Sequence { tracks, items: TimelineItem[], transitions, markers, ducking }`. Items include Video, Image, Text, Shape, Sticker,
  Visualizer, Progress, Draw, Confetti, Whiteboard and Composition
  ([crates/video-model/src/lib.rs L73-L127](https://github.com/JimLiu/baocut/blob/263aa691ba9df2e6addc5c3be43e9f84bad3c360/crates/video-model/src/lib.rs#L73-L127)).
  Items carry a `followPolicy` (follow cuts vs sequence-fixed) and semantic anchors to transcript words.
- **Rendering.** The export worker computes a frame plan, rasters it on the CPU, and sends it to the encoder, with
  platform-native encoding first and FFmpeg as the fallback
  ([crates/export-worker/src/main.rs L1-L15](https://github.com/JimLiu/baocut/blob/263aa691ba9df2e6addc5c3be43e9f84bad3c360/crates/export-worker/src/main.rs#L1-L15);
  `media-native` uses AVFoundation and Media Foundation). The **editor preview uses the same raster compiled to WASM**
  (`bindings/preview-wasm`, "与导出同一份实现", i.e. "the same implementation as export"), so preview and export are
  consistent by construction. FFmpeg is used as a subprocess to decode and encode, not for compositing.
- **HTML motion graphics.** Code bundles (`baocut/1` and `hyperframes/1` contracts) are "baked" to `.mov` in one of two ways:
  (a) recording Canvas2D calls in Chromium and replaying them as DrawOps in Rust, or (b) pixel fallback, where PNG screenshots
  per frame are piped to ffmpeg `image2pipe`
  ([packages/code-runtime/src/composition-bake.ts L10-L19](https://github.com/JimLiu/baocut/blob/263aa691ba9df2e6addc5c3be43e9f84bad3c360/packages/code-runtime/src/composition-bake.ts#L10-L19)).
- **Local transcription and AI on Apple Silicon.** MLX (`pmetal-mlx-rs`), Core ML Whisper, LiteRT, candle, and whisper.cpp
  with Metal/Vulkan/CUDA features
  ([crates/model-runtime/Cargo.toml L10-L33](https://github.com/JimLiu/baocut/blob/263aa691ba9df2e6addc5c3be43e9f84bad3c360/crates/model-runtime/Cargo.toml#L10-L33)).
  The README lists Whisper large-v3/turbo, Qwen3-ASR, MOSS with diarization, HTDemucs separation, local TTS (Qwen3-TTS,
  IndexTTS, VoxCPM2, ...) and Qwen-Image.
- **Agent.** `packages/agent-drivers` drives the user's own `claude` through `@anthropic-ai/claude-agent-sdk` (0.3.303), plus
  Codex, OpenCode, Pi and generic ACP. Edits go through one command gateway with transactions and receipts, shared with the
  UI. Both an MCP service and a CLI are provided.
- **Talking-head features.** Filler, pause, retake and false-start removal on the timeline (`crates/timeline` "口播剪口",
  i.e. talking-head cut points); designed captions; dubbing; ducking. **Segmentation / text-behind-subject was not found**
  (grep for matting, rmbg and segmenter found nothing). Face detection exists (YuNet) for frame metadata; reframing was not
  verified.

### Implemented vs claimed

- Code paths exist for the main claims, and the depth is real: a deterministic binary DrawOp IR, a byte-exact vendored-resvg
  gate, and spec-driven docs. Only 57 TODO/unimplemented hits across ~2.9M lines. Activity is extremely high and almost
  single-author, and most code was ported from the closed v2. The size (Rust plus ~2.4M lines of TS across packages and apps,
  including generated and i18n files) makes it hard to take apart.

### Reusable parts

- Under its license, **none for a product supplied to others**: code may only be used internally or noncommercially. An
  "independently written plugin, integration, or client that only uses BaoCut's public interfaces" is allowed, so CreatorBrio
  could *integrate with* a user-installed BaoCut over its MCP or CLI without copying code.
- As design reference: preview and export sharing one raster core via WASM, the follow-cuts / semantic-anchor item model,
  the talking-head cut semantics, the designed-caption recipes, and the canvas-recorder bake path for HTML motion graphics.

### Verdict: **learn from (exclude as a code source)**

Technically the most serious engine in the set, and strong on Apple Silicon local AI. The license explicitly forbids
incorporating it into a product supplied to others, and the codebase is enormous and in Rust. Integration as an optional,
user-installed external tool is the only clean path.

---

## 4. vedit (metiutek/editorvideo-ai)

### Metadata

| Field | Value |
|---|---|
| Repo | https://github.com/metiutek/editorvideo-ai |
| HEAD | `6e94414c85dde0b0aca53754adc4ecf792536533` (2026-11-02 22:20 +0100) |
| First commit | 2026-08-03 |
| Commits | 94 total / 93 in the last 90 days |
| Authors | 2 names, both the same person (metiu1) |
| Stars / forks | 17 / 2 |
| Package | PyPI `vedit-mcp` 0.5.3 |
| License | MIT ([LICENSE](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/LICENSE)). Optional extras: `ultralytics` (**AGPL-3.0**, YOLO-seg, used for remove_background, auto_reframe and track_mask), `faster-whisper` (MIT), `playwright`, `yt-dlp`, `pedalboard` (GPLv3) ([pyproject.toml L60-L80](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/pyproject.toml#L60-L80)). |
| Tests | 59 pytest files, including "slow" real-render tests and a preview-vs-render comparison |
| Platforms | Python 3.10+ local server (FastAPI) and React/Vite web UI at 127.0.0.1:8760; cross-platform |
| Code size | backend ~28k lines of Python; frontend ~8k lines of JSX; code and comments in Italian |

### Architecture

- **Schema.** Python dataclasses serialized to JSON:
  `Project { version, name, settings, media: Media[], tracks: Track[], master, markers, cover }` and
  `Clip { id, type: media|text|color|html, media, start, in_, duration, speed, reverse, fit, blend, link, transform, audio, effects, fade_in/out, transition_out, text, color, html, html_base }`
  ([model.py L211-L245](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/backend/vedit/model.py#L211-L245),
  [L316-L327](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/backend/vedit/model.py#L316-L327)).
- **Rendering: true FFmpeg compositing.** The timeline is compiled into one `filter_complex`: a color canvas with one
  `overlay` per clip, `tpad` for placement, `geq` alpha masks for wipes, and keyframes as ffmpeg expressions
  ([graph.py L1-L17](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/backend/vedit/graph.py#L1-L17)).
  Exports longer than 20 s are split at cut points into ~4 s pieces, rendered in parallel and concatenated (README "How it
  works").
- **Preview.** Not real-time compositing: `slice_project` renders the requested portion through the same FFmpeg graph. This
  keeps preview and export consistent, but preview means waiting for segments (README "Known limits"). The UI has a
  LivePlayer for media.
- **HTML clips.** Playwright Chromium captures frames with a virtualized clock that replaces performance.now, Date and rAF and
  freezes CSS/WAAPI animation, then encodes FFV1 `.mov` with alpha. The live preview runs in an iframe with the same clock
  ([htmlclip.py L1-L24](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/backend/vedit/htmlclip.py#L1-L24)).
- **Transcription.** faster-whisper, word timestamps, in a child process
  ([analyze.py L348-L365](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/backend/vedit/analyze.py#L348-L365)).
  On a Mac it runs on CPU int8 (CTranslate2 has no Metal backend). Features: tighten_speech, censor_speech, make_captions.
- **Segmentation and reframe.** YOLO-seg through ultralytics per frame for `remove_background`; `invert=True` plus a
  duplicated clip gives **text-behind-person**, which is explicitly documented
  ([mcp_server.py L1940-L1955](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/backend/vedit/mcp_server.py#L1940-L1955)).
  The README admits it is "fast rotoscoping, not compositing-grade". `auto_reframe` and `track_mask` also exist.
- **Agent.** `Store` is the single source of edit operations, with undo/redo, used by the UI, the MCP server (README says 130
  tools) and the in-app chat. The chat supports Anthropic SDK (key), OpenAI-compatible providers (including Ollama), and
  **Claude Code without a key**: `claude -p --output-format stream-json --mcp-config {vedit http MCP} --strict-mcp-config --allowedTools mcp__vedit Read Glob WebFetch WebSearch`
  ([llm.py L1-L17](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/backend/vedit/llm.py#L1-L17),
  [L629-L662](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/backend/vedit/llm.py#L629-L662)).
  This is essentially CreatorBrio's pattern. Agent QA tools: `preview_frame` and `preview_grid` return real rendered frames;
  `music_beats` (numpy) supports beat-cutting.
- **Audio.** FFmpeg chains (loudnorm, presets, a mixer UI), 5.1 routing, and VST/AU through pedalboard.

### Implemented vs claimed

- The claims are mostly backed by code (`store.py`, `graph.py`, `effects.py`, `mcp_server.py` ~3k lines). The README
  contradicts itself: the FAQ says the assistant needs "your own Anthropic key", while code and the tour support keyless
  Claude Code. The code wins.
- The README badge says 130 tools; the GitHub About text says 83. The count was not verified.
- Single developer, 3 months old, 17 stars: bus factor 1. README "Known limits" admits there is no project-file lock and that
  `geq` animated opacity is slow.
- An FFmpeg filter-graph engine is hard to extend to rich motion graphics and kinetic captions without falling back to HTML
  clips.

### Reusable parts

- `graph.py` and `keyframes.py` as a reference for compiling a timeline into an FFmpeg filter graph (concepts only; it is
  Python, and CreatorBrio is TS).
- The `htmlclip.py` virtual clock (overriding performance.now, Date, rAF and timers and stepping by 1/fps): useful if
  CreatorBrio wants arbitrary GSAP/CSS animations to render deterministically without requiring a `frame(t)` API.
- The text-behind-subject recipe (inverse matte plus duplicated clip). Use a non-AGPL segmenter instead of ultralytics.
- The `claude -p` + MCP config pattern (CreatorBrio already does something similar with curl).

### Verdict: **extract ideas / small parts (MIT), not a foundation**

A clean, honest and small codebase, MIT, and genuinely keyless with Claude Code. But it is Python plus FFmpeg filter graphs,
has no real-time preview, is single-maintainer and has little adoption. Good for borrowing techniques; a poor base for a
polished Next.js studio.

---

## 5. QCut (Quriosity-agent/qcut)

### Metadata

| Field | Value |
|---|---|
| Repo | https://github.com/Quriosity-agent/qcut |
| HEAD | `15e2f42f0c0424a5c24b44d13d1a3883590c8710` (2026-11-02 01:24 +1100) |
| First commit | 2025-08-01, "Initial commit: QCut video editor project" (imports `OpenCut-main/`) |
| Commits | 19,473 total / 12,517 in the last 90 days (about 140 per day) |
| Authors | 5: Donghao Zhang 16,575 and donghaozhang 2,863 (same person), peter 32, plus bots |
| Stars / forks | 45 / 6 |
| License | MIT ([qcut/LICENSE](https://github.com/Quriosity-agent/qcut/blob/15e2f42f0c0424a5c24b44d13d1a3883590c8710/qcut/LICENSE)), "Copyright 2025 QCut". **Provenance issue:** the code is a fork of OpenCut, whose MIT LICENSE read "Copyright 2025 OpenCut" (visible in initial commit `835db273a`). A later "complete rebrand from OpenCut to QCut" (`7fa71612b`, 2025-08-20) replaced that notice, and `grep -r OpenCut` over the current tree finds 0 matches. MIT requires keeping the original copyright notice. Also depends on Remotion 4.0.497 (source-available, company license required above 3 employees). |
| Tests | 2,119 test files (vitest / Playwright) |
| Platforms | Electron 40 (Windows, macOS ARM, Linux), Bun monorepo, plus a hosted `license-server`, `qcut-relay`, auth and db packages |
| Code size | ~1.6M lines of TS/TSX (non-node_modules) |

### Architecture

- **Base.** OpenCut (Next.js) migrated to Vite, TanStack Router and Electron. `packages/editor-core` holds the timeline types,
  commands and history, captions, effects, tracking and templates
  ([types/timeline.ts](https://github.com/Quriosity-agent/qcut/blob/15e2f42f0c0424a5c24b44d13d1a3883590c8710/qcut/packages/editor-core/src/types/timeline.ts)).
- **Rendering.** Seven export engines: `standard`, `optimized`, `webcodecs`, `muxer` (mediabunny), `ffmpeg`, `cli`, `remotion`
  ([export-engine-factory.ts L28-L36](https://github.com/Quriosity-agent/qcut/blob/15e2f42f0c0424a5c24b44d13d1a3883590c8710/qcut/apps/web/src/lib/export/export-engine-factory.ts#L28-L36)).
  The Electron CLI path builds FFmpeg filter graphs for text, stickers, images and transitions (`electron/ffmpeg-export-handler.ts`
  modes 1, 1.5 and 2). The preview is a canvas composition (`apps/web/src/lib/preview/canvas-composition-*`). With this many
  engines there is no single shared render contract.
- **Transcription.** Cloud only: ElevenLabs Scribe v2 via fal
  ([electron/elevenlabs-transcribe-handler.ts L1-L12](https://github.com/Quriosity-agent/qcut/blob/15e2f42f0c0424a5c24b44d13d1a3883590c8710/qcut/electron/elevenlabs-transcribe-handler.ts#L1-L12))
  and Gemini. `apps/transcription` is a leftover OpenCut Modal/openai-whisper cloud function. No whisper.cpp, MLX or
  faster-whisper was found.
- **AI and monetization.** Requests made without your own keys are "relayed through the QCut license server, which holds
  provider keys on behalf of authenticated users"
  ([README L203-L204](https://github.com/Quriosity-agent/qcut/blob/15e2f42f0c0424a5c24b44d13d1a3883590c8710/README.md#L203-L204)).
  The code has credit costs, a license server (Cloudflare Workers / Hono) and a shared Freesound key.
- **Agent.** The Claude Code and Codex plugins call a 286-command CLI that talks to the running editor's HTTP API with a
  bearer token (`electron/claude/*`). The commands are structured.
- **IP red flag.** `electron/jianying-effect/offline-runtime.ts` locates the user's installed ByteDance JianyingPro app
  (`/Applications/VideoFusion-macOS.app`) and copies its proprietary frameworks (`libAGFX.dylib`, `libLumiGeneRuntime.dylib`,
  `libcccreator.dylib`, ...) to run Jianying effects
  ([L27-L33](https://github.com/Quriosity-agent/qcut/blob/15e2f42f0c0424a5c24b44d13d1a3883590c8710/qcut/electron/jianying-effect/offline-runtime.ts#L27-L33),
  [L482-L483](https://github.com/Quriosity-agent/qcut/blob/15e2f42f0c0424a5c24b44d13d1a3883590c8710/qcut/electron/jianying-effect/offline-runtime.ts#L482-L483)).
  There is also a CapCut 8.1 draft-install guard, "Sticker Lab" Jianying reference media marked non-redistributable
  (`electron/types/restricted-media-export-policy.ts`), and a `research/` folder of "independent" re-implementations of
  Jianying filters.

### Implemented vs claimed

- Code exists for a very wide surface, but the commit rate (about 140 per day from one person) indicates heavy AI-generated
  churn. A "Metal filter renderer" exists as Swift research files plus a compiled host bridge
  (`electron/qcut-independent-filter`); its completeness was not verified. Low adoption (45 stars).

### Reusable parts

- Very little that is safe and practical to reuse. OpenCut upstream (MIT, with its notice intact) is a cleaner source for any
  timeline UI ideas. The mediabunny/WebCodecs export engine could be a reference, but mediabunny itself is the reusable piece.

### Verdict: **exclude**

Unclear provenance (the OpenCut notice was dropped), proprietary ByteDance runtime dependencies, cloud-only transcription, a
commercial relay and credits, a Remotion dependency, an unmanageable size (1.6M LOC) and a bus factor of 1.

---

## Cross-cutting conclusions for CreatorBrio

1. **Render architecture fit.** OpenFilm's approach (deterministic `frame(t)` HTML pages, parallel headless Chromium,
   CDP screenshots, FFmpeg encode, FFmpeg audio mix) is a direct extension of CreatorBrio's current Puppeteer slide export
   and of `wrapSlideHtml()`. It keeps one rendering contract shared by preview and export, and it is MIT. This is the most
   reusable asset in set A.
2. **The keyless Claude Code pattern is proven in 4 of the 5 projects.** OpenFilm uses a skill plus CLI and ACP; OpenChatCut
   and vedit use `claude -p --output-format stream-json --mcp-config` with a strict tool allow-list; BaoCut uses the
   claude-agent-sdk driving the user's binary. Exposing the editor's operations as MCP tools (OpenChatCut, vedit, BaoCut) is
   cleaner than curl-ing REST routes and gives typed, structured edits with undo.
3. **Gaps none of the permissive projects fill well.** Local ASR on Apple Silicon (best in BaoCut with MLX and Core ML,
   which is not reusable; OpenChatCut's whisper.cpp and transformers.js is AGPL; vedit's faster-whisper runs on CPU only);
   per-frame person matting for text-behind-subject (only vedit, through AGPL ultralytics and of rotoscope quality); and
   face-tracked 9:16 reframing (OpenChatCut with MediaPipe, AGPL; vedit with YOLO, AGPL). These need separate permissive
   components, for example whisper.cpp / mlx-whisper / parakeet-mlx, MediaPipe (Apache-2.0), RobustVideoMatting or BiRefNet,
   and SAM2. Those are covered in other slices.
4. **Licensing traps found.** AGPL (OpenChatCut; vedit's optional ultralytics); Remotion company licensing (OpenChatCut,
   QCut); a source-available "Community License" banning incorporation into commercial products (BaoCut); a removed upstream
   MIT notice and proprietary ByteDance libraries (QCut); and a trademark-only restriction (OpenFilm, which is harmless if the
   name is not reused).
