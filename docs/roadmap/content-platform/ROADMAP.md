# Proposed roadmap: local → open-source → hosted → mobile

**Status:** proposal; not an accepted execution backlog. **Date:** 2026-11-17. See [architecture RFC](ARCHITECTURE-RFC.md), [review brief](ARCHITECTURE-REVIEW.md), and [current Video Studio plan](../video-studio/README.md).

## Roadmap principles

- One useful product outcome and evidence-backed gate at a time; no promise to make every channel or video modality work immediately.
- Current CreatorBrio Video Studio workstreams keep their existing ownership and acceptance criteria. This roadmap is **not** a replacement or scheduled engineering program.
- Keep clean boundaries for API, tenant-owned objects, durable workflows and sandboxed execution; implement only the infrastructure required for the next verified outcome.
- Reuse existing canonical production model, content-addressed media, export and security guarantees. Do not create a duplicate editor, renderer or research pipeline without a recorded decision.
- No ticket, no implementation. A passing architecture review is not a substitute for technical evidence or founder approval.

## Outcome 0: architecture reconciliation and proofs

**User impact:** prevents investing in a structurally incompatible app before creating new functionality.

**Work:** inventory merged CreatorBrio capabilities, current video program and external publishing tools (only after verifying their code/licenses); validate product boundary: evolution inside CreatorBrio vs a reusable separate workflow platform. Define the end-to-end domain model, authority/approval state machine, API contract, threat model, local-hosted deployment parity and migration strategy. Run a narrow workflow engine comparison (Hatchet, Temporal, Trigger.dev or simpler equivalent), isolate media execution proof, and assess initial publication provider constraints.

**Exit gate:** reviewed architecture with explicit accepted/rejected ADRs and evidence for restart-safe human waits, retries, identity/tenant scope, and one publication API. A list of unresolved decisions with owners is acceptable; falsely claiming proof is not. No application feature implementation is authorized by this document.

## Outcome 1: one complete local content job

**User impact:** enter an idea and get an actual research report, review/approve it, receive an assembled artifact, approve that exact version, and schedule/publish to one supported destination, with verified status.

**Scope:** one brand; one content format; one fully supported destination; one provider configuration; structured research sources; revision/refusal; immutable manifest; reproducible execution events; creator-visible outputs; local recovery; failure-safe publishing and durable notifications.

**Exit gate:** demonstrated end-to-end on representative real content, forced crash during approval and render, duplicate approval submission, publish timeout reconciliation, and creator acceptance. Metrics recorded: manual interventions, quality acceptance, run time/cost, failure/retry counts.

**Exclusions:** arbitrary model provider marketplace, every social account, full text-to-video generation, generalized user-authored code and SaaS billing.

## Outcome 2: self-hostable open-source distribution

**User impact:** an unrelated developer can install, run, update and back up the product without the founder's credentials or machine layout.

**Scope:** documented reproducible local installer (e.g. container profile), sample workflows, BYOK / approved local model options, secure account connection, brand configuration, access controls, privacy/telemetry disclosures, provider compatibility, backup/restore and clean upgrade path. License, third-party provenance and asset rights review.

**Exit gate:** fresh-machine test by an independent contributor, successful restore and version upgrade, no hidden developer-specific credentials or paths, full documented costs/prerequisites. Reasonable local setup should not require managed cloud services. Persistent scheduling requires an always-on host or verified native provider schedule.

## Outcome 3: hosted multi-tenant SaaS

**User impact:** users sign up, connect providers and channels securely, and run workflows without maintaining servers.

**Scope:** protected identity and workspace membership, cross-tenant isolation across SQL/blob/workflow/secret/log boundaries, quotas and budgets, account lifecycle, provider credential rotation, usage ledger, payments, operational dashboards, backup/restore, incident response, compliance/privacy/data retention, sandboxed workers, and abuse controls.

**Exit gate:** automated cross-tenant attack suite and threat model reviewed, load/cost and capacity tests under concurrent media jobs, chaos/DR restoration, documented support/runbooks and provider contract/legal verification. No SaaS launch on the strength of a single local demo.

## Outcome 4: native mobile companion

**User impact:** approvals, research summaries, content previews, schedule management and status notifications on phone.

**Scope:** Expo/React Native client over the same versioned API; push, notification inbox, secure auth, media preview, deep links and limited offline cache where appropriate. Mobile video editing is a separate business case.

**Exit gate:** same authorization and review semantics as web, no mobile-only domain duplication, push fallback/receipt handling, tested platform lifecycle and accessibility.

## Outcome 5: breadth, integrations and measured scale

Only after previous outcomes earn expansion: additional platforms and media formats, agency collaboration, workflow recipe marketplace, selectively supported plug-in SDK, analytics attribution and learning loops, optional enterprise isolation. Split execution services or repositories only when independent release/scale/security evidence warrants it.

## Cross-cutting engineering gates

| Concern | Minimum evidence |
|---|---|
| Editorial/creative quality | Human acceptance on real examples, source/rights traceability, refusal when not possible |
| Reliability | Restart and at-least-once replay, correct approval reentry, no duplicated external posts |
| Security | Threat model, attack tests, least privilege, tenant boundary including workers and signed asset URLs |
| Cost | Per-run usage ledger, budgets and limits; no unbounded runaway AI/media job |
| Portability | Same domain/API/workflow contract for local/hosted/mobile; explicit migration/backup path |
| Operations | Structured trace correlation, runbook, recoverable failure states, redaction, upgrades |
| Licensing | MIT provenance intact; external code, model and content rights verified per distribution |

## Metrics to observe, not promises

- Research acceptance without rewriting; first-pass production acceptance; percentage of runs requiring manual rescue.
- Mean and p95 end-to-end duration split by stage and human waits.
- AI/media cost per publishable artifact; cancellation and refusal rates.
- Publication confirmation rate and reconciliation time for unknown external outcomes.
- Worker retry count, dead-letter/blocked jobs and corruption incidents.
- Cross-tenant authorization test coverage and reported security incidents.
- Self-host install/upgrade/restore success and support tickets per install.
- Eventually, retention, active workspaces, conversion and contribution margin for SaaS.

## Dependencies and sequencing notes

Outcome 0 must decide whether this roadmap should ultimately stay in CreatorBrio or become a separate independently distributed orchestration project. That is **open**. The current Video Studio implementation roadmap continues independently; do not delay existing approved work merely because the speculative platform RFC exists. Outcome 4 can begin earlier than full SaaS if a reachable and secured API is justified, but do not imply that native mobile hosting is free.

## Next action

Give the [independent architecture review brief](ARCHITECTURE-REVIEW.md) to a separate Claude session with repository read access. Ask for an evidence-backed verdict and proposed document changes only. Founder reviews any recommendation to accept ADRs, alter product ownership, or schedule implementation.
