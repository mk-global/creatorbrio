# 06 · Feature coverage matrix

[← Research index](README.md) · Architecture: [05](05-proposed-architecture.md)

This matrix maps every capability the brief requires to what provides it.
"Reused" names a library or existing component, and "CreatorBrio builds" names the code we write.

**Judgment** says whether the step is deterministic code (**D**), AI judgment (**AI**), or both (**D+AI**: deterministic candidates and execution, AI choice).

**Confidence** is how well the approach is established:

- **High**: verified in source in a working project with the same approach.
- **Medium**: documented, or verified in a project with a different stack.
- **Low**: a design proposal that needs a validation checkpoint ([08](08-implementation-plan.md#validation-checkpoints)).

"Key-free" means the feature works with only the user's Claude Code subscription: no other API key or paid service.

| # | Capability | Reused | CreatorBrio builds | Judgment | Key-free | Confidence | Honest limitation |
|---|---|---|---|---|---|---|---|
| 1 | Raw footage ingestion, multiple takes | FFmpeg/FFprobe (probe, SDR proxy, WAV extraction); mediabunny (thumbnails, waveforms) | Path-based import (no browser upload of GB files), SHA-256 content addressing, media registry, HDR policy | D | ✔ | High | iPhone HLG/Dolby Vision tone mapping needs validation (V3) |
| 2 | Intelligent take selection, duplicated-speech removal | parakeet-mlx words; local text embedder | Take grouping (lexical + embedding similarity + cue phrases, as in Ghost Editor's approach), default "last complete take"; Edit Agent can override with a reason | D+AI | ✔ | Medium | Paraphrased retakes far apart in time are harder; the user confirms groups in the UI |
| 3 | Transcript-based editing | parakeet-mlx (word timings), Silero VAD | Transcript editor UI; `deleteWords` / `restoreWords` ops mapping words to source ranges; corrections that survive re-transcription | D | ✔ | High (Nuzky, OpenChatCut, FableCut implement it) | Cut points between words need a few ms of handle and an audio crossfade to avoid clicks |
| 4 | Filler-word and silence editing | Silero VAD; YAMNet or CLAP classifier; optional Whisper filler prompt re-decode | Voiced-but-unworded gap detector + classifier; `tightenPauses`; per-style thresholds | D+AI | ✔ | Low–Medium (V4) | No permissive ASR reliably transcribes "um/uh"; CrisperWhisper does but is non-commercial |
| 5 | Story restructuring without altering meaning | — | Segment model + `reorderSegments` op; Director proposes order in the storyboard; meaning check: Claude compares old vs new transcript and reports any changed claim before applying | AI | ✔ | Medium | Meaning preservation is judgment; the user approves restructures explicitly, never silently |
| 6 | Multitrack editing, cuts, trims, transitions, keyframes | `@xzdarcy/react-timeline-editor` (interaction); HyperFrames (render of transforms, transitions) | EDD tracks and clips, ops (`insert/move/trim/split/remove`, keyframes), timeline lanes, transition templates (CSS/WAAPI) | D | ✔ | High for model and render; Medium for UI scope | Real-time preview of many simultaneous video layers depends on proxies and the browser (tested in V1/V2) |
| 7 | Automated and manual captions | Word timings; `@remotion/captions` (MIT) optional for SRT/VTT utilities | Caption layout (line breaking, max chars, safe zones as in Ghost Editor and OpenEdit), style presets per brand, `editCaptionText` corrections, SRT/VTT export | D (+AI for emphasis words) | ✔ | High | Non-English line-breaking rules need per-language work |
| 8 | Animated typography and captions | HyperFrames CSS/WAAPI/anime.js adapters | Kinetic caption templates (pop, highlight, karaoke, word-stack), brand fonts embedded via existing `fonts.ts` | D | ✔ | High (E1 + HyperFrames adapters) | Quality is template quality: needs a designer's eye on each preset |
| 9 | Subject tracking and intelligent reframing | Apple Vision face rectangles / tracking (Swift CLI); MediaPipe fallback | Reframe algorithm: subject choice, headroom rules, dead zone, One-Euro smoothing, scene-cut reset → `framing` keyframes the user can edit | D | ✔ | Medium (OpenChatCut and OpenEdit do it with MediaPipe; ours uses Apple Vision) | Multi-person active-speaker selection is not in the first version without diarisation |
| 10 | Zooms, speed ramps, camera treatment | HyperFrames (CSS transforms over video); FFmpeg for speed-changed audio (`atempo`) | `setFraming` punch-ins on emphasis words, `setSpeed` ramps, shake/drift presets per style | D+AI | ✔ | High for zoom; Medium for speed ramps (audio pitch handling) | Speed ramps on speech sound unnatural; style profiles restrict them to B-roll |
| 11 | Background removal and replacement | Apple Vision person matte; BiRefNet fallback | Matte job, temporal smoothing, edge refinement; compositor layers: replacement plate (image, video or brand colour) under the cut-out | D | ✔ | Medium (V5) | Hair-level edges and fast motion; the person's lighting cannot match a new background, the same honest limit as today's image editing |
| 12 | Person masking and text behind subject | Same matte | `fx.text-behind-subject` capability: footage, then text, then matte cut-out stacked in one composition | D | ✔ | High for compositing (Ghost Editor, OpenEdit, HyperFrames recipe); Medium for matte quality (V5) | Occlusion must stay partial (30–55% guidance in HyperFrames docs) to keep text readable |
| 13 | Visual effects and colour grading | FFmpeg `lut3d` at render input; CSS filters in compositions | Grade presets (LUTs) per style profile; effect templates (blur, vignette, glow) | D | ✔ | Medium | Grading auto-matching across cameras is not automated; presets only |
| 14 | B-roll search, selection and insertion | SigLIP 2 (visual search), PySceneDetect (shots), Claude vision on contact sheets; optional Pexels/Pixabay (free keys) | Local B-roll library index; `search_assets` tool; insertion on the B-roll track at transcript anchors with J/L-cut audio handling | D+AI | ✔ (local library); free key for stock | Medium | Quality is bounded by the library; a stock API is a free-key option, not mandatory |
| 15 | Custom SVG graphics and animations | CSS/WAAPI, HyperFrames adapters | "Authored graphics" capability: Design Agent writes script-free HTML/CSS/SVG, linted + determinism-checked | AI | ✔ | High (same as slides + E1) | Taste varies run to run; evaluation harness tracks it |
| 16 | Data visualisation and animated diagrams | Mermaid (layout), HyperFrames registry `data-chart` / `flowchart` (adapted), Lemo-Opuscar styles | `graphic.architecture-diagram`, `graphic.data-chart` templates with typed params (nodes, edges, series) | D (+AI for content) | ✔ | Medium–High | Complex diagrams need manual layout touch-ups; params are editable |
| 17 | Cinematic animation sequences | HyperFrames adapters, Lottie, optional ManimCE (imported as video) | Sequence templates (title sequences, chapter cards); motion blur via HyperFrames | D+AI | ✔ | Medium | "Cinematic" is design work: the template library grows over time |
| 18 | Collage-style visuals | gbro-collage-info CSS/motion grammar (MIT), HyperFrames `paper-collage-reveal` | `graphic.collage-sequence` template; cut-outs from Apple Vision foreground masks | D+AI | ✔ | Medium | Needs good source imagery; no generative fill by default |
| 19 | Image editing and compositing | Existing image service (optional, background replacement only) + sharp | Stills enter the EDD as image clips; existing image-editing rules apply unchanged | D | ✔ (image service is local, optional) | High (exists for carousels) | Same limits as today: no relighting, object removal or person regeneration |
| 20 | Sound effects with frame-accurate placement | Earshot procedural bank (MIT), CC0 uisfx pack, CLAP retrieval, user library | Cue extraction from the compiled timeline (graphic entrances, cuts, zooms) → audio clips at exact frames, levelled against voice | D+AI | ✔ | Medium (Real SFX and Ghost Editor show the approach) | SFX taste: style profile sets density; the agent proposes, the user can mute per cue |
| 21 | Music selection, ducking, professional mixing | CLAP over licence-tagged library; FFmpeg `loudnorm` two-pass, limiter; optional ACE-Step 1.5 generation | Ducking as explicit gain keyframes from VAD/words; per-track levels; final master at a configurable LUFS target | D+AI | ✔ | High for mixing; Medium for selection | Music licensing is per track: the library records licence and attribution; no copyrighted commercial music |
| 22 | Voice enhancement and noise removal | DeepFilterNet3 (mlx-audio or Rust CLI); FFmpeg high-pass and EQ | Processing chain with strength and wet/dry; A/B preview | D | ✔ | Medium | Over-suppression of breaths and room tone; never hidden, always adjustable |
| 23 | Reference-reel style analysis | FFmpeg (cut detection, loudness), PySceneDetect, Claude vision on contact sheets | Metrics extractor + Director prompt → proposed style profile for approval | D+AI | ✔ | Medium | Infers style, not intent; never copies another creator's content |
| 24 | Brand-specific editing styles | Existing brands (colours, fonts, logo, keywords) | Video style profiles per brand ([05 §8](05-proposed-architecture.md#8-brand-specific-editing-styles)), CSS-variable injection, style-aware Director | D+AI | ✔ | High (extends shipped brand system) | Two creators' profiles must be authored and tuned with real footage |
| 25 | Storyboard generation and approval | Claude CLI `--json-schema` (as the Visual Director) | Storyboard schema, approval UI, beats linked to transcript ranges | AI | ✔ | High (same pattern as the existing Director) | Storyboard quality depends on the transcript and brief |
| 26 | Editable previews and targeted revision requests | HyperFrames player; render cache | Change sets scoped to clips; recompile only changed sub-compositions; markers for questions | D+AI | ✔ | Medium (V2) | Very large revisions still need a full re-render |
| 27 | Manual editing capabilities | Timeline widget, mediabunny | Studio UI: transcript editor, timeline, inspector, keyframe lanes, keyboard shortcuts | D | ✔ | Medium (UI scope is the largest build item) | A full NLE UI is never "done"; the scope is what reels need |
| 28 | Non-destructive project editing | — | Immutable content-addressed originals; derived media regenerable; EDD references only IDs | D | ✔ | High | Disk use grows with proxies and mattes; a cleanup command is needed |
| 29 | Undo, versioning and recovery | Existing `data.ts` locking and atomic writes | Revisions + change-set log; agent run = one undo step with Keep/Discard; named versions; corrupt-file refusal | D | ✔ | High | OS crash between write and rename can lose the latest revision (same as today) |
| 30 | Local rendering and export | HyperFrames producer; FFmpeg (VideoToolbox H.264/HEVC encode) | Render worker process, export presets (Instagram Reel, LinkedIn video, story), SRT sidecar, OTIO/FCPXML hand-off | D | ✔ | Medium (V1 measures speed on Mac) | Chromium per-frame capture is slower than native compositors |
| 31 | Automated technical quality checks | FFmpeg (`ebur128`, `blackdetect`, `freezedetect`), OpenEdit-style review ideas | QA stage: loudness and true peak, black/frozen frames, A/V sync, safe-zone violations, caption legibility (contrast, size, reading speed), determinism spot-check, duration limits | D | ✔ | High | QA catches technical faults, not whether the edit is good |
| 32 | Reproducible rendering and source preservation | Pinned HyperFrames, pinned models, FFmpeg version recorded | Render manifest per output: EDD revision, compiler version, package versions, model versions, input hashes | D | ✔ | High | Reproducibility across machines depends on identical fonts and Chromium build; the manifest records them |

## What genuinely runs without extra API keys

**Everything above runs key-free** on the user's Mac with their Claude Code subscription.
The optional extras are:

- Pexels/Pixabay stock search (free keys).
- Freesound library downloads (free key).
- Gated model downloads that need a Hugging Face account acceptance (SAM 3.1).
- The existing local image service.

None is required by the core workflow.

## Capabilities that remain hard to automate well

These are listed so expectations stay honest.

1. **Taste.** Hook choice, comedic timing, when an effect helps versus distracts. The system proposes, explains and makes everything reversible; it does not claim to replace an editor's eye.
2. **Filler words** without a non-commercial model ([V4](08-implementation-plan.md#validation-checkpoints)).
3. **Hair-level matting** on busy backgrounds and fast motion ([V5](08-implementation-plan.md#validation-checkpoints)).
4. **B-roll relevance** without a good library: retrieval cannot invent the right shot, and local video generation is too slow and would not meet the trust standard for the wellness creator.
5. **Meaning-preserving restructuring**, which is always a user-approved proposal.
6. **Music choice and licensing** at a professional level, bounded by the library the creator assembles.
7. **HDR iPhone footage** consistency with what the creator saw in Photos ([V3](08-implementation-plan.md#validation-checkpoints)).
