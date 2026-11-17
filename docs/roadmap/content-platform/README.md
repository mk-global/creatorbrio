# Future content operations platform

**Status:** PROPOSAL FOR INDEPENDENT REVIEW, not an approved ADR, feature commitment, or implementation authorization.  
**Date:** 2026-11-17  
**Tracking:** [documentation ticket #214](https://github.com/mk-global/creatorbrio/issues/214)  
**Owner of present Video Studio roadmap:** [Video Studio roadmap](../video-studio/README.md)

## Why this exists

CreatorBrio could evolve from a local-first creation studio into a **self-hostable open-source social-content operations product** that accepts a creator's goal and carries a job from documented research, through explicit approvals, to asset production, publishing, and confirmed notifications. The same domain system should later support a managed multi-tenant SaaS and a native mobile client. This is an architectural exploration, not a decision to replace the current product or its roadmap.

### Proposed user outcome

A user enters a topic, objective, audience, brand, intended format, destination accounts, desired schedule, and optional source footage. The system:

1. Researches evidence, competing formats, hooks, audience context and claims, recording provenance and uncertainty. It must not claim it can guarantee virality or rights to reuse competitor footage.
2. Produces a research report, proposed script/storyboard/creative direction, and first **human approval gate**. Revision or rejection remains possible.
3. On approval, creates or assembles a versioned production package, including appropriate video/carousel, captions, cover art, subtitles, metadata and rights manifest. It may also refuse when capabilities or source rights are missing.
4. Displays the exact files and copy to be published for a second **human approval gate**.
5. Freezes a publication manifest, schedules permitted destinations, publishes only the approved version, reconciles ambiguous external outcomes, and sends durable in-app notifications plus optional email/push messages.
6. Records publication IDs, URLs, provider results, cost, and later attributable performance, distinguishing correlation from causation.

The user sees **one product and one end-to-end job**, not three separate products for research, creation and posting.

## What already exists and must remain true

Current-state facts are defined by [the root README](../../../README.md), [architecture overview](../../architecture/README.md), [Video Studio implementation roadmap](../video-studio/README.md), and [Video Production API](../../architecture/video-production-api.md).

- CreatorBrio already supports brand-aware carousel/LinkedIn document/Reel-cover creation and exports.
- Video Studio has a local Production API, file-backed durable production store, media registry and verified render/export paths, with scoped human/agent authority. It is still early, with real-world creative acceptance and advanced AI editing outstanding.
- The present application is local-first, bound to loopback, uses Claude CLI for certain agent flows, and stores data primarily on the filesystem. The current local authentication scheme does **not** provide hosted multi-tenant isolation.
- The existing Video Studio roadmap owns its accepted implementation program, contracts and release gates; this future-platform proposal does not amend, supersede or relabel any of those as complete.
- ContentEngine is retired and **is not a dependency, integration or migration target**.
- An external social publishing automation project may exist for the maintainers; its implementation and terms are **not verified here**. Do not assume it is product-ready, distributable, or licensed for inclusion.

## Reading order

1. [Architecture RFC](ARCHITECTURE-RFC.md): target logical architecture, interfaces, isolation, deployment, failure semantics, technology candidates and decision register.
2. [Outcome-based roadmap](ROADMAP.md): stage gates from technical proof to local OSS, SaaS and mobile.
3. [Independent review brief](ARCHITECTURE-REVIEW.md): challenge questions, evidence requirements, review format and go/no-go criteria.

## Authority and change control

- **Present facts**: merged code and existing architecture/Video Studio documentation win over this proposal.
- **Future platform choices**: this RFC proposes options and criteria; it is not an accepted ADR and does not authorize code changes.
- **Unresolved conflicts**: maintain the present contract until a separately reviewed ADR and migration plan resolve them. Do not silently change the current file store, agent tooling, export or editor contracts.
- **Delivery**: future implementation requires open issues and normal independent review, per [maintaining guide](../../MAINTAINING.md).
- **Licensing**: preserve the current MIT license and provenance; review dependencies, provider terms, asset rights and distribution model before promising any hosted or plug-in functionality.
