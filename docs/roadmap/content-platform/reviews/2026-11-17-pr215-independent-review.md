<!--
Preserved record.
The text below the line is the independent review of PR #215 exactly as delivered on 2026-11-17, unedited.
It is a historical record, not current guidance.
Each finding has a recorded resolution or status in the decision register (../DECISION-REGISTER.md) under issue #216, and some remain open; where later founder decisions superseded findings (notably P0-4, F2 and F7, and the statement that the external publishing project was unverified), the register records that.
-->

> **Preserved record (issue #216).**
> This is the independent review of PR #215, kept verbatim as delivered on 2026-11-17.
> It is not current guidance: each finding's recorded resolution or status, including those superseded by later founder decisions and those still open, is in the [decision register](../DECISION-REGISTER.md).

---

# Independent architecture review: PR #215, future content operations platform

**Reviewed:** PR #215 head `33171bf`, built on `origin/main` as fetched on 2026-11-17.
The PR was squash-merged during the review as `20542ee`; the merged tree is identical to the reviewed head, so every finding applies to the documents on `main`.
**Reviewer stance:** independent, adversarial, read-only.
No code, documentation, issue or PR was modified.

## 0. Evidence basis

### Inspected

Read in full:
- All five PR #215 documents and the PR body. CI and both independent-reviewer checks passed; the PR had no comments or reviews.
- `CLAUDE.md`, `LICENSE`, `docs/architecture/README.md`, `adr-creatorbrio-video-studio.md`, `design-decisions.md`, `video-production-store.md`, `video-production-api.md`, the "Render jobs" section of `video-rendering.md`.
- `src/types/carousel.ts` (the `Carousel` type), `src/proxy.ts`, the Design Agent argument builder in `src/lib/design-agent.ts`, `src/app/uploads/[...path]/route.ts`.

Searched or read in part:
- `docs/PROVENANCE.md` (licence section), `docs/MAINTAINING.md` (governance), `creative-workflow.md` (source retrieval), `design-agent.md` (inherited configuration), the rest of `video-rendering.md` (workers).
- `docs/roadmap/video-studio/README.md` (status, gates, decisions, execution rules), `spec/11-implementation-program.md` (workstream table), `spec/08-licensing-and-commercial.md` (licence classes, Anthropic terms, paid-service readiness).
- `src/types/production.ts` (stages, research, approvals), the spawn sites in `src/app/api/chat/route.ts` and `src/lib/visual-director.ts`, the header and boundary of `src/lib/source-retrieval.ts`, authority wiring in `src/lib/video/production/api/`, dependency manifest, route inventory, filesystem-root call sites, Server Action directives.
- GitHub: all open issues by title; bodies of #184, #186, #213, #214; current state of #213 (open) and #214 (closed by the merge).
- External technical and terms facts, gathered by a separate research pass with citations (section 12).

### Not inspected or not verified

- No test was run. Test-backed claims below (for example the production store's 72 crash points) are as documented in the repository, not re-executed.
- `spec/01`, `spec/06`, `spec/07` and `spec/10` were searched, not read in full; `video-media-registry.md` was not opened.
- The maintainers' external social publishing automation project: not available to this review and therefore **unverified**, as the RFC itself says.
- Whether Claude Code's WebFetch tool fetches from the user's machine or from Anthropic's infrastructure was not verified; finding P0-2 does not depend on it.
- Local `main` in the reviewer's checkout was 59 commits behind `origin/main` (pre-rename Framewoven state). All repository statements here are from `origin/main` plus the PR head, not from that stale checkout.

## 1. Verdict

**Architectural direction: APPROVE WITH REQUIRED CHANGES.**
Keep the product inside CreatorBrio as one product in one repository, use an API-first modular monolith, keep domain authority separate from execution, and keep frozen-manifest publishing with explicit unknown-outcome reconciliation.
Those principles are sound.

**Readiness to implement, and the RFC and roadmap as written: REJECT.**
The documents describe a second platform beside the one already accepted, rather than an extension of it.
They duplicate the accepted Video Studio domain and workstreams, contradict an accepted ADR without amending it, schedule local credentialed publishing next to an agent that has an unrestricted shell, and assume a self-hosted publishing model that social platform policies make impractical for ordinary users.
They also put platform infrastructure ahead of evidence that creators want the outcome and that its quality and cost are acceptable.

The required changes are substantial but mostly subtractive.
A revised RFC is a smaller document than the current one.

## 2. The five things that matter most

1. **There is already a platform domain model, and the RFC does not use it.**
   Production v2 already has a stage machine from brief through research and review to delivery, a research dossier with hashed sources and claim statuses, approvals bound to a revision, platform targets and deliverables.
   The RFC proposes a parallel set of entities for the same concepts.
2. **Local publishing is currently unsafe by construction.**
   The carousel Design Agent runs with an unrestricted shell and web fetch, as the same OS user, from the repository root, with the app's environment and the operator's personal Claude settings.
   The repository's own security documentation says such a process can read every local secret.
   Any publishing token stored locally would be readable by a prompt-injectable agent.
3. **Self-hosted publishing needs a developer app per installation, and Instagram needs public media.**
   An open-source project cannot ship app credentials, so every self-hosted installation registers its own developer apps; formal review is needed mainly for serving other people's accounts, and LinkedIn member posting is self-serve (section 12).
   Instagram fetches images from a public URL, which conflicts with the loopback-only security model.
   Whether this is practical for non-developer creators is a product judgment for the founder (F2), informed by proof T5.
4. **The roadmap builds the platform before validating the outcome.**
   Video Studio has been verified with synthetic media only and has no AI-assisted editing.
   The only AI-produced format today is the carousel; the one measured eight-slide run was estimated at USD 4.24 at list price, under inherited personal agent settings.
   PostgreSQL, a workflow engine, workspace tenancy, notifications and mobile are proposed before a single creator has approved and published one researched piece.
5. **"API-first" is already true for routes; the real rework is identity and asset access.**
   Every capability is already a route handler (46 routes, no Server Actions).
   What blocks SaaS and mobile is that the codebase has three different authority models, imports media by absolute path, serves uploads without authentication, and embeds storage paths in carousel slide HTML.
   The RFC does not inventory any of this.

## 3. Findings

Severity: **P0** stays wrong even if every proof the RFC defers passes, or blocks acceptance; **P1** important defect that will cause rework or risk if not corrected before the related stage; **P2** improvement.

### P0-1: The RFC defines a second domain model beside Production v2

**Problem.**
RFC §5 proposes `ContentProject`, `ResearchReportVersion`, `SourceEvidence`, `CreativeBriefVersion`, `ReviewRequest` and `ApprovalDecision`, and RFC §4 proposes a lifecycle (`draft → researching → … → published`).
None of these reference the existing Production v2 document beyond the word "Production".

**Evidence.**
- `src/types/production.ts`: `PRODUCTION_STAGES` (brief, research, script, ingest, selects, storyboard, production, assembly, review, finishing, delivered, archived); `ResearchDossier` with `sources` (retrieval time, SHA-256 of extracted text, reliability) and `claims` with `supported | unsupported | disputed | user-asserted`; `Approval { by, at, revision, scope: "plan" | "realization" }`; `PLATFORMS` including Instagram Reel, TikTok, YouTube Short and LinkedIn; `deliverables`; `usageIntent`.
- `spec/11` assigns these to accepted workstreams: WS1 "stage machine, approvals", WS3 rights, WS5 job runner, WS8 provider gateway with CLI, API and manual runtimes, WS9 "research dossier and claims", WS10 review model.
- The Video Studio ADR §1 already decides "CreatorBrio stores a versioned Production v2 document with project brief, sources, script, storyboard, … approvals and review".
- The RFC's own roadmap principle says "Reuse existing canonical production model … Do not create a duplicate editor, renderer or research pipeline without a recorded decision"; RFC §5 then defines the duplicate entities without such a decision.
- Carousels, the format the platform could validate first, share none of this: `src/types/carousel.ts` has a `creativeBrief`, `caption` and `hashtags`, but no stage, research dossier, approval or document revision.
- Production v2's own approvals exist only on storyboard scenes, and the Production API lists "stage-exit approvals" as not built.

**Why it is P0.**
Publishing safety depends on one unambiguous answer to "was this exact artifact approved, by whom, at which revision?"
Two approval models give two answers.
Every later proof (approval reentry, manifest freezing, reconciliation) would be tested against a model that the creative engine does not use.

**Correction.**
Production v2 stays the content authority for video, and the carousel record for carousels.
Make Production v2's `ResearchDossier`, `Claim` and `Approval` the single canonical definitions by lifting them into a shared module (owned by WS1 and WS9) that both content kinds use; carousels gain them as additive optional fields, so existing data stays valid.
Extend `Approval` with an approver principal and a `publication` scope whose subject is a `PublicationManifest` hash.
That manifest names artifact hashes: the render `manifest.json` hashes for video, and the exported file hashes for a carousel, which has no document revision to bind to.
Build the missing stage-exit approvals once, in the shared module, rather than separately for the platform.
The platform then adds only what genuinely does not exist: `ConnectedAccount`, `PublicationManifest`, `PublicationAttempt`, `ExternalPublicationRecord`, `ScheduledAction`, `Notification`, and later `Workspace` and `Member`.
Map the RFC lifecycle onto `ProductionStage` (and a minimal carousel equivalent) plus one separate publication lifecycle, instead of a competing project state machine.

**Product impact.**
Avoids building research, approval and rights twice, and keeps the platform work on the critical path of the product that already exists.

### P0-2: Local credentialed publishing would sit inside the Design Agent's trust domain

**Problem.**
RFC §7 says the publisher has "no research tools or general shell access", and Outcome 1 schedules local publishing.
In local mode every component runs as the same OS user, and an existing agent already has an unrestricted shell and web access.

**Evidence.**
- `src/lib/design-agent.ts` grants `Bash`, `WebFetch` and `Read` without command restrictions.
- `src/app/api/chat/route.ts` spawns it with `cwd: process.cwd()` (the repository root) and the inherited environment; `src/lib/visual-director.ts` passes `env: process.env` explicitly. Next.js loads `.env.local` into that environment, which is where CreatorBrio's operator configuration lives.
- `docs/architecture/design-agent.md` ("Configuration it inherits") and issue #186: it loads the operator's personal Claude Code settings, plugins and instructions.
- `docs/architecture/video-production-api.md`, "Not protected": "a process running with arbitrary execution as the same operating-system user can read every local secret … That includes today's carousel Design Agent, which has Bash."
- `docs/architecture/design-decisions.md` limitation: tool restrictions are "Claude CLI policy, not operating-system isolation".

**Triggering scenario.**
A user asks for a carousel about a topic and links a page, or the agent fetches one itself.
The page carries instructions to read a token file or environment variable and call a provider API.
The agent has the shell to do it, and the publish happens outside any approval gate.

**Why it is P0.**
This holds regardless of which workflow engine, database or worker topology is chosen, because local mode colocates everything.
The consequence is an unapproved public post on a real account, which is the single outcome the RFC's human-approval design exists to prevent.

**Correction (prerequisite to any credential being stored).**
1. Bring the carousel Design Agent under the agent model Video Studio already specifies: run-scoped token, typed tools (MCP or equivalent) over the API, no shell and no access to `data/` (`video-production-api.md` cites spec 06 §9). This is WS8 and G8 work, plus #156 and #186.
2. Remove agent-side web fetching from any run whose output can reach publishing. Research goes through `src/lib/source-retrieval.ts`, which already pins DNS, accepts only public unicast addresses and validates every redirect hop.
3. Run the publisher as a separate process whose credentials live in the OS keychain (local) or a KMS-backed secret service (hosted), never in `data/` or the app's environment.
4. Prove it with an injection test (section 9, T1).
If step 1 is rejected for quality reasons, the alternative is OS-account separation for the agent, which is a much heavier setup for self-hosters.

**Product impact.**
Turns "publishing" from the riskiest feature into a defensible one; the cost is a possible change in Design Agent quality, which must be measured with the existing acceptance harness and approved by the founder (section 11, F5).

### P0-3: The RFC contradicts accepted decisions without amending them, and builds platform before outcome

**Problem.**
RFC §2 and §11 propose PostgreSQL, an S3 abstraction, a durable workflow engine, workspace tenancy "from the start", OpenAPI clients, an outbox and notification channels.
Outcome 1 bundles research, two approval gates, production, scheduling, publishing, reconciliation and notifications into the first slice.

**Evidence.**
- Video Studio ADR item 10: "No speculative scale. Next.js localhost, file-backed jobs … Future hosted billing/auth is a separate decision after the core has real users."
- `design-decisions.md`, "Local JSON storage stays": "A database, queue or workflow engine would add installation and operational weight with no benefit at this scale."
- Video Studio roadmap, current status: "verified with synthetic media only; creative acceptance on real footage is pending. No AI-assisted video editing exists yet." The roadmap closes with "No paid tier, separate editing repository or infrastructure platform is authorized by this roadmap."
- RFC §14 and the roadmap README both state the proposal "does not amend or supersede" existing decisions, while proposing exactly what those decisions exclude.
- The RFC's own roadmap principle says "implement only the infrastructure required for the next verified outcome", yet Outcome 0 already requires "identity/tenant scope" evidence and a workflow-engine comparison, and Outcome 1's scope includes scheduling, publishing and durable notifications before any creator has accepted a researched piece.

**Why it is P0.**
The RFC cannot be accepted while it conflicts with an accepted ADR; and its first outcome cannot be validated because its success depends on creative capabilities (AI video) that do not exist.

**Correction.**
Either amend ADR item 10 through its own change-control path, or (recommended) keep it and re-sequence so that infrastructure arrives only with the stage that needs it (section 10).
Redefine Outcome 1 around the format that is AI-produced today (carousel or LinkedIn document) and make publishing automation a later stage.

**Product impact.**
Months of platform work are moved behind a cheap test of whether creators want researched, approval-gated content at all.

### P0-4: Self-hosted publishing is assumed to be a product feature; platform policy makes it a developer feature

**Problem.**
Outcome 2's exit gate expects "an unrelated developer can install … secure account connection" and Outcome 1 expects local publishing to "one fully supported destination".
The RFC treats provider constraints as a capability matrix to fill in later (§9, D7), not as a product-boundary decision.

**Evidence.** Citations and retrieval dates are in section 12.
- No platform offers a credential an open-source project can publish; a confidential client secret cannot ship in public source, so each self-hosted installation needs its own developer app, or a hosted service must broker OAuth.
- Instagram: professional accounts only; images "must be on a public server" because Meta fetches them by URL; JPEG is the only image format (CreatorBrio exports PNG); direct resumable upload covers video only and requires Facebook Login for Business; there is no scheduling in the API; serving accounts the app owner does not manage needs Advanced Access through App Review and Business Verification.
- TikTok (from official guidelines seen through search, not fetched): unaudited clients can post only `SELF_ONLY`, to at most five users per day, and posting apps must follow mandated consent and privacy-selection UX.
- YouTube: the private-until-audit rule was reversed on 2026-11-02, but an OAuth app in "Testing" status has at most 100 test users whose consent expires after seven days, and an unverified production app is capped at 100 new users.
- LinkedIn: member posting is self-serve (`w_member_social`); organization posting requires the Community Management API, which is "only available to registered legal organizations for commercial use cases"; organic carousels are not supported through the API, while Document and MultiImage posts are.

The Instagram rule has a direct architectural consequence: a self-hosted Instagram image or carousel publish requires exposing the approved media at a public HTTPS URL (a tunnel or a public object store), which contradicts the loopback-only posture the whole local security model relies on (`src/proxy.ts`, `video-production-api.md`).

**Why it is P0.**
Two facts hold whatever proofs pass: an open-source project cannot ship platform app credentials, so publishing in the self-hosted edition always means per-installation developer apps; and Instagram image publishing always requires publicly reachable media, which the local security model forbids today.
The RFC's Outcome 1 and Outcome 2 exit gates depend on both without acknowledging either.
How practical per-installation apps are for non-developer creators is a judgment, not a fact, and belongs to F2 and T5; but the roadmap cannot be accepted while it assumes the question away, because the answer decides whether publishing value sits in the self-hosted or the hosted edition.

**Correction.**
Make publishing a deliberate distribution decision (section 11, F2): hosted product publishes through the operator's reviewed apps; the self-hosted edition delivers an approved, frozen package with a guided manual posting handoff, plus a documented "bring your own developer app" mode for technical users.

**Product impact.**
Prevents promising a self-hosted feature that ordinary creators cannot set up, and identifies where paid value actually lives.

### P1-1: The workflow engine is framed as central; human waits are domain state

**Problem.**
RFC §2 names "a single durable workflow authority" and §11 spikes Hatchet, Temporal and Trigger.dev.
The hardest waits in this product are human approvals lasting hours to days, which the RFC itself says must be authoritative in domain state, not in the engine (§3).

**Evidence.**
- The render-job lifecycle in `video-rendering.md` already has staged creation, lease locks with owner verification by process id, host and start time, transient, permanent and configuration failure classes, bounded retries with backoff, startup recovery of interrupted work, person-initiated retry, and sanitized failure messages; media preparation uses durable jobs too (`docs/architecture/README.md`).
  That covers most of the lifecycle properties the RFC asks of an engine.
- The production store's crash consistency is documented as tested at 72 crash points (`video-production-store.md`; not re-run for this review).
- The production store already models interrupted agent runs that require an explicit human decision after restart (`recoveryRequired`, `resolveInterruptedRun`), which is exactly the "approve next day and resume once" pattern.
- Engine footprints and licences (section 7 and 12): the strongest engines either need a separate production service (Temporal) or add determinism and versioning constraints to every workflow (Temporal, Hatchet, DBOS, Restate); Trigger.dev's self-hosted deployment needs PostgreSQL, Redis, ClickHouse, a container registry and Docker, and lacks checkpoints; Inngest's server is SSPL and Restate's is BSL.
- DBOS's MIT library documents week-long waits, but resource-free suspension and distributed recovery are features of its paid Conductor control plane, which shows how much of "durable human waits" depends on parts that are not free to self-host.

**Correction.**
Model the pipeline as a domain state machine whose transitions enqueue bounded, idempotent jobs, plus a due-time scheduler that scans for work.
Approval waits are rows or records in a state, not sleeping workflow executions.
Defer engine selection to the hosted stage; prefer an engine that runs on the same PostgreSQL the hosted product needs anyway, and adopt a dedicated engine only if a measured requirement (long multi-step compensation, high fan-out) appears.

**Product impact.**
Keeps local installation free of a second stateful service, and removes the largest operational burden from the self-hosted edition.

### P1-2: API-first will not minimize SaaS and mobile rework unless identity and asset access are unified

**Problem.**
RFC §6 focuses on versioned paths, OpenAPI and generated clients.
The real incompatibilities are elsewhere.

**Evidence.**
- Three authority models: carousel routes have no authentication and rely on `src/proxy.ts` loopback and Origin checks ("The API has no authentication"); Video Studio routes use a human key file, terminal-issued pairing codes and a cookie scoped to `/api/video`; agent run tokens live only in server memory and do not survive a restart (`video-production-api.md`).
- Media import is by absolute local path (`POST /api/video/media { path }`), a concept with no hosted or mobile meaning.
- `/uploads/*` is served by `src/app/uploads/[...path]/route.ts` with no authority check and `Cache-Control: public, max-age=0`; the guard in `src/proxy.ts` matches only `/api/:path*`, so binding to loopback is its only protection.
- Carousel slide HTML references images as `/uploads/{filename}` (`CLAUDE.md`, `chat-system-prompt.ts`), so stored carousel content embeds storage locations. Video Studio, by contrast, refers to media by content hash, which is portable.

**Correction.**
Write an identity and asset-access ADR before any route is exposed beyond loopback: one principal model (person, agent run, service) applied to every route, using the Production API's credential-not-body authority as the template; durable agent-run credentials; asset references by identifier resolved server-side for carousels; uploads served through the same authority; browser upload as the import path (#141).
Versioned `/api/v1` paths and OpenAPI can follow; they are cheap once the semantics are right.

**Product impact.**
This is where most local-to-SaaS rework actually lives; doing it once, early and locally, is far cheaper than retrofitting.

### P1-3: "Configurable agents and model providers" is unproven, and CLI subscription use cannot drive unattended runs

**Problem.**
RFC §2 proposes model- and provider-independent agent contracts and keeps the Claude CLI as an opt-in adapter.

**Evidence.**
- The Design Agent's tool contract is a shell running `curl` against REST routes, tuned by a frozen prompt pinned by a test (`design-decisions.md`). Porting it to another provider means replacing its tool surface, not swapping a model name.
- Issue #186: CreatorBrio does not own the agent's runtime configuration; model, effort, advisor and plugins come from the operator's personal settings.
- `spec/08` §4, quoting Anthropic's documentation (retrieved 2026-11-04): third-party products may not offer Claude.ai login or route requests through subscription plans for their users; CreatorBrio's own policy restricts the CLI adapter to a person running their own unmodified `claude`, "runs are user-initiated", never for hosted or multi-user use.

**Correction.**
Define the controlled Creative Agent execution profile (#186) and the typed tool surface (WS8, G8) as prerequisites for any provider abstraction.
Add an explicit rule: the CLI adapter may run only interactive, user-initiated steps; scheduled, unattended or hosted steps use API-key runtimes under commercial terms.

**Product impact.**
Prevents a design where the "automated" pipeline only works when the founder's personal subscription is signed in on the machine.

### P1-4: Operating cost is unmeasured, and the one measurement is high

**Problem.**
RFC §10 asks for a usage ledger and budgets but sets no cost target, and the roadmap has no cost gate before hosted work.

**Evidence.**
Issue #184: one eight-slide carousel's design run was estimated at USD 4.06 over 30 turns and about ten minutes, plus USD 0.18 for the Visual Director, at list price; most tokens were cache reads from the agent re-reading its own slide renders.
This is a single run under the operator's inherited personal agent settings (#186), so it is a signal, not a baseline.
The Director runs on every message by design (`design-decisions.md`).
Research, revisions and video would add to this.

**Correction.**
Add a cost proof (T6) with a target cost per approved artifact before any hosted commitment, measured on API-key runtimes, and resolve #184's optimization options first.

**Product impact.**
At USD 4 or more of model cost per carousel before research and revisions, hosted pricing and free-tier design are constrained; this must be known before SaaS planning, not after.

### P1-5: Media execution runs inside the web server process

**Problem.**
RFC §7 requires isolated, bounded media workers; the current render path runs up to 16 Chromium browsers plus FFmpeg inside the Next.js server process.

**Evidence.**
`video-rendering.md` ("Up to `workers` (1 to 16, default 4) Chromium browsers"; "One render runs at a time in a process"; "When the API starts, renders still queued are run"); `docs/architecture/README.md`: "Video Studio media preparation and rendering run as durable jobs in the app's own process."
The overlay boundary itself is strong: page JavaScript off, every request refused except bundled fonts.

**Correction.**
Extract media and render jobs into a separate worker process with the same file-backed job contract (already planned in WS5) before any scheduler or publisher shares that process.
In hosted mode, run each job in a container with no network egress and per-job CPU, memory, disk and time limits.

**Product impact.**
A long render currently competes with the API and UI for the same process; a publisher or scheduler in that process would inherit its failure modes.

### P1-6: The proposed container distribution changes the licensing position

**Problem.**
Outcome 2 suggests a "container profile" installer.

**Evidence.**
`spec/08` §2 classifies FFmpeg GPL builds as "Separate process, user-installed, never bundled"; §7 notes that distributing binaries triggers GPL source obligations.
A container image is distribution, and FFmpeg's legal page states that `--enable-gpl` builds (for example with libx264) are GPL as a whole.
Claude Code is proprietary ("All rights reserved", governed by Anthropic's Commercial Terms); it may not be vendored into the MIT repository, and preinstalling it in an image is allowed only unmodified and with each end user authenticating with their own credentials.

**Correction.**
Before Outcome 2, run a licence review of the actual image contents (T9); choose an LGPL FFmpeg build or keep FFmpeg user-supplied; make the containerised edition API-key only.

**Product impact.**
Avoids a distribution that silently violates the project's own licensing policy.

### P1-7: The production store's model is portable, but its storage semantics are not; the RFC asks the wrong question

**Problem.**
RFC D3 asks whether the production store can "remain local while an extensible domain store is introduced", which implies two stores of truth.

**Evidence.**
`video-production-store.md`: commit by hard-link compare-and-swap on a generation number, run ownership by process id and host, hard links required, power-loss durability unmeasured.
The change-set engine is pure (`applyChangeSet`, `admitProduction`), and the store "adds no editing logic".

**Correction.**
Answer D3 as: one store of truth per stage, behind a storage port.
The journal-plus-content-addressed-snapshot model maps directly onto a relational table with a unique `(production_id, generation)` constraint and an object store for snapshots.
Write the store's existing crash and concurrency tests as a conformance suite that any adapter must pass (T8), and build the PostgreSQL adapter only at the hosted stage.
Carousel JSON storage (`src/lib/data.ts`) needs the same port.

**Product impact.**
Local-to-SaaS migration becomes an adapter plus export and import, not a rewrite.

### P2 findings

- **P2-1 Duplicate tracking issue.** #213 and #214 propose the same document; the merge closed #214, and #213 is still open. Close #213 as a duplicate.
- **P2-2 Research should build on the existing boundary.** Make `source-retrieval.ts` the research module's only fetch path, and extend its limits (three pages per message today) deliberately.
- **P2-3 Mobile is premature.** Approvals and notifications on a phone can be served by the responsive web app and email first; a native client should wait for a hosted API with real identity. Keep RFC §6's warning against a shared mobile video editor.
- **P2-4 Transactional outbox is only meaningful with a database.** State that local mode uses the store's commit as the dispatch point and adopt an outbox with the hosted database.
- **P2-5 "Versioned portable recipes" are undefined.** They risk becoming a workflow DSL. Defer until three real customer workflows exist; until then, recipes are brand and style profiles (WS18) plus parameters.
- **P2-6 Local scheduling.** A sleeping laptop cannot publish on time. For the self-hosted edition, prefer "publish on approval" or provider-native scheduling where it exists; avoid promising unattended local schedules.
- **P2-7 Vocabulary.** Align RFC state names with `ProductionStage` and the Production API error codes so the documentation describes one system.
- **P2-8 Keep what is good.** `external_outcome_unknown`, server-generated identifiers, refusal on capability gaps, approval invalidation on any change, and "workflow engine is not an agent framework" are correct and should survive the rewrite.

## 4. Answers to the ten challenge questions

1. **Inside CreatorBrio or a separate repository?** Inside CreatorBrio. The domain (Production v2), brand model, rights work and approval semantics already live there; a separate orchestrator would either duplicate them or be a thin, undifferentiated scheduler. See section 5.
2. **Is a modular monolith correct?** Yes, with one change: a separate worker process from the start for media, research and publishing (P1-5, P0-2). Enforce module boundaries with the existing pattern of handler libraries behind thin route files.
3. **Will API-first minimize rework?** Only partly. Routes are already API-first; the rework is identity, asset access and media import (P1-2).
4. **Workflow engine candidates?** None are needed now. A domain state machine with durable jobs covers the local product; choose a PostgreSQL-native option at the hosted stage, with a proof (P1-1, section 7).
5. **Are agent isolation, media execution, tenancy, credentials and publishing security sufficiently designed?** No. They are listed as invariants, but the local-mode colocation problem (P0-2) and the in-process renderer (P1-5) are not addressed, and tenancy has no design beyond "RLS where chosen".
6. **Can existing CreatorBrio be reused without duplication?** Yes, if the RFC adopts Production v2, the Production API authority model, the source-retrieval boundary and the render manifest, instead of defining parallel ones (P0-1).
7. **Is local-to-SaaS migration achievable without rewrites?** Yes for the domain and change engine; no for identity, asset serving and storage semantics unless the ports in P1-2 and P1-7 are introduced first.
8. **Is the roadmap correctly sequenced and commercially sensible?** No. It builds infrastructure before validating outcome, quality and cost, and places publishing in the self-hosted edition where platform policy makes it hardest (P0-3, P0-4, P1-4).
9. **Overlooked failure scenarios, security risks, licensing and costs?** Agent credential exfiltration in local mode (P0-2), container licensing (P1-6), subscription terms for unattended runs (P1-3), per-artifact model cost (P1-4), public media URLs and JPEG-only images for Instagram (P0-4), seven-day OAuth expiry for unverified Google apps, Instagram containers expiring after 24 hours (so a scheduler must create them close to publish time), and the AGPL licence of the most visible open-source scheduler, Postiz, which rules out copying its code into the MIT core.
10. **Overengineering?** Yes: workspace tenancy, usage ledger, notification channels, OpenAPI clients, outbox, workflow engine and mobile are all ahead of a validated single-user outcome.

## 5. Product and repository boundary alternatives

| Criterion | A. Evolve CreatorBrio directly | B. Separate orchestration product | C. Hybrid: CreatorBrio as a creative capability behind a separate platform |
|---|---|---|---|
| Duplication of domain | None if Production v2 is adopted | High: projects, brands, approvals, rights duplicated or proxied | Medium: approvals and identity straddle two systems |
| UX cohesion | One product, one job | Two products stitched by integration | One UI possible, two backends |
| Local OSS | One install | Two installs and a contract between them | Two installs |
| SaaS | Needs identity and storage ports (needed in every option) | Needs CreatorBrio to expose hosted-grade API anyway | Same as B |
| Mobile | One API | Two APIs or a gateway | Gateway required |
| Differentiation | Creative quality plus approval-bound publishing in one place | Orchestration alone is commodity (general automation tools and social schedulers) | Moderate |
| Solo-founder cost | One release train | Two release trains, versioned contract | Two release trains |
| Licensing and provenance | MIT unchanged | New repo can choose a licence | New repo can choose a licence |

**Winner: A**, with two seams reserved for later.
Provider publishing adapters live in their own module with a narrow interface so they can become a package.
A hosted control plane (billing, tenant administration, operator tooling) can later live in a separate, possibly private repository that deploys the MIT core, if the founder chooses an open-core model (F3).
Neither seam justifies a second repository now.

## 6. Recommended architecture

- **One repository, one codebase, two processes.**
  The Next.js app serves the UI and the API through thin route files over handler libraries (the Production API pattern).
  A worker process from the same codebase runs media, render, research and publishing jobs.
  Locally, one start command launches both.
- **Content authority.** Production v2 for video and the carousel record for carousels, each behind a storage port with today's file adapters.
- **Publication module (new).** `ConnectedAccount`, `PublicationManifest` (frozen: artifact hashes from the render manifest, caption, cover, destination, options, scheduled instant), `PublicationAttempt`, `ExternalPublicationRecord` with `external_outcome_unknown` and provider-evidence reconciliation.
- **Research and approval.** One model: Production v2's `ResearchDossier`, `Claim` and `Approval`, lifted into a shared module used by productions and carousels, with `Approval` extended by an approver principal and a `publication` scope bound to a manifest hash; agents can never create an approval (already enforced for change sets made with agent tokens).
- **Execution.** Domain state transitions enqueue bounded, idempotent jobs; a due-time scheduler; no external engine until the hosted stage proves a need.
- **Agents.** One agent model: run-scoped credential, typed tools over the API, no shell, no data directory, no free web access; research through `source-retrieval.ts`. CLI runtime for interactive local steps only; API-key runtimes for anything unattended or hosted.
- **Identity.** One principal model for every route now (a single local person), so hosted authentication later plugs into it rather than replacing three schemes.
- **Assets.** Referenced by identifier and resolved server-side; served only through the authority layer; browser upload replaces path import for anything beyond the local Studio.
- **Secrets.** Publisher-only access; OS keychain locally, KMS-backed service hosted.
- **Hosted stage only.** PostgreSQL adapters, object storage, tenant-scoped principals, a PostgreSQL-native durable execution layer if needed, containerised media jobs without egress, usage ledger and budgets.

## 7. Technology decision matrix

| Decision | Options | Recommendation | Decide when | Proof |
|---|---|---|---|---|
| Product boundary | A / B / C (section 5) | A | Now (F1) | None beyond this review |
| API host | Next.js route handlers / separate API process | Route handlers over handler libraries; revisit if a hosted load or isolation test fails | Hosted stage | Hosted auth and load test |
| Workers | In-process / separate process / container per job | Separate process locally; container per job hosted | Before first publisher | T4 |
| Durable execution | Domain state + job records / PostgreSQL-native library / dedicated engine | Domain state now; PostgreSQL-native at hosted stage | Hosted stage | T10 |
| Business state | Files / SQLite / PostgreSQL | Files behind ports locally; PostgreSQL hosted | Hosted stage | T8 |
| Assets | Local content-addressed files / S3-compatible | Keep; add object-store adapter hosted | Hosted stage | T8 |
| Agent runtime | Claude CLI / Anthropic API / other providers / manual | CLI interactive-only; API key for unattended; others after typed tools exist | Before unattended runs | T1, T6 |
| Secrets | Env file / OS keychain / KMS service | Keychain local; KMS hosted; never env or `data/` | Before first credential | T1 |
| Mobile | Responsive web / PWA / Expo | Responsive web and email; Expo after hosted identity | After hosted alpha | None now |
| Distribution | npm install / container | npm install now; container only after licence review | Before Outcome 2 | T9 |

### Durable execution candidates

Assessed for the hosted stage; none is recommended for the local product.

| Candidate | Licence (server / TS SDK) | Minimum self-hosted footprint | Human waits and timers | Versioning burden | Tenancy primitives | Fit |
|---|---|---|---|---|---|---|
| Domain state + job records (current pattern) | Own code, MIT | None beyond today's files | Approval is a stored state; a scheduler scans due work | Ordinary data migrations | Whatever the domain models | **Local product, now** |
| pg-boss | MIT / MIT | PostgreSQL 13+, library | Deferral and cron; no wait primitive (not needed if waits are domain state) | None | None documented | **Hosted default** with domain state |
| Graphile Worker | MIT / MIT | PostgreSQL, library | Cron, job keys for de-duplication; no waits | None | None documented | Hosted alternative to pg-boss |
| DBOS Transact | MIT library / MIT | PostgreSQL, library | `recv` and events with long timeouts | Deterministic workflows, patching or version tags | Partitioned queues per key | Escalation option; check which recovery features need paid Conductor |
| Hatchet | MIT / MIT | PostgreSQL only (RabbitMQ optional); a separate engine service | Durable sleep and event waits | Deterministic between checkpoints | Per-key concurrency, round-robin fairness | Escalation option; small vendor, low-confidence company data |
| Temporal | MIT / MIT | Production cluster with persistence and visibility stores; single-binary dev server is for development only | Signals and durable timers, the most mature | Deterministic; patching or worker versioning | Namespaces, fairness keys | Only if workflow complexity and scale are proven |
| Trigger.dev v4 | Apache-2.0 / MIT | PostgreSQL, Redis, ClickHouse, object storage, registry, Docker or Kubernetes; no checkpoints when self-hosted | Wait tokens | Run versions | Concurrency keys | **Reject** for a self-hostable product |
| Inngest | SSPL 1.0 with delayed Apache-2.0 / Apache-2.0 | Single binary, SQLite or PostgreSQL | Sleep and wait for event | Step functions | Concurrency keys | **Reject** for distribution: an SSPL server cannot be a required part of an MIT self-hosted product without imposing SSPL obligations on anyone who offers it as a service |
| Restate | BSL 1.1 / MIT | Single binary with embedded store | Awakeables, durable promises | Immutable deployments | None seen | **Reject** under `spec/08`'s exclusion of source-available components |

**Decision rule.**
Keep approvals and schedules in domain state so that the engine only runs short, idempotent jobs.
At the hosted stage, start with pg-boss or Graphile Worker on the application's PostgreSQL.
Escalate to DBOS or Hatchet only if T10 shows multi-step code workflows that domain state cannot express cleanly; consider Temporal only with measured scale and a team to operate it.

## 8. Required changes to the RFC and roadmap

All changes are to the merged documents in `docs/roadmap/content-platform/` on `main`, through a new ticket and PR.
Nothing in `docs/roadmap/video-studio/` or `docs/architecture/` changes implicitly; any change there goes through its own ticket.

**`ARCHITECTURE-RFC.md`**
- §2 Decisions: replace the "Storage" and "Execution" rows with "files behind storage ports locally; PostgreSQL and a durable execution layer only at the hosted stage, subject to ADR item 10"; resolve "Product/repos" as option A; add a row "Agent model: the Video Studio agent authority applies to every agent".
- §3 Ownership: add that the Production module is Production v2, and that research is built on `source-retrieval.ts`.
- §4 Lifecycle: replace the project state machine with a mapping onto `ProductionStage` plus a publication lifecycle; define the `publication` approval scope.
- §5 Domain model: remove `ContentProject`, `ResearchReportVersion`, `SourceEvidence`, `CreativeBriefVersion`, `ReviewRequest` and `ApprovalDecision`; reference the Production v2 types; keep only the publication, account, notification and (hosted) workspace entities.
- §6 API: add the identity and asset-access requirements of P1-2; keep generated clients as a hosted-stage item.
- §7 Threat model: add a "local mode" column; add the Design Agent's shell and web access as the first threat, with the P0-2 correction as a precondition for credentials.
- §8: replace D3's framing with the storage-port and conformance-suite approach.
- §9: add the CLI interactive-only rule and the platform facts from section 12.
- §11: remove Hatchet as the lead candidate; state the domain-state-first approach and the hosted-stage selection criteria.
- §13: close D1 (A), D3 (ports), D4 (route handlers for now) as recommended; add D11 publishing distribution model, D12 open-core boundary, D13 agent tool surface.

**`ROADMAP.md`**
- Replace Outcomes 0 to 5 with the stages in section 10.
- Add a cost gate and a creator-outcome gate before any hosted work.
- Move publishing out of the first local outcome; state that self-hosted publishing is "bring your own developer app" unless F2 decides otherwise.

**`README.md` (content platform)**
- Add the overlap table between the RFC's modules and WS1, WS3, WS5, WS8, WS9 and WS10, stating that those workstreams own them.

**`ARCHITECTURE-REVIEW.md`**
- Record this review's verdict and link it; mark resolved decisions.

**New ADRs (proposed, each with its own ticket):** product boundary (option A); agent authority model for all agents; identity and asset access; publishing distribution model.
**ADR item 10** stays as is; the recommended sequence does not need it amended until the hosted stage, at which point it is amended explicitly.

## 9. Technical proofs required before implementation

| ID | Proof | Pass condition |
|---|---|---|
| T1 | Agent injection containment | A Design Agent run fed a page instructing it to read local secrets and call an external API produces zero secret reads outside its allowed tools, zero outbound calls beyond the allowlist, and no publication. Run against the current agent first to document the baseline. |
| T2 | Approval binding | Changing any manifest field or artifact hash after approval makes publish refuse; two concurrent approvals produce exactly one; an agent credential can never create an approval. |
| T3 | Publication reconciliation | Against a provider test account, a forced timeout after the provider accepted the publish ends in exactly one post after reconciliation, across a worker restart. |
| T4 | Worker restart | Killing the worker during research, render, approval wait and publish resumes each exactly once with no orphaned artifacts; the web process stays responsive during a 16-browser render. |
| T5 | Provider feasibility | For the first destination, document the full setup a self-hoster must perform (app registration, review, permissions, media hosting) and whether a non-developer can complete it. |
| T6 | Cost and time | Ten representative end-to-end jobs on API-key runtimes produce a cost and time distribution per approved artifact against a target set by the founder. |
| T7 | Creator outcome | Five or more real creators or brands run research, approval, production and manual posting; measure acceptance without rewriting, edits per piece and time saved against their current process. |
| T8 | Storage port conformance | The production store's crash and multi-process tests pass unchanged against a second adapter. Required only before the hosted stage. |
| T9 | Distribution licence | A bill of materials for any container image shows no GPL or excluded component distributed against `spec/08`. |
| T10 | Durable execution (hosted) | The chosen layer survives full restart with day-long waits, cancellation, version change of in-flight work and per-tenant concurrency limits, on the same PostgreSQL instance as the app. |

## 10. Staged implementation strategy

1. **Stage 0: decisions (documentation only).**
   Revise the RFC and roadmap per section 8, open the four proposed ADRs, close the duplicate issue.
   Exit: founder decisions F1 to F7 recorded.
2. **Stage 1: safety and runtime prerequisites, inside existing workstreams.**
   Controlled agent execution profile (#156, #186); typed agent tools replacing shell for the Design Agent (WS8, G8), measured with the acceptance harness; worker process extraction (WS5); one principal model across routes; #184 cost optimizations.
   Exit: T1, T4 and a cost baseline.
3. **Stage 2: validate the outcome without publishing automation.**
   Carousel or LinkedIn document, because they are AI-produced today.
   First lift `ResearchDossier`, `Claim` and `Approval` into the shared module and add them to carousels (P0-1).
   Then: structured research through `source-retrieval.ts` into the dossier, a research approval, production, a publication-scope approval on a frozen package of exported file hashes, and a guided manual posting handoff with a reminder.
   Exit: T2, T6, T7.
4. **Stage 3: first publishing adapter.**
   One destination chosen from T5, separate publisher process, keychain credentials, frozen manifest, reconciliation.
   Exit: T3 and T5 documented for self-hosters.
5. **Stage 4: video joins** after Edit Studio acceptance (#96), reusing the same approval and publication path.
6. **Stage 5: hosted alpha.**
   Amend ADR item 10; storage adapters (T8), hosted identity and tenancy on the principal model, API-key runtimes only, containerised media jobs, durable execution choice (T10), usage ledger and budgets.
7. **Stage 6: mobile companion** for approvals and notifications over the hosted API.

Video Studio's accepted program continues unchanged throughout; Stage 1 items are already within its workstreams.

## 11. Decisions that need the founder

| ID | Decision | Recommended default |
|---|---|---|
| F1 | Keep the platform inside CreatorBrio (option A) | Yes |
| F2 | Publishing distribution: hosted-only publishing, self-hosted "bring your own developer app", or manual handoff only | Hosted publishes through operator apps; self-hosted offers manual handoff plus a documented BYO-app mode |
| F3 | Open-core boundary: is the hosted control plane MIT in this repository or private | MIT core here; private control plane later |
| F4 | Priority relative to Edit Studio | Stage 1 proceeds now because it is shared; Stage 2 in parallel on carousels; video publishing waits for Edit Studio acceptance |
| F5 | Accept a possible Design Agent quality change from removing its shell and web access | Accept, conditional on the acceptance harness showing no material regression |
| F6 | Budget for paid cost and outcome proofs (T6, T7) | A fixed, small budget approved in advance, per the existing rule against unapproved paid runs |
| F7 | First publishing destination | LinkedIn member document post as the first T5 candidate: member posting is self-serve, and documents are an existing CreatorBrio format. UNVERIFIED: whether Document posts work with `w_member_social`, and whether LinkedIn accepts direct uploads without public media hosting; confirm both in T5 before committing. Instagram second, through the hosted product. |

## 12. External facts

Retrieved 2026-11-17 unless stated.
[F] fetched from the primary source; [S] official page seen through search only; facts marked UNVERIFIED were not confirmed.
The Instagram public-server and JPEG statements and the YouTube 2026-11-02 reversal were independently re-fetched for this review.

**Instagram Platform, content publishing** ([F] <https://developers.facebook.com/docs/instagram-platform/content-publishing>)
- "We will cURL your image using the passed in URL so it must be on a public server."
- "JPEG is the only image format supported."
- Resumable upload via `rupload.facebook.com` is for video (`VIDEO`, `REELS`, `STORIES`) and "Only for apps that have implemented Facebook Login for Business."
- The page states both "100 API-published posts within a 24-hour moving period" and, for carousels, "50 published posts within a 24-hour period"; a carousel counts as one post.
- No scheduling parameter; unpublished containers expire after 24 hours.
- Advanced Access (App Review and Business Verification) is required to serve accounts the app owner does not own or manage ([F] <https://developers.facebook.com/docs/instagram-platform/overview>).

**TikTok Content Posting API** ([S] <https://developers.tiktok.com/docs/en/content-sharing-guidelines>; the site refused direct fetches)
- "Unaudited API Clients can only post contents in SELF_ONLY viewership", limited to five users per 24 hours.
- Posting apps must query creator info, offer only the returned privacy options, and obtain explicit consent.

**YouTube Data API** ([F] <https://developers.google.com/youtube/v3/revision_history>, <https://support.google.com/cloud/answer/15549945>)
- 2026-11-02: "Videos uploaded through the videos.insert method from unverified API projects are no longer restricted to private viewing mode."
- 2026-06-01: `videos.insert` moved to its own quota bucket; 2025-12-04: upload cost cut from about 1,600 to about 100 units.
- OAuth apps in Testing status: at most 100 test users, consent expires after seven days; unverified production apps: lifetime cap of 100 new users. Whether `youtube.upload` is a sensitive scope requiring verification: UNVERIFIED.

**LinkedIn** ([F] <https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin>, <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api>, <https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review>)
- Member posting: self-serve "Share on LinkedIn", `w_member_social`.
- Organization posting: `w_organization_social` and a Page admin role; Community Management API "only available to registered legal organizations for commercial use cases".
- Organic carousels are not supported via the API; Document and MultiImage posts are (Posts API, version li-lms-2026-10). Whether Document posts work under `w_member_social`: UNVERIFIED.

**Anthropic terms** ([F] <https://code.claude.com/docs/en/agent-sdk/overview>, <https://code.claude.com/docs/en/legal-and-compliance>, <https://www.anthropic.com/legal/consumer-terms>)
- Third-party products may not offer Claude.ai login or route requests through subscription plans for their users; products should use API keys.
- An end user may sign in to the unmodified Claude Code binary with their own subscription, "including where a platform hosts Claude Code"; products embedding it "may not pay for, resell, or intermediate Claude usage on their end users' behalf".
- Plan limits "assume ordinary, individual usage". These match what `spec/08` recorded on 2026-11-04.
- Claude Code and the Agent SDK are proprietary ("All rights reserved"), governed by the Commercial Terms.

**Workflow engines** (licences from repository LICENSE files and npm metadata [F]; footprints from official self-hosting docs [F])
- Hatchet MIT, PostgreSQL-only possible (<https://docs.hatchet.run/self-hosting>).
- Temporal MIT; `temporal server start-dev` is for development; visibility may use PostgreSQL 12+ (<https://docs.temporal.io/self-hosted-guide>).
- Trigger.dev Apache-2.0; self-hosting needs PostgreSQL, Redis, ClickHouse, registry, object storage and Docker; no checkpoints when self-hosted (<https://trigger.dev/docs/self-hosting/overview>).
- DBOS Transact MIT library on PostgreSQL; Conductor features such as resource-free suspension are paid (<https://docs.dbos.dev/architecture>, <https://www.dbos.dev/pricing>).
- Inngest server SSPL 1.0 with delayed Apache-2.0 (<https://github.com/inngest/inngest/blob/main/LICENSE>).
- Restate server BSL 1.1 with an additional use grant (<https://github.com/restatedev/restate/blob/main/LICENSE>).
- pg-boss MIT, PostgreSQL 13+ and Node 22.12+; Graphile Worker MIT.
- Company and funding information came from news and aggregator sites and was not used in any finding.

**Media and schedulers** ([F] <https://ffmpeg.org/legal.html>, <https://github.com/gitroomhq/postiz-app>, <https://mixpost.app/pricing>)
- FFmpeg is LGPL-2.1+ by default; `--enable-gpl` builds are GPL; `--enable-nonfree` builds are not redistributable.
- Postiz is AGPL-3.0. Mixpost Lite is MIT (PHP); Mixpost Pro and Enterprise are source-available and may not be redistributed.
- Remotion is source-available and not used by CreatorBrio; `spec/08` already excludes it.

## 13. Review limitations

- No tests were run; repository test claims are as documented.
- External platform rules and licences change; each fact in section 12 carries its source and retrieval date.
- The external publishing project could not be inspected.
