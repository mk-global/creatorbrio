# Social Automation migration plan

**Status:** PROPOSED under [#216](https://github.com/mk-global/creatorbrio/issues/216), revised under [#218](https://github.com/mk-global/creatorbrio/issues/218); no code has moved.

**Date:** 2026-11-18 (revision 2 was 2026-11-17).

**Decision context:** founder decision FD-C in the [decision register](DECISION-REGISTER.md); architecture in the [RFC](ARCHITECTURE-RFC.md).

This plan is public.
It describes only how the code moves: the snapshot, the import, continuous integration, the deploy source, the shadow period, the cutover and the rollback.
The invariants of the publishing domain are stated once, as design, in [RFC section 5.4](ARCHITECTURE-RFC.md#54-publishing-domain).
Account names, platform identifiers, credential names, cloud project names, private issue references and security-sensitive details never appear here, and the detailed assessment is kept privately by the owner.

## 1. What was assessed

The Social Automation repository was located in the founder's development environment and read without modification on 2026-11-17 at its `main` branch head.
The assessment covered its documentation, every module, configuration, tests, governance files and git history.

**What it is.**
A Python 3.12 command-line system using only the standard library, with SQLite state, an append-only event log, a content-addressed media store and a scheduled runner on macOS.
It publishes Instagram Reels and carousels, Facebook Page Reels and photo posts, and YouTube videos for its owner's accounts, and has done so in production since 2026-11-15.

**What makes it valuable.**
- A fingerprint over a canonical form of every file and setting of a package, which excludes the slot.
- Append-only versions, stagings, approvals and revocations, enforced by database triggers, with approval in force derived by one function.
- Per-platform state machines that record "a publish call was sent" before sending it, read the platform after any lost answer before repeating anything that could post, believe "gone" only after two reads, never delete a live post, and arm native schedulers only with the last call.
- Bounded retries with classified failures, one alert per situation, and missed slots instead of late posts.

**Test evidence.**
The Python suite (810 tests in the assessment run) passed in an isolated clone with the network, keychain, scheduler and notification commands stubbed; none of the stubs was invoked.
Many tests are regression cases from repeated independent review rounds on lost answers, withdrawal and approval lapse.

The invariants of the publishing domain are stated once, in [RFC section 5.4](ARCHITECTURE-RFC.md#54-publishing-domain); the imported suite plus T2 and T12 are the import gates.

**Sensitive material.**
No secret values were found in tracked files or history, so nothing needs rotating for the migration.
Operational detail of the kinds listed in section 4 stays private, so the history is not published.

**Fit with CreatorBrio today.**
CreatorBrio exports carousels as PNG, in 1:1, 4:5 and 9:16, with 1 to 20 slides.
The publisher accepts only upright JPEG slides, 2 to 20 of them, all of one shape between 4:5 and 1.91:1, because that is what Instagram publishes without cropping.
So 9:16 and single-slide carousels cannot be published as carousels, and conversion must happen in CreatorBrio before staging, so that the person approves the converted bytes.

## 2. Decision

**Move the publisher into CreatorBrio as an isolated Python module and process, with its behavior and tests intact, apart from the recorded P1 changes; do not rewrite it, and do not copy its folder in and call the integration done.**

- Its package, fingerprint, approval-in-force rule, per-platform lifecycle, reconciliation and never-delete-live rules become CreatorBrio's publishing domain (RFC 5.4), so there is no second domain model.
- Its runner becomes CreatorBrio's only publication scheduler (AD-08), so there is no second scheduler.
- Its approval records become the `publication` scope of the shared approval contract, created only for a person principal (AD-12), so there are no duplicate approvals.
- It stays in Python because the logic that makes it safe is dense, live-verified edge-case handling pinned by its tests, the Video Studio ADR already allows local Python workers, and a separate process gives credential use one narrow, auditable interface.
  A separate process is not privilege separation from other processes of the same operating-system user; credentials are protected from agents by containment (M1, proven by T1 on the publishing host), and operating-system account separation is the escalation (AD-45).
  A TypeScript port is decided before a third new platform adapter is built or at the hosted stage, whichever comes first, behind the full parity suite (AD-07).

## 3. Target shape in the repository

```text
publisher/                     Python package, standard library only
  src/...                      the imported modules, with behavior and tests intact apart from the recorded P1 changes
  tests/                       the imported suite, plus parity and contract tests
  examples/accounts/           example account configuration with placeholders
  docs/                        publisher architecture, packages contract, runbooks, self-hoster guides
```

- Operator configuration (real accounts, platform identifiers, credential item names, system settings) lives outside the repository in the publisher's state directory, read from a configured path; the repository carries only examples.
- CI for the module runs on GitHub-hosted runners only, and a test fails if any workflow names a self-hosted runner or a private reusable workflow.
- The publisher keeps its own state directory, SQLite database, event log and content-addressed store, so cutover moves code, not data.
- CreatorBrio's app talks to the publisher only through a publisher client (section 6); no TypeScript module reads the publisher's database.

## 4. Sensitive material that must never enter the public repository

By category (the exact list is kept privately by the owner):

- account configuration naming real brands, timezones, platform account, Page and channel identifiers;
- names of credential items in the OS keychain, and the cloud provider and project names behind them;
- system configuration naming the operator's bucket, alerting and calendar resources;
- documentation and decision records that name accounts, people, business portfolios, token scopes of real tokens, or security-sensitive findings;
- references to private issues and private organisation tooling, including any workflow that names a private runner or a private reusable workflow;
- commit messages and history that contain any of the above;
- local virtual environments, caches, `.gstack/` and any runtime state (none of which is tracked, but a careless copy could include it).

The import is therefore a **sanitized snapshot**, not a history import (FQ-2):

1. Prepare the snapshot in the private repository (section 5, step P1).
2. Scan the snapshot with a secret scanner and a list of private identifiers taken from the private configuration; the scan must return nothing.
3. Import the snapshot in one commit under `publisher/`, recording the source repository and commit in `docs/PROVENANCE.md`.
4. Archive the private repository read-only as the history of record; its history keeps authorship and the reasoning behind each change.

A filtered-history import is possible but not recommended: the history is short, and rewriting every message safely costs more than the history is worth in public.

## 5. Migration steps

| Step | Where | What | Exit criteria |
|---|---|---|---|
| P0 | Founder | Answer FQ-1 (MIT licence), FQ-2 (snapshot) and the open half of FQ-3 (authorizing P1's removal of nonconforming approval paths); FQ-3's rule was answered by FD-H on 2026-11-18 | Recorded in the decision register |
| P1 | Private repository | Prepare the snapshot: configuration is read from a path outside the repository; owner-specific values and documentation are excluded from the snapshot; the suite runs on GitHub-hosted runners; the snapshot satisfies every invariant of RFC 5.4, including the attribution rule of AD-38 and the staging provenance of AD-41, and any change needed for that is recorded with its replacement tests; any approval path that does not meet FD-H is removed or disabled, which needs the founder's authorization under FQ-3 because it changes live publishing behavior. If a P1 change alters how a package's fingerprint is computed, packages not yet posted are re-approved before the shadow window | The full suite passes, each recorded behavior change has its replacement tests, and the runner deploys and runs |
| P2 | CreatorBrio | Import the sanitized snapshot under `publisher/`; add a Python job to CreatorBrio's GitHub-hosted CI running the suite with the standard library only (on hosted Linux and macOS runners, never a self-hosted runner, because the repository accepts outside contributions); mark the suite's fake credentials so secret scanners do not flag them; add provenance and the licence record | Scan clean; suite green in CreatorBrio CI; independent review passes |
| P3 | Founder's machine | Shadow: the runner keeps running from the standalone repository while `dry-run` and read-only status commands run from the CreatorBrio copy against the same packages | Identical results for every package in the window (T12) |
| P4 | Founder's machine | Cutover, after T1 has passed on this machine, the actual publishing host (FD-I; see below): the runner deploys from a pinned CreatorBrio commit, with the deploy gate testing the `publisher/` tree; the state directory stays where it is | The first live posts after cutover are watched and correct |
| P5 | Both | Rollback window of at least 30 days and at least ten successful posts across platforms; then archive the standalone repository | No rollback needed; archive recorded |
| P6 | CreatorBrio | Integration (roadmap phase 4): package builder, publisher client, Gate 2 card, notifications, the `manual` destination (section 8) | T2 and the phase 4 acceptance criteria |

The database schema is frozen from P3 until P5 ends, so a rollback to the standalone code can open the same database.
Any schema change waits until the standalone repository is archived.

**Why cutover waits for containment.**
The import (P2) does not wait for it: it adds code that becomes public anyway and exposes no credential, because credentials stay in the OS keychain outside the repository.
The cutover does wait, because from then the live runner deploys from this repository, and an unconfined agent with a shell can write to that checkout.
By founder decision FD-I, the cutover waits for T1 to pass on the actual publishing host, which includes the canaries for writes outside the agent's carousel folder, the keychain and the app's API; a recorded baseline is not that proof.
If T1's keychain canary cannot pass there while the agent keeps a shell, the remedies of AD-45 apply first (a profile without a shell, or a separate operating-system account), and the cutover keeps waiting.
T1 on every supported platform is required before phase 4's credential integration (RFC section 14).

## 6. The interface between CreatorBrio and the publisher

The first integration uses the publisher's command-line interface with machine-readable output, run as a subprocess by CreatorBrio's server; it adds no network port and no new service.

| Operation | Direction | Contract |
|---|---|---|
| Stage | CreatorBrio to publisher | A package folder: files (JPEG slides, or video and cover) and a manifest with the account, key, slot, platforms and per-platform text and declarations, plus the staging's provenance (brand, content kind, identifier and revision, dossier identifier and revision when there is one), recorded with the staging and outside the fingerprint (AD-41); returns the fingerprint and a review card |
| Show | CreatorBrio to publisher | The review card of the newest version, rendered for Gate 2 from the stored package |
| Approve | CreatorBrio to publisher | Account, key, fingerprint, the person principal's identifier, the permission exercised and the person's statement; only for the newest version; refused for any other fingerprint |
| Revoke | CreatorBrio to publisher | An approval, the person principal's identifier and a reason; returns which copies will be withdrawn and which stay live |
| Reslot | CreatorBrio to publisher | A new local slot time, the identifier of a person principal holding `schedule` and a reason; never touches the approval; recorded as an attributed event (AD-06) |
| Status | CreatorBrio to publisher | Every publication of a package with its state, platform link and stop reason |
| Handoff | Both ways | For a `manual` destination (section 8): the frozen handoff bundle of an approved package, refused for any other fingerprint, and the person's confirmation that it was posted, recorded for a person principal as an attributed event |
| Events | Publisher to CreatorBrio | The append-only event log, each event with a sequence number and an actor, read from a cursor, for notifications, the calendar view (AD-44) and history |

Mutating commands are serialized with the runner's tick (RFC 5.4), so a call never interleaves with a publication step.
Approval and reslot operations follow the approval authority of [RFC section 5.5](ARCHITECTURE-RFC.md#55-approval-authority-in-the-publishing-domain); agents never receive a route to this interface, which containment (M1) and typed tools enforce.
At the hosted stage this interface becomes an authenticated service API with the same operations.

## 7. Ports of the publishing module

The module reaches credentials, triggers, keep-awake, media hosting, notifications and its store only through these ports (RFC section 5.4).

| Port | Reference adapter | Self-hosted adapters | Hosted adapter |
|---|---|---|---|
| Secret store | macOS Keychain | Linux Secret Service; encrypted file for headless servers | Managed key service, tenant-scoped |
| Trigger | launchd calendar job | systemd timer; cron; an always-on supervisor | Always-on worker |
| Keep-awake | `caffeinate` while a post is due | `systemd-inhibit`; none on servers | None |
| Media host | One private bucket with 24-hour signed links | Any S3-compatible bucket with presigned URLs that the platform can fetch | Operator's bucket, tenant prefixes |
| Notifier | Phone push service and desktop notifications | ntfy, email or webhook; CreatorBrio in-app records | CreatorBrio notifications |
| Store | SQLite, event log, content-addressed files | Same | PostgreSQL and object storage |

Each port gets a conformance test before a new adapter ships.
macOS parity comes first; Linux support is claimed only after its adapters pass the suite (roadmap phase 5).

## 8. Platform adapters and their ownership

- The Instagram, Facebook Page and YouTube clients move as they are and are owned by the publishing module.
- The module defines one adapter surface (`check`, `validate`, `prepare`, `publish` or `schedule`, `find_live`, and the platform reads the insights module uses) and its conformance tests when the first new adapter is added (roadmap phase 9); the import does not rework the existing clients.
- New platforms (LinkedIn, TikTok) are built inside the same module against that surface (roadmap phase 9).
- The manual handoff is a `manual` destination of the same module (roadmap phase 4, AD-36): the publisher holds the frozen package and the Gate 2 approval for a platform that is not automated exactly as for any other, the person receives the frozen handoff bundle and confirms the posting, and no platform is called.
- The account-level insight snapshots move with the publisher and become the insights module's data, re-keyed by publication when the readback lands in roadmap phase 5 (AD-42); insights is a separate module that uses the same connections, not part of publishing.
- Connections, destinations and accounts follow AD-40: an account is one brand's named set of destinations, a brand may have several, and each connection's publishing, insights and engagement capabilities are used only by their own modules.

## 9. Credentials and authorization

- Self-hosted use: the self-hoster's own platform apps; tokens in the OS keychain or Secret Service; nothing secret in configuration, the database, the event log or logs (rules of the publishing module).
- The publisher process is the only reader of social credentials; CreatorBrio's app, worker and agents never read them.
- Hosted: the operator's reviewed apps, per-tenant OAuth grants stored encrypted with rotation, behind the hosted secret adapter.
- Tokens carry least privilege: each account's token holds only the scopes the module's operations need, checked before onboarding to the hosted edition.

**Isolation targets for the publisher process.**
- The publisher runs as its own operating-system process, started by its own trigger, with its own state directory outside the repository; the publisher's credentials and state sit outside every agent's reach (agent containment, M1).
- Only the publisher process reads social credentials; the app, the worker and agents do not, and their environments carry none.
- CreatorBrio reaches the publisher only through the command interface in section 6; no TypeScript module reads its database or content-addressed store.
- Agents have no route to the publisher except CreatorBrio's API, which requires a person principal holding the matching permission on every publisher operation that changes an approval, a slot or an account, so agent-run tokens and requests without a person credential, including tokenless requests with no `Origin`, are refused.
- The publisher's own process is fault isolation and one narrow interface, not privilege separation from other processes of the same operating-system user (AD-45); operating-system account separation for the publisher is DEFERRED to a multi-person server deployment, to T1 needing it, or to the hosted stage.
- Hosted mode runs the publisher as a separate service with per-tenant credentials and an authenticated interface, never inside the web process.
- These targets are verified by T1 (agent containment, on the publishing host before cutover), T2 (approval binding) and a test that no social credential reaches the app, worker or agent environment.

## 10. Proving parity before retiring the standalone system

- The imported suite passes in CreatorBrio CI with no test weakened or removed, except tests of approval paths removed under P1, each replaced by a test of the RFC 5.4 rule.
- New contract tests pin the machine-readable outputs CreatorBrio depends on, and a test proves that mutating commands and the runner's tick never interleave (T12).
- The shadow window (P3) shows identical dry-run and status results on real packages; the P1 changes land in the private repository and the standalone runner deploys them before the window, so both copies carry them.
- After cutover, the first post on each platform is watched; the standalone runner stays loadable from its last commit for the rollback window.
- Equivalent or better: any later change to publishing behavior (for example a new adapter) must keep the whole suite green and add tests for its own behavior.

## 11. Rollback and decommissioning

- **Before cutover:** nothing in production changed; remove the import if it is abandoned.
- **During the rollback window:** unload the runner, deploy the standalone repository's last commit with its own deploy command, and reload; the state directory and database stay usable because the schema is frozen.
- **Decommissioning:** after the window, archive the standalone repository read-only, keep its operator documentation in the private operations folder, and remove its runner deploy path.
- **Not migrated:** the calendar check (CreatorBrio becomes the plan, AD-27); a cloud publishing path is not part of this plan and is decided separately (AD-28).

## 12. Risks

| Risk | Mitigation |
|---|---|
| Private operational data reaches the public repository | Snapshot, not history; scanner plus a private identifier list; independent review |
| The deploy gate tests the wrong tree after the move | The deploy command is changed to test `publisher/` at the pinned CreatorBrio commit, with a test that fails if it tests anything else |
| Two scheduling paths while both copies exist | Only one runner is ever loaded; the shadow uses dry-run and read-only commands |
| An approval recorded without a person principal | Approve is reachable only through the CreatorBrio server for a person principal holding the permission, or from the person's interactive terminal; agents have no route to it (T2, M1 containment); any approval path that does not meet FD-H is removed or disabled at P1, and every approval records its person principal (AD-38) |
| Python becomes a prerequisite for self-hosters | Needed for every Gate 2 publication, the manual handoff included, because the publisher holds every frozen package and approval; the standard library only; documented in setup; phase 6 ships the Python publisher to self-hosters as an accepted consequence (AD-07, FQ-9) |
| Duplicate alerts once CreatorBrio notifications exist | One delivery owner per alert, switched in phase 4 |
| A slot is missed because the machine is off or the lid is closed | Keep-awake covers idle sleep only; a missed slot is a known limit of local-first publishing, surfaced as an alert; a cloud publishing path is decided separately (AD-28) |
| Fake test credentials trip secret scanning | Marked as fixtures in P2 before the first scan |
