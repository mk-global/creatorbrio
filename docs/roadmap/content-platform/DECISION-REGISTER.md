# Decision register: content automation platform

**Status:** maintained under [#216](https://github.com/mk-global/creatorbrio/issues/216).

**Date:** 2026-11-17.

Statuses:
- **ACCEPTED**: decided by the founder, or already decided in an accepted CreatorBrio document that is cited.
- **PROPOSED**: recommended by the [RFC](ARCHITECTURE-RFC.md); becomes ACCEPTED only when the founder accepts it, recorded here with the date.
- **DEFERRED**: deliberately left to a named later stage or proof.
- **REJECTED**: considered and ruled out, with the reason.

A PROPOSED decision is not an authorization to implement; implementation needs admitted issues.

## 1. Founder decisions

| ID | Decision | Status | Source |
|---|---|---|---|
| FD-A | One unified product with a continuous, durable two-approval workflow | ACCEPTED 2026-11-17 | [RFC section 1](ARCHITECTURE-RFC.md#1-founder-decisions-accepted-requirements) |
| FD-B | One modular repository, `mk-global/creatorbrio`; separate processes allowed for isolation | ACCEPTED 2026-11-17 | [RFC section 1](ARCHITECTURE-RFC.md#1-founder-decisions-accepted-requirements) |
| FD-C | Migrate the Social Automation publisher into CreatorBrio as an isolated module | ACCEPTED 2026-11-17 | [RFC section 1](ARCHITECTURE-RFC.md#1-founder-decisions-accepted-requirements) |
| FD-D | Open-source edition stays useful; self-hosters bring their own infrastructure, AI keys and platform apps; hosted edition sells convenience; MIT preserved | ACCEPTED 2026-11-17 | [RFC section 1](ARCHITECTURE-RFC.md#1-founder-decisions-accepted-requirements) |
| FD-E | Local first; same domain later serves self-hosted, hosted SaaS and mobile; no premature infrastructure | ACCEPTED 2026-11-17 | [RFC section 1](ARCHITECTURE-RFC.md#1-founder-decisions-accepted-requirements) |

## 2. Architecture decisions

| ID | Decision | Status | Where |
|---|---|---|---|
| AD-01 | Evolve CreatorBrio itself (no separate orchestration product or repository) | ACCEPTED (follows from FD-A and FD-B) | RFC section 3 |
| AD-02 | Three process kinds: app, worker, publisher; agents as contained subprocesses | PROPOSED | RFC section 2 |
| AD-03 | No umbrella content entity; the carousel record and Production v2 stay authoritative | PROPOSED | RFC 5.1 |
| AD-04 | A grouping record for one idea in several formats | DEFERRED until real use needs it | RFC 5.1 |
| AD-05 | One shared research and approval contract; approval in force is derived, never stored; carousels adopt it additively | PROPOSED | RFC 5.2 |
| AD-06 | The publisher's fingerprinted package is the publication manifest; publication approvals are held by the publisher. The slot is outside the fingerprint, so rescheduling does not lapse an approval; only a person principal can reslot, and every reslot is an attributed event. This deviates from the review's frozen-time manifest, which listed the scheduled instant, because a posting time is not content the public sees and re-approving unchanged bytes for every reschedule would teach people to approve without reading | PROPOSED | RFC 5.3 and 5.4 |
| AD-07 | Keep the publisher in Python as a separate process; decide a TypeScript port before a third new platform adapter is built or at the hosted stage, whichever comes first, behind the full parity suite. The publisher assessment recommended a staged TypeScript port and advised against shipping a Python process to public users; this departs from it for the lowest risk to working publishing, credential isolation through a separate process, and Video Studio ADR item 10, which already allows Python workers; phase 6 ships the Python publisher to self-hosters as an accepted consequence (FQ-9) | PROPOSED (port DEFERRED) | RFC section 3 |
| AD-08 | The publisher's runner is the only publication scheduler; its trigger is a port (launchd, systemd timer, always-on) | PROPOSED | RFC section 6 |
| AD-09 | No workflow engine, database server or queue for the local product; human waits are domain state; compute is durable jobs | PROPOSED | RFC section 6 |
| AD-10 | Hosted job layer on the application's PostgreSQL, chosen by proof T10 | DEFERRED to the hosted stage | RFC section 6 |
| AD-11 | Agent containment first with the CLI's documented sandbox and settings controls, then typed tools as the durable boundary; OS-account separation only if typed tools fail on quality | PROPOSED | RFC 7.4 |
| AD-12 | Agents never create or judge approvals; one person approval covers every platform of a package | PROPOSED | RFC 5.5 |
| AD-13 | The Claude CLI runs only interactive, person-started local steps; unattended and hosted steps use API keys | ACCEPTED (existing policy in `docs/research/video-studio/spec/08-licensing-and-commercial.md` section 4) | RFC 7.4, section 10 |
| AD-14 | One principal model (person, agent run, service) across every route before any route leaves loopback; phase 2 extends the Production API's person principal (the human key or a paired browser session) to the carousel approval routes | PROPOSED | RFC section 8 |
| AD-15 | Carousel assets referenced by identifier and served through the same authority; browser upload replaces path import outside the local Studio | PROPOSED | RFC section 8 |
| AD-16 | Storage behind ports with conformance suites; PostgreSQL and object storage only at the hosted stage | PROPOSED | RFC section 9 |
| AD-17 | Secrets behind a port: OS keychain, Linux Secret Service, encrypted file; managed key service hosted | PROPOSED | RFC section 8 |
| AD-18 | Self-hosted publishing uses the self-hoster's own apps and bucket; a frozen package with a manual handoff completes the workflow where automation is not possible | ACCEPTED in principle (FD-D); details PROPOSED | RFC 11.2 |
| AD-19 | Media reaches platforms only through a private bucket and short-lived signed links; CreatorBrio's own routes stay on loopback | PROPOSED | RFC 7.2 |
| AD-20 | Notifications are durable CreatorBrio records fed by domain events and the publisher's event log; one delivery owner per alert | PROPOSED | Roadmap phase 4 |
| AD-21 | Research goes through the server's retrieval boundary; no platform scraping; competitor study only through official APIs and links the person supplies | PROPOSED | RFC section 4 |
| AD-22 | Mobile: responsive web and email first; a native client after hosted identity; no mobile video editing | PROPOSED | RFC section 9 |
| AD-23 | CreatorBrio stays MIT; a licence change to deter competing hosts is a separate review | ACCEPTED (FD-D) for MIT; change DEFERRED | RFC 11.3 |
| AD-24 | No container or binary distribution before a bill-of-materials licence review (T9) | PROPOSED | RFC section 12 |
| AD-25 | Import the publisher as a sanitized snapshot; the private repository is archived as the history of record | PROPOSED (needs FQ-2) | Migration plan |
| AD-26 | Import and cut the runner over before integrating CreatorBrio with the publisher; the cutover waits for M1's confinement ticket and T1's baseline, and integration waits for T1 passing | PROPOSED | Roadmap phase 3 |
| AD-27 | Do not migrate the calendar check; CreatorBrio becomes the plan | PROPOSED | Migration plan |
| AD-28 | Do not migrate the cloud publisher | DEFERRED: not part of this plan; a cloud publishing path is decided separately | Migration plan |
| AD-29 | First automated destinations are those the publisher supports (Instagram carousels and Reels, Facebook Page, YouTube); LinkedIn and TikTok later | PROPOSED | Roadmap phases 4 and 9 |
| AD-30 | Publisher SQLite inside its boundary as a scoped exception to "Local JSON storage stays" | PROPOSED (needs the amendment in RFC section 13) | RFC section 9 |
| AD-31 | Alternative C, a separate publishing service repository behind a contract: it contradicts FD-B, and approvals and accounts would straddle two repositories and two release trains | REJECTED | RFC section 3 |
| AD-32 | Alternative D, adopting an existing open-source scheduler such as Postiz as the publisher: it contradicts FD-C and the capability ownership in the Video Studio ADR, its users, accounts, approvals and scheduler would duplicate CreatorBrio's, and AGPL-3.0 code is excluded by `spec/08` (see TD-11) | REJECTED | RFC section 3 |
| AD-33 | The publication package carries a rights and credits manifest for every asset, taken from the asset's rights record (Video Studio WS3) or the person's declaration; Gate 2 shows it, it is inside the fingerprint, and staging is refused for an asset that is not cleared | PROPOSED | RFC 5.3 and the overlap table in section 4 |
| AD-34 | Video publishing through the platform waits for the amendment of the out-of-scope list in Video Studio `spec/01`; Video Studio's own scope, gates and sequencing do not change | PROPOSED | RFC section 13 |

## 3. Technology decisions

Evidence and sources are in [OSS-RESEARCH.md](OSS-RESEARCH.md).

| ID | Decision | Status |
|---|---|---|
| TD-01 | No agent framework; provider SDKs (Anthropic TypeScript SDK) plus one typed tool registry exposed over MCP (MCP TypeScript SDK) and REST | PROPOSED |
| TD-02 | Vercel AI SDK behind CreatorBrio's provider port for other APIs and local models | PROPOSED |
| TD-03 | Reject Claude Agent SDK (proprietary), Mastra, LangGraph and OpenAI Agents SDK as frameworks; Video Studio `spec/01` AIM-03 keeps the Claude Agent SDK as an optional runtime, which RFC section 13 lists as an amendment to reconcile | PROPOSED |
| TD-04 | Local durable execution is CreatorBrio's own domain state and job records; pg-boss is the hosted default, with Graphile Worker, DBOS and Hatchet as studied alternatives | PROPOSED (hosted choice DEFERRED to T10) |
| TD-05 | Inngest (SSPL server) and Restate (BSL server) are source-available, which `spec/08` excludes; Temporal and Trigger.dev have a self-hosting footprint out of proportion to one machine; none is used for the distributed product | REJECTED |
| TD-06 | Defuddle for page extraction behind the existing retrieval boundary | PROPOSED |
| TD-07 | Search through bring-your-own-key providers (Brave default; Tavily, Exa optional); self-hosters may supply their own search endpoint, including a service they run themselves, but CreatorBrio does not integrate, bundle or distribute SearXNG or any other AGPL service (`spec/08`); store only pages CreatorBrio fetches itself, never provider result payloads beyond transient use | PROPOSED |
| TD-08 | Competitor and trend study only through official platform APIs and links the person supplies; no downloaders or scraping | PROPOSED |
| TD-09 | promptfoo as a development-time harness, OpenTelemetry GenAI conventions for run telemetry, and an owned rubric judge plus cost ledger | PROPOSED |
| TD-10 | Speech, audio and image choices follow [OSS-RESEARCH.md](OSS-RESEARCH.md) sections E to G and remain subject to Video Studio gates G3, G4 and G9 | PROPOSED |
| TD-11 | Postiz and other AGPL schedulers (AGPL is excluded by `spec/08`), Mixpost, n8n and Activepieces (source-available editions, and a second platform to replace one module) are not used as code or runtime | REJECTED |
| TD-12 | Thin first-party platform clients inside the publisher; vendor SDKs only where permissively licensed | PROPOSED |
| TD-13 | Hosted stage: Better Auth, PostgreSQL with Drizzle, an S3-compatible adapter, OpenTelemetry and Pino; OpenBao optional | DEFERRED to the hosted stage |
| TD-14 | Mobile: Expo and React Native after hosted identity; Web Push first | DEFERRED |
| TD-15 | MinIO, HashiCorp Vault, Nango, Arize Phoenix server and Sentry server are not distributed (archived or source-available); Garage (AGPL-3.0) is neither integrated nor distributed, and a self-hoster may point the S3-compatible adapter at a store they run themselves | REJECTED |
| TD-16 | sharp (Apache-2.0, loading its prebuilt LGPL libvips dynamically, already in use) stays and adds the JPEG conversion; no new LGPL library is adopted, so Sidequest is rejected for that reason and because pg-boss covers the need; `spec/08` gets the clarification listed in RFC section 13 | PROPOSED |

## 4. Resolution of the independent review's findings

The [preserved review](reviews/2026-11-17-pr215-independent-review.md) returned APPROVE WITH REQUIRED CHANGES for direction and REJECT for implementation readiness.

| Finding | Resolution | Status |
|---|---|---|
| P0-1 Second domain model beside Production v2 | Removed; AD-03 and AD-05 | Resolved |
| P0-2 Local credentialed publishing inside the Design Agent's trust domain | Containment is the first milestone (AD-11); integration waits for it (AD-26); T1 is its gate | Resolved by plan; risk open until M1 passes |
| P0-3 Contradicts accepted decisions; platform before outcome | Infrastructure moved to the stages that need it (AD-09, AD-10, AD-16); amendments listed in RFC section 13; the first workflow builds on the existing carousel engine and publisher. Deviation from the review's correction, which asked to validate the outcome before publishing automation with stage-2 exit gates T2, T6 and T7: the roadmap merges the first workflow with publishing (phase 4), because the publisher is imported in phase 3, so publishing is not new infrastructure to defer. T2 stays a phase 4 gate, cost per approved artifact is recorded from the run records at phase 4 exit, and T6 and T7 move to the hosted commitment (phase 7) | Partly superseded |
| P0-4 Self-hosted publishing assumed a product feature | Superseded by FD-D (bring-your-own-app) with AD-18; the Instagram public-media conflict is answered by AD-19, the publisher's existing signed-link design | Superseded |
| P1-1 Workflow engine framed as central | AD-09 and AD-10 | Resolved |
| P1-2 Identity and asset access are the real SaaS and mobile rework | AD-14 and AD-15 | Resolved by plan |
| P1-3 Agent portability unproven; CLI cannot drive unattended runs | AD-13 and the typed-tool step of AD-11 | Resolved by plan |
| P1-4 Operating cost unmeasured | Per-run records, #184, proof T6 before pricing | Open until T6 |
| P1-5 Media execution inside the web process | AD-02 worker process (Video Studio WS5) | Resolved by plan |
| P1-6 Container distribution changes the licensing position | AD-24, proof T9 | Resolved by plan |
| P1-7 Storage semantics not portable | AD-16 and proof T8 | Resolved by plan |
| P2-1 Duplicate tracking issue #213 | Still open; recommend closing it as a duplicate of #214 | Open (administrative) |
| P2-2 Research should build on the retrieval boundary | AD-21 | Resolved |
| P2-3 Mobile premature | AD-22 | Resolved |
| P2-4 Outbox only with a database | Hosted stage, with AD-10 | Deferred |
| P2-5 Recipes undefined | Recipes are brand and style profiles plus parameters, in phase 9 | Deferred |
| P2-6 Local scheduling on a sleeping laptop | The publisher's native scheduling where platforms have it, and keep-awake while a post is due; a cloud publishing path is decided separately (AD-28) | Resolved for native platforms; for Instagram, keep-awake covers idle sleep only, and a machine that is off or closed misses the slot with an alert |
| P2-7 Vocabulary | RFC 5.3 maps the gates onto existing stages | Resolved |
| P2-8 Keep the good parts | Unknown-outcome reconciliation, server identifiers, capability refusal and approval invalidation survive, and the publisher implements them | Resolved |
| Review F1 Inside CreatorBrio | FD-A, FD-B | Superseded by founder decision |
| Review F2 Publishing distribution model | FD-D | Superseded by founder decision |
| Review F3 Open-core boundary | MIT kept (AD-23); whether a hosted control plane lives in a private repository is FQ-6 | Open |
| Review F4 Priority against Edit Studio | Roadmap: containment now, carousel workflow next, CreatorBrio video publishing after Edit Studio acceptance | Resolved by plan |
| Review F5 Accept a measured Design Agent quality change | FQ-4 | Open |
| Review F6 Budget for paid proofs | FQ-5 | Open |
| Review F7 LinkedIn as the first destination | Superseded by AD-29: the publisher publishes Instagram carousels in production | Superseded |
| Review statement "the external publishing project is unverified" | Assessed read-only for #216; see the [migration plan](SOCIAL-AUTOMATION-MIGRATION.md) | Superseded |

### Outcome of the review's section 8 (required changes)

Section 8 of the review asked for an overlap table and four proposed ADRs.
The register records each outcome here, because it is the one place where PROPOSED decisions live; a standalone ADR is written when the founder accepts the decision, so a document that reads as accepted never precedes the acceptance.

| Proposed change | Outcome | Status |
|---|---|---|
| Overlap table between the platform and WS1, WS3, WS5, WS8, WS9 and WS10 | Added to RFC section 4 as "Overlap with Video Studio workstreams", beside the module map it qualifies, stating that those workstreams own the capabilities | Resolved |
| Rights and credits (WS3) and review (WS10) relative to Gate 2 and the package | The rights and credits manifest is part of Gate 2 and the package (AD-33); review surfaces feed Gate 2, which is the final package approval (overlap table) | PROPOSED |
| ADR: product boundary (option A) | Adopted as AD-01 and RFC section 3, and decided by FD-A and FD-B; no separate ADR is needed | ACCEPTED |
| ADR: agent authority model for all agents | Adopted as AD-11 (containment), AD-12 (approvals) and TD-01 (one typed tool registry), with the Production API's run-scoped authority applying to every agent role (RFC 5.5, 7.4 and section 10); the standalone ADR is DEFERRED until the founder accepts them | PROPOSED (ADR DEFERRED) |
| ADR: identity and asset access | Adopted as AD-14 and AD-15 (RFC section 8); the standalone ADR is DEFERRED until the founder accepts them, and the identity work lands before any route leaves loopback | PROPOSED (ADR DEFERRED) |
| ADR: publishing distribution model | Adopted as FD-D, AD-18 and AD-19 (RFC 11.2); FD-D answers the review's open question, so no separate ADR is needed | ACCEPTED in principle |

## 5. Questions only the founder can answer

| ID | Question | Recommended default |
|---|---|---|
| FQ-1 | License the Social Automation code under MIT when it is imported (you are its sole author) | Yes |
| FQ-2 | Import as a sanitized snapshot with the private repository archived as the history of record, or import a filtered history | Snapshot plus archive |
| FQ-3 | Confirm the rule that every publication approval comes from you as a person principal (through CreatorBrio or your own interactive terminal) and that agents never record or judge approvals | Yes; one person approval covers all platforms of a package |
| FQ-4 | Accept a measured change in Design Agent quality from containment, including the temporary loss of the agent's own topic research until phase 2's research job and the Windows capability change (the Design Agent runs under WSL2, and is unavailable on native Windows without it), and authorize the one change to the frozen design prompt (its URL instruction) that disabling web fetch requires | Accept if the acceptance harness shows no material regression, and accept the topic-research and Windows changes as deliberate; otherwise decide on the measured numbers; authorize the URL-instruction change as part of M1 |
| FQ-5 | A spend cap for M1's containment and quality runs and later T6 and T7 | A small fixed cap per milestone, approved in advance |
| FQ-6 | Whether a future hosted control plane (billing, tenant administration, operations) lives in a private repository | Decide at the hosted stage |
| FQ-7 | When to start business verification and platform app reviews for the hosted edition | During phase 6, as paperwork |
| FQ-8 | Whether handling comments and messages on published posts is in CreatorBrio's product scope | Yes, in phase 9, only under an agreed reply policy |
| FQ-9 | Accept the revised sequence, including running the publisher import in parallel with containment and merging the first workflow with publishing (the deviation recorded under P0-3), and shipping the Python publisher to self-hosters in phase 6 (AD-07) | Yes |
