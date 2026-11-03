[← Research index](../README.md) · Evidence appendix

> **About this appendix.** These are the working notes of one research slice, kept close to how they were written so a reviewer can trace each conclusion in the main documents to its source. Every repository was cloned and **read only**: nothing was installed, built or executed. Dates and commit SHAs come from `git log` of fresh clones taken on 2026-11-03, and package versions from the npm and PyPI registries. Labels such as *implemented*, *claimed*, *unverified* and *[web]* mark how each claim was established. Paths shown as `<local clone>/…` refer to the researcher's temporary clone, not to anything in this repository.

# 06: Fresh discovery (agent-operable video editing, 2026-08-05 to 2026-11-03)

Researched 2026-11-03. Every git date below comes from a blobless clone in
`<local clone>/<owner>_<repo>` (`git log -1`, `git log --reverse | head -1`, `git log --since=2026-08-05 | wc -l`).
npm and PyPI dates come from the public registry JSON. Nothing was installed or run.

**Coverage gaps:** `hn.algolia.com` is outside this session's allowed network, because DNS fails from both curl and WebFetch.
Hacker News was therefore covered only indirectly, through web search and the GitHub topic and search pages, which WebFetch can read. I did not try Reddit.

**Caveats:**
- Star counts are as shown on GitHub pages on 2026-11-03. They are not a quality signal.
- Several repos have very high commit rates, such as FilmCraft with 3,482 commits in 34 days and BashCut with 952 in 16 days. Most of that output is agent-generated. A high rate means the code exists, not that it is mature.
- Several repos have a first commit that is clearly an import of earlier private work, for example Yap Studio with 495 source files in its first 11 days.

Already covered by other agents and only mentioned here: OpenFilm, OpenChatCut, vedit (= `metiutek/editorvideo-ai`, which I verified is the same project), Concat, Nuzky, HyperFrames, Remotion, Diffusion Studio, OpenVideo and Clipkit.

## Table

