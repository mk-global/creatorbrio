# ADR: CreatorBrio Video Studio architecture and delivery model

**Status:** Accepted at product architecture level, conditional component qualifications.  
**Date:** 2026-11-04  
**Issue:** [#68](https://github.com/mk-global/creatorbrio/issues/68)  
**Evidence:** [research PR #64](https://github.com/mk-global/creatorbrio/pull/64), [product spec PR #67](https://github.com/mk-global/creatorbrio/pull/67), [implementation roadmap](../roadmap/video-studio/README.md).

## Context

CreatorBrio is an open-source, potentially commercially offered creative studio. Video Studio must complete two product workflows with independent release gates: (A) raw footage into a professionally edited, editable video, and (B) topic/script into a narrated, animated, editable video. Both have research, scene-level visual storyboard, asset discovery and license checking, editing, sound, review and export.

A third workflow combines A-roll and generated animation in one production. The aim is *reuse underlying mature open source technology while retaining full ownership of the product and ability to customize it*. A single vendor editor, proprietary project format or personal subscription login must not define all future product behavior.

## Decision

1. **Own the production contract and editing operations.** CreatorBrio stores a versioned Production v2 document with project brief, sources, script, storyboard/scene materialisation, one canonical timeline, voices, asset records, approvals and review. Integer-frame timeline timing and microsecond source ranges, immutable originals, atomic typed changes and revision history.
2. **Storyboard is first-class, not a static planning document.** Scene cards, real rendered frames, asset slots, storyboard-to-timeline provenance and target-scoped approval/regeneration. Both production workflows use the same storyboard and master timeline.
3. **One renderer, behind a replaceable compiler adapter.** HyperFrames producer/player and FFmpeg are provisional preferred choices. G1 on founder's M5 Max is required before deep renderer integration. If it fails, test OpenFilm's renderer against the same contract. Never silently run two competing renderers for the authoritative timeline.
4. **Reuse editor UI foundations.** Evaluate embeddable timeline components in G7. Own the product interface, word/take controls, scene review and manual editing semantics, but do not rebuild a full low-level video UI without compelling validation.
5. **Creative capability registry.** Native editable vector/HTML/SVG effects and isolated specialist tool outputs (Manim, Earshot, OpenFilm pieces, other licensed tools) each yield well-defined assets and timeline operations. Do not copy copyleft/noncommercial source into the MIT core.
6. **Local AI and image providers are replaceable.** Existing Claude Code CLI and image-service contract are first implementations; runtime roles use provider-neutral interfaces. Public deployment includes a manual-capable mode and commercial-safe reference models. No intermediary reuse of customers' personal subscription credentials.
7. **Audio spine unifies workflows.** A-roll recorded audio or AI narration supplies word timing for cuts, captions, sound cues and ducking. Separate model processing from editorial judgment; preserve original voice and control gain changes explicitly.
8. **Media provenance and rights by design.** Each asset/model has source, usage rights and consent data. Commercial-safe default, explicit opting in to restricted connectors and separate legal qualification prior to paid service.
9. **Deliver in two releasable milestones without changing shared infrastructure.** Shared Core enables camera, script-only and hybrid projects. Edit Studio must be complete before its release, without waiting for Create-only character/TTS tests. Create Studio later adds commercial-safe TTS, illustration consistency, cartoon motion and long-form animation. Both remain in one repository.
10. **No speculative scale.** Next.js localhost, file-backed jobs, Python/Swift local workers, render worker, guarded APIs and current brand storage. Future hosted billing/auth is a separate decision after the core has real users.

## Why

This preserves full customization and open-source/paid-product options while avoiding codec, video-compositor, transcription and foundational UI reinvention. The dual workflow shares most costly foundation work, yet each product can be accepted and shipped separately. Ownership of the production document lets rendering/ML providers evolve without invalidating user projects.

## Consequences and qualifications

- We must implement nontrivial domain code: editing operations, storyboard UX, creative capabilities, provenance, automation rules and QA. This is product-specific value rather than a redundant media engine.
- The renderer, preview security, Mac codecs, AI model licenses and character rig quality require G1–G9 measured qualification. A preferred vendor listed here is **not** a validated runtime choice.
- Edit Studio's audio/source/graphics capabilities must not be blocked by Create Studio voice cloning or animated character work. Workstreams WS12/WS18 have cross-release child tickets #106–#109.
- The current local image service is implemented; additional style/reference/character-consistency features and public model distribution are **proposed**, not shipped.
- The future hosted paid offering requires terms-compatible inference, rights and cost controls, but implementation may proceed now using current local CLI and commercially safe model contracts.

## Alternatives rejected

- Fork a complete editor and make its UI or HTML representation authoritative: fast initial demo, less flexibility, uncertain legal/maintenance behavior.
- Build FFmpeg/codecs or entire animation compositor/timeline UI from primitives: excessive time and divergence.
- Two independent video products/repos: duplicated core, unclear hybrid editing and extra integration burden.
- Block first editing release until all character-generation and narrated-animation work is complete: unnecessary dependency.
- Ship a basic clipper as the complete editing product: fails stated quality/functionality acceptance.

## Verification and change control

All production requirements and acceptance tests remain in [spec/](../research/video-studio/spec/README.md). Changes to this ADR require a linked governance ticket, documented technical evidence, full CI and independent PR review. Failed validation gates may trigger an ADR amendment; they do not authorize unrelated redesign or speculative infrastructure.
