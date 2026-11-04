# CreatorBrio Video Studio: product specification

**Status:** proposed for founder approval (gate G0). Once approved, this specification is the authoritative product contract for Video Studio.
**Ticket:** [mk-global/creatorbrio#66](https://github.com/mk-global/creatorbrio/issues/66) · **Date:** 2026-11-04
**Builds on:** the merged architecture research ([index](../README.md), [mk-global/creatorbrio#64](https://github.com/mk-global/creatorbrio/pull/64)). Where they differ, this specification governs; every difference is listed in [09](09-differences-from-pr64.md).

> Documentation only. Nothing here is implemented.

## In one paragraph

CreatorBrio Video Studio supports two complete production workflows on one editorial infrastructure:

- **Raw footage to an edited video** ([02](02-workflow-a-footage.md)).
- **A script or topic to an animated video** with local narration, characters, diagrams and illustrated scenes ([03](03-workflow-b-script-animation.md)).

Both flow through the same versioned **production document**: brief, research, script, **storyboard with per-scene approval**, and **one authoritative timeline**.
Every change is a typed, reversible operation.
Every asset carries provenance and rights checked against the production's usage intent.
Everything renders through HyperFrames and FFmpeg.
AI roles run through a **provider-agnostic model gateway**: the creator's own Claude Code CLI for local use, an API key, a local OpenAI-compatible model, or no model at all.

## Documents

| # | Document | Answers |
|---|---|---|
| 01 | [Product requirements](01-product-requirements.md) | What Video Studio is; users; principles; scope; non-functional requirements; **requirements register** (113 requirements, each with owner, technology candidate, dependencies, acceptance tests and workstream) |
| 02 | [Workflow A: footage to video](02-workflow-a-footage.md) | Stages, inputs, outputs, judgments, exit criteria, failure handling |
| 03 | [Workflow B: script to animation](03-workflow-b-script-animation.md) | The same for scripts and topics; timing without footage; hybrid productions |
| 04 | [Storyboard and editorial review](04-storyboard-and-review.md) | Scene schema, scene lifecycle, frames and animatic, Scene Specs for animation, materialisation into the timeline, comments, targeted revisions, versions |
| 05 | [Capability and tool matrix](05-capability-matrix.md) | Every specialist tool's use mode (dependency, direct, native, reference, excluded) and every capability's technology |
| 06 | [Architecture](06-architecture.md) | The complete editorial pipeline; subsystems and ownership; runtime components; capability routing; audio architecture; security |
| 07 | [Data models and interfaces](07-data-models-and-interfaces.md) | Production document, brief/research/script, speech spine, asset and rights ledger, media formats, capability interface, operations, model gateway, stage machine, project bundle, subsystem interfaces |
| 08 | [Licensing and commercialisation](08-licensing-and-commercial.md) | Constraints on code, model weights, generated assets, sourced media and audio; AI provider terms; decisions for the founder |
| 09 | [Differences from the merged research](09-differences-from-pr64.md) | What stays, what changes (D1–D16) and why |
| 10 | [Acceptance tests](10-acceptance-tests.md) | 31 tests on real talking-head footage and script-generated animation, plus cross-cutting tests |
| 11 | [Implementation programme](11-implementation-program.md) | Validation gates G0–G9, workstreams WS0–WS19 in dependency order, requirements by workstream, the first engineering task |

New evidence gathered for this specification:

- [E7 · OpenMontage, character animation and local image models](../evidence/e7-openmontage-animation.md)
- [E8 · Local TTS, media-sourcing API terms and AI provider terms](../evidence/e8-tts-sourcing-providers.md)

## Traceability

Every requirement ID appears in four places:

- the register in [01](01-product-requirements.md#6-requirements-register);
- the capability matrix in [05](05-capability-matrix.md);
- exactly one workstream in [11 §3](11-implementation-program.md#3-requirements-by-workstream);
- at least one acceptance test in [10](10-acceptance-tests.md), whose "Requirements verified" lines are generated from the register.

These cross-references were checked mechanically when this specification was written.
