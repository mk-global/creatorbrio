# CreatorBrio Video Studio: architecture research

> **Historical record, 2026-11-08.** This document is kept as written.
> Since then the renderer decision changed: HyperFrames failed gate G1, and CreatorBrio uses its own script-free overlay renderer with FFmpeg (see the [amended ADR](../../architecture/adr-creatorbrio-video-studio.md)).
> A first Studio slice has also merged.
> For current status, see the [roadmap](../../roadmap/video-studio/README.md#current-status).

Research package for [#63](https://github.com/mk-global/creatorbrio/issues/63), dated **2026-11-03**.
It recommends how to build a professional, AI-assisted Video Studio for short-form reels inside CreatorBrio.
The recommendation is based on source-code study of the open-source ecosystem and a small rendering experiment.

> **Status: research only.** No Video Studio code exists. Nothing here is shipped or approved; implementation starts only after the founder reviews this architecture, under its own tickets.

> **Product specification:** the complete product contract for both workflows (footage to video, and script to animated video) is in [`spec/`](spec/README.md) ([#66](https://github.com/mk-global/creatorbrio/issues/66)). It builds on this research and governs where they differ; the differences are listed in [spec/09](spec/09-differences-from-pr64.md).

## The recommendation in one paragraph

CreatorBrio should own the edit model, the editing operations, the Claude controller, the creative-capability library and the Studio UI.
It should reuse **HyperFrames** (Apache-2.0) as its single HTML-to-video rendering engine for preview and export, **FFmpeg** for media processing, and **local Apple Silicon models** for analysis: parakeet-mlx, Silero VAD, Apple Vision, DeepFilterNet3, CLAP and SigLIP.
Claude edits only through validated, revisioned change sets over MCP, never by writing files or running media tools.
OpenFilm, Twick and Remotion were examined and are not the foundation; the reasons are in [00](00-executive-decision.md) and [04](04-architecture-alternatives.md).

## Read in this order

| # | Document | What it answers |
|---|---|---|
| 00 | [Executive decision](00-executive-decision.md) | The decision, why it wins, what it sacrifices, what would change it, the first action |
| 01 | [CreatorBrio baseline](01-creatorbrio-baseline.md) | What exists in the repository today and what Video Studio can reuse |
| 02 | [Ecosystem inventory](02-ecosystem-inventory.md) | Every editor, SDK, renderer, model and creative tool examined, with licence, activity and verdict |
| 03 | [Source-code analysis](03-source-analysis.md) | How the strongest candidates are really built, with permalinks; the OpenFilm questions answered; what is reused vs built |
| 04 | [Architecture alternatives](04-architecture-alternatives.md) | Four architectures plus one excluded option, with diagrams, trade-offs and the weighted decision matrix |
| 05 | [Proposed architecture](05-proposed-architecture.md) | The chosen design: edit document, operations, agent safety, capabilities, rendering, styles, orchestration |
| 06 | [Feature coverage matrix](06-feature-coverage.md) | Each required capability mapped to its library and our code, deterministic vs AI, confidence, limits |
| 07 | [Integration plan](07-integration-plan.md) | Exactly how it fits this repository: modules, directories, schemas, workers, tests, installation, performance |
| 08 | [Implementation plan](08-implementation-plan.md) | Validation checkpoints V1–V8, workstreams in dependency order, first tickets |
| 09 | [Risks and open questions](09-risks-and-open-questions.md) | Risk register, unverified assumptions, questions for the founder |
| 10 | [Sources and freshness](10-sources.md) | Every repository examined with its commit SHA and dates; key files; package versions |

## Evidence appendices

The working notes behind the documents above, with commit-pinned permalinks:

| Appendix | Scope |
|---|---|
| [E0 · Experiments and direct verification](evidence/e0-experiments.md) | Deterministic HTML overlay render + FFmpeg composite; `<video>` seek accuracy; facts checked in source by the lead researcher |
| [E1 · Complete editors, set A](evidence/e1-complete-editors-a.md) | OpenFilm, OpenChatCut, BaoCut, vedit, QCut |
| [E2 · Complete editors, set B](evidence/e2-complete-editors-b.md) | Ghost Editor, OpenEdit, Concat, AutoBroll, Nuzky, OpenCut, SynthCut, MakeMyClip, Monet, Omniclip |
| [E3 · SDKs and renderers](evidence/e3-sdks-and-renderers.md) | Remotion, HyperFrames, Twick, Clipkit, timeline components, OpenVideo, Revideo, Motion Canvas, Diffusion Studio, etro, mediabunny, Theatre.js, Editly, OpenTimelineIO |
| [E4 · Creative and audio tools](evidence/e4-creative-and-audio-tools.md) | HyperFrames in depth, Lemo-Opuscar, OneTake, Claude Animation Base, collage tools, OpenHiggsfield, Real SFX, Earshot, animation libraries |
| [E5 · Building blocks](evidence/e5-building-blocks.md) | FFmpeg, speech, vision, audio, video understanding, local runtime pattern on Apple Silicon |
| [E6 · Recent discovery](evidence/e6-recent-discovery.md) | 34 projects released or substantially changed in the last 90 days, with verified dates |
| [E7 · OpenMontage, character animation, local image models](evidence/e7-openmontage-animation.md) | Added for the product specification (#66) |
| [E8 · Local TTS, sourcing API terms, AI provider terms](evidence/e8-tts-sourcing-providers.md) | Added for the product specification (#66) |

## Evidence conventions

- **[source]**: verified by reading code at a pinned commit.
- **[docs]**: official documentation.
- **[exp]**: our own experiment.
- **[inferred]**: follows from the architecture.
- **[untested]** / **unverified**: needs a validation checkpoint.
- Effort and performance figures are engineering estimates unless a source is cited. No benchmark numbers were invented.
- Licences were read from licence files, not from README badges, wherever the file was reachable.
