# 01 · Product requirements: CreatorBrio Video Studio

[← Specification index](README.md)

**Status:** authoritative product contract once approved (gate G0). **Ticket:** [mk-global/creatorbrio#66](https://github.com/mk-global/creatorbrio/issues/66). **Date:** 2026-11-04.

## 1. What CreatorBrio Video Studio is

CreatorBrio is an open-source, commercially extensible AI creative production studio for branded social content.
It already designs carousels, reel covers and branded images.
Video Studio adds two complete video production workflows on **one** editorial infrastructure:

- **Workflow A · Footage to video.** Ingest raw talking-head footage. Understand what was said, select the best takes and remove mistakes. Develop a storyboard, then source or create supporting visuals and add motion graphics. Edit captions, produce the sound design, review and export. Specified in [02](02-workflow-a-footage.md).
- **Workflow B · Script to animated video.** Accept a complete script or a topic, and research it when necessary. Create a visual storyboard and generate narration with local AI voices. Create animated stick figures, characters, diagrams, motion graphics and illustrated scenes. Generate or select music and sound effects, assemble, review and export. Specified in [03](03-workflow-b-script-animation.md).

Both workflows share the same production document, timeline, asset ledger, brand profiles, approval process, rendering system and quality checks.
A single production can combine them ([03 §6](03-workflow-b-script-animation.md#6-hybrid-productions)).

The quality bar is a strong human social-media editing team: edits that are attractive, engaging, on-brand and trustworthy, not merely technically valid.

## 2. Users

| Persona | Needs | Typical output |
|---|---|---|
| **Founder** (technology, AI, engineering, entrepreneurship, leadership, personal growth) | Energetic, clear, credible explainers; diagrams and data; fast turnaround from rough phone takes | Talking-head reels with diagrams and punch-ins; stick-figure explainers |
| **Wellness educator** (women's wellness, educational, talking head) | Calm, trustworthy, evidence-based content; legibility; no sensational claims | Calm talking-head reels with key-point cards; illustrated explainers with a gentle narrator |
| **Future users** of the open-source distribution, and of any future paid service | The same workflows with their own brands and providers | Their own content |

## 3. Product principles

1. **The creator stays in charge.** Explicit instructions beat inferences. Every AI decision is visible, explained and reversible, and approval happens at scene level.
2. **One production, one timeline.** Plans (brief, research, script, storyboard) feed one authoritative timeline; nothing renders outside it.
3. **Nothing is destroyed.** Source media is immutable; every change is a typed, revisioned operation.
4. **Local first, no mandatory paid services.** The core workflow runs on the creator's Mac with local models. Every AI role can also run without the Claude subscription, and every workflow can be completed by hand.
5. **Rights are a product feature.** Every asset knows where it came from, what its licence allows, and what credit it needs; exports respect the production's usage intent.
6. **Reuse foundations, own the product.** Rendering, codecs and models are reused; editorial semantics, workflow, agents and the creative library are CreatorBrio's ([05](05-capability-matrix.md)).
7. **Effects serve the message.** Capabilities run only when the plan or the user asks; the style profile limits what a brand uses.
8. **The person stays as recorded.** No generative model alters a real person's face, body or voice without consent. Cloned voices need recorded consent.

## 4. Scope

Every capability area in the request is in scope.
The register in §6 gives each an ID, owner, technology candidate, dependencies and acceptance test.

| Area | Requirements |
|---|---|
| Creative briefs and audience intent | PLN-01, PLN-02 |
| Research and script development | PLN-03 … PLN-06, PLN-09 |
| Story structure and hook selection | PLN-07, PLN-08 |
| Visual storyboards with individual scene approval | STB-01 … STB-09 |
| Speech analysis and best-take selection | SPC-04, SPC-05, SPC-07 |
| Local transcription (Parakeet / Whisper alternatives) | SPC-01 … SPC-03, SPC-06 |
| Media discovery and sourcing (Commons, Openverse, Freesound, Internet Archive, optional stock) | SRC-01 … SRC-07 |
| Asset relevance, licensing and provenance | SRC-06, RGT-01 … RGT-05, MED-04 |
| AI voice generation and narration controls | VOC-01 … VOC-06 |
| Stick-figure, cartoon, diagram and motion-graphics generation | GFX-01 … GFX-09, STB-09 |
| Previously researched specialist tools (Lemo-Opuscar, OpenFilm, Ghost Editor, OpenMontage, HyperFrames, collage, Earshot, Real SFX and others) | [05 §1](05-capability-matrix.md#1-specialist-tools-and-projects), AIM-06 |
| Multitrack editing and manual controls | EDT-01 … EDT-05 |
| Captions, masking, reframing, compositing, visual effects | GFX-01, VFX-01 … VFX-05, SPC-08, SPC-09 |
| Music, Foley, SFX, ducking and mixing | AUD-01 … AUD-05, VOC-07 |
| Creative and technical quality assurance | QAS-01 … QAS-05 |
| Targeted revisions, undo, non-destructive editing | REV-01, REV-02, PRD-03, PRD-05, STB-05 |
| Final exports and editable project preservation | EXP-01 … EXP-04 |
| Distinct brand-specific editing styles | STY-01 … STY-04 |
| Open-source distribution and future commercial use | OSS-01 … OSS-03, AIM-01 … AIM-05, [08](08-licensing-and-commercial.md) |
| Platform and performance | PRD-01, PRD-02, PRD-04, MED-01 … MED-03, MED-05, REN-01 … REN-04, PLT-01 … PLT-05 |

### Out of scope

These are excluded because they are unrelated or speculative, not to shrink the product:

- multi-user collaboration, accounts and cloud storage;
- hosted rendering farms;
- publishing and scheduling to social platforms;
- photorealistic generative video of people;
- lip-syncing real people to new words;
- live streaming.

A future paid service is planned for in the model, licensing and provider design ([08](08-licensing-and-commercial.md)), but no hosting infrastructure is specified now.

## 5. Non-functional requirements

| Area | Requirement |
|---|---|
| Platform | macOS on Apple Silicon is the primary target (M5 Max, 128 GB). The app keeps working on Linux and Windows for features whose tools exist there; Apple-only features (Vision, MLX) state their absence |
| Local operation | After models are downloaded, the core workflows run offline (AT-X5) |
| Performance | Interactive preview on proxies; final render time for a 60 s reel within the target agreed at G1; one-scene revisions re-render only affected ranges |
| Reliability | Typed outcomes for every job; restart-safe job records; no partial assets; corrupt documents never overwritten |
| Security | Loopback-only API; MCP-only agents; path confinement; no model-authored scripts in previews; allow-listed connector hosts; isolated external tools |
| Privacy | Media stays local unless a user enables a connector (search queries leave the machine) or a hosted model runtime (context leaves the machine). Both are stated in the UI |
| Accessibility of output | Captions on by default; legibility and reading-speed checks; sidecar captions for every deliverable |
| Maintainability | Exact pins for fast-moving dependencies (HyperFrames); every capability versioned; golden and determinism tests |

## 6. Requirements register

Columns:

- **Owner**: the subsystem defined in [06 §2](06-architecture.md#2-subsystems-and-ownership).
- **Technology candidate**: what is reused; "Owned" or "CreatorBrio-owned" means CreatorBrio writes it.
- **Depends on**: requirement IDs, gates or subsystems.
- **Acceptance**: the tests in [10](10-acceptance-tests.md).
- **WS**: the implementing workstream in [11](11-implementation-program.md).

### PLN · Brief, research, script, structure and hooks

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="pln-01"></a>**PLN-01** | Capture a creative brief: objective, audience and their knowledge level, platform, target duration, tone, call to action, must-include and must-avoid items, usage intent (personal/commercial/client) | SS-PLAN | Existing `creative-brief.ts` (explicit/inferred provenance) | PRD-01 | AT-B1, AT-A4 | WS9 |
| <a id="pln-02"></a>**PLN-02** | Infer missing brief fields from the request and mark them inferred; never overwrite explicit user values | SS-PLAN | Existing Visual Director brief rules | PLN-01, AIM-01 | AT-B1 | WS9 |
| <a id="pln-03"></a>**PLN-03** | Research a topic when asked or when the brief requires facts: questions, sources with retrieval date and reliability, claims linked to sources | SS-PLAN | Existing `source-retrieval.ts` (bounded fetch); `researcher` role | PLN-01, AIM-01 | AT-B1 | WS9 |
| <a id="pln-04"></a>**PLN-04** | Flag sensitive claims (health, finance, legal) and block unsupported sensitive claims from on-screen text until the user confirms | SS-PLAN | CreatorBrio-owned claim model; `visual-critic`/`story-director` checks | PLN-03 | AT-B1, AT-A6 | WS9 |
| <a id="pln-05"></a>**PLN-05** | Write or import a complete script with sections, lines, speakers and claim links; accept a pasted script unchanged | SS-PLAN | CreatorBrio-owned script model | PLN-01 | AT-B1, AT-B2 | WS9 |
| <a id="pln-06"></a>**PLN-06** | Generate a script draft from a brief and dossier in the brand voice, within the target duration estimate | SS-PLAN | `story-director` role via model gateway | PLN-03, AIM-01, STY-01 | AT-B1 | WS9 |
| <a id="pln-07"></a>**PLN-07** | Offer at least three hook options with named techniques and rationale; user selects or edits one | SS-PLAN | `story-director` role | PLN-05 | AT-B1, AT-A4 | WS9 |
| <a id="pln-08"></a>**PLN-08** | Choose a story structure (hook–problem–solution–CTA, list, story, explainer, myth vs fact, before/after, custom) with rationale | SS-PLAN | `story-director` role | PLN-05 | AT-B2, AT-A4 | WS9 |
| <a id="pln-09"></a>**PLN-09** | Derive a script from footage (transcribed script) that links each line to the spoken words and its take group | SS-PLAN | Spine transcript + take groups | SPC-02, SPC-04 | AT-A4 | WS9 |

### STB · Storyboard and review

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="stb-01"></a>**STB-01** | Create a storyboard of scenes with purpose, script lines, duration target, visual plan, audio plan, caption plan and asset slots | SS-STORY | CreatorBrio-owned schema (04 §2) | PLN-05 or PLN-09 | AT-B2, AT-A4 | WS10 |
| <a id="stb-02"></a>**STB-02** | Render storyboard frames for every scene from the real composition; show labelled placeholders for missing assets | SS-STORY | HyperFrames frame capture via compiler | REN-01, STB-01 | AT-B2, AT-A4 | WS10 |
| <a id="stb-03"></a>**STB-03** | Render an animatic: timed frames with the voice spine (selected takes or narration/draft voice) | SS-STORY | Compiler held-frame timeline; HyperFrames | STB-02, VOC-01 or SPC-02 | AT-B2 | WS10 |
| <a id="stb-04"></a>**STB-04** | Approve, request changes on, or reject each scene individually; configurable approval granularity including autopilot | SS-STORY | Scene lifecycle (04 §3) | STB-01, PRD-04 | AT-B2, AT-X1 | WS10 |
| <a id="stb-05"></a>**STB-05** | Regenerate or revise one scene without changing any other scene | SS-STORY | Target-scoped change sets (04 §7) | STB-04, AIM-04 | AT-B2, AT-X1 | WS10 |
| <a id="stb-06"></a>**STB-06** | Materialise approved scenes into timeline clips deterministically, with scene ownership and divergence detection | SS-STORY | CreatorBrio-owned materialiser (04 §6) | EDT-01, STB-04 | AT-B2, AT-A5, AT-X1 | WS10 |
| <a id="stb-07"></a>**STB-07** | Comment on productions, script lines, scenes, scene elements, time ranges, clips and assets; resolve comments with linked change sets | SS-STORY | CreatorBrio-owned review model | PRD-01 | AT-X1 | WS10 |
| <a id="stb-08"></a>**STB-08** | Show a diff of each agent run grouped by scene, with keep/discard for the whole run or per scene | SS-STORY | Merged-research run lifecycle (Nuzky/WeftCut patterns) | AIM-04, PRD-03 | AT-X2 | WS10 |
| <a id="stb-09"></a>**STB-09** | Author animated scenes as Scene Specs (characters, props, illustrations, diagrams, charts, text, camera, cues) that compile to the single renderer | SS-STORY | CreatorBrio-owned Scene Spec (04 §5) | GFX-04 | AT-B4, AT-B5 | WS10 |

### PRD · Production service

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="prd-01"></a>**PRD-01** | Store each production as one versioned document changed only by validated typed operations, with revisions and a change log | SS-PROD | Merged-research EDD, ops funnel and history; `data.ts` locking | — | AT-X2 | WS1 |
| <a id="prd-02"></a>**PRD-02** | Enforce document invariants on every change (no overlaps, valid ranges, available capabilities, captions on surviving words, platform duration) | SS-PROD | Merged-research invariants | PRD-01 | AT-X2 | WS1 |
| <a id="prd-03"></a>**PRD-03** | Undo, redo, restore any revision, label versions; one agent run is one undo step | SS-PROD | Merged-research history | PRD-01 | AT-X2 | WS1 |
| <a id="prd-04"></a>**PRD-04** | Run the production stage machine with exit criteria and approvals for both workflows and hybrids | SS-PROD | CreatorBrio-owned state machine (07 §8) | PRD-01 | AT-A5, AT-B4 | WS1 |
| <a id="prd-05"></a>**PRD-05** | Keep source media immutable and every derived artefact regenerable | SS-MEDIA | Content-addressed store (merged research) | MED-01 | AT-X2, AT-A1 | WS2 |

### MED · Media and asset ledger

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="med-01"></a>**MED-01** | Ingest footage, audio and images by local path or streamed upload; hash, probe, store originals read-only | SS-MEDIA | FFprobe; streaming SHA-256 | — | AT-A1 | WS2 |
| <a id="med-02"></a>**MED-02** | Create SDR H.264 proxies, analysis WAVs, waveforms and thumbnails; tone-map HDR (HLG/Dolby Vision) per validated path | SS-MEDIA | FFmpeg (`ffmpeg-full`); mediabunny; optional AVFoundation helper | MED-01, gate G2 | AT-A1 | WS2 |
| <a id="med-03"></a>**MED-03** | Handle multiple takes and multi-file recordings of the same session as one source set | SS-MEDIA | CreatorBrio-owned source sets | MED-01 | AT-A1, AT-A2 | WS2 |
| <a id="med-04"></a>**MED-04** | Maintain an asset ledger for every asset (footage, uploads, sourced, generated, rendered, derived) with provenance and rights | SS-MEDIA | CreatorBrio-owned ledger (07 §4) | MED-01, RGT-01 | AT-X6 | WS2 |
| <a id="med-05"></a>**MED-05** | Organise user media libraries (B-roll, photos, music, SFX) with tags, licences and embeddings for search | SS-MEDIA | SigLIP 2, CLAP via media worker | MED-04, PLT-02 | AT-A5, AT-B6 | WS2 |

### SPC · Speech and visual analysis

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="spc-01"></a>**SPC-01** | Transcribe locally with word timings: Parakeet (English and supported European languages) and whisper.cpp for other languages; user-selectable engine | SS-ANALYSIS | parakeet-mlx; whisper.cpp | MED-02, PLT-02 | AT-A2 | WS6 |
| <a id="spc-02"></a>**SPC-02** | Treat the primary speech (footage voice or narration) as the spine; all word-timed features read from it | SS-ANALYSIS | Shared `Transcript` type | SPC-01 or VOC-03 | AT-A2, AT-B3 | WS6 |
| <a id="spc-03"></a>**SPC-03** | Correct transcript words; corrections survive re-transcription and update captions | SS-ANALYSIS | Corrections overlay (merged research) | SPC-01 | AT-A2 | WS6 |
| <a id="spc-04"></a>**SPC-04** | Group retakes and duplicated speech; recommend the best take with a reason; user can swap takes in one action | SS-ANALYSIS | Lexical + embedding similarity, cue phrases; `edit-agent` adjudication | SPC-01 | AT-A2, AT-A3 | WS6 |
| <a id="spc-05"></a>**SPC-05** | Detect filler words, false starts and long pauses as reviewable candidates; tighten pauses per style threshold | SS-ANALYSIS | Silero VAD; gap classifier (YAMNet/CLAP); gate G3 | SPC-01 | AT-A3 | WS6 |
| <a id="spc-06"></a>**SPC-06** | Edit by transcript: delete/restore words and ranges, with clean cut points and short crossfades | SS-ANALYSIS | Merged-research word ops | SPC-01, EDT-01 | AT-A3 | WS6 |
| <a id="spc-07"></a>**SPC-07** | Analyse delivery for take selection: pace, pauses, energy and loudness per take | SS-ANALYSIS | Media worker (pyloudnorm, VAD); `visual-critic` on frames | SPC-04 | AT-A2 | WS6 |
| <a id="spc-08"></a>**SPC-08** | Detect faces, shots and saliency in footage for reframing, caption placement and B-roll | SS-ANALYSIS | Apple Vision (Swift CLI); PySceneDetect | MED-02, PLT-03 | AT-A7 | WS6 |
| <a id="spc-09"></a>**SPC-09** | Produce person mattes with temporal smoothing for masking and text behind subject | SS-ANALYSIS | Apple Vision; BiRefNet fallback; gate G5 | PLT-03 | AT-A7, AT-A5 | WS6 |

### VOC · Voice and narration

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="voc-01"></a>**VOC-01** | Generate narration locally from script lines with a selectable voice; no paid API | SS-VOICE | Kokoro-82M via mlx-audio (Apache-2.0 code and weights), kokoro-onnx fallback; gate G4 | PLN-05, PLT-02 | AT-B3 | WS7 |
| <a id="voc-02"></a>**VOC-02** | Control narration: rate, pauses, emphasis, energy, pitch where supported, pronunciation lexicon per brand | SS-VOICE | CreatorBrio narration markup translated per engine; Kokoro speed and inline phoneme overrides (misaki) | VOC-01 | AT-B3 | WS7 |
| <a id="voc-03"></a>**VOC-03** | Obtain word timings for narration (engine timings or forced alignment of the known text) to drive captions and cues | SS-VOICE | Kokoro native word timestamps (English); Qwen3-ForcedAligner (mlx-audio) for other engines and languages | VOC-01 | AT-B3 | WS7 |
| <a id="voc-04"></a>**VOC-04** | Keep multiple narration takes per line; regenerate one line without touching others; select per line | SS-VOICE | Narration take cache keyed by text+voice+direction | VOC-01 | AT-B3, AT-X1 | WS7 |
| <a id="voc-05"></a>**VOC-05** | Support multiple voices for characters and narrator in one production | SS-VOICE | Voice library | VOC-01 | AT-B4 | WS7 |
| <a id="voc-06"></a>**VOC-06** | Clone a voice only with recorded consent of the voice's owner and a commercially usable model; label synthetic voices | SS-VOICE | Chatterbox Multilingual V3 via mlx-audio (MIT code; weights licence confirmed at G9); VoxCPM2 or Qwen3-TTS alternatives; CreatorBrio provenance marking; consent record | VOC-01, RGT-04 | AT-B3 | WS7 |
| <a id="voc-07"></a>**VOC-07** | Process recorded and synthesised voice: denoise, EQ, de-ess, level | SS-AUDIO | DeepFilterNet3; FFmpeg filters | MED-02 | AT-A8 | WS13 |

### SRC · Sourcing

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="src-01"></a>**SRC-01** | Search Wikimedia Commons and import files with licence, author and attribution from file metadata | SS-SOURCE | MediaWiki API (per E8 terms) | RGT-01, MED-04 | AT-B6 | WS11 |
| <a id="src-02"></a>**SRC-02** | Search Openverse (images, audio) and import with licence metadata | SS-SOURCE | Openverse API (per E8 terms) | RGT-01, MED-04 | AT-B6 | WS11 |
| <a id="src-03"></a>**SRC-03** | Search Freesound and import sounds with licence (CC0/CC-BY/CC-BY-NC) and attribution | SS-SOURCE | Freesound API, opt-in with the user's own key; its API terms are non-commercial (E8), so off by default and excluded from commercial use without a Freesound agreement | RGT-01, MED-04 | AT-B6, AT-A5 | WS11 |
| <a id="src-04"></a>**SRC-04** | Search Internet Archive and import items with their stated rights; unknown rights require a user decision | SS-SOURCE | Internet Archive search and metadata APIs, opt-in (site terms are research-oriented; rights unreliable, E8) | RGT-01, MED-04 | AT-B6 | WS11 |
| <a id="src-05"></a>**SRC-05** | Optional stock connectors (Pexels, Pixabay) and public-domain archives (NASA, Smithsonian Open Access, Library of Congress) behind user-supplied keys where required | SS-SOURCE | Respective APIs (per E8); Pixabay content never used as input to generative features | RGT-01 | AT-B6 | WS11 |
| <a id="src-06"></a>**SRC-06** | Rank candidates for a slot by relevance (text–image/audio embeddings plus model judgment on contact sheets) and explain each choice | SS-SOURCE | SigLIP 2, CLAP; `visual-critic` | MED-05, AIM-01 | AT-B6, AT-A5 | WS11 |
| <a id="src-07"></a>**SRC-07** | Work fully offline with local libraries only; connectors are optional | SS-SOURCE | — | MED-05 | AT-X5 | WS11 |

### RGT · Rights and provenance

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="rgt-01"></a>**RGT-01** | Normalise licences into a rights record (licence, attribution, commercial use, modification, share-alike, AI-generated, consent, status) | SS-RIGHTS | CreatorBrio-owned (07 §4.1) | — | AT-X6 | WS3 |
| <a id="rgt-02"></a>**RGT-02** | Apply the rights policy to placed assets and before export according to usage intent; block or require review with reasons | SS-RIGHTS | CreatorBrio-owned policy (07 §4.2) | RGT-01 | AT-X6, AT-B6 | WS3 |
| <a id="rgt-03"></a>**RGT-03** | Generate credits automatically (file, description text, optional end card) | SS-RIGHTS | CreatorBrio-owned | RGT-01 | AT-X6, AT-B6 | WS3 |
| <a id="rgt-04"></a>**RGT-04** | Record consent for real people in footage and for cloned voices | SS-RIGHTS | CreatorBrio-owned consent records | RGT-01 | AT-B3, AT-X6 | WS3 |
| <a id="rgt-05"></a>**RGT-05** | Record generation provenance (engine, version, model licence, params, seed) for every generated asset and label AI-generated content | SS-RIGHTS | GenerationRecord (07 §4.1) | MED-04 | AT-X6, AT-X9 | WS3 |

### GFX · Graphics and animation

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="gfx-01"></a>**GFX-01** | Animated captions: brand presets (kinetic, calm sentence, karaoke, word-stack), safe-zone aware, manual edit of text and style | SS-GFX | HyperFrames CSS/WAAPI adapters; native templates | SPC-02, REN-01 | AT-A5, AT-A6, AT-B4 | WS12 |
| <a id="gfx-02"></a>**GFX-02** | Motion-graphics templates: titles, lower thirds, key-point cards, callouts, end cards, transitions, brand-tokenised | SS-GFX | Native templates; adapted HyperFrames registry blocks (Apache-2.0) | REN-01, STY-01 | AT-A5, AT-B4 | WS12 |
| <a id="gfx-03"></a>**GFX-03** | Animated diagrams and data charts from structured data, revealed in sync with words | SS-GFX | Mermaid (+ D2/ELK if validated); native chart templates | REN-01, SPC-02 | AT-A5, AT-B4 | WS12 |
| <a id="gfx-04"></a>**GFX-04** | Stick-figure and cartoon character animation from Scene Specs: rigs, poses, expressions, walk cycles, shape-based lip sync | SS-GFX | CreatorBrio rig format + choreography schema + `pose(t)` sampler with 2D IK; rough.js (MIT) for hand-drawn look; OpenMontage Ink techniques as reference only (AGPL); gate G6 | STB-09, REN-01 | AT-B4 | WS12 |
| <a id="gfx-05"></a>**GFX-05** | Illustrated scenes: generate or source illustrations in the brand illustration style with character/style consistency, animated with parallax and camera moves | SS-GFX | Existing image-service contract with a commercially licensed model (FLUX.2 [klein] 4B or Z-Image, Apache-2.0 per E7, via mflux); sourced art | RGT-05, STY-02 | AT-B5 | WS12 |
| <a id="gfx-06"></a>**GFX-06** | Collage and documentary-style sequences from cut-outs, textures and sourced imagery | SS-GFX | Adapted gbro-collage-info grammar (MIT); HyperFrames `paper-collage-reveal` | SPC-09 or GFX-05, SRC-01 | AT-B8 | WS12 |
| <a id="gfx-07"></a>**GFX-07** | Authored one-off graphics: the scene-author writes script-free HTML/CSS/SVG that passes lint and determinism checks | SS-GFX | Merged-research authored-graphics path | AIM-01, REN-01 | AT-B4 | WS12 |
| <a id="gfx-08"></a>**GFX-08** | Import animation assets (Lottie) and vector art (SVG) as clips | SS-GFX | Lottie runtime (HyperFrames adapter) | REN-01 | AT-B5 | WS12 |
| <a id="gfx-09"></a>**GFX-09** | Brand-style presets from Lemo-Opuscar-style direction guides adapted into style prompts and templates, with attribution | SS-GFX | Lemo-Opuscar (MIT) as source material | STY-01 | AT-X12 | WS12 |

### EDT · Editing

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="edt-01"></a>**EDT-01** | Multitrack timeline: A-roll, B-roll, overlay, graphics, captions, voice, music, SFX, ambience tracks | SS-PROD | Merged-research EDD | PRD-01 | AT-A5, AT-B4 | WS1 |
| <a id="edt-02"></a>**EDT-02** | Manual editing: insert, move, trim, split, ripple, roll, slip, delete, snapping, keyboard shortcuts | SS-UI | `@xzdarcy/react-timeline-editor` (gate G7) + owned ops | EDT-01 | AT-X3 | WS14 |
| <a id="edt-03"></a>**EDT-03** | Keyframes for transform, opacity, crop/framing, speed and gain with easing; keyframe lanes | SS-UI | Owned ops; HyperFrames transforms | EDT-01 | AT-X3 | WS14 |
| <a id="edt-04"></a>**EDT-04** | Transitions library (cut, dissolve, wipe, whip, zoom, match-cut helpers) | SS-GFX | Native CSS/WAAPI templates | REN-01 | AT-A5 | WS12 |
| <a id="edt-05"></a>**EDT-05** | Inspector editing of any clip, capability parameter, Scene Spec element and caption | SS-UI | Forms from capability JSON Schemas | EDT-01 | AT-X3 | WS14 |

### VFX · Visual finishing

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="vfx-01"></a>**VFX-01** | Reframe to the output aspect with face/subject tracking, smoothing and editable keyframes | SS-ANALYSIS | Apple Vision faces; owned smoothing | SPC-08 | AT-A7 | WS6 |
| <a id="vfx-02"></a>**VFX-02** | Zooms, punch-ins, speed ramps and camera moves on emphasis words | SS-GFX | Owned ops and templates | SPC-02 | AT-A5 | WS12 |
| <a id="vfx-03"></a>**VFX-03** | Masking and compositing: text and graphics behind the subject, background replacement and blur | SS-GFX | Mattes from SPC-09; compositor layers | SPC-09 | AT-A7, AT-A5 | WS12 |
| <a id="vfx-04"></a>**VFX-04** | Colour grading presets (LUTs) and visual effects (blur, vignette, glow, grain) | SS-GFX | FFmpeg `lut3d` at render input; CSS filters | REN-01 | AT-A6 | WS12 |
| <a id="vfx-05"></a>**VFX-05** | Platform safe zones respected by captions and graphics; overlay in preview | SS-GFX | OpenEdit safe-zone approach (Apache-2.0), existing carousel safe-zone overlay | GFX-01 | AT-X10 | WS12 |

### AUD · Audio design

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="aud-01"></a>**AUD-01** | Music selection from licence-tagged libraries and connectors by mood and intensity, with optional local generation | SS-AUDIO | CLAP retrieval over licence-tagged libraries; ACE-Step 1.5 (optional, MIT) | MED-05, SRC-03 | AT-A5, AT-B5 | WS13 |
| <a id="aud-02"></a>**AUD-02** | Sound effects and Foley placed frame-accurately on spine words, composition events, cuts and transitions | SS-AUDIO | Cue extraction (owned); Earshot procedural bank; CC0 packs (e.g. uisfx); user libraries; Freesound opt-in | SPC-02, REN-01 | AT-A5, AT-B4 | WS13 |
| <a id="aud-03"></a>**AUD-03** | Ducking as explicit gain keyframes derived from the spine; editable | SS-AUDIO | Owned envelope generator | SPC-02 | AT-A8, AT-B4 | WS13 |
| <a id="aud-04"></a>**AUD-04** | Mix and master: per-track levels, SFX levelled to voice, two-pass loudness normalisation and true-peak limit to the delivery target | SS-AUDIO | FFmpeg loudnorm; HyperFrames audio mixer | AUD-01..03 | AT-A8, AT-X10 | WS13 |
| <a id="aud-05"></a>**AUD-05** | Ambience beds for animated scenes | SS-AUDIO | Library + connectors | AUD-01 | AT-B5 | WS13 |

### QAS · Quality assurance

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="qas-01"></a>**QAS-01** | Technical QA: loudness and true peak, black/frozen frames, A/V sync, safe-zone violations, caption legibility and reading speed, duration, resolution and codec conformance, missing fonts | SS-QA | FFmpeg (`ebur128`, `blackdetect`, `freezedetect`); OpenEdit review ideas | REN-02 | AT-X10 | WS16 |
| <a id="qas-02"></a>**QAS-02** | Creative QA: a rubric (hook strength, clarity, pacing, visual relevance, brand fit, trust) assessed by the visual-critic role on frames and transcript, with timestamped findings | SS-QA | `visual-critic` role via model gateway | AIM-01, REN-02 | AT-X11 | WS16 |
| <a id="qas-03"></a>**QAS-03** | Fact and claim QA: on-screen text and narration checked against the research dossier; sensitive unsupported claims block delivery | SS-QA | Claim links (PLN-03/04) | PLN-04 | AT-B1, AT-A6 | WS16 |
| <a id="qas-04"></a>**QAS-04** | Rights QA at export (RGT-02) and determinism spot-check of the render | SS-QA | Rights policy; frame-hash re-render | RGT-02, REN-02 | AT-X6, AT-X9 | WS16 |
| <a id="qas-05"></a>**QAS-05** | Fix or waive each finding; waivers recorded with a reason in the render manifest | SS-QA | Owned | QAS-01 | AT-X10 | WS16 |

### REV · Revisions

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="rev-01"></a>**REV-01** | Targeted revisions from natural language resolved to explicit targets; changes outside targets rejected | SS-AI | Target-scoped runs (04 §7) | AIM-04, STB-07 | AT-X1 | WS8 |
| <a id="rev-02"></a>**REV-02** | Non-destructive editing: every change reversible; earlier versions reproducible | SS-PROD | Revisions + render manifests | PRD-03 | AT-X2, AT-X9 | WS1 |

### REN · Rendering

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="ren-01"></a>**REN-01** | Compile the production to one HyperFrames composition for preview, frames, drafts and finals | SS-RENDER | HyperFrames (Apache-2.0), pinned; gate G1 | PRD-01 | AT-X8 | WS4 |
| <a id="ren-02"></a>**REN-02** | Render drafts and finals locally in a separate worker with progress, cancel and render manifest | SS-RENDER | `@hyperframes/producer`; FFmpeg | REN-01 | AT-X9, AT-X14 | WS4 |
| <a id="ren-03"></a>**REN-03** | Cache expensive layers and generated assets by content hash; re-render only changed ranges | SS-RENDER | Content-hash cache; range splice (OpenEdit pattern) | REN-02 | AT-X1, AT-X14 | WS4 |
| <a id="ren-04"></a>**REN-04** | Preview in an opaque-origin, CSP-locked iframe on proxies | SS-RENDER | `<hyperframes-player>`; gate G1 | REN-01 | AT-X8 | WS4 |

### EXP · Export and preservation

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="exp-01"></a>**EXP-01** | Export deliverables per platform (Reels, TikTok, Shorts, LinkedIn, YouTube 16:9) with captions sidecars and cover/thumbnail | SS-EXPORT | FFmpeg; existing carousel export for covers | REN-02 | AT-A5, AT-B4 | WS17 |
| <a id="exp-02"></a>**EXP-02** | Export and reopen an editable production bundle with assets, provenance, capability lock and credits | SS-EXPORT | Owned bundle format (07 §9) | PRD-01, MED-04 | AT-X7 | WS17 |
| <a id="exp-03"></a>**EXP-03** | Interchange export to OTIO and FCPXML with graphics baked as alpha layers | SS-EXPORT | OTIO JSON (written directly); FCPXML | REN-02 | AT-X13 | WS17 |
| <a id="exp-04"></a>**EXP-04** | Every final render carries a manifest (revision, versions, models, inputs, QA, waivers) | SS-EXPORT | Merged-research render manifest | REN-02 | AT-X9 | WS17 |

### STY · Brand and style

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="sty-01"></a>**STY-01** | Per-brand video style profiles: pacing, caption style, graphics vocabulary, B-roll policy, SFX density, music mood, grade, trust rules | SS-STYLE | Existing brands + owned profiles | — | AT-X12 | WS18 |
| <a id="sty-02"></a>**STY-02** | Per-brand illustration and animation style: palette, line weight, texture, character design sheets | SS-STYLE | Owned; character library | STY-01 | AT-B5, AT-X12 | WS18 |
| <a id="sty-03"></a>**STY-03** | Per-brand narration defaults: voice, delivery, pronunciation lexicon | SS-STYLE | Voice library; lexicons | VOC-02 | AT-X12 | WS18 |
| <a id="sty-04"></a>**STY-04** | Reference-reel analysis proposes a style profile for approval (metrics plus model interpretation) | SS-STYLE | FFmpeg, PySceneDetect; `visual-critic` | STY-01, AIM-01 | AT-X12 | WS18 |

### AIM · AI model gateway and agents

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="aim-01"></a>**AIM-01** | Provider-agnostic model gateway with roles, structured output, tools and vision requirements, and uniform outcomes | SS-AI | Owned gateway (07 §7); MCP | — | AT-X4 | WS8 |
| <a id="aim-02"></a>**AIM-02** | Claude Code CLI runtime for local use on the user's own account, with the existing isolation flags | SS-AI | Existing `visual-director.ts` invocation pattern | AIM-01 | AT-X4 | WS8 |
| <a id="aim-03"></a>**AIM-03** | Anthropic API runtime (Agent SDK or Messages API) with an operator-supplied key, and an OpenAI-compatible runtime for local models | SS-AI | `@anthropic-ai/sdk` (Apache-2.0) Messages API with MCP tools; Claude Agent SDK optional (Anthropic licence); Ollama / LM Studio / llama.cpp servers (MLX-LM lacks JSON-schema output, E8) | AIM-01 | AT-X4 | WS8 |
| <a id="aim-04"></a>**AIM-04** | Edit agent operates only through MCP tools and validated change sets; runs are budgeted, cancellable and reviewable | SS-AI | Merged-research MCP design | AIM-01, PRD-01 | AT-X1, AT-X2 | WS8 |
| <a id="aim-05"></a>**AIM-05** | Manual mode: every workflow can be completed without any model | SS-AI | — | PRD-01, SS-UI | AT-X3 | WS8 |
| <a id="aim-06"></a>**AIM-06** | Direct use of specialist tools through isolated external-tool adapters that return media with an invocation manifest | SS-TOOLS | Adapter interface (07 §5); Manim, Earshot, render(t) pages | PLT-01, RGT-05 | AT-B7 | WS15 |

### OSS · Open source and commercial use

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="oss-01"></a>**OSS-01** | Every bundled dependency has a licence on the allow-list; copyleft tools run only as separate, user-installed processes; source-available renderers excluded | SS-PLATFORM | Licence scan in CI (e.g. license-checker style script) | — | AT-X15 | WS0 |
| <a id="oss-02"></a>**OSS-02** | Model registry records weights licence and commercial-use status; non-commercial models are opt-in, labelled, and blocked for commercial productions | SS-PLATFORM | Model manager | PLT-02 | AT-X15, AT-X6 | WS5 |
| <a id="oss-03"></a>**OSS-03** | No paid API or account is required for the local core workflow; optional connectors and providers are clearly marked | SS-PLATFORM | — | AIM-05, SRC-07 | AT-X5 | WS0 |

### PLT · Local platform and performance

| ID | Requirement | Owner | Technology candidate | Depends on | Acceptance | WS |
|---|---|---|---|---|---|---|
| <a id="plt-01"></a>**PLT-01** | Job runner with GPU and CPU lanes, progress, cancel, interruption recovery | SS-PLATFORM | Merged-research job runner | — | AT-X14 | WS5 |
| <a id="plt-02"></a>**PLT-02** | Media worker (uv, MLX-first) on loopback with capabilities endpoint and model manager (pinned revisions, offline at runtime) | SS-PLATFORM | uv; mlx; mlx-audio; parakeet-mlx | PLT-01 | AT-X5 | WS5 |
| <a id="plt-03"></a>**PLT-03** | Vision CLI (Swift) for Apple Vision and AVFoundation tasks | SS-PLATFORM | Apple Vision, AVFoundation | PLT-01 | AT-A7 | WS5 |
| <a id="plt-04"></a>**PLT-04** | Setup and doctor detect FFmpeg build, workers, models and optional tools, and say what each missing piece disables | SS-PLATFORM | Existing `setup.mjs` / `doctor.mjs` | PLT-02, PLT-03 | AT-X5 | WS5 |
| <a id="plt-05"></a>**PLT-05** | Performance: interactive preview on proxies; a 60 s reel final render within the founder-agreed target on the M5 Max | SS-RENDER | HyperFrames parallel capture; gate G1 | REN-02 | AT-X14 | WS4 |


## 7. Glossary

| Term | Meaning |
|---|---|
| Production | One video project: brief, research, script, storyboard, timeline, voice, review and deliverables in one versioned document |
| Spine | The primary speech track (footage speech or narration) whose word timings drive scenes, captions, cues and ducking |
| Scene | The unit of storyboard planning, approval and revision |
| Scene Spec | Declarative data describing an animated scene, compiled to HTML/SVG and rendered by the single renderer |
| Materialisation | Deterministic conversion of an approved scene into timeline clips it owns |
| Capability | A versioned creative or analytical function with a manifest; native or external |
| External-tool adapter | Direct use of a specialist tool as an isolated job returning baked media |
| Usage intent | personal, commercial or client; drives the rights policy |
| Runtime | A way to run AI roles: Claude Code CLI, Anthropic API, OpenAI-compatible, or manual |