| # | Name | URL | Category | First commit | Last commit | HEAD SHA | Commits since 08-05 | License | Local? / paid-API deps | Substance |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **WeftCut** | https://github.com/WeftCut/WeftCut | Desktop NLE + MCP (Electron, Rust, React 19, PixiJS, WebCodecs) | 2026-05-07 | 2026-11-03 | 25aa8cdb7ca4 | 1082 (3930 total) | MIT (+ FFmpeg LGPL/GPL lanes) | Local. Cloud ASR is optional; whisper.cpp and FunASR download on demand. No model weights bundled | **High.** Full NLE: about 1,560 TS and 177 Rust files, ADRs, conformance E2E tests. MCP drives the live project, with checkpoints, a Timeline diff, "Tacks" (agent notes on time ranges) and **Motifs**, which are HTML overlays rendered as a pure function of time. One maintainer |
| 2 | **elah** | https://github.com/elahlabs/elah | Browser engine + React timeline/editor SDK + HTML motion spec + Claude Code plugin | 2026-05-15 | 2026-10-30 | d4e8b2377781 | 135 (453) | Apache-2.0 | Fully local; browser export through mediabunny, no keys | **High.** Packages `@elah/core`, `timeline`, `editor`, `react` and `cli` (playwright-core); 1.0.0 published to npm on 2026-10-28, 11 versions since 2026-06-09. HTML `data-motion` compiles to real clips and keyframes |
| 3 | **Yap Studio** | https://github.com/cathrynlavery/yap-studio | Talking-head vertical-reel engine (Python CLI + MCP) on HyperFrames | 2026-10-23 | 2026-11-03 | f5a4bc35e83a | 99 | Apache-2.0 | Local ASR (parakeet-mlx, parakeet-onnx, faster-whisper). ElevenLabs, WaveSpeed and Pexels are opt-in only. Frames go to whichever agent the user runs | **High** for the reel use case: 647 .py files. Stages, checks, "taste" rules, macOS cutouts and face detection, SFX, an EDL model that exports FCPXML/xmeml, and a phone review page |
| 4 | **FableCut** | https://github.com/ronak-create/FableCut | Browser NLE whose interface is `project.json`, over MCP and REST | 2026-07-06 | 2026-10-30 | 579b08ec1a78 | 267 (389) | MIT | Local, zero npm deps. In-browser Whisper through transformers.js (word timestamps; library fetched from jsDelivr on first use) | **Medium-high.** About 40 plain-JS modules (reframe, tracker, ducking, silence, transcripts, mcp-server). SSE hot-reload, a revision counter, and agent edits kept on a separate undo track. npm `fablecut` 1.18.0 (2026-10-27). 776★ |
| 5 | **ffmpeg-skill** (kajisho5) | https://github.com/kajisho5/ffmpeg-skill | Agent Skill + MCP: 42 typed FFmpeg tools | 2026-09-03 | 2026-11-01 | 1ce2c186bf1d | 471 | MIT | Local, Python stdlib only. ASR is optional (Parakeet or whisper) | **Medium-high.** Each tool's contract is derived from its argparse parser and drift-checked in CI. Every job runs probe, then edit, then verify with a contact sheet. Reels/TikTok presets, `broll.py`, `caption.py`. npm 3.1.1 (161 versions). 4.4k★ |
| 6 | **Kinocut** (formerly mcp-video) | https://github.com/KyaniteLabs/mcp-video | Guardrailed FFmpeg MCP with quality gates, Shorts/Reels repurposing and a HyperFrames bridge | 2026-03-20 | 2026-11-02 | a6f44fb55621 | 652 (1674) | Apache-2.0 | Local. Optional extras: `anthropic` for image-ai, openai-whisper + torch for transcription | **Medium.** 1,272 .py files, "Video Receipts". PyPI `kinocut` 1.16.5 (2026-10-27) |
| 7 | **FilmCraft** (ArtCraft) | https://github.com/storytold/filmcraft | Pure-Rust professional NLE (native + WASM), more than 650 commands over CLI, JSON-TCP and MCP | 2026-09-30 | 2026-11-03 | 57dc82ea2046 | 3482 | Apache-2.0 | Local. Codecs written in-house. Speech crate (VAD, diarize) is off by default | **High scope, alpha.** README rates it ~86% for feature breadth and ~56% "ready for real work". Interchange via OTIO, FCP7 XML and AAF. 17.4k★ |
| 8 | **Tandem** | https://github.com/mikecann/tandem | Swift macOS editor + CLI + MCP, with a `.tandem` JSON project | 2026-09-25 | 2026-11-03 | b59a19f69d71 | 523 | MIT | Local: FluidAudio with Underdog Bark 3.0 Pro, SpeechAnalyzer fallback, RVM cutout | **Medium.** 587 Swift files. A personal tool: issues and PRs are closed |
| 9 | **BashCut** | https://github.com/dongnguyenvie/BashCut | Native macOS (Swift) editor + `bashcut` CLI + MCP + out-of-process plugins | 2026-10-02 | 2026-10-18 | 7128e31ca4d6 | 952 | MIT | Local Whisper plugin. An optional in-app "AI Editor" plugin uses your own keys | **Medium.** 1,043 Swift files, written very fast |
| 10 | **OpenVids** | https://github.com/bazodev/open-vids | Fork of a HyperFrames snapshot: a desktop multi-agent studio (Director plus specialist agents) | 2026-09-28 | 2026-10-09 | 119cbe17557e | 183 | Apache-2.0 | Analysis is local (whisper.cpp or Parakeet, sherpa-onnx diarization). The in-app agent and TTS need provider keys | **Medium.** Story mode, design systems, render QA. Quiet since 10-09 |
| 11 | **AgentShot** | https://github.com/hormuz-labs/agentshot | Note-driven "talk to your editor" desktop app | 2026-10-06 | 2026-11-03 | e35c2e4c72a9 | 317 | GPL-3.0 | whisper.cpp bundled, with DTW re-timing of words. The LLM comes from its own credits or your Claude/Gemini/OpenAI key | **Medium.** Copyleft, and has a credits business model |
| 12 | **Synkinema** | https://github.com/dziksu/synkinema | Desktop editor + headless FFmpeg engine + REST/MCP/CLI, chat with a local CLI agent | 2026-09-14 | 2026-11-03 | d93063e9a785 | 172 | MIT | Local Whisper and Supertonic TTS. ElevenLabs only if you bring a key | **Medium** |
| 13 | **CutVoke** | https://github.com/frankShan001/CutVoke | Editable timeline over MCP/HTTP/CLI, transcript-based deletion with impact preview | 2026-09-22 | 2026-11-03 | e1d76491a488 | 156 | MIT | Optional local ASR | **Medium.** Repo is heavy with media assets |
| 14 | **OpenKatana** | https://github.com/rk0neki/OpenKatana | Agent-driven editing engine; `analyze_reference` turns a reference edit into timeline settings | 2026-10-16 | 2026-11-03 | f3b09107a982 | 117 | Apache-2.0 | Requires `comfy-sdk` (Comfy platform). faster-whisper optional | **Medium.** Montage and anime-edit focus, not talking heads |
| 15 | **Remocn Studio** | https://github.com/Remocn/remocn-studio | Tauri app where your own coding agent writes a Remotion project | 2026-06-24 | 2026-10-13 | fe21cf3db88e | 458 (544) | MIT | Local. ElevenLabs optional for SFX and music | **Medium.** Launch and motion videos, not footage editing |
| 16 | **agentcut** | https://github.com/0xPasho/agentcut | Local harness + visual editor; clip finding, captions, publishing calendar | 2026-09-16 | 2026-10-13 | f289afbb80bb | 258 | **No LICENSE file** | whisper.cpp (whisper-cli) | Medium, but not legally reusable |
| 17 | **ReelTerminal** | https://github.com/yuchen-ya/reelterminal | Human + agent finishing editor (Chinese-first, Windows build first) | 2026-01-19 | 2026-11-02 | 55aa3528c304 | 654 (883) | MIT | Local Qwen or SenseVoice captions | Medium |
| 18 | **OpenReel Video** | https://github.com/Augani/openreel-video | Browser CapCut alternative (React, mediabunny, WebCodecs, WebGPU) | 2026-01-19 | 2026-10-17 | 367d7e90b61b | 15 (244) | MIT | Local | Medium. Slowing down |
| 19 | **FreeCut** | https://github.com/walterlow/freecut | Browser NLE using WebGPU, WebCodecs, OPFS and File System Access; has a `headless/` dir | 2025-11-16 | 2026-10-29 | 5ceeeb388eef | 278 (2795) | MIT | Local in-browser transcription and analysis | **Medium-high** as a browser-NLE reference. 2.3k★ |
| 20 | **Clypra** | https://github.com/AIEraDev/Clypra | Rust + Tauri v2 + React 19 NLE | 2026-04-17 | 2026-11-01 | b6cbc1f49dca | 2646 (3873) | MIT | Local | Medium. No agent surface in the README |
| 21 | **Timeline Studio** | https://github.com/MartinDelophy/ai-video-editor | Browser editor; skills plus STDIO MCP | 2026-07-09 | 2026-11-03 | 947285a56f36 | 144 (263) | MIT | Pushes the "Anna" cloud edition. Contains deep-synthesis (face) features | Medium-low fit |
| 22 | **OpenCaptions** | https://github.com/leogaudin/opencaptions | Animated word-level captions; one Rust engine for both preview and export | 2026-10-05 | 2026-10-23 | 8ef9a7cd907e | 257 | **AGPL-3.0** | Local Parakeet or Whisper; OpenAI only if you supply a key | Medium. AGPL rules out embedding it |
| 23 | **karaoke-captions** | https://github.com/PeerReviewedShorts/karaoke-captions | Offline word-by-word captions (Parakeet) + agent mode | 2026-10-22 | 2026-10-22 | db287360eb7a | 6 | MIT | Local | Low (small) |
| 24 | **watch-skill / DeepWatch** | https://github.com/oxbshw/watch-skill | Video and screen understanding for agents (scenes, OCR, ASR, embeddings, diarization) over MCP | 2026-07-03 | 2026-09-08 | f1317c8fe647 | 481 (550) | MIT | Local extras: PySceneDetect, RapidOCR, faster-whisper, fastembed, pyannote | Medium. Aimed at verification, not editing |
| 25 | **video-use** (browser-use) | https://github.com/browser-use/video-use | Claude Code skill: edit from a word-level transcript | 2026-04-11 | 2026-10-08 | 43cfc5668335 | 5 (23) | MIT | **Requires ElevenLabs Scribe** (`helpers/transcribe.py` calls `api.elevenlabs.io`) | Low-medium. Thin helpers plus a SKILL.md |
| 26 | **ReelMimic** | https://github.com/edenfunf/reelmimic | Multi-agent "make a new video in the style of this reference" | 2026-09-28 | 2026-11-03 | 2fcf5b66f95a | 145 | MIT | Mixed | Low-medium fit |
| 27 | video-talkcraft | https://github.com/Vincentwei1021/video-talkcraft | Remotion explainer skill: 108 motion "recipe cards", word-level voiceover sync | 2026-08-28 | 2026-10-12 | a7c29edfb240 | 84 | **Noncommercial custom license** | Local | Ideas only. The license blocks reuse |
| 28 | mrpaidsocial video-editor-agent | https://github.com/mrpaidsocial/mrpaidsocial-video-editor-agent | Claude Code skill pack for short-form: reference-reel style cloning, QA, review page | 2026-08-29 | 2026-10-26 | bbbc1a4c55f7 | 28 | **No LICENSE file** | ElevenLabs for sound design | Ideas only |
| 29 | Talking-head skills | vincentventalon/claude-code-video-editing-skill · griffinwooldridge/talking-head-editor · jacobksamuelson/talking-head-video · tenfoldmarc/video-edit-skill · social-media-skills/video-editing-skill · YildizDikme/claude-video-edit | SKILL.md + ffmpeg + whisper rough-cut recipes | 2026-09-11 to 2026-11-02 | 2026-10-14 to 2026-11-02 | (e.g. vincentventalon 49acf5b65c46) | 1–32 each | Mostly MIT; tenfoldmarc has none | Local | Low. Prompt and recipe collections, useful only as checklists |
| 30 | **parakeet-mlx** | https://github.com/senstella/parakeet-mlx | Apple Silicon ASR with word/token timestamps | 2025-05-04 | 2026-11-03 | d4c3df0c8bb5 | 12 (114) | Apache-2.0 | Local MLX | **High.** PyPI 0.6.0 (2026-11-02) added RNNT beam search and a forced-alignment fix |
| 31 | **mlx-audio** | https://github.com/Blaizzy/mlx-audio | MLX STT/TTS/STS hub | 2024-11-27 | 2026-11-02 | 97d125f423c4 | 545 (1427) | MIT | Local | **High.** 0.6.4 (2026-11-02). Added Granite-Speech-5.0, Ming 3.0, and Whisper word timestamps (2026-10-29) |
| 32 | **FluidAudio** (likely covered by the local-ML slice) | https://github.com/FluidInference/FluidAudio | Swift/CoreML ASR + diarization + VAD on the ANE | 2025-06-21 | 2026-11-02 | ee78635d23d5 | 197 (840) | Apache-2.0 | Local | **High.** v0.18.x added **Underdog Bark 3.0** (2026-10-28) and **Nemotron 3.5 Transcribe Lite + Nemotron-3 diarization** |
| 33 | swift-speech-transcriber | https://github.com/arraypress/swift-speech-transcriber | SpeechAnalyzer wrapper with word-level SRT/VTT/JSON | 2026-06-09 | 2026-10-11 | e194f569a5ab | 6 (17) | MIT | Local (macOS 26) | Low-medium. A thin wrapper, but over the OS engine |
| 34 | json-render `@json-render/remotion` | https://github.com/vercel-labs/json-render | JSON spec rendered to Remotion video (Generative-UI framework) | 2026-01-14 | 2026-11-02 | 1210a3825b7d | 32 (251) | Apache-2.0 | Local | Medium. A catalog-constrained JSON-to-video pattern; npm 0.21.4 |

