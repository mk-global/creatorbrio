# 05 · Capability and tool-mapping matrix

[← Specification index](README.md) · Requirements: [01](01-product-requirements.md#6-requirements-register) · Capability interface: [07 §5](07-data-models-and-interfaces.md#5-capability-interface)

This matrix maps each capability to the technology that provides it, and each specialist tool to how CreatorBrio uses it.
Third-party projects are treated as reusable technology or as references, never as mandatory dependencies of the core workflow.

**Use modes**

- **Dependency**: a library or binary CreatorBrio calls inside its own pipeline.
- **Direct**: the specialist tool is run as an isolated external-tool adapter that returns baked media ([07 §5](07-data-models-and-interfaces.md#5-capability-interface)).
- **Native**: the technique is reimplemented in CreatorBrio as a template or executor rendered by the single renderer.
- **Reference**: design ideas only; no code.
- **Excluded**: not used, for the reason given.

## 1. Specialist tools and projects

| Tool | What it is | Licence (verified where noted) | Mode | How CreatorBrio uses it | Requirements | Evidence |
|---|---|---|---|---|---|---|
| **HyperFrames** | HTML-composition video renderer, player, adapters | Apache-2.0 (root licence file) | **Dependency** | The single renderer for preview, frames, animatic, drafts and finals; registry blocks adapted as templates | REN-01 … REN-04, STB-02, GFX-02 | [E4 §1](../evidence/e4-creative-and-audio-tools.md#1-hyperframes--heygen-comhyperframes-most-important), [E0](../evidence/e0-experiments.md#direct-verification-by-the-lead-researcher) |
| **OpenFilm** | HTML `film.html` editor and `frame(t)` renderer | MIT + trademark policy | **Reference** + fallback **Direct** | Its `look` QA ideas (shuffled-order determinism, clipped text) inform QAS-01. A self-contained `frame(t)` page can be baked through an adapter. Its renderer is the documented fallback if gate G1 fails | QAS-01, AIM-06 | [E1 §1](../evidence/e1-complete-editors-a.md#1-openfilm-openfilmopenfilm) |
| **Ghost Editor** | Claude Code skill: `reel.json` → HyperFrames for talking-head reels | MIT (Mixkit media terms excluded) | **Native** | Reimplement its algorithms with attribution: anti-merge transcription settings, take selection, safe-zone caption placement, matte temporal smoothing, SFX levelling against voice | SPC-04, SPC-09, GFX-01, AUD-02 | [E2 §1](../evidence/e2-complete-editors-b.md#1-ghost-editor--kurbaitaevghost-editor) |
| **OpenMontage** (`calesthio/OpenMontage`) | Agent-orchestrated production pipelines (YAML + skills + ~209 Python tools) rendering via Remotion or HyperFrames; Ink Theater stick figures | **AGPL-3.0** (licence file read) | **Reference** | Learn its techniques only, reimplemented from first principles: closed-form spring easing, timeline-stepped line boil, 2D IK, seeded randomness, mocap-to-stick-figure clip libraries. Excluded as dependency and adapter: AGPL, cloud-first tools, and an agent-as-orchestrator design that would compete with the production document | GFX-04 | [E7](../evidence/e7-openmontage-animation.md) |
| **Lemo-Opuscar** | 66 film-style prompts + director guides + small `render(t)` toolkit | MIT code; CC BY 4.0 demo films | **Native** + optional **Direct** | Style prompts and direction guides become brand style presets and `scene-author` guidance, with attribution (GFX-09). A `render(t)` canvas scene can be baked through an adapter when its look is wanted as-is | GFX-09, AIM-06 | [E4 §2](../evidence/e4-creative-and-audio-tools.md#2-lemo-opuscar--lemomo-ailemo-opuscar) |
| **gbro-collage-info** | Paper-collage infographic skill on HyperFrames | MIT (vendored GSAP and Mixkit files excluded) | **Native** | Collage motion grammar and CSS adapted into `graphic.collage-sequence` | GFX-06 | [E4 §7](../evidence/e4-creative-and-audio-tools.md#7-gbro-collage-info--pyang5166gbro-collage-info) |
| gbro-collage-broll, VOX-COLLAGE-BROLL | Prompt skills over paid generation APIs | MIT | **Excluded** | Depend on Gemini, MaxFusion or ElevenLabs; the collage aesthetic is covered natively | — | [E4 §5–6](../evidence/e4-creative-and-audio-tools.md#5-gbro-collage-broll--pyang5166gbro-collage-broll) |
| **Earshot** | Procedural SFX bank (252 sounds), CLAP/AST listening analysis, CLI + MCP | MIT | **Direct** | Sidecar adapter: model-free `sfx`/`kit` rendering for licence-clean sounds; optional analysis as QA input | AUD-02, AIM-06 | [E4 §10](../evidence/e4-creative-and-audio-tools.md#10-earshot--leonxlnxearshot) |
| **Real SFX** (Clipwing) | Skill that reads cue times from a HyperFrames composition and places real recordings | No LICENSE file (README says MIT); bundled `uisfx` CC0 | **Native** + CC0 pack as dependency | Cue extraction reimplemented in SS-AUDIO; the CC0 sound pack adopted with its notice | AUD-02 | [E4 §9](../evidence/e4-creative-and-audio-tools.md#9-real-sfx--clipwingskills-skillsreal-sfx) |
| **OpenEdit** (VEED) | Virtual-clock HTML renderer, EDL, safe zones, review checks | Apache-2.0 + NOTICE | **Native** | Safe-zone definitions, review checks and range splicing adapted with attribution; virtual clock as a determinism hardening option | VFX-05, QAS-01, REN-03 | [E2 §2](../evidence/e2-complete-editors-b.md#2-openedit--veedstudioopen-edit) |
| **Manim** (Community Edition) | Python mathematical animation | MIT | **Direct** | External-tool adapter for derivations and maths scenes, returning a ProRes 4444 or WebM-alpha layer | AIM-06 | [E4 extras](../evidence/e4-creative-and-audio-tools.md#extras--other-credible-open-source-systems) |
| **Nuzky**, **WeftCut**, **OpenChatCut** | NLEs with keyless Claude Code agent loops | GPL-3.0; MIT; AGPL-3.0 | **Reference** | Agent run lifecycle, MCP-only tools, timeline diff, draft review | AIM-04, STB-08 | [E2 §5](../evidence/e2-complete-editors-b.md#5-nuzky--nuzkyappnuzky), [E6](../evidence/e6-recent-discovery.md#table), [E1 §2](../evidence/e1-complete-editors-a.md#2-openchatcut-0xslineopenchatcut) |
| **Yap Studio** | Talking-head reel engine on HyperFrames; taste rules | Apache-2.0 | **Reference** | Taste rules from review notes inform style-profile learning | STY-04 | [E6 §3](../evidence/e6-recent-discovery.md#3-yap-studio-the-closest-product-match-raw-talking-head-takes-to-a-finished-vertical-reel) |
| BaoCut, Concat | Native NLEs | Source-available; AGPL-3.0 + CLA | **Reference** | Design references only | — | [E1 §3](../evidence/e1-complete-editors-a.md#3-baocut-jimliubaocut), [E2 §3](../evidence/e2-complete-editors-b.md#3-concat--jub0tconcat) |
| OneTake | Continuous-take motion skill | PolyForm Noncommercial | **Excluded** | Non-commercial licence; motion blur already exists in HyperFrames | — | [E4 §3](../evidence/e4-creative-and-audio-tools.md#3-onetake--feitangyuanonetake) |
| Claude Animation Base | p5.brush mascot kit | MIT; mascot trademark concern | **Reference** | Storyboard → shot → contact-sheet workflow guide | STB-02 | [E4 §4](../evidence/e4-creative-and-audio-tools.md#4-claude-animation-base--windpipeclaudeanimationbase) |
| OpenHiggsfield | Web client for paid generation APIs | MIT (frontend provenance unverified) | **Excluded** | Cloud-only | — | [E4 §8](../evidence/e4-creative-and-audio-tools.md#8-openhiggsfield--thehiggsfieldaiopenhiggsfield) |
| Remotion | React video framework | Remotion License (source-available) | **Excluded** from core | Licence binds every user; `@remotion/captions` (MIT) may be used standalone | — | [E3 §1](../evidence/e3-sdks-and-renderers.md#1-remotion-remotion-devremotion) |
| elah | Embeddable timeline/editor SDK | Apache-2.0 | **Reference**; candidate at gate G7 | Timeline UI candidate if its multi-track playback matures | EDT-02 | [E0](../evidence/e0-experiments.md#direct-verification-by-the-lead-researcher) |

## 2. Capabilities mapped to technology

| Capability | Requirements | Foundation (mode) | CreatorBrio builds | Owner |
|---|---|---|---|---|
| Brief, research, claims | PLN-01 … PLN-04 | Existing `creative-brief.ts`, `source-retrieval.ts` (dependency); `researcher` role | Dossier, claim model, sensitivity rules | SS-PLAN |
| Script, hooks, structure | PLN-05 … PLN-09 | `story-director` role (model gateway) | Script model, hook options, structure patterns | SS-PLAN |
| Storyboard, frames, animatic, approval | STB-01 … STB-09 | HyperFrames frame capture (dependency) | Scene schema, lifecycle, materialiser, Scene Spec, review | SS-STORY |
| Production document, ops, history, stages | PRD-01 … PRD-04, REV-02, EDT-01 | Merged-research EDD design; `data.ts` | Everything | SS-PROD |
| Ingest, proxies, HDR, ledger, libraries | MED-01 … MED-05, PRD-05 | FFmpeg, mediabunny, SigLIP 2, CLAP (dependency) | Ledger, source sets, HDR policy | SS-MEDIA |
| Transcription, takes, fillers, transcript editing | SPC-01 … SPC-07 | parakeet-mlx, whisper.cpp, Silero VAD (dependency); Ghost Editor techniques (native) | Spine, take grouping, filler classifier, word ops | SS-ANALYSIS |
| Faces, shots, mattes, reframing | SPC-08, SPC-09, VFX-01 | Apple Vision via Swift CLI; PySceneDetect; BiRefNet fallback (dependency) | Smoothing, framing keyframes | SS-ANALYSIS |
| Narration and voices | VOC-01 … VOC-06 | Kokoro-82M via mlx-audio (Apache-2.0) as primary; Chatterbox Multilingual V3 (MIT) for consented cloning; Qwen3-ForcedAligner for timing ([E8](../evidence/e8-tts-sourcing-providers.md)) (dependency) | Voice library, lexicons, takes, direction mapping, consent | SS-VOICE |
| Voice processing | VOC-07 | DeepFilterNet3, FFmpeg (dependency) | Processing chain | SS-AUDIO |
| Sourcing and relevance | SRC-01 … SRC-07 | Public APIs over HTTP: Wikimedia Commons and Openverse on by default; Freesound and Internet Archive opt-in (non-commercial or research terms); Pexels, Pixabay, NASA, Smithsonian, Library of Congress optional; SigLIP 2, CLAP | Connectors, ranking, explanations | SS-SOURCE |
| Rights, credits, consent, provenance | RGT-01 … RGT-05 | — | All of it | SS-RIGHTS |
| Captions | GFX-01 | HyperFrames adapters (dependency); Ghost Editor placement ideas (native) | Caption presets and layout | SS-GFX |
| Motion-graphics templates, transitions | GFX-02, EDT-04 | HyperFrames registry blocks (native adaptation), anime.js, CSS/WAAPI | Brand-tokenised template library | SS-GFX |
| Diagrams and charts | GFX-03 | Mermaid / dagre (dependency); D2 as an optional external CLI | Reveal templates synced to words | SS-GFX |
| Stick figures and characters | GFX-04, STB-09 | rough.js for hand-drawn rendering (dependency); OpenMontage Ink techniques (reference); curated mocap clips if their licence is cleared | Character rig format, choreography schema, `pose(t)` sampler with IK, lip-sync shapes | SS-GFX |
| Illustrated scenes | GFX-05 | Image-service contract with a commercially licensed model, e.g. FLUX.2 [klein] 4B or Z-Image (Apache-2.0, per [E7](../evidence/e7-openmontage-animation.md)) via mflux; sourced art | Style conditioning, character sheets, parallax animation | SS-GFX |
| Collage | GFX-06 | gbro-collage-info grammar (native) | Collage template | SS-GFX |
| Authored graphics | GFX-07 | Merged-research lint + determinism check | — | SS-GFX |
| Lottie and SVG import | GFX-08 | Lottie runtime via HyperFrames adapter (dependency) | Import validation | SS-GFX |
| Style presets from direction guides | GFX-09 | Lemo-Opuscar (native, attribution) | Style preset library | SS-GFX |
| Specialist tools used directly | AIM-06 | Manim, Earshot, `render(t)` pages (direct) | Adapter runtime and manifests | SS-TOOLS |
| Manual editing, keyframes, inspector | EDT-02, EDT-03, EDT-05 | `@xzdarcy/react-timeline-editor` or the G7 choice (dependency) | Lanes, ops, inspector forms | SS-UI |
| Zooms, masks, compositing, grading, safe zones | VFX-02 … VFX-05 | HyperFrames transforms; FFmpeg `lut3d`; OpenEdit safe zones (native) | Templates and presets | SS-GFX |
| Music, SFX, Foley, ambience, ducking, mastering | AUD-01 … AUD-05 | CLAP, Earshot, CC0 packs, user libraries, Freesound (opt-in), ACE-Step 1.5 (optional), FFmpeg loudnorm, HyperFrames audio mixer | Cue extraction, envelopes, levelling | SS-AUDIO |
| QA | QAS-01 … QAS-05 | FFmpeg filters; `visual-critic` role | Checks, rubric, claims, waivers | SS-QA |
| Targeted revisions | REV-01 | — | Target-scoped runs | SS-AI |
| Rendering | REN-01 … REN-04, PLT-05 | HyperFrames, FFmpeg | Compiler, caches, manifests | SS-RENDER |
| Export and bundles | EXP-01 … EXP-04 | FFmpeg; OTIO JSON | Bundle format, FCPXML writer | SS-EXPORT |
| Brand and style | STY-01 … STY-04 | Existing brands | Profiles, illustration styles, analysis | SS-STYLE |
| Model gateway and agents | AIM-01 … AIM-05 | Claude Code CLI; Claude Agent SDK / API; OpenAI-compatible local servers; MCP | Gateway, roles, prompts, schemas, MCP server | SS-AI |
| Licensing controls | OSS-01 … OSS-03 | Licence scanner in CI | Allow-lists, model registry policy | SS-PLATFORM |
| Local platform | PLT-01 … PLT-04 | uv, MLX, Swift toolchain | Job runner, worker, model manager, doctor | SS-PLATFORM |

## 3. One tool per responsibility (extended)

The merged research's table ([05 §10](../05-proposed-architecture.md#10-one-tool-per-responsibility)) still applies.
New rows:

| Responsibility | The one tool | Not used for this |
|---|---|---|
| Narration synthesis | Kokoro-82M via mlx-audio, confirmed at gate G4 ([E8](../evidence/e8-tts-sourcing-providers.md)) | A second always-on TTS: Chatterbox is used only for consented custom voices. Excluded: F5-TTS, XTTS-v2 (non-commercial weights), Piper (GPL-3.0), Fish Audio and IndexTTS (restrictive licences) |
| Narration word timing | The TTS engine's own timings where reliable; otherwise one forced aligner | ASR re-transcription of known text |
| Character animation | CreatorBrio's Scene Spec compiler | OpenMontage Ink Theater (AGPL), Rive, Spine, Synfig |
| Diagram layout | Mermaid / dagre | Hand-positioned SVG by the model |
| Illustration generation | The image-service contract | A second diffusion host inside the media worker |
| Media sourcing | The connectors in SS-SOURCE | Agent web browsing for media |
