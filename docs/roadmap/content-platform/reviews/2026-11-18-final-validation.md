# Final product and architecture validation before implementation

**Date:** 2026-11-18, under [#218](https://github.com/mk-global/creatorbrio/issues/218).

**Subject:** revision 2 of the [RFC](../ARCHITECTURE-RFC.md), [roadmap](../ROADMAP.md), [migration plan](../SOCIAL-AUTOMATION-MIGRATION.md) and [decision register](../DECISION-REGISTER.md), merged in #217, tested against the founder's positioning (FD-F) and deferment principle (FD-G).

**Stance:** an evidence-based review whose findings were written into revision 3 of those documents in the same change.
It does not replace the independent reviewer on the pull request or the founder's acceptance of PROPOSED decisions.
Documentation being complete does not mean anything in it is implemented.

## 1. Method and evidence

- **Merged code**, read on 2026-11-18 at `main` 64c399c, for what exists rather than what is proposed:
  - carousels have no revision counter, and their routes are guarded only by loopback and Origin checks, which allow any request without an `Origin`;
  - the Design Agent is told to call carousel and style-preset routes with `curl`;
  - brands hold visual identity only;
  - Production v2 embeds a research dossier without an identifier, and its approvals and review comments name a generic actor rather than a person;
  - the Video Studio API already separates a human credential from run-scoped agent tokens.
- **The private Social Automation repository**, read without modification, and the earlier private assessment, for publishing behavior, approval records, account structure, insight snapshots and scheduling.
  Only target invariants and plan steps are published here; nothing about the live system's identifiers, configuration or current weaknesses is.
- **The vendor's [sandboxing documentation](https://code.claude.com/docs/en/sandboxing.md)**, re-read on 2026-11-18, for the facts the first milestone depends on (RFC 7.4).
- **Public vendor pages of existing products**, read on 2026-11-18, for positioning (section 2).

## 2. Positioning against existing products

The positioning's claimed differentiation is the combination of (1) research with cited sources behind each piece, (2) brand-consistent AI production, (3) approval of the exact final package, (4) publishing and scheduling and (5) performance fed back into the next piece's research.
Where a page said nothing about a capability, that is recorded as silence, not as proof of absence.

| Product | (1) Cited research | (2) Brand-consistent production | (3) Exact-package approval | (4) Publishing | (5) Performance into research |
|---|---|---|---|---|---|
| Buffer | Partial, through an external research tool | Partial, text only | Approval workflow on team plans; locking unverified | Yes | Partial, AI takeaways |
| Later | No | Partial | Approval workflow on higher plans | Yes | Partial, timing and trends |
| Hootsuite | Partial, cited listening insights (seen in search results for its 2026 release notes, not read directly) | Partial, text and images | Yes, on higher plans | Yes | Partial, recommendations; use of own results unverified |
| Sprout Social | Partial, listening summaries without citations | Partial, text | Multi-step approval; unapproved posts do not publish | Yes | Partial, timing and report takeaways |
| Planable | No | Partial | Yes, including content locked after approval | Yes | Partial, analytics add-on |
| Metricool | No | Partial | Approval system on higher plans | Yes | Partial, analytics without a loop |
| Predis.ai | No | Yes, carousels and video with a brand kit | Approval flow; locking unverified | Yes | Partial, suggestions; loop unverified |
| Ocoya | No | Yes | Partial, drafts to approve | Yes | Partial, claim without a described mechanism |
| Jasper | Yes, cited research reports | Partial, images only | Partial, status labels | No | No |
| Taplio | Partial, a post database without citations | Partial, LinkedIn carousels | Partial | Yes, LinkedIn only | Partial, repurposing top posts |
| Canva | No | Yes, with a brand kit | Partial, design approval only | Yes | Partial, basic post figures |
| Postiz (AGPL-3.0) | No | Partial | Partial, preview links; approval not enforced | Yes | Partial, per-post analytics |

Sources, all read on 2026-11-18: buffer.com/pricing, later.com/pricing, hootsuite.com/plans, hootsuite.com/platform/ai, sproutsocial.com/pricing, planable.io/pricing, planable.io/guides/content-approvals-in-planable, metricool.com/pricing, predis.ai/pricing, ocoya.com/pricing, jasper.ai/pricing, jasper.ai/agents/research, taplio.com/pricing, docs.postiz.com/general/approvals.
Canva refuses automated page reads, so its row comes from search-result summaries of its help pages and is unverified.
Plan placement for some features, whether some products lock a post after approval, and whether any vendor's recommendations really use the account's own results are unverified.

**Conclusions.**

- Scheduling, approval workflows, brand kits, AI captions and basic analytics are table stakes; none differentiates CreatorBrio alone.
- Cited research attached to the piece that ships, and a loop from performance into the next piece's research, are rare, and no product checked combines them with an approval of the exact final package.
- The combination is a plausible differentiation, not a demonstrated competitive advantage: one incumbent reportedly added cited insights in 2026 and another already locks content after approval, so the window may be short.
- Approval workflows are sold mainly in team and agency tiers, so whether solo creators value formal approval is an open assumption.
- An advantage would be demonstrated by side-by-side runs on the same objectives scored for factual accuracy, the share of claims with sources and reviewer edits; time from objective to approved post; measured improvement in later pieces when the loop is used; and target users choosing to pay for it.
  T7 and T6 are where those measurements belong, and revision 3 runs T7 after phase 4, before open-source release claims (FQ-9).

## 3. Findings

Severity: P0 blocks implementation; P1 must be resolved before the phase it affects; P2 should be resolved and does not block; P3 is a note.
No P0 was found.

| ID | Severity | Finding | Product impact | Action taken | Blocks |
|---|---|---|---|---|---|
| V-1 | P1 | The shared approval contract left "principal" undefined, Production v2 records a generic `by: "user"`, and approval and publication records are meant to be immutable | Team review, delegated approval and audit would later need a change to records that cannot be changed | Every human-attributed record carries a stable principal identifier; absent fields and `by: "user"` read as the local owner, agent and system records never do (AD-38); authority is a permission (AD-39, FD-H) | Phase 2 approvals and migration step P1 must implement it; M1 does not depend on it |
| V-2 | P1 | Under Route A the contained shell keeps full authority over every carousel, brand and template through the app's API, because the request guard allows any request without an `Origin` and the routes take no credential | A hostile page could make the agent delete or rewrite other projects | M1 confines the agent to an agent-only listener scoped to its run's carousel, or typed tools; the criterion is an outcome tested by T1 (AD-46) | M1 acceptance, not M1 start |
| V-3 | P1 | The live cutover waited only for a recorded containment baseline | Live publishing could deploy from a repository an unconfined agent can write to | The cutover waits for T1 to pass on the actual publishing host (FD-I, AD-26) | Phase 3 cutover |
| V-4 | P1 | The RFC and migration plan described the separate publisher process as credential isolation | A false sense of protection: same-user processes reach the same secrets | Corrected; containment is the control, operating-system account separation the escalation (AD-45) | No |
| V-5 | P2 | A brand linked to exactly one connected account, and platform insights sat inside publishing | Several accounts per brand, and separate analytics and engagement permissions, had no owner | Connections, destinations and accounts with per-capability use; insights and engagement as separate modules (AD-40, AD-42, AD-43) | Phase 4 design |
| V-6 | P2 | A research dossier has no identity, a carousel has no revision, and stagings record no provenance | A published post could never be traced back to its research and creative revision | Identifier chain from dossier to performance (AD-41, RFC 5.7, T13) | Phases 2 and 4 must implement it |
| V-7 | P2 | The positioning's measurement loop was scheduled after the hosted and mobile phases | The product would launch as an AI scheduler, which the positioning rules out | Read-only performance readback in phase 5 (AD-42) | No |
| V-8 | P2 | The editorial plan was undefined while the publisher's check against an external plan is not migrated (AD-27) | The founder would lose a planning view, with a risk of a second scheduler being invented | Plan entries are intent and never trigger anything; one scheduler (AD-44) | Phase 4 design |
| V-9 | P2 | Small teams are primary customers, but remote review needs an identity beyond loopback | Teams cannot be served by the local product | Recorded in RFC 1.1: teams are served by the hosted edition or a self-hosted server after identity work | No |
| V-10 | P2 | The positioning's outcomes and the value of formal approval to solo creators are unmeasured | Building toward an unvalidated advantage | T7 runs after phase 4, before release claims (FQ-9) | No |
| V-11 | P2 | M1's proof needs Linux and WSL2 test hosts that are not provisioned | The milestone cannot complete on those platforms without them | A platform that cannot be tested is reported unavailable until proven, not treated as a Route A failure (AD-35) | The rest of M1 until a Linux host runs the proof; Design Agent availability on WSL2 until a Windows host does |
| V-12 | P3 | `strictAllowlist` needs Claude Code 2.1.219 or later, and an `allowedDomains` entry without a port opens every port | Route A could silently allow every local port | The profile refuses older CLIs and always names a port (AD-35) | No |
| V-13 | P3 | The agent's file-reading tool runs outside the operating-system sandbox, and Keychain behavior under the sandbox is undocumented | Two containment legs rest on tests, not enforcement | Already acknowledged; T1's canaries test them, and AD-45 states the remedies if the keychain canary fails | No |

Positioning, licensing and provenance were also checked: nothing in revision 3 adds a dependency, distributed component or licence change, and MIT with the Open Carrusel notice stays as it is.

## 4. Complexity audit: what the MVP refuses to build

- A workflow engine, queue or database server for the local product (AD-09).
- Workspaces, membership, invitations, team screens, single sign-on or hosted tenancy before the hosted stage (AD-39).
- A campaign or objective entity; the dossier is the cross-format anchor (AD-04, AD-41).
- A second scheduler, or plan dates that trigger anything (AD-44).
- Metric schemas, dashboards, experiments or ROI attribution before the readback is used (AD-42).
- A unified inbox, message storage, AI replies or moderation before an independent review (AD-43).
- An agent framework, a plug-in system, or a separate API process (TD-01, AD-37).
- Ports extracted before their second adapter exists (AD-16).
- A TypeScript port of the publisher now, a cloud publishing path, Kubernetes, a hosted control plane or a native mobile client (AD-07, AD-28, FQ-6, AD-22).

## 5. Proofs still required

None of these has been run; each is a gate in the [roadmap](../ROADMAP.md).

- The Route A feasibility proof on the publishing host, Linux and, where a test host exists, WSL2 (AD-35).
- T1 baseline against today's agent, then T1 passing on the publishing host before cutover and on every supported platform before credential integration.
- T2 approval binding, including the no-Origin request and permission checks, before the first integrated publish.
- T12 publisher parity and the shadow window before the standalone publisher retires.
- T13 provenance chain with the phase 5 readback.
- T7 creator outcome after phase 4; T6 cost before pricing; T8, T10 and T11 before the hosted stage; T9 before any container release.

## 6. Readiness verdicts

Each label judges the design: whether the work can proceed without a foreseeable redesign.
Prerequisites are governance and proof gates that the plan already places before the work they protect; they do not change the label, but the named work must not start without them.
Non-blocking conditions can be met while the work proceeds.

**A. Architecture foundation: READY.**
Every capability area has an owner and a classification, and the contracts that immutable records would make costly to retrofit (person identity, permissions, connection cardinality, the identifier chain, one scheduler, one approval contract) are designed now.
No foreseeable capability in the matrix needs a change to data ownership or authorization later.
Prerequisites: the founder accepts or amends AD-38, AD-39 and AD-41 before phase 2 and migration step P1 implement them, and AD-40 and AD-44 before phase 4; the WS1 and WS9 owners agree dossier identity and the `Approval` generalization before phase 2 (RFC section 13).
Brand-limited grants are a deferred extension point (AD-39), not a condition.

**B. M1 implementation: READY WITH NON-BLOCKING CONDITIONS.**
M1 depends on no other phase, addresses a risk that exists today, and its first ticket changes no product behavior; no foundational question is unresolved.
Prerequisites before implementation starts: the founder accepts the decisions M1 implements (AD-11, AD-35 and AD-46), and each M1 ticket is admitted under the canonical ticket policy, #186 included.
Prerequisites inside M1: a Linux test host for the feasibility proof before the rest of M1 proceeds; the FQ-5 budget before the T1 baseline runs; FQ-4 before the prompt change merges; Claude Code 2.1.219 or later.
Non-blocking condition: a Windows test host for WSL2; without one, WSL2 is reported unavailable until proven.

**C. End-to-end product: READY WITH NON-BLOCKING CONDITIONS.**
Each phase has an outcome, gates and deferrals, so the stages can proceed in order without finalizing deferred or future modules now.
Prerequisites: FQ-1, FQ-2 and the open half of FQ-3 before the publisher import; FQ-9, the founder's acceptance of the revised sequence, before phase 3; T1 passing on the publishing host before cutover; the Video Studio `spec/01` amendment before any video is published; T7 evidence before open-source release claims.
Non-blocking conditions: platform facts are re-verified before each phase that depends on them; the positioning's outcome and commercial assumptions stay unvalidated until T7 and T6 measure them (FD-F).

**Answer to the final question.** Yes: CreatorBrio can begin implementation without a reasonably foreseeable need to redesign its foundational architecture, as soon as the founder accepts M1's decisions (AD-11, AD-35, AD-46) and M1's tickets are admitted, and provided the other foundational decisions are accepted before the phases that implement them.
Build M1 first, starting with the ticket "Prove the Design Agent's sandbox network route" and, in parallel, the T1 harness with its baseline against today's agent.

## 7. Decisions that need the founder

- Accept or amend the decisions M1 implements, AD-11, AD-35 and AD-46, before M1 starts.
- Accept or amend AD-38, AD-39 and AD-41 before phase 2 and migration step P1, then AD-40 and AD-42 to AD-45 before the phases that use them.
- The open half of FQ-3: authorizing P1 to remove or disable approval paths that do not meet FD-H, and the AD-38 treatment of earlier approvals, which would change live publishing behavior if the snapshot has such a path or record.
- FQ-1 (MIT licence for the publisher) and FQ-2 (snapshot import), before the import.
- FQ-4 (accept a measured quality change and authorize the prompt changes, now including the API-call change AD-46 requires) and FQ-5 (budget), for M1.
- FQ-6 and FQ-7, at their stages.
- FQ-9, the revised sequence.

## 8. What this review may still get wrong

- It is one author's review; the independent reviewer and the founder are the checks.
- The competitor scan read public pages on one day; products change quickly and several facts are unverified.
- Whether an agent-only listener fits cleanly beside the Next.js app is a design question for the confinement ticket; if it cannot be built to AD-46's scope, Route B is used, as AD-46 records.
- The vendor's sandbox behavior can change between CLI versions, which the recorded CLI version and on-demand T1 reruns are meant to catch.
