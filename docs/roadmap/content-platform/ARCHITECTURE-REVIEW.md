# Independent architecture review brief

**Status:** completed record.
This brief commissioned the independent review of the proposal merged in PR #215.
The review was delivered on 2026-11-17 and is [preserved verbatim](reviews/2026-11-17-pr215-independent-review.md); each finding has a recorded resolution or status in the [decision register](DECISION-REGISTER.md), and some remain open.
The brief is kept unchanged below as the record of what the reviewer was asked to do.

**Original date:** 2026-11-17.

**Scope:** independently challenge the [future platform RFC](ARCHITECTURE-RFC.md) and [roadmap](ROADMAP.md) against the current CreatorBrio repository. The point is to find bad assumptions, not rubber-stamp a desired result.

## Review mandate

Act as an independent staff/principal engineer specializing in content platforms, agent workflows, secure self-hosted products, creator tooling, and multi-tenant SaaS. You have no stake in our previous architectural preferences. Prefer falsifiable evidence, source code and documented constraints over agreement. State exactly what you inspected and what you could not verify.

1. **Start from reality**: read `README.md`, `CLAUDE.md`, `docs/MAINTAINING.md`, `docs/PROVENANCE.md`, `LICENSE`, `docs/architecture/README.md`, Video Studio ADR and Production v2/API/store/media/render documents, `docs/roadmap/video-studio/README.md`, current product code/tests and relevant open issues. Verify current implementation rather than assuming narrative status is fresh.
2. **Challenge the product boundary**: should end-to-end orchestration live inside CreatorBrio, or should CreatorBrio be one independent creative tool called by a separate platform? Evaluate UX cohesion, repo ownership, standalone open-source distribution, licensing/provenance, migration cost, public contributions and avoiding a second renderer. Explicitly consider whether the proposed platform has a differentiated product outcome vs orchestration frameworks.
3. **Challenge the architecture**: one modular monorepo vs separate repos, API process vs Next.js route handlers, workflow state vs domain state, Hatchet vs Temporal vs Trigger.dev vs small custom jobs, provider abstractions, durable approval semantics, publishing reconciliation, threat boundaries, media sandboxing, tenant isolation, encrypted secret management, and mobile client reuse.
4. **Verify deployability**: one-machine local setup, service dependencies, data backup/restore, existing Video Studio journals and file paths, safe path from local auth/loopback to internet-facing multi-tenant auth, and practical limits of "minimal changes." Identify incompatible invariants and required migrations; do not propose silently exposing current loopback-only routes.
5. **Validate the user journey**: actual research provenance and rights, script/storyboard quality, media-generation feasibility and costs, approval UX, platform capability constraints (OAuth, schedules, covers, API rate limits) and mobile notifications. Avoid vague claims of hands-free viral output.
6. **Perform adversarial review**: external-content prompt injection, SSRF, upload/FFmpeg/Chromium abuse, cross-tenant SQL/blob/queue/log leaks, privilege escalation by agents, duplicate publishing after partial failure, race conditions, model output schema failures, resource exhaustion, and compromised plug-ins.
7. **Audit licensing/business assumptions**: MIT inherited provenance, distribution of third-party components, bundled models, provider contracts, creator asset rights, managed-cloud differentiators, support burden, and self-hosting privacy.
8. **Check roadmap realism**: the smallest *real* end-to-end slice, dependency sequencing, tests, gates, measurable user outcomes, and how to avoid premature framework and infrastructure work.

## Required deliverable

Return a compact but rigorous report with:

- **Verdict**: APPROVE / APPROVE WITH REQUIRED CHANGES / REJECT, with distinction between architectural direction and readiness to implement.
- **Evidence inventory**: concrete repo files, functions, tests, GitHub issues/PRs, and externally documented technical facts for every consequential assertion. Clearly label assumptions and gaps. No fabricated test results.
- **Prioritized findings**: P0 security/data loss/architectural blockers, P1 important defects, P2 optional improvements. For each give risk, triggering scenario, evidence, preferred correction, alternatives/trade-offs, and verification method.
- **Architecture comparison**: at least three credible boundaries (evolve CreatorBrio directly, separate orchestration product, hybrid with CreatorBrio as a capability) and an explicit winner justified against local OSS / SaaS / mobile.
- **Workflow engine decision matrix**: self-hosting and SaaS parity, human waits, crash recovery, lifecycle/version changes, license, resource requirements, testability, security and operational complexity. Recommend **proof**, not an unfounded vendor declaration.
- **Proposed changes to RFC / roadmap**: exact document paths and section-level edits, clearly identify accepted vs tentative ADRs. Explain impact on existing Video Studio roadmap; never revise it implicitly.
- **Acceptance plan**: minimal failure-injection and adversarial technical proofs with objective pass/fail conditions before code implementation or public commitments.
- **Decision requests**: only those issues that require founder choice and cannot be resolved through research. Provide a recommended default for each.

## Rules

Read-only review by default. Do NOT modify production code, docs, GitHub issues/PRs, CI, branch protection, or dependencies. Do NOT create an implementation backlog or merge anything. No authorization to restructure CreatorBrio. No claims of a security-qualified architecture based only on diagrams. Preserve current MIT attribution and repository governance. ContentEngine is retired and out of scope. The documents being audited are **proposed**, not decisions.

If using web research, cite provider documentation and identify version/date where it could have changed. If an external social automation repository is unavailable or its license unclear, mark it **unverified** rather than assuming it can be copied.

The final answer should explicitly say whether the roadmap should remain inside CreatorBrio or become an independent product, and how current Video Studio should participate without duplicating work.
