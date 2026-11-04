# 03 · Source-code and dependency analysis of the strongest candidates

[← Research index](README.md)

This page analyses, at source level, the projects that shaped the decision.
Each section links to commit-pinned files.
The full notes, with more permalinks, are in the evidence appendices.

Labels: **[source]** read in code at the pinned commit, **[docs]** project documentation, **[claimed]** README claim not verified, **[untested]** not run.

## 1. How real video editors are built: the three rendering families

Reading 30+ codebases shows three families of rendering architecture.
The choice of family decides almost everything else.

| Family | How a frame is made | Examples **[source]** | Preview = export? | Fit for CreatorBrio |
|---|---|---|---|---|
| **HTML in headless Chromium** | A document is seeked to time *t* and screenshotted; FFmpeg encodes and mixes audio | HyperFrames, OpenFilm, Remotion (SSR), OpenEdit, Lemo-Opuscar, Ghost Editor (via HyperFrames) | Yes, when the preview runs the same document | **Native.** CreatorBrio already renders slides this way |
| **Native GPU/CPU compositor** | A Rust compositor draws a scene graph per frame; the same code runs as WASM or native for preview | BaoCut (tiny-skia CPU), Nuzky and Concat (wgpu), opencut-classic (Rust→WASM) | Yes, by construction | Fast, but each is a large engine under GPL, AGPL or a source-available licence; not HTML/CSS |
| **FFmpeg filter graph** | The timeline compiles to one `filter_complex` | vedit, SynthCut, MakeMyClip, Monet | Only if preview is also an FFmpeg render (vedit); SynthCut's Canvas preview "mirrors … within reason" | Poor for rich motion graphics and kinetic type |

