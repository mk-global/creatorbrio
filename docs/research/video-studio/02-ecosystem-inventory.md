# 02 · Open-source ecosystem inventory

[← Research index](README.md)

Every project below was examined on 2026-11-03.
"Activity" gives the last commit date and the number of commits since 2026-08-05 (the last 90 days), taken from `git log` of a fresh clone, or the registry date where noted.
A high commit count shows that code exists, not that it is mature: several projects commit hundreds of AI-generated changes a week.
Stars are not used as a quality signal.

**Verdict vocabulary**

- **Adopt**: use as a dependency.
- **Integrate**: call through a supported interface.
- **Adapt**: port source or templates, with attribution.
- **Learn**: design reference only; no code.
- **Skill**: reuse prompts or recipes.
- **Exclude**: not used.

The detailed evidence for every row is in the appendices linked in the last column: [E1](evidence/e1-complete-editors-a.md), [E2](evidence/e2-complete-editors-b.md), [E3](evidence/e3-sdks-and-renderers.md), [E4](evidence/e4-creative-and-audio-tools.md), [E5](evidence/e5-building-blocks.md), [E6](evidence/e6-recent-discovery.md), [E0](evidence/e0-experiments.md).

## 1. Complete editors (an application you could fork)

| Project | What it really is | Licence | Activity | Verdict | Why | Evidence |
|---|---|---|---|---|---|---|
| [OpenFilm](https://github.com/openfilm/openfilm) | HTML `film.html` format; headless Chromium frame capture + FFmpeg encode; React 19 Studio; Claude Code via skill and ACP | MIT + trademark policy | 2026-11-02; 216 (first commit 2026-10-10) | **Learn** (fallback renderer) | Closest paradigm to CreatorBrio, but 3.5 weeks old, no local ASR or vision, HTML-as-project format | [E1 §1](evidence/e1-complete-editors-a.md#1-openfilm-openfilmopenfilm) |
| [OpenChatCut](https://github.com/0xsline/OpenChatCut) | Remotion-based editor; local whisper; MediaPipe; `claude -p` + own MCP | **AGPL-3.0** + Remotion licence | 2026-10-21; 855 | **Learn** | Licence blocks reuse; draft-review-approve agent pattern is worth copying | [E1 §2](evidence/e1-complete-editors-a.md#2-openchatcut-0xslineopenchatcut) |
| [BaoCut](https://github.com/JimLiu/baocut) | Rust CPU compositor shared by preview (WASM) and export; MLX/Core ML ASR; Claude Agent SDK | **Source-available**, forbids incorporation into products supplied to others | 2026-11-03; 1,387 | **Learn** | The most engineered engine examined; licence excludes it | [E1 §3](evidence/e1-complete-editors-a.md#3-baocut-jimliubaocut) |
| [vedit](https://github.com/metiutek/editorvideo-ai) | Python FFmpeg filter-graph compiler; virtual-clock HTML clips; `claude -p` + MCP | MIT (optional extras AGPL/GPL) | 2026-11-02; 93 | **Learn** | Honest, small; no real-time preview; one developer | [E1 §4](evidence/e1-complete-editors-a.md#4-vedit-metiutekeditorvideo-ai) |
| [QCut](https://github.com/Quriosity-agent/qcut) | OpenCut fork with seven export engines, cloud ASR, credits relay | MIT (upstream notice removed) | 2026-11-02; 12,517 | **Exclude** | Copies proprietary ByteDance libraries from an installed app; provenance problem | [E1 §5](evidence/e1-complete-editors-a.md#5-qcut-quriosity-agentqcut) |
| [Concat](https://github.com/jub0t/Concat) | 153k-line native Rust NLE; wgpu compositor; in-process whisper.cpp; MCP server | **AGPL-3.0** + CLA + trademark; GPL weights | 2026-11-03; 1,306 | **Learn** | Licence and architecture (native app) | [E2 §3](evidence/e2-complete-editors-b.md#3-concat--jub0tconcat) |
| [Nuzky](https://github.com/nuzkyapp/nuzky) | Tauri + Rust NLE; whisper.cpp Metal; retakes; style learning; spawns user's `claude` with strict MCP | **GPL-3.0** | 2026-11-03; 1,031 (first 2026-10-06) | **Learn** (agent loop model) | Best agent-loop design; GPL and native | [E2 §5](evidence/e2-complete-editors-b.md#5-nuzky--nuzkyappnuzky) |
| [OpenCut](https://github.com/OpenCut-app/OpenCut) | Rewrite scaffold; promised MCP and headless mode not written | MIT | 2026-09-24; 1 | **Exclude** | No editor code today | [E2 §6](evidence/e2-complete-editors-b.md#6-opencut--opencut-appopencut-main-and-opencut-classic) |
| [opencut-classic](https://github.com/OpenCut-app/opencut-classic) | Archived Next.js 16 / React 19 editor; Rust/WASM compositor; browser Whisper | MIT | 2026-05-17 (archived); 0 | **Learn** | Same framework as CreatorBrio, but archived and without an agent API | [E2 §6b](evidence/e2-complete-editors-b.md#6b-opencut-classic-the-real-editor-archived) |
| [AutoBroll](https://github.com/andriidrok1/autobroll) | Small Remotion app + MCP | MIT + Remotion licence | 2026-09-29; 12 | **Exclude** | Requires a Gemini key; WhisperX without Apple GPU | [E2 §4](evidence/e2-complete-editors-b.md#4-autobroll--andriidrok1autobroll) |
| [SynthCut](https://github.com/relo-video/synthcut) | FFmpeg filter-graph export, separate Canvas2D preview | GPL-3.0 | 2026-07-21; 0 | **Learn** | Shows the preview/export divergence to avoid | [E2 §8](evidence/e2-complete-editors-b.md#8-synthcut--relo-videosynthcut) |
| [MakeMyClip Editor](https://github.com/MakeMyClip/editor) | zod document + op log + pure FFmpeg compiler | MIT | 2026-10-29; 21 | **Learn** | Single video track only | [E2 §9](evidence/e2-complete-editors-b.md#9-makemyclip-editor--makemyclipeditor) |
| [Monet](https://github.com/Monet-AI-Editor/Monet), [Omniclip](https://github.com/omni-media/omniclip) | Electron + Remotion; Lit + PixiJS | MIT (+ Remotion) | 2026-07-06; 2025-08-07 | **Exclude** | Stale | [E2 §7, §10](evidence/e2-complete-editors-b.md#7-omniclip--omni-mediaomniclip) |
| [WeftCut](https://github.com/WeftCut/WeftCut) | Electron + Rust NLE; MCP drives live project with checkpoints, timeline diff, agent notes on ranges; HTML "Motifs" as pure functions of time | MIT | 2026-11-03; 1,082 | **Learn** | Best reference for reviewing agent edits | [E6 #1](evidence/e6-recent-discovery.md#table) |
| [FableCut](https://github.com/ronak-create/FableCut) | Browser NLE whose interface is `project.json`, SSE hot-reload, revision counter | MIT | 2026-10-30; 267 | **Learn** | Mirrors CreatorBrio's JSON + SSE model | [E6 §4](evidence/e6-recent-discovery.md#4-fablecut-the-project-file-is-the-interface-which-is-almost-creatorbrios-own-architecture) |
| [FilmCraft](https://github.com/storytold/filmcraft) | Pure-Rust NLE with 650+ commands over MCP; OTIO/AAF/FCP7 | Apache-2.0 | 2026-11-03; 3,482 (first 2026-09-30) | **Learn** | Alpha by its own rating | [E6 #7](evidence/e6-recent-discovery.md#table) |
| [Tandem](https://github.com/mikecann/tandem), [BashCut](https://github.com/dongnguyenvie/BashCut), [Synkinema](https://github.com/dziksu/synkinema), [CutVoke](https://github.com/frankShan001/CutVoke), [Clypra](https://github.com/AIEraDev/Clypra), [FreeCut](https://github.com/walterlow/freecut), [OpenReel Video](https://github.com/Augani/openreel-video) | Native Swift, Tauri or browser NLEs, several with MCP | MIT | Oct–Nov 2026 | **Learn** | Personal tools or browser-only; none better than the above | [E6](evidence/e6-recent-discovery.md#table) |
| [AgentShot](https://github.com/hormuz-labs/agentshot), [OpenCaptions](https://github.com/leogaudin/opencaptions) | Note-driven editor; caption engine | GPL-3.0; AGPL-3.0 | 2026-11-03; 2026-10-23 | **Exclude** | Copyleft | [E6](evidence/e6-recent-discovery.md#table) |
| [Palmier Pro](https://github.com/palmier-io/palmier-pro) | Former GPL editor | Proprietary since 2026-08-24 | — | **Exclude** | No longer open source | [E6](evidence/e6-recent-discovery.md#does-anything-make-an-earlier-candidate-obsolete) |

## 2. Agent-operated reel pipelines and skills (no GUI)

| Project | What it really is | Licence | Activity | Verdict | Why | Evidence |
|---|---|---|---|---|---|---|
| [Ghost Editor](https://github.com/kurbaitaev/ghost-editor) | Claude Code skill + ~80 scripts: `reel.json` → HyperFrames; mlx-whisper; YuNet face track; BiRefNet matte; text behind speaker | MIT (Mixkit media terms) | 2026-10-30; 12 | **Adapt** (algorithms) + **Learn** | Closest workflow to ours; validates owned-JSON-compiled-to-HyperFrames | [E2 §1](evidence/e2-complete-editors-b.md#1-ghost-editor--kurbaitaevghost-editor) |
| [OpenEdit (VEED)](https://github.com/veedstudio/open-edit) | CLI + skill: virtual-clock HTML renderer, EDL, range re-render, safe zones, review checks | Apache-2.0 (NOTICE) | 2026-11-03; 18 (bot mirror) | **Adapt** (QA checks, safe zones, range splice idea) | Clean TypeScript; cloud paths stripped | [E2 §2](evidence/e2-complete-editors-b.md#2-openedit--veedstudioopen-edit) |
| [Yap Studio](https://github.com/cathrynlavery/yap-studio) | Python CLI + MCP: talking-head takes → reel via HyperFrames; parakeet-mlx; taste rules; FCPXML | Apache-2.0 | 2026-11-03; 99 (repo from 2026-10-23) | **Learn** | Independent confirmation of HyperFrames + Python sidecar | [E6 §3](evidence/e6-recent-discovery.md#3-yap-studio-the-closest-product-match-raw-talking-head-takes-to-a-finished-vertical-reel) |
| [ffmpeg-skill](https://github.com/kajisho5/ffmpeg-skill) | 42 typed FFmpeg tools, probe → edit → verify | MIT | 2026-11-01; 471 | **Learn** | Verification-first pattern for our QA | [E6 §6](evidence/e6-recent-discovery.md#6-ffmpeg-skill-kajisho5-a-verification-first-hands-layer) |
| [Kinocut](https://github.com/KyaniteLabs/mcp-video) | Guard-railed FFmpeg MCP with quality gates | Apache-2.0 | 2026-11-02; 652 | **Learn** | Same niche as ffmpeg-skill | [E6 §8](evidence/e6-recent-discovery.md#8-kinocut-guardrailed-mcp-with-quality-gates-and-a-hyperframes-bridge) |
| [video-use](https://github.com/browser-use/video-use) | Transcript-editing skill | MIT | 2026-10-08; 5 | **Exclude** | Transcription hard-wired to ElevenLabs | [E6](evidence/e6-recent-discovery.md#does-anything-make-an-earlier-candidate-obsolete) |
| Talking-head recipe skills (six repos) | SKILL.md + FFmpeg + whisper recipes | Mostly MIT | Sep–Nov 2026 | **Skill** (checklists only) | Thin | [E6 #29](evidence/e6-recent-discovery.md#table) |

## 3. Rendering frameworks and engines

| Project | Class | Licence | Activity | Verdict | Why | Evidence |
|---|---|---|---|---|---|---|
| [HyperFrames](https://github.com/heygen-com/hyperframes) | HTML composition contract; seek-protocol frame capture; adapters (GSAP, CSS, WAAPI, anime.js, Lottie, Three.js, D3…); FFmpeg encode and audio mixer; player; SDK; Studio | Apache-2.0 | 2026-11-03; 2,989; v0.9.9 | **Adopt** (`core`, `player`, `producer`, `engine`, pinned) | HTML-native, permissive, used by Ghost Editor, Yap Studio and OpenVids; Node API | [E4 §1](evidence/e4-creative-and-audio-tools.md#1-hyperframes--heygen-comhyperframes-most-important), [E0](evidence/e0-experiments.md#direct-verification-by-the-lead-researcher) |
| [Remotion](https://github.com/remotion-dev/remotion) | React composition framework; SSR renderer; player | **Remotion License** (source-available; company licence above 3 people; Player use counts as "Automators") | 2026-11-03; 5,529; v4.0.540 | **Exclude** as core; **Adopt** only MIT add-ons if needed (`@remotion/captions`) | Most mature, but its licence would bind every CreatorBrio user | [E3 §1](evidence/e3-sdks-and-renderers.md#1-remotion-remotion-devremotion) |
| OpenFilm renderer | `frame(t)` pages + playwright-core | MIT | see above | **Fallback** | Same paradigm if HyperFrames fails V1 | [E1 §1](evidence/e1-complete-editors-a.md#1-openfilm-openfilmopenfilm) |
| [Revideo](https://github.com/redotvideo/revideo), [Motion Canvas](https://github.com/motion-canvas/motion-canvas) | Canvas2D generator scenes | MIT (Revideo telemetry opt-out) | 2026-07-15; dormant since 2025-02 | **Exclude** | Not HTML/CSS; stagnant | [E3 §8–9](evidence/e3-sdks-and-renderers.md#8-revideo-redotvideorevideo--now-branded-midrenderrevideo-same-repo) |
| [Diffusion Studio](https://github.com/diffusionstudio/core) | Browser Canvas2D + WebCodecs | MPL-2.0 header, watermark unless paid key, minified | 2025-11-18; 0 | **Exclude** | Watermark and no public v4 source | [E3 §10](evidence/e3-sdks-and-renderers.md#10-diffusion-studio-core-diffusionstudiocore) |
| [etro](https://github.com/etro-js/etro) | Canvas/GLSL layers | GPL-3.0 | 2026-10-24; 13 | **Exclude** | GPL; real-time recording only | [E3 §11](evidence/e3-sdks-and-renderers.md#11-etro-etro-jsetro) |
| [Editly](https://github.com/mifi/editly) | JSON5 → FFmpeg CLI | MIT | 2025-02-20; 0 | **Exclude** | No preview; native builds | [E3 §14](evidence/e3-sdks-and-renderers.md#14-editly-mifieditly) |

## 4. Embeddable editing SDKs and timeline UI

| Project | Class | Licence | Activity | Verdict | Why | Evidence |
|---|---|---|---|---|---|---|
| [`@xzdarcy/react-timeline-editor`](https://github.com/xzdarcy/react-timeline-editor) | UI-only timeline: drag, resize, snap, zoom, virtualised rows | MIT | 2026-01-25 (v1.0.0); 0 | **Adopt** (interaction layer; fork if needed, ~3.2k lines) | Only mature permissive UI-only option; semantics stay ours | [E3 §7](evidence/e3-sdks-and-renderers.md#7-xzdarcyreact-timeline-editor) |
| [elah](https://github.com/elahlabs/elah) | Engine + React timeline/editor SDK; WebGL2 + WebCodecs; HTML `data-motion` compiler; Claude plugin | Apache-2.0 | 2026-10-30; 135; npm 1.0.0 (2026-10-28) | **Learn**; re-evaluate for timeline UI | Excellent engine design, but its own render path and "one active video clip" limit | [E6 §2](evidence/e6-recent-discovery.md#2-elah-the-most-embeddable-editor-and-timeline-sdk-for-a-nextjs--react-19-app), [E0](evidence/e0-experiments.md#direct-verification-by-the-lead-researcher) |
| HyperFrames Studio / SDK | Full React NLE (`EditorShell`, timeline, property panel) and `EditOp` session over HTML | Apache-2.0 (Studio depends on GSAP) | 2026-11-03; v0.9.9 | **Learn** (Architecture D was rejected) | Fixes the data model as HTML+GSAP; very large and fast-moving | [04 D](04-architecture-alternatives.md#architecture-d--hyperframes-native-adopt-hyperframes-studio-and-its-document-as-the-product) |
| [Twick](https://github.com/ncounterspecialist/twick) | Canvas editor SDK, `ProjectJSON`, caption styles | Custom "Sustainable Use License" (terms changeable); MIT render core | 2026-05-07; 0 | **Exclude** | Licence; dormant; preset animations only | [E3 §3](evidence/e3-sdks-and-renderers.md#3-twick-ncounterspecialisttwick) |
| [Clipkit](https://github.com/clipkit-video/clipkit) | JSON protocol + GPU runtime + React editor + MCP | Apache-2.0 except **BSL runtime (250 rendered minutes/month cap)** | 2026-08-12; 2 (npm newer) | **Learn** (keyframe panel, mixer UI) | Every part depends on the BSL runtime | [E3 §4](evidence/e3-sdks-and-renderers.md#4-clipkit-clipkit-videoclipkit) |
| [Ektie timeline](https://github.com/Ektie/react-video-timeline-editor) | UI-only NLE timeline | AGPL-3.0 (Apache-2.0 snapshot `1f44b94`) | 2026-09-21; 4 total | **Exclude** | AGPL; product-specific model | [E3 §5](evidence/e3-sdks-and-renderers.md#5-ektie-react-video-timeline-editor-ektiereact-video-timeline-editor) |
| [OpenVideo / react-video-editor](https://github.com/openvideodev/react-video-editor) | Next.js app on closed engine | Remotion-style licence; npm metadata contradicts | 2026-06-29; 0 | **Exclude** | Closed engine, paid transcription | [E3 §6](evidence/e3-sdks-and-renderers.md#6-openvideo--react-video-editor-openvideodevreact-video-editor-formerly-designcomboreact-video-editor) |
| Remotion Editor Starter / Timeline | Paid template and component | Paid + Remotion licence | private | **Exclude** | Cannot ship in a public MIT repo | [E3 §1](evidence/e3-sdks-and-renderers.md#1-remotion-remotion-devremotion) |
| [Theatre.js](https://github.com/theatre-js/theatre) | Keyframe sequencer | Apache core / AGPL studio | 2024-04-11; 0 | **Exclude** | Dormant | [E3 §13](evidence/e3-sdks-and-renderers.md#13-theatrejs-theatre-jstheatre) |

## 5. Interchange

| Project | Licence | Activity | Verdict | Why | Evidence |
|---|---|---|---|---|---|
| [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) | Apache-2.0 | 2026-10-30; 23; v0.18.1 | **Adopt as export format** (write OTIO JSON directly) | Hand-off to Resolve and Premiere; no JS bindings; no motion-graphics model, so it cannot be our canonical format | [E3 §15](evidence/e3-sdks-and-renderers.md#15-opentimelineio-academysoftwarefoundationopentimelineio) |

## 6. Media processing

| Tool | Licence | Latest | Verdict | Evidence |
|---|---|---|---|---|
| FFmpeg / FFprobe (Homebrew `ffmpeg-full`) | GPL-3+ build, separate process, user-installed | 9.0.2 (2026-09-18) | **Adopt** (CLI, configurable path; default `ffmpeg` lacks zscale, libass, drawtext, libplacebo) | [E5 §1.1](evidence/e5-building-blocks.md#11-ffmpeg--ffprobe) |
| [mediabunny](https://github.com/Vanilagy/mediabunny) | MPL-2.0 | 1.65.1 (2026-11-03) | **Adopt** (browser thumbnails, filmstrips, waveforms) | [E3 §12](evidence/e3-sdks-and-renderers.md#12-mediabunny-vanilagymediabunny) |
| fluent-ffmpeg | MIT | deprecated on npm | **Exclude** | [E5](evidence/e5-building-blocks.md#recommended-stack) |

## 7. Speech and transcript

| Tool | Licence | Latest | Verdict | Evidence |
|---|---|---|---|---|
| [parakeet-mlx](https://github.com/senstella/parakeet-mlx) (Parakeet TDT 0.6B v3) | Apache-2.0 code; CC-BY-4.0 weights | 0.6.0 (PyPI 2026-11-02) | **Adopt** (primary ASR, word timings) | [E5 §2](evidence/e5-building-blocks.md#24-recommendation-for-layer-2) |
| whisper.cpp | MIT | v1.9.5 | **Adopt** (languages outside Parakeet's set) | [E5 §2](evidence/e5-building-blocks.md#21-candidates) |
| Silero VAD | MIT | 6.2.3 | **Adopt** (speech activity, pauses, filler gaps) | [E5 §2](evidence/e5-building-blocks.md#21-candidates) |
| Qwen3-ForcedAligner (mlx-audio) | Apache-2.0 | mlx-audio 0.6.4 | **Adopt after validation** (realign corrected text) | [E5 §2](evidence/e5-building-blocks.md#24-recommendation-for-layer-2) |
| [FluidAudio](https://github.com/FluidInference/FluidAudio) + Underdog Bark 3.0 | Apache-2.0; CC-BY-4.0 | 0.18 (2026-10/11) | **Evaluate** (Swift/ANE; filler-free variant; vendor claims) | [E6 §5](evidence/e6-recent-discovery.md#5-parakeet-mlx-06--mlx-audio-06--fluidaudio-018--underdog-bark-30-the-apple-silicon-transcription-layer) |
| mlx-whisper | MIT | 0.4.3 (2025-08-29) | **Exclude** (superseded for English word timing) | [E6](evidence/e6-recent-discovery.md#does-anything-make-an-earlier-candidate-obsolete) |
| WhisperX, faster-whisper | BSD / MIT | — | **Exclude** (no Apple GPU path) | [E5](evidence/e5-building-blocks.md#21-candidates) |
| CrisperWhisper | **non-commercial weights** | 2.0 | **Exclude by default** (best verbatim fillers) | [E5 §2.2](evidence/e5-building-blocks.md#22-filler-words-umuh) |
| pyannote | MIT code; gated / paid models | — | **Defer** (diarisation not needed for single-speaker reels; Sortformer via mlx-audio if needed) | [E5](evidence/e5-building-blocks.md#24-recommendation-for-layer-2) |
| Apple SpeechAnalyzer (macOS 26) | OS | — | **Experiment only** (word timestamp reliability reported weak) | [E5](evidence/e5-building-blocks.md#key-caveats) |

## 8. Computer vision

| Tool | Licence | Verdict | Evidence |
|---|---|---|---|
| Apple Vision (person segmentation and instance masks, faces, saliency, tracking) via a Swift CLI | OS framework | **Adopt** (primary matte, faces, reframe input) | [E5 §3](evidence/e5-building-blocks.md#3-computer-vision) |
| SAM 3.1 via mlx-vlm | SAM License (gated) | **Adopt optional** (text-prompted object tracking) | [E5 §3](evidence/e5-building-blocks.md#3-computer-vision) |
| BiRefNet (as used by Ghost Editor) | MIT | **Fallback** if Apple Vision mattes fail V5 | [E5 §3](evidence/e5-building-blocks.md#3-computer-vision), [E2 §1](evidence/e2-complete-editors-b.md#1-ghost-editor--kurbaitaevghost-editor) |
| MediaPipe Tasks | Apache-2.0 | **Fallback** (cross-platform faces; YAMNet audio classifier) | [E5 §3](evidence/e5-building-blocks.md#3-computer-vision) |
| `@remotion/video-matting` | MIT (model licences unverified) | **Watch** | [E3 §1](evidence/e3-sdks-and-renderers.md#1-remotion-remotion-devremotion) |
| HyperFrames `remove-background` (rembg u2net_human_seg) | Apache-2.0 wrapper | **Exclude** for final quality (~2 fps CPU, coarse) | [E4 §1](evidence/e4-creative-and-audio-tools.md#text-behind-speaker) |
| RMBG-2.0, MatAnyone 1/2 | **Non-commercial** | **Exclude** | [E5 §3](evidence/e5-building-blocks.md#3-computer-vision) |
| Robust Video Matting | GPL-3.0, stale | **Exclude** | [E5 §3](evidence/e5-building-blocks.md#3-computer-vision) |
| Ultralytics YOLO | AGPL-3.0 | **Exclude** | [E5 §3](evidence/e5-building-blocks.md#3-computer-vision) |
| SAM 2.1 | Apache-2.0 | **Exclude** (superseded) | [E5 §3](evidence/e5-building-blocks.md#3-computer-vision) |

## 9. Audio

| Tool | Licence | Verdict | Evidence |
|---|---|---|---|
| DeepFilterNet3 (mlx-audio port; Rust CLI arm64) | MIT / Apache-2.0 | **Adopt** (voice denoise, with wet/dry) | [E5 §4](evidence/e5-building-blocks.md#4-audio) |
| FFmpeg `loudnorm` (two-pass), limiter, EQ | as FFmpeg | **Adopt** (deterministic mastering) | [E5 §4](evidence/e5-building-blocks.md#4-audio) |
| pyloudnorm | MIT | **Adopt** (measurement in the worker) | [E5 §4](evidence/e5-building-blocks.md#4-audio) |
| CLAP | code CC0 (verify weights) | **Adopt** (text → SFX/music retrieval) | [E5 §4](evidence/e5-building-blocks.md#4-audio) |
| [Earshot](https://github.com/Leonxlnx/earshot) | MIT | **Integrate** (sidecar; model-free procedural SFX bank; optional analysis) | [E4 §10](evidence/e4-creative-and-audio-tools.md#10-earshot--leonxlnxearshot) |
| [Real SFX (Clipwing)](https://github.com/Clipwing/skills) | **No LICENSE file** (README says MIT); uisfx CC0 | **Adopt** the CC0 sound pack; **Learn** cue placement | [E4 §9](evidence/e4-creative-and-audio-tools.md#9-real-sfx--clipwingskills-skillsreal-sfx) |
| ACE-Step 1.5 | MIT | **Optional** (local music generation, MLX) | [E5 §4](evidence/e5-building-blocks.md#4-audio) |
| Stable Audio 3.0 Small SFX | Stability Community License (< US$1M revenue) | **Optional** | [E5 §4](evidence/e5-building-blocks.md#4-audio) |
| Apple AUSoundIsolation | OS | **Evaluate** (offline file processing undocumented) | [E5 §4](evidence/e5-building-blocks.md#4-audio) |
| Demucs v4, UVR models | MIT code; weights unclear / non-commercial risk | **Exclude by default** | [E5 §4](evidence/e5-building-blocks.md#4-audio) |
| MusicGen / AudioGen, MMAudio, AudioLDM | **Non-commercial** weights | **Exclude** | [E5 §4](evidence/e5-building-blocks.md#4-audio) |
| pedalboard | GPL-3.0 | **Exclude** from core | [E5 §4](evidence/e5-building-blocks.md#4-audio) |

## 10. Video understanding and B-roll

| Tool | Licence | Verdict | Evidence |
|---|---|---|---|
| PySceneDetect | BSD-3 | **Adopt** (shot boundaries in user B-roll) | [E5 §5](evidence/e5-building-blocks.md#5-video-understanding-and-b-roll) |
| SigLIP 2 | Apache-2.0 | **Adopt** (local visual search) | [E5 §5](evidence/e5-building-blocks.md#5-video-understanding-and-b-roll) |
| Qwen3-VL via mlx-vlm | Apache-2.0 (verify) | **Optional** (shot descriptions); Claude's own vision via `Read` is the default | [E5 §5](evidence/e5-building-blocks.md#5-video-understanding-and-b-roll) |
| Pexels / Pixabay APIs | Free keys | **Optional integration** | [E5 §5](evidence/e5-building-blocks.md#5-video-understanding-and-b-roll) |
| Local video generation (LTX-2, Wan 2.x) | various | **Exclude** from the core (minutes per clip on Mac, reported) | [E5 §5](evidence/e5-building-blocks.md#5-video-understanding-and-b-roll) |

## 11. Creative, animation and motion-graphics tools

| Tool | What it really is | Licence | Verdict | Evidence |
|---|---|---|---|---|
| HyperFrames registry (~450 blocks: `flowchart`, `data-chart`, `paper-collage-reveal`…) | HTML blocks | Apache-2.0 | **Adapt** selected blocks as templates (rewritten without GSAP where needed) | [E4 §1](evidence/e4-creative-and-audio-tools.md#what-it-is) |
| [Lemo-Opuscar](https://github.com/lemomo-ai/lemo-opuscar) | 66 style prompts + director guides + tiny `render(t)` toolkit | MIT code; CC BY 4.0 films | **Skill** (style presets, with attribution) | [E4 §2](evidence/e4-creative-and-audio-tools.md#2-lemo-opuscar--lemomo-ailemo-opuscar) |
| [gbro-collage-info](https://github.com/pyang5166/gbro-collage-info) | Paper-collage infographic skill on HyperFrames | MIT (bundled GSAP and Mixkit files excluded) | **Adapt** (collage template) | [E4 §7](evidence/e4-creative-and-audio-tools.md#7-gbro-collage-info--pyang5166gbro-collage-info) |
| [OneTake](https://github.com/feitangyuan/onetake) | Continuous-take motion skill | **PolyForm Noncommercial** | **Exclude** | [E4 §3](evidence/e4-creative-and-audio-tools.md#3-onetake--feitangyuanonetake) |
| [Claude Animation Base](https://github.com/windpipe/claudeanimationbase) | p5.brush mascot animation kit | MIT (mascot trademark concern) | **Exclude** (workflow guide as reference) | [E4 §4](evidence/e4-creative-and-audio-tools.md#4-claude-animation-base--windpipeclaudeanimationbase) |
| [gbro-collage-broll](https://github.com/pyang5166/gbro-collage-broll), [VOX-COLLAGE-BROLL](https://github.com/MegaTroll222/VOX-COLLAGE-BROLL) | Prompt skills over paid generation APIs (Gemini; MaxFusion / ElevenLabs) | MIT | **Exclude** | [E4 §5–6](evidence/e4-creative-and-audio-tools.md#5-gbro-collage-broll--pyang5166gbro-collage-broll) |
| [OpenHiggsfield](https://github.com/thehiggsfieldai/OpenHiggsfield) | Web client for fal / Higgsfield / OpenRouter | MIT (frontend provenance unverified) | **Exclude** | [E4 §8](evidence/e4-creative-and-audio-tools.md#8-openhiggsfield--thehiggsfieldaiopenhiggsfield) |
| Mermaid | Graph layout to SVG | MIT | **Adopt** (diagram layout) | [E4 extras](evidence/e4-creative-and-audio-tools.md#extras--other-credible-open-source-systems) |
| anime.js | Animation library | MIT | **Adopt** (template animation where CSS is not enough) | [E4 extras](evidence/e4-creative-and-audio-tools.md#extras--other-credible-open-source-systems) |
| Lottie / dotLottie | Animation runtime | MIT | **Adopt** (imported animation assets; HyperFrames adapter exists) | [E4 extras](evidence/e4-creative-and-audio-tools.md#extras--other-credible-open-source-systems) |
| GSAP | Animation library | GSAP "Standard no charge" licence (restriction wording unverified) | **Avoid in our output** | [E0](evidence/e0-experiments.md#direct-verification-by-the-lead-researcher), [09 R4](09-risks-and-open-questions.md) |
| ManimCE | Python maths animation | MIT | **Optional** external renderer for special explainer clips, imported as video | [E4 extras](evidence/e4-creative-and-audio-tools.md#extras--other-credible-open-source-systems) |
| Excalidraw-animate | Hand-drawn SVG animation | MIT | **Learn** (sketch-style diagram template) | [E4 extras](evidence/e4-creative-and-audio-tools.md#extras--other-credible-open-source-systems) |
| Rive runtime | Interactive animation runtime | MIT | **Defer** (needs a custom adapter) | [E4 extras](evidence/e4-creative-and-audio-tools.md#extras--other-credible-open-source-systems) |

## What changed compared with the earlier discussions

- **OpenFilm is not the foundation.** It is well built and MIT, but it is weeks old, its project format is HTML, and it has none of the talking-head intelligence. Its renderer is kept as the documented fallback.
- **Twick is insufficient and its licence is unsuitable.** It has a custom licence whose terms can change, has been dormant since May 2026, and offers preset animations rather than keyframes.
- **HyperFrames is the strongest discovery for rendering.** It is Apache-2.0, HTML-native and already used as the renderer by independent talking-head projects (Ghost Editor, Yap Studio, OpenVids). It replaces both "build our own renderer" and "adopt Remotion".
- **Remotion is excluded from the core on licence grounds, not technical ones.**
- **parakeet-mlx replaces Whisper** as the primary English transcriber on Apple Silicon; mlx-whisper has had no release since 2025-08.
- **Nuzky, WeftCut and OpenChatCut** converged on the agent pattern this design adopts: the user's own `claude` CLI, MCP-only tools, run-scoped undo and a reviewable diff.
