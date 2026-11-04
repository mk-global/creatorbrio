# 09 · Differences from the merged research architecture (PR #64)

[← Specification index](README.md) · Merged research: [00](../00-executive-decision.md), [05](../05-proposed-architecture.md), [08](../08-implementation-plan.md)

The merged research ([mk-global/creatorbrio#64](https://github.com/mk-global/creatorbrio/pull/64)) was evaluated critically against the complete product.
Its core holds.
Its gaps come from its scope: it specified a footage editor, not a production studio with two entry points.
This page lists every change and what stays.
Where this specification and the merged research disagree, this specification governs.

## 1. Decisions kept unchanged

| Decision | Why it still holds | Where |
|---|---|---|
| CreatorBrio owns the project format | Both workflows need words, takes, scenes and provenance that no third-party format models; ownership keeps the renderer replaceable | [05 §3](../05-proposed-architecture.md#3-the-edit-decision-document) |
| One authoritative timeline | Workflow B adds documents *before* the timeline but nothing that renders on its own; storyboard frames are compiled timeline fragments | [06 §4](06-architecture.md#4-one-authoritative-timeline-two-kinds-of-plans) |
| Immutable, content-addressed source media | Unchanged; extended to every asset kind | [07 §4](07-data-models-and-interfaces.md#4-assets-provenance-and-rights) |
| Typed operations, one mutation funnel, optimistic concurrency, invariants | Unchanged; the operation vocabulary grows | [07 §6](07-data-models-and-interfaces.md#6-operations-and-change-sets) |
| Reversible AI changes: one run = one change set = one undo step, keep or discard | Unchanged; extended with per-scene keep and target-scoped runs | [04 §7](04-storyboard-and-review.md#7-editorial-review) |
| HyperFrames as the single renderer for preview, frames and export; FFmpeg for media | Workflow B's animation is HTML/SVG, the renderer's native medium. OpenMontage's animated scenes also render through HyperFrames ([E7](../evidence/e7-openmontage-animation.md)), which supports the choice | [05 §9](../05-proposed-architecture.md#9-rendering-contract) |
| Local analysis stack (parakeet-mlx, whisper.cpp, Silero, Apple Vision, DeepFilterNet3, CLAP, SigLIP 2, PySceneDetect) | No new evidence against it | [05 §10](../05-proposed-architecture.md#10-one-tool-per-responsibility) |
| Loopback media worker, Swift vision CLI, render worker on Node 22, file-backed job runner | Hosts the new TTS and alignment jobs without new infrastructure | [05 §11](../05-proposed-architecture.md#11-local-process-orchestration) |
| Opaque-origin, CSP-locked preview; no model-authored scripts | Unchanged; Scene Specs make it easier, because models now author data | [05 §9](../05-proposed-architecture.md#preview-isolation) |
| Validation checkpoints V1–V8 | All still needed; they become gates in the programme | [11](11-implementation-program.md#validation-gates) |

## 2. Changes

| # | Merged research said | This specification says | Why | Impact |
|---|---|---|---|---|
| D1 | The EDD (`VideoProject`) holds the timeline; a `Storyboard` of beats is a one-shot Director output | A **Production** document holds brief, research dossier, script, storyboard, timeline, voice and review state under one revision counter. `schemaVersion` goes from 1 to 2 | Workflow B starts before any media exists; scene-level approval and revision need the plan to be a living, versioned document linked to its realisation | `VideoProject` becomes the `timeline` section; ops for all sections ([07 §1](07-data-models-and-interfaces.md#1-the-production-document)) |
| D2 | The storyboard is beats proposed for approval; then the Edit Agent executes | The storyboard is **first-class**: scenes with lifecycle states, real rendered frames, an animatic, per-scene approval, deterministic materialisation into clips owned by scenes, and divergence detection | "Individual scene approval" and targeted revision are core product requirements | New SS-STORY subsystem and WS10 ([04](04-storyboard-and-review.md)) |
| D3 | The spine is the recorded A-roll; words come from ASR | The **speech spine** is either footage speech (ASR) or synthesised narration (TTS + alignment), with the same `Transcript` type | One code path for captions, cues, ducking and scene timing in both workflows | New SS-VOICE subsystem ([07 §3](07-data-models-and-interfaces.md#3-the-speech-spine)) |
| D4 | Media store with licence fields only for library media; licences treated as a risk note | A **rights ledger** on every asset (source, generation record, licence, commercial use, modification, share-alike, AI-generated, consent) with a deterministic **rights policy** driven by the production's usage intent, plus automatic credits | Public sourcing from Commons, Openverse, Freesound and Internet Archive, plus future commercial use, make rights a product function, not a footnote | New SS-RIGHTS subsystem ([07 §4](07-data-models-and-interfaces.md#4-assets-provenance-and-rights)) |
| D5 | B-roll from a local library; Pexels/Pixabay optional | **Sourcing connectors** for Wikimedia Commons, Openverse, Freesound and Internet Archive, plus optional stock and public-domain archives, with relevance ranking and explanations; local libraries first; fully optional | Requested product scope; Workflow B depends on sourced imagery and sound | New SS-SOURCE subsystem; the only new outbound network use ([06 §9](06-architecture.md#9-security-and-isolation)) |
| D6 | Every agent role runs on the Claude Code CLI | A **model gateway** with runtimes: Claude Code CLI (local, own account), Anthropic API (operator key), OpenAI-compatible (local models or other providers) and manual. Role prompts, schemas and MCP tools are shared | An open-source, potentially commercial product cannot depend solely on a personal subscription login; provider terms restrict offering it to others ([08 §4](08-licensing-and-commercial.md#4-ai-providers-and-terms)) | New SS-AI gateway ([07 §7](07-data-models-and-interfaces.md#7-model-gateway-interface)); existing flags kept in the CLI runtime |
| D7 | Two roles: Edit Director (storyboard) and Edit Agent | Five roles: `story-director`, `researcher`, `edit-agent`, `scene-author`, `visual-critic` | Research, script, Scene Spec authoring and creative QA are distinct jobs with different tools and output schemas | Role registry in the gateway |
| D8 | "Integrate external tools by porting their visual grammar into templates, never by calling their renderers" | **Both** native adaptation and **direct use** are supported. Specialist tools may run as isolated external-tool adapters that return baked media with an invocation manifest; they never own timing outside their clip or write the production | The brief requires direct use where technically appropriate (for example Manim, Earshot); a baked asset does not compete with the timeline | `external-tool` capability kind and SS-TOOLS ([07 §5](07-data-models-and-interfaces.md#5-capability-interface)) |
| D9 | Animated graphics come from templates or model-authored script-free HTML | Adds **Scene Specs**: declarative animated scenes (character rigs and pose tracks, diagrams, charts, illustrations, camera, cues) compiled by a native capability; characters come from an owned **character library** | Stick figures and characters must be authorable by a model and editable by a person, deterministically | SS-GFX character compiler ([04 §5](04-storyboard-and-review.md#5-scene-specs-the-format-for-animated-scenes)) |
| D10 | Image generation stays the existing optional service, for stills | Illustrated scenes use the **same image-service contract**, extended with style and reference inputs. The specification records that the contract must have a **commercially licensed reference model** for public distribution | The current service is private and runs a FLUX.2 Klein variant; only some variants are commercially usable ([E7](../evidence/e7-openmontage-animation.md)) | Contract extension ticket; licence gate in the model registry |
| D11 | Brand style profile covers editing (pacing, captions, B-roll, sound, grade) | Adds illustration and animation style, character design sheets, narration voice, delivery defaults and pronunciation lexicon | Workflow B's identity is mostly voice and illustration | SS-STYLE ([01](01-product-requirements.md#requirements-register) STY-02, STY-03) |
| D12 | QA: technical checks; creative quality by an eval harness, not in-product | Adds in-product **creative QA** (rubric findings by `visual-critic`) and **claim QA** against the research dossier. Both produce timestamped findings the user fixes or waives | Professional quality and trustworthiness (wellness content) need product-level checks, not only offline evaluation | SS-QA ([01](01-product-requirements.md#requirements-register) QAS-02, QAS-03) |
| D13 | Exports: deliverables, SRT, OTIO/FCPXML; project lives in `data/` | Adds the **editable production bundle** (`.cbvideo`) with assets, provenance, capability lock and credits, verified on open | "Editable project preservation" across machines and versions | SS-EXPORT ([07 §9](07-data-models-and-interfaces.md#9-editable-project-bundle)) |
| D14 | Stages: ingest → analyse → rough cut → storyboard → execute → review → QA → render | One **stage machine** for both workflows and hybrids (brief, research, script, ingest, selects, storyboard, production, assembly, review, finishing, delivered, archived) with explicit exit criteria and optional autopilot | Both workflows share the same infrastructure and approval process | [07 §8](07-data-models-and-interfaces.md#8-workflow-state-machine) |
| D15 | Workstreams W0–W11 | Programme WS0–WS19 with validation gates G0–G9 that absorb V1–V8 and add gates for TTS, character animation, local-model viability and sourcing terms | New subsystems | [11](11-implementation-program.md) |
| D16 | Licence notes per tool; GSAP avoided | A **licence policy** for code, model weights, generated assets, sourced media and audio, with dependency and model allow-lists checked in CI and in the model registry | Public distribution and paid services | [08](08-licensing-and-commercial.md) |

## 3. Components not redesigned

The following merged-research designs carry into implementation unchanged, because no new evidence challenges them:

- the time model (integer timeline frames, microsecond source ranges);
- the clip and track types;
- the invariants;
- the compiler output layout;
- render caching and range re-rendering;
- the preview isolation design;
- the job runner lanes;
- the media worker contract;
- the "one tool per responsibility" table, extended in [05](05-capability-matrix.md);
- the decision to keep GSAP out of CreatorBrio output.

## 4. Merged-research statements now superseded

| Merged research | Superseded by |
|---|---|
| [05 §6](../05-proposed-architecture.md#6-creative-capabilities): "External creative projects are therefore integrated by porting their visual grammar into templates, not by calling their renderers" | D8: direct use through external-tool adapters is allowed for baked assets |
| [05 §5](../05-proposed-architecture.md#5-how-claude-edits-safely): two agent roles, both on the Claude Code subscription | D6, D7 |
| [00](../00-executive-decision.md): "Everything runs locally on the user's Claude Code subscription" as the only AI arrangement | D6: the subscription workflow remains for local use; other runtimes are supported |
| [08 Workstreams](../08-implementation-plan.md#workstreams-and-dependency-order) | [11](11-implementation-program.md) |