A fourth group of **browser canvas/WebCodecs engines** (elah, Twick, Clipkit, OpenVideo, Diffusion Studio, Remotion's web renderer) is internally consistent.
These engines do not render arbitrary HTML/CSS, though.
Remotion documents that its client renderer lacks `z-index`, `backdrop-filter` and `perspective` **[docs]** ([E3 §1](evidence/e3-sdks-and-renderers.md#1-remotion-remotion-devremotion)).

The HTML family wins for CreatorBrio.
The brand system, the Design Agent's skill and the export pipeline are all HTML already.
Experiment E1 showed the principle works deterministically with plain CSS animations ([E0](evidence/e0-experiments.md#e1--deterministic-htmlcss-overlay-frames-composited-by-ffmpeg)).

## 2. HyperFrames: the chosen render engine

Repository: [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) at [`faae601`](https://github.com/heygen-com/hyperframes/tree/faae6017dd6ab3ce2031489922e9a1750777e0e2) (2026-11-03). Apache-2.0. First commit 2026-03-10; 2,989 commits in the last 90 days; npm 0.9.9.

**What it reuses and what it wrote itself.**
The engine relies on Puppeteer, chrome-headless-shell and FFmpeg as dependencies.
Everything above that is its own code:

- the composition contract;
- the seek protocol and readiness gates;
- frame adapters for animation libraries;
- frame extraction and injection for video elements;
- the audio mixer with volume envelopes;
- parallel capture;
- motion blur;
- alpha outputs;
- the player, the SDK and the Studio.

### Composition contract **[source]**

- Root `index.html` with `data-composition-id`, `data-width`, `data-height`, `data-duration`; timed elements carry `class="clip"`, `data-start`, `data-duration`, `data-track-index`; media use `data-media-start`, `data-volume`, `data-has-audio`. Sub-compositions sit in `compositions/*.html` inside `<template>`.
- Determinism is a contract: no `Date.now()`, unseeded `Math.random()`, timers, network fetches or infinite repeats ([SKILL.md#L17-L30](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/skills/hyperframes/SKILL.md#L17-L30)).

### Render pipeline **[source]**

1. **Seek, do not record.** The runtime exposes `window.__hf = { duration, seek(t) }`; the engine quantises *t* to the frame grid and seeks ([frameCapture.ts](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/engine/src/services/frameCapture.ts#L1-L9)).
2. **Frame adapters** make animation libraries seekable: `FrameAdapter { init?, getDurationFrames, seekFrame(frame), destroy? }` ([adapters/types.ts#L9-L15](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/core/src/adapters/types.ts#L9-L15)). Runtime adapters cover GSAP, CSS animations, WAAPI, anime.js, Lottie, Three.js, D3, TypeGPU and map libraries. There is no global monkey-patching of `requestAnimationFrame` or `Date`, so determinism depends on the contract plus adapters.
3. **Capture mode depends on the OS.** Chromium BeginFrame control is used only on Linux with chrome-headless-shell; macOS and Windows use seek plus CDP `Page.captureScreenshot` ([browserManager.ts#L871-L878](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/engine/src/services/browserManager.ts#L871-L878); [screenshotService.ts#L243-L260](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/engine/src/services/screenshotService.ts#L243-L260); [producer README#L98](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/producer/README.md#L98)). **On the target Mac, frame accuracy comes from the seek protocol**, which is what validation checkpoint V1 checks.
4. **Video elements** are not played. Frames are extracted with FFmpeg and injected per frame (`videoFrameExtractor.ts`, `videoFrameInjector.ts`), so footage is frame-exact in renders.
5. **Audio** is mixed by FFmpeg from declared `<audio>` / `<video data-has-audio>` with volume envelopes (`audioMixer.ts`, `audioVolumeEnvelope.ts`).
6. **Outputs**: MP4 H.264/H.265 (HDR10), WebM VP9 with alpha, MOV ProRes 4444 with alpha, PNG sequence, GIF, HLS ([producer README](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/producer/README.md)).

### Programmatic surface **[source]**

| Package | Use in CreatorBrio | Notes |
|---|---|---|
| `@hyperframes/producer` | Render worker: `createRenderJob({fps, quality, format})`, `executeRenderJob(job, dir, out, onProgress)` | Node ≥ 22; Puppeteer; no GSAP dependency |
| `@hyperframes/engine` | Frame captures for the agent's `look` tool (contact sheets) | `acquireBrowser`, `createCaptureSession`, `captureFrame` |
| `@hyperframes/core` | Runtime injected into compiled compositions; adapters | No GSAP dependency |
| `@hyperframes/player` | Preview web component | Sandboxing to be validated (V2) |
| `@hyperframes/sdk` | **Not used** | Typed `EditOp`s over HTML ([types.ts#L109](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/sdk/src/types.ts#L109)); our operations act on the EDD instead |
| `@hyperframes/studio` | **Not used** | Full NLE; depends on GSAP; ~166k lines |
| `@hyperframes/cli` | Optional developer tool only | PostHog telemetry on by default; opt-out `HYPERFRAMES_NO_TELEMETRY=1` ([E4 §1](evidence/e4-creative-and-audio-tools.md#external--paid-dependencies)) |

### Known limitations and risks

- **Pre-1.0 and very fast-moving.** Ghost Editor pinned `hyperframes@0.8.159` and gbro-collage-info pinned `0.7.56`; both are already behind 0.9.9 ([E2 §1](evidence/e2-complete-editors-b.md#1-ghost-editor--kurbaitaevghost-editor), [E4 §1](evidence/e4-creative-and-audio-tools.md#activity--risk)). Pin exact versions, wrap behind one module, and upgrade deliberately with render tests.
- Most `packages/*/package.json` files have no `license` field; the repository root is Apache-2.0. Confirm on the published tarballs before adoption.
- Upstream skills (`/media-use`) steer agents to HeyGen sign-in and credits ([SKILL.md#L17-L32](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/skills/media-use/SKILL.md#L17-L32)). CreatorBrio uses none of the upstream skills; it gives its agents its own instructions.
- Its built-in `remove-background` uses rembg `u2net_human_seg`: CPU, ~2 fps at 1080p, coarse ([captions.md#L41-L46](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/skills/hyperframes/references/captions.md#L41-L46)). We supply our own mattes from Apple Vision.

## 3. OpenFilm: the brief's questions answered

Repository: [openfilm/openfilm](https://github.com/openfilm/openfilm) at [`4d52629`](https://github.com/openfilm/openfilm/tree/4d526294e0a7ad718cbf9bd27e2a562438819c73) (2026-11-02). MIT + trademark policy. First commit 2026-10-10. Full notes: [E1 §1](evidence/e1-complete-editors-a.md#1-openfilm-openfilmopenfilm).

| Question from the brief | Answer **[source]** |
|---|---|
| Existing timeline library or its own? | **Its own.** `studio/ui/src/lib/timeline-*.ts`, `components/Timeline.tsx`; the in-page playback engine is `src/timeline.mjs` (1,337 lines). No timeline library |
| FFmpeg for rendering or just encoding? | **Encoding and audio mixing only.** Chromium composites every pixel; frames are piped to FFmpeg as `image2pipe` ([render.mjs#L435-L437](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/render.mjs#L435-L437)); audio is an `atrim/volume/adelay/amix` graph ([shared.mjs#L274-L332](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/shared.mjs#L274-L332)) |
| Chromium/Playwright for composition? | **Yes.** playwright-core, N parallel browsers, `window.film.frame(t)`, video `seeked` / `requestVideoFrameCallback`, CDP `Page.captureScreenshot` ([host.mjs#L606-L653](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/host.mjs#L606-L653)) |
| Reusable editor components? | The npm package exports `./render`, `./host`, `./film-doc`, `./look`. The Studio UI (76 components, ~70k lines) is the same stack as CreatorBrio but is coupled to its own `lib/timeline-*` and server |
| Stable project format? | `film.html`, with a spec ([SPEC.md](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/SPEC.md)) and a parsed `FilmDoc` type ([film-doc.d.mts#L44-L82](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/film-doc.d.mts#L44-L82)). It is clearly designed, but at 3.5 weeks old "stable" is not yet earned |
| Adaptable into a Next.js app? | The render and doc modules can be called from a Node runtime. The Studio is a Vite app with its own server; it would run alongside CreatorBrio or be ported, not dropped in |
| Limitations for advanced non-linear editing? | No local ASR (cloud providers or a user-run HTTP service only, [groq.mjs#L15](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/studio/server/providers/groq.mjs#L15)). No reframing, segmentation, silence or filler algorithms, ducking or denoise. The agent's own edits are file edits rather than structured ops; Studio ops are structured ([ops.mjs#L12-L25](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/studio/server/ops.mjs#L12-L25)). Raw footage is composited in Chromium per frame |
| Worth taking? | Ideas: the `look` QA, which draws frames twice in shuffled order to detect non-determinism and reports clipped text and failed fonts; per-clip undo; NLE export. Its renderer is the **documented fallback** if HyperFrames fails V1 |

**Verdict: OpenFilm is the wrong foundation to fork**, but the right design to learn from and the best fallback renderer.

## 4. Ghost Editor: the workflow reference

Repository: [kurbaitaev/ghost-editor](https://github.com/kurbaitaev/ghost-editor) at [`ce17272`](https://github.com/kurbaitaev/ghost-editor/tree/ce172726c36293722b08eb57b5b307d4f06389e8). MIT. 12 commits, one author. Full notes: [E2 §1](evidence/e2-complete-editors-b.md#1-ghost-editor--kurbaitaevghost-editor).

It is the closest existing implementation of *our* workflow: a talking-head creator on a Mac with Claude Code, producing a 9:16 reel with HTML motion graphics.

- **An owned JSON edit document compiled to HyperFrames.** `reel.json` holds takes in original-recording seconds, zooms, captions, layout, mix, typed beats and SFX ([reel-json.md](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/references/reel-json.md#L1-L45)). `build.mjs` compiles it and **refuses** a beat that points at cut material ([build.mjs#L1-L25](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/build.mjs#L1-L25)). This is the pattern Architecture C generalises.
- **Transcription tuned for retakes**: mlx-whisper large-v3-turbo with anti-merge decoding settings ([transcribe.py#L1-L17](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/transcribe.py#L1-L17)).
- **Text behind the subject**: BiRefNet-portrait on MPS with temporal smoothing, guided upsampling and colour decontamination. It refuses RMBG on licence grounds ([matte.py#L1-L30](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/matte.py#L1-L30)).
- **Gaps against our constraints**: Gemini (an API key) for B-roll QA; Mixkit media terms; GSAP from a CDN; no interactive editor, undo or tests beyond three files.
- **Reuse**: the algorithms (anti-merge settings, take selection, safe-zone caption placement, matte post-processing, SFX levelling against voice p95) are MIT and can be ported with attribution. The scripts themselves are not a library.

## 5. OpenEdit (VEED): renderer hardening and QA

Repository: [veedstudio/open-edit](https://github.com/veedstudio/open-edit) at [`74b7240`](https://github.com/veedstudio/open-edit/tree/74b724014e4ca0f6e158afe72671f94fc02e5734). Apache-2.0 with NOTICE. A bot mirror of a private repository. Full notes: [E2 §2](evidence/e2-complete-editors-b.md#2-openedit--veedstudioopen-edit).

- **Virtual clock**: replaces `performance.now`, `Date`, timers and rAF, and seeds `Math.random` before page code runs ([page-runtime.ts#L1-L80](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/render/page-runtime.ts#L1-L80)). This is stronger than HyperFrames' contract-based determinism. Applying it is a hardening option if V1 finds templates that drift.
- **Range re-render and splice** with the concat demuxer ([encode.ts](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/render/encode.ts#L1-L10)): the approach to small-revision renders.
- **Review checks** (`cli/src/verify/*`: blank frames, dead tails, caption legibility) and **platform safe-zone CSS**: inputs to our QA stage.
- Its cut-outs come from VEED or fal cloud services, and those paths are excluded.

## 6. Nuzky, OpenChatCut, vedit, WeftCut: the agent loop

All four drive the user's own Claude Code CLI with no API key and expose editor operations as MCP tools **[source]**:

| Project | Invocation | Edit safety |
|---|---|---|
| Nuzky (GPL) | `claude -p --input-format stream-json --output-format stream-json --strict-mcp-config --mcp-config {nuzky} --tools WebSearch --allowedTools mcp__nuzky,WebSearch --permission-mode dontAsk`, with hooks, CLAUDE.md and memory disabled ([claude.rs#L15-L44](https://github.com/nuzkyapp/nuzky/blob/45004221d7ad4d6448c159df849363ebcbc6c78c/crates/agent/src/claude.rs#L15-L44)) | `begin_run` / `apply_edits(run_id, request_id, edits[])` / `end_run(keep|discard)`; one agent turn = one undo entry; idempotent by `request_id`; UI blocked while the agent edits ([AI-ARCHITECTURE.md](https://github.com/nuzkyapp/nuzky/blob/45004221d7ad4d6448c159df849363ebcbc6c78c/docs/AI-ARCHITECTURE.md)) |
| OpenChatCut (AGPL) | Fresh `claude -p --output-format stream-json --mcp-config <own endpoint>` per turn, with Bash, Read and Edit denied ([turn-runner.ts#L10-L60](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/server/claude-code/turn-runner.ts#L10-L60)) | External agents edit an isolated draft: `begin_edit_session` → `review_edit_session` → approve or reject |
| vedit (MIT) | `claude -p --output-format stream-json --mcp-config {vedit} --strict-mcp-config --allowedTools mcp__vedit Read Glob WebFetch WebSearch` ([llm.py#L629-L662](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/backend/vedit/llm.py#L629-L662)) | One `Store` with undo shared by UI, MCP and chat |
| WeftCut (MIT) | MCP drives the live project | A checkpoint per agent session, a timeline diff to approve or revert, agent notes pinned to time ranges ([E6 #1](evidence/e6-recent-discovery.md#table)) |

CreatorBrio's Visual Director already uses the strictest form of this pattern (`--strict-mcp-config`, `--setting-sources ""`, `--no-session-persistence`, path-scoped `Read`) ([visual-director.ts#L420-L442](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/lib/visual-director.ts#L420-L442)).
The Video Studio's Edit Agent combines it with Nuzky's run semantics and WeftCut's reviewable diff ([05 §5](05-proposed-architecture.md#5-how-claude-edits-safely)).
No code is copied from the GPL and AGPL projects.

## 7. Remotion: technically mature, excluded by licence

Repository: [remotion-dev/remotion](https://github.com/remotion-dev/remotion) at [`cd1bb77`](https://github.com/remotion-dev/remotion/tree/cd1bb77f35b839a6fdcd64765725749409c3f4e5). Full notes: [E3 §1](evidence/e3-sdks-and-renderers.md#1-remotion-remotion-devremotion).

- The SSR renderer is the most hardened HTML renderer examined. It seeks via `window.remotion_setFrame`, waits for `delayRender`, captures with `Page.captureScreenshot`, and uses a Rust compositor for exact video frames ([seek-to-frame.ts#L180-L213](https://github.com/remotion-dev/remotion/blob/cd1bb77f35b839a6fdcd64765725749409c3f4e5/packages/renderer/src/seek-to-frame.ts#L180-L213)).
- **Licence** ([LICENSE.md#L16-L33](https://github.com/remotion-dev/remotion/blob/cd1bb77f35b839a6fdcd64765725749409c3f4e5/LICENSE.md#L16-L33)): free for individuals, organisations of up to three people and non-profits. Embedding `<Player>` or calling render APIs counts as the "Automators" plan for companies ([faq.mdx#L106-L129](https://github.com/remotion-dev/remotion/blob/cd1bb77f35b839a6fdcd64765725749409c3f4e5/packages/docs/docs/license/faq.mdx#L106-L129)). An end user who can view or modify Remotion code is themselves a Remotion user ([terms.mdx#L351-L353](https://github.com/remotion-dev/remotion/blob/cd1bb77f35b839a6fdcd64765725749409c3f4e5/packages/docs/docs/terms.mdx#L351-L353)).
- CreatorBrio is a public MIT project that every user runs themselves. A mandatory Remotion dependency would put those terms on every user, including a brand team of four or more. The founder alone would currently qualify for the free licence, but the brief asks us to disclose terms that constrain a derived product, and these do.
- Usable on their own: `@remotion/captions` (MIT, zero dependencies) and `@remotion/video-matting` (MIT; no dependency on Remotion core; model licences unverified).

## 8. elah: the best-designed embeddable engine, not chosen

Repository: [elahlabs/elah](https://github.com/elahlabs/elah) at [`d4e8b23`](https://github.com/elahlabs/elah/tree/d4e8b237778128ac453bbd93fd6cb85c758c9b91). Apache-2.0. npm 1.0.0 on 2026-10-28.

- Its architecture document states principles this design shares: an engine before the framework, integer-frame time, one mutation funnel through `commit()`, and pure `resolveTimeline(frame, project) → Scene` ([ARCHITECTURE.md](https://github.com/elahlabs/elah/blob/d4e8b237778128ac453bbd93fd6cb85c758c9b91/ARCHITECTURE.md)).
- Its renderer is WebGL2 with WebCodecs export, so choosing it would bring a second render path alongside HTML motion graphics. Its own limitations file says one active video clip at a time is the tested path, backward scrubbing is unstable, and export is Chromium-only ([CURRENT_LIMITATIONS.md](https://github.com/elahlabs/elah/blob/d4e8b237778128ac453bbd93fd6cb85c758c9b91/CURRENT_LIMITATIONS.md)).
- Re-evaluate `@elah/timeline` as a timeline UI when multi-track playback matures ([04 decision table](04-architecture-alternatives.md#final-recommendation)).

## 9. What "reuse most of the work" means precisely

The brief asks what share of the work can be reused, without inventing percentages.
This is the exact split by function.

**Reused, not written by CreatorBrio:**

- Decoding, encoding, conforming, tone mapping, filters and loudness measurement: FFmpeg.
- Turning HTML/CSS/SVG plus animation into frames deterministically: the seek protocol, animation-library adapters, frame-exact video injection, parallel capture, alpha output, motion blur and audio mixing with envelopes. All HyperFrames.
- An embeddable preview player: HyperFrames.
- Speech recognition with word timings (parakeet-mlx), voice activity (Silero), voice denoise (DeepFilterNet3), person masks and face detection (Apple Vision), audio and visual embeddings for search (CLAP, SigLIP 2), and shot detection (PySceneDetect).
- Timeline drag, resize, snap, zoom and virtualisation: `@xzdarcy/react-timeline-editor`. Browser thumbnails and waveforms: mediabunny.
- Diagram layout (Mermaid), animation runtimes (CSS/WAAPI, anime.js, Lottie), and starting templates (HyperFrames registry blocks, gbro-collage-info, Lemo-Opuscar style prompts).
- A procedural SFX bank (Earshot) and CC0 UI sounds.
- The agent itself: Claude Code, with existing isolation flags.
- From CreatorBrio itself: brands, fonts, storage locking, SSE chat contract, capability-table pattern, staging and attach protocol, generation-run semantics, loopback guard ([01](01-creatorbrio-baseline.md)).

**Built by CreatorBrio, because no candidate provides it under acceptable terms:**

- The EDD, operation engine, invariants, history and change sets.
- The compiler from EDD to HyperFrames HTML.
- The Studio UI: transcript editor, timeline lanes for words, takes, captions, keyframes and waveforms, inspector, history and review diff.
- The agent controller: Director schema and prompts, Edit Agent prompts, MCP server, run lifecycle.
- The capability registry, plus brand-aware templates for captions, titles, diagrams, collage and transitions.
- Ingest: path registration, hashing, proxies, HDR policy.
- Media worker glue: job API and model manager; Swift vision CLI.
- Analysis algorithms on top of models: retake grouping, filler-gap classification, reframe smoothing, ducking envelopes, SFX cue extraction.
- QA checks, style profiles and reference-reel analysis.
- Tests and an evaluation harness.

The reused part is the technology that is expensive to build and has no product-specific behaviour.
The built part is the product.
