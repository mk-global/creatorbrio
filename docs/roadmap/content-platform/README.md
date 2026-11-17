# Content automation platform

**Status:** Revision 2, reconciled under [#216](https://github.com/mk-global/creatorbrio/issues/216).
Founder decisions FD-A to FD-E are ACCEPTED product requirements; the architecture, migration and sequence are PROPOSED until accepted in the [decision register](DECISION-REGISTER.md).
Nothing here authorizes implementation by itself; each milestone needs its own admitted issues.

**Date:** 2026-11-17.

**Present-day authority:** the [root README](../../../README.md), the [architecture documentation](../../architecture/README.md) and the [Video Studio roadmap](../video-studio/README.md).

## What this is

CreatorBrio is becoming one AI-powered social content automation product.
A person gives an idea, objective, topic, source video or prompt; CreatorBrio researches it, proposes directions, hooks, scripts, covers, captions and a production plan; the person approves the research; CreatorBrio produces the content; the person approves the exact publishing package; CreatorBrio schedules or publishes it and reports the result.
It stays local-first and open source, and later serves a hosted edition and mobile clients from the same domain and API.

## Reading order

1. [ARCHITECTURE-RFC.md](ARCHITECTURE-RFC.md): the target architecture, module boundaries, domain model, execution model, threat model, portability and commercial model.
2. [ROADMAP.md](ROADMAP.md): the phases from today's product, and the first milestone with its acceptance criteria.
3. [SOCIAL-AUTOMATION-MIGRATION.md](SOCIAL-AUTOMATION-MIGRATION.md): how the existing publisher moves into this repository without a second domain, approval system or scheduler.
4. [DECISION-REGISTER.md](DECISION-REGISTER.md): every decision with its status, including the resolution or status of each finding of the independent review (some remain open), and the questions only the founder can answer.
5. [OSS-RESEARCH.md](OSS-RESEARCH.md): the open-source and platform research behind each technology decision.
6. Reviews:
   - [2026-11-17 independent review of PR #215](reviews/2026-11-17-pr215-independent-review.md), preserved verbatim;
   - [2026-11-17 adversarial self-review of this revision](reviews/2026-11-17-reconciliation-self-review.md).
7. [ARCHITECTURE-REVIEW.md](ARCHITECTURE-REVIEW.md): the brief that commissioned the independent review, kept as a record.

## What changed from the proposal merged in #215

- The product boundary is decided by the founder: one product, one repository (FD-A, FD-B).
- The duplicate domain entities are gone; carousels and Production v2 stay authoritative, with one shared research and approval contract.
- The Social Automation publisher, assessed read-only, supplies the publishing domain: its fingerprinted package is the frozen publication manifest and its runner is the one publication scheduler.
- The workflow engine, PostgreSQL, tenancy, outbox and mobile client move to the stages that need them; the local product uses domain state and durable jobs.
- Agent containment is the first milestone, because a process running as the person's operating-system user, today's Design Agent with its shell included, can read every local secret (see the [Production API documentation](../../architecture/video-production-api.md#what-this-does-and-does-not-protect-against)), and it is a precondition for integrating publishing.
- Self-hosted publishing is bring-your-own-app by founder decision (FD-D), replacing the review's open question on publishing distribution.

## Authority and change control

- Present facts: merged code and the architecture documentation win over these documents.
- Accepted Video Studio decisions are not amended here; the [RFC](ARCHITECTURE-RFC.md#13-required-amendments-to-accepted-documents-each-its-own-governed-change) lists the amendments that need their own governed change.
- Licensing: CreatorBrio stays MIT with its provenance; imported code needs its author's licence decision first.
- ContentEngine is retired and is not a dependency or migration source.