**Non-repo items:**
- **Underdog Bark 3.0** (Conway Research, released about 2026-10-21). A 163 MB, Parakeet-derived ASR model under CC-BY-4.0, with "Clean" (filler-free), Plus and Pro variants. It already runs in FluidAudio and Tandem. All accuracy claims come from the vendor.
- **SAM 3 / 3.1 MLX** conversions on the mlx-community Hugging Face org: local video segmentation and tracking for cutouts and reframing.

**Licence changes and staleness:**
- **Palmier Pro** (https://github.com/palmier-io/palmier-pro). The README now states: *"releases through v0.7.6, and source code through `last-gpl-source` [8805801fa4df, 2026-08-24], were published under GPLv3. Later binary releases are proprietary, and their corresponding source is not published."* Commits since then are only appcast bumps (v0.9.0 to v0.12.1). It is **no longer an open-source candidate.**
- **mlx-whisper**: the last PyPI release was 0.4.3 on 2025-08-29.
- **@diffusionstudio/core**: the last npm release was 4.0.3 on 2025-11-30. This is covered elsewhere and noted here only for comparison with elah.
- **chandler767/mcp-video-editor** (last commit 2026-02-14, no license) and **artbyjazi/autoclip** (last commit 2026-08-01) are dormant.
- **slopstudio** (last commit 2026-07-21) and **mazsola2k/ai-video-editor** (last commit 2026-04-11) show no activity in the last 90 days.

## Top 8 for CreatorBrio (ranked)

### 1. WeftCut: the best architectural reference for "agent drives a real NLE"
- **Why:**
  - It solves the exact UX problems CreatorBrio will hit. The agent edits the *same* live project the user watches.
  - Each agent work session starts with a checkpoint, and every committed agent batch is a step in undo history.
  - Undo is locked during agent sessions.
  - A **Timeline diff** offers Approve all / Revert all.
  - **Tacks** are agent notes and questions pinned to time ranges that go stale when the content changes. This is a clean model for "agent proposes cuts, human reviews".
- **Motifs** are HTML/CSS/SVG/canvas pages placed as timeline layers. They render as a **pure function of time**: the harness owns the clock, and a strict CSP is enforced. This maps directly onto CreatorBrio's `wrapSlideHtml()` and sandboxed-iframe contract, and onto the Design Agent's strength of writing HTML.
- **Caveats:** Electron + napi-rs app, single maintainer. Treat it as a design and code reference, not an embeddable library.
- **Evidence:**
  - MCP surface: https://github.com/WeftCut/WeftCut/blob/25aa8cdb7ca456180915be79f8db8d6b6228ba41/docs/mcp.md
  - Motif authoring: https://github.com/WeftCut/WeftCut/blob/25aa8cdb7ca456180915be79f8db8d6b6228ba41/docs/motif-authoring.md
  - Data model: https://github.com/WeftCut/WeftCut/blob/25aa8cdb7ca456180915be79f8db8d6b6228ba41/docs/data-model.md
  - Agent skill: https://github.com/WeftCut/WeftCut/blob/25aa8cdb7ca456180915be79f8db8d6b6228ba41/skills/weftcut/SKILL.md

### 2. elah: the most embeddable editor and timeline SDK for a Next.js + React 19 app
- **Why:**
  - Apache-2.0, with separately published `@elah/timeline`, `@elah/editor` and `@elah/core` (deps: immer, zustand, mediabunny).
  - The model writes HTML with `data-motion`. elah compiles it into one `Project` document with ordinary clips and keyframes, which stays editable by hand.
  - Exports MP4 in the browser, or on a server through `@elah/cli` (playwright-core).
  - Ships a Claude Code plugin.
- **Fit:** this is the closest match to CreatorBrio's "agent writes HTML, user edits" loop.
- **Overlap:** it covers the same niche as Twick, OpenVideo and Diffusion Studio. It is more actively released than Diffusion Studio and has a more permissive licence (Apache-2.0 vs MPL-2.0).
- **Evidence:**
  - Engine: https://github.com/elahlabs/elah/blob/d4e8b237778128ac453bbd93fd6cb85c758c9b91/packages/core/src/engine.ts
  - Spec compiler: https://github.com/elahlabs/elah/blob/d4e8b237778128ac453bbd93fd6cb85c758c9b91/packages/core/src/spec/compile.ts
  - Timeline package manifest: https://github.com/elahlabs/elah/blob/d4e8b237778128ac453bbd93fd6cb85c758c9b91/packages/timeline/package.json

### 3. Yap Studio: the closest product match (raw talking-head takes to a finished vertical reel)
- **Pipeline:**
  - Python CLI + MCP, with a receipt for every stage.
  - Removes fillers and restarts; adds captions, 30 card types, B-roll, music and SFX.
  - "Every cut checked" through a checks stage.
  - Phone notes become persistent **taste rules**.
  - Renders through HyperFrames.
  - Transcription runs locally: parakeet-mlx on Apple Silicon, with parakeet-onnx or faster-whisper as fallbacks.
  - macOS-native cutouts and face detection.
  - EDL export to FCPXML and xmeml, so the cut can open in other NLEs.
- **Caveats:**
  - The repo is only 11 days old, although the code is clearly older.
  - The README is explicit that frames and transcripts go to whichever agent vendor the user runs.
- **Fit:** strong evidence for a "HyperFrames renderer + Python analysis sidecar" architecture.
- **Evidence:**
  - ASR backends: https://github.com/cathrynlavery/yap-studio/blob/f5a4bc35e83a81666084f3b3a159e47247629ceb/src/yap_studio/transcript/backends.py
  - EDL model: https://github.com/cathrynlavery/yap-studio/blob/f5a4bc35e83a81666084f3b3a159e47247629ceb/src/yap_studio/edl/model.py
  - HyperFrames bridge: https://github.com/cathrynlavery/yap-studio/blob/f5a4bc35e83a81666084f3b3a159e47247629ceb/src/yap_studio/render/hyperframes.py

### 4. FableCut: "the project file is the interface", which is almost CreatorBrio's own architecture
- **Design:**
  - A single `project.json` holds media, tracks, clips, effects, keyframes and transitions.
  - Any process can write it.
  - The browser UI hot-reloads in about 150 ms over SSE.
  - A revision counter arbitrates between the UI, MCP and direct file writes.
  - Agent edits get their own undo steps.
  - Zero npm dependencies; MIT.
- **Transcription:** `transcribe.js` builds word-level transcripts in the browser with Whisper `*_timestamped` ONNX models through transformers.js, then turns phrase matches into frame-aligned cut operations.
- **Fit:** directly comparable to CreatorBrio's JSON storage + SSE + curl-the-local-API agent model.
- **Caveats:** export needs an open Chromium tab, and transformers.js is fetched from a CDN at first use.
- **Evidence:**
  - https://github.com/ronak-create/FableCut/blob/579b08ec1a789baec5cbf06d7430373460508d09/transcribe.js
  - https://github.com/ronak-create/FableCut/blob/579b08ec1a789baec5cbf06d7430373460508d09/mcp-server.js
  - https://github.com/ronak-create/FableCut/blob/579b08ec1a789baec5cbf06d7430373460508d09/project-ops.js

### 5. parakeet-mlx 0.6 / mlx-audio 0.6 / FluidAudio 0.18 + Underdog Bark 3.0: the Apple Silicon transcription layer
- **What's new:**
  - All three are very active (last release or commit 2026-11-02 for each).
  - parakeet-mlx is a plain Python CLI and API with token and word timestamps, so it is the easiest to spawn from Node.
  - FluidAudio adds ANE-accelerated diarization: Sortformer, plus the new Nemotron-3 diarization.
  - Underdog Bark 3.0 has a "Clean" variant that drops filler words.
- **Effect on other options:** for English talking-head work, these make mlx-whisper (stale since 2025-08) a weaker default. whisper.cpp and WhisperX are still useful for multilingual work and as fallbacks.
- **Evidence:**
  - parakeet-mlx log: `git log` shows "beam search for rnnt parakeets" (2026-11-03) and "Force-align out-of-order tokens after chunk merge" (2026-10-02).
  - FluidAudio Bark 3.0 commit (2026-10-28), title "feat(asr): Underdog Bark 3.0 + Bark 3.0 Clean": https://github.com/FluidInference/FluidAudio/blob/ee78635d23d52379117554ba72358b65a0612447/README.md

### 6. ffmpeg-skill (kajisho5): a verification-first "hands" layer
- **Why:**
  - MIT, Python stdlib only.
  - 42 typed tools whose MCP and JSON input schemas come from the same argparse definitions and are drift-checked in CI.
  - Every job is probe, then edit, then verify (including a contact sheet).
  - Platform presets for reels.
- **Fit:** a good pattern, or a vendored component, for CreatorBrio's export and verification step. It avoids letting the agent compose raw filter graphs.
- **Evidence:**
  - Contract: https://github.com/kajisho5/ffmpeg-skill/blob/1ce2c186bf1dba96132d87274eee46df4f537e0e/scripts/_contract.py
  - B-roll tool: https://github.com/kajisho5/ffmpeg-skill/blob/1ce2c186bf1dba96132d87274eee46df4f537e0e/scripts/broll.py
  - Timeline helper: https://github.com/kajisho5/ffmpeg-skill/blob/1ce2c186bf1dba96132d87274eee46df4f537e0e/scripts/_common/timeline.py

### 7. FilmCraft: the largest new open NLE, with a command bus built for agents
- **Why:**
  - Apache-2.0, pure Rust, with decoders written in-house.
  - More than 650 typed commands dispatched identically from the UI, CLI, JSON-over-TCP and MCP.
  - UI automation ids and screenshots for agents.
  - Runs native or as WASM.
  - OTIO, FCP7 and AAF interchange.
- **Caveats:** alpha (self-rated ~56% "ready for real work"), with extreme commit velocity. Its best use for CreatorBrio is as a "finish in a pro NLE" target or a command-design reference, not as the core.
- **Evidence:**
  - Speech crate: https://github.com/storytold/filmcraft/blob/57dc82ea2046c2ec479ab4d4d8167d90e5500b49/crates/speech/src/lib.rs
  - README: https://github.com/storytold/filmcraft/blob/57dc82ea2046c2ec479ab4d4d8167d90e5500b49/README.md

### 8. Kinocut: guardrailed MCP with quality gates and a HyperFrames bridge
- **Why:**
  - Apache-2.0, very active (652 commits in 90 days), PyPI 1.16.5.
  - Receipts and quality gates.
  - Shorts/Reels repurposing.
  - Paid LLM use is confined to the optional `image-ai` extra.
- **Fit:** an alternative to #6 if CreatorBrio wants an MCP server rather than a skill.
- **Evidence:** https://github.com/KyaniteLabs/mcp-video/blob/a6f44fb55621462a4bb69352aea66d85e1d9dabf/pyproject.toml

**Honourable mentions:**
- **FreeCut**: a mature MIT browser NLE built on WebCodecs and OPFS with in-browser transcription.
- **Tandem** and **BashCut**: native Swift macOS editors with CLI + MCP, useful as Apple-native references.
- **OpenCaptions**: a good caption style set, but AGPL.
- **watch-skill**: an MCP for video understanding and verification.

## Does anything make an earlier candidate obsolete?
- **Palmier Pro is out** as an open-source base. Current releases are proprietary, and the GPL source is frozen at `last-gpl-source` (2026-08-24).
- **video-use** is not local-first, because transcription is hard-wired to ElevenLabs Scribe. Yap Studio, ffmpeg-skill and FableCut cover the same transcript-driven-edit idea locally.
- **mlx-whisper** is superseded for English word timing by parakeet-mlx, mlx-audio and FluidAudio.
- **Diffusion Studio core** (no npm release since 2025-11-30) is largely overtaken in the "embeddable browser engine + timeline" niche by **elah** (Apache-2.0, 1.0 on 2026-10-28).
- **OpenVids** shows that HyperFrames is already being forked into full agent studios, and **Yap Studio** builds on HyperFrames as a renderer. This strengthens the case for HyperFrames, or another HTML-as-video approach, as CreatorBrio's renderer rather than replacing it.
- Nothing found replaces **Remotion** or **HyperFrames** outright.
- **WeftCut Motifs** and **elah** are the strongest new arguments for keeping slides and motion graphics as deterministic, time-parameterised HTML. That is CreatorBrio's existing contract.
