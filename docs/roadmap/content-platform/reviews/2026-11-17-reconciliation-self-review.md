# Adversarial self-review of the reconciled architecture

**Date:** 2026-11-17, under [#216](https://github.com/mk-global/creatorbrio/issues/216).

**Subject:** the [RFC](../ARCHITECTURE-RFC.md), [roadmap](../ROADMAP.md), [migration plan](../SOCIAL-AUTOMATION-MIGRATION.md) and [decision register](../DECISION-REGISTER.md) of revision 2.

**Stance:** written by the author of revision 2, deliberately against it.
It is not a substitute for the independent reviewer on the pull request or for the founder's decisions.

Each challenge ends with what changed in the documents because of it, or why nothing did.

## 1. Unnecessary complexity

**1.1 Two languages in one repository.**
Keeping the publisher in Python means two toolchains, two test runners, two styles of error handling and a subprocess boundary.
The publisher assessment estimated a careful TypeScript port at 35 to 55 engineer-days and noted that keeping Python only defers it, since the macOS-specific parts must be replaced either way.
It recommended a staged TypeScript port and advised against shipping a Python process to public users.
Counter-argument: the port would rewrite the most safety-critical, live-verified code before any user value, a separate process is wanted for credential isolation anyway, and Video Studio ADR item 10 already allows Python workers.
Weakness that remains: every new platform adapter written in Python enlarges a future port, and phase 6 ships the Python publisher to self-hosters.
**Changed:** AD-07 now names a trigger: the port decision is made before a third new platform adapter is built, or at the hosted stage, whichever comes first.
It also records the departure from the assessment's recommendation, and FQ-9 asks the founder to accept shipping the Python publisher to self-hosters.

**1.2 A subprocess command line as the integration interface.**
Parsing command output is brittle, spawning a process per call adds latency, and calls made while the runner is mid-tick must not race it.
**Changed:** RFC 5.4 now lists, among the invariants of the publishing module, that mutating commands and the runner's tick are serialized, so a command never interleaves with a publication step, and T12 proves it.
The migration plan also adds contract tests that pin the machine-readable outputs CreatorBrio depends on (section 10).

**1.3 The shared contract module could be premature.**
WS9 has not started research for video, so lifting types now could freeze a shape before its first real use.
Counter-argument: the lift is a re-export of existing types with no behavior, and carousels are the first real user.
**Unchanged.**

**1.4 Ports everywhere.**
Defining ports for secrets, triggers, keep-awake, media hosting, notifications and every store before a second adapter exists is speculative.
**Unchanged:** the roadmap already defers Linux adapters to phase 5, and the RFC's port table is a map, not a work item; a port is worth extracting only when its second adapter is built.

## 2. Conflicting requirements

**2.1 "The open-source edition completes the advertised workflows" against "self-hosters register their own platform apps".**
Most non-developer creators will not complete Meta Business setup, system-user tokens and a bucket.
The manual handoff keeps the workflow complete, but "automation" is then honest only for technical self-hosters.
**Changed nothing structurally; the RFC section 11.2 wording already limits the promise, and the release messaging must follow it.**

**2.2 FD-A's research approval against today's quick carousel flow.**
Forcing a research gate on every carousel would remove an existing capability, which the brief says to preserve.
**Changed:** the roadmap's phase 2 states that Gate 1 applies when an item asks for research; designing directly from a brief remains available.

**2.3 "Agents never approve" against low-friction approval.**
Requiring a person principal for every publication approval costs a person a step each time, which a convenience-minded design would automate.
The unified product's rule is that no agent creates or judges an approval, and one person approval covers all platforms of a package.
**Unchanged:** the rule stands; founder question FQ-3 asks the founder to confirm it, with a recommendation, so it is not silently assumed.

## 3. Unproven assumptions

- **Claude Code's sandbox contains the agent well enough.**
  The vendor states that permission rules are not a security boundary ([permissions documentation](https://code.claude.com/docs/en/permissions.md), retrieved 2026-11-17) and that the sandbox covers the shell but not the `Read` or `WebFetch` tools ([sandboxing documentation](https://code.claude.com/docs/en/sandboxing.md), retrieved 2026-11-17).
  Whether the web fetch switch depends on the CLI version, and whether local IPC (for example to the keychain service) escapes network and file rules, are risks that T1 tests with canaries; they are not taken from vendor documentation.
  **Changed:** the roadmap now makes T1 the gate for any credential integration (phase 4), with canaries for the `Read` tool, the keychain, the browser profile and cookie stores, a Unix domain socket connection and, on WSL2, a Windows binary launch (RFC T1); if step 1 cannot pass T1, typed tools (step 2) become a prerequisite for phase 4 rather than a follow-up.
  The execution profile records the CLI version T1 last passed on; a different version starts with a visible warning in the app and in the doctor command, and T1 is rerun on that version on demand.
  The sandbox does not run on native Windows, so there the Design Agent runs under WSL2 or is reported unavailable with setup guidance, a deliberate capability change listed in M1's risks.
  On Linux and WSL2 without the sandbox prerequisites (bubblewrap, socat and the seccomp filter) it is likewise reported unavailable with setup guidance, and the doctor command checks for all three.
  The agent's own API calls are a further unproven point: the Design Agent creates slides by calling the app's API from its shell, and the vendor documents that a sandboxed command cannot connect directly to a server outside the sandbox by default, that `network.allowLocalBinding` opens every local port on macOS and has no effect on Linux and WSL2, and that `excludedCommands` runs a command with no filesystem or network limits ([sandboxing documentation](https://code.claude.com/docs/en/sandboxing.md), section "A command fails to reach a server on localhost", retrieved 2026-11-17).
  Whether the sandbox proxy with an `allowedDomains` entry for the app's address and port reaches the app and nothing else on macOS, Linux and WSL2 is therefore unproven.
  **Changed:** the first milestone begins with a feasibility proof, on macOS, Linux and WSL2, of Route A (calls through the sandbox proxy to that one `allowedDomains` entry, with `sandbox.network.strictAllowlist` set and a pinned permission mode that is not bypass-permissions, so the proxy refuses every other host in every mode), and falls back to Route B (typed tools on an MCP server that CreatorBrio operates, so the shell needs no network) if the proof fails on any of them.
  `allowLocalBinding` and `excludedCommands` are rejected, and the chosen route is recorded as AD-35 (RFC 7.4).
- **Session continuity under confinement.**
  A fresh working folder for every run would break `--resume`, because Claude Code stores a session under the working directory it started in, while the chat is one continuing conversation (`docs/architecture/design-agent.md`).
  That per-working-directory storage is a local observation of the CLI on 2026-11-17, not vendor documentation, and T1 verifies it.
  **Changed:** the working folder is one per carousel conversation, reused across that carousel's runs with writes denied elsewhere, and M1's acceptance criteria include that a follow-up message in a carousel chat begun after M1 resumes the same session, while a chat begun before M1 starts one fresh session through the existing reset path.
- **Local approval authority.**
  In local single-user mode, processes of the same operating-system user are one principal, so the rule that only a person approves holds only as far as agent containment keeps agents out; it is not a boundary against every same-user process.
  Hosted mode uses an authenticated service interface.
  **Changed:** the RFC states this residual risk explicitly (5.5), and roadmap phase 2 requires the Production API's person principal on the carousel approval routes, so a tokenless loopback request cannot approve (T2).
- **The package fingerprint anchors Gate 2.**
  Gate 2 is only as strong as the fingerprint's coverage of every value that reaches a platform.
  **Changed:** the RFC states that coverage as an invariant of the publishing module (5.4), proven by T2 and T12.
- **Platform facts.**
  TikTok's rules were seen through search only; LinkedIn document posts under the self-serve permission need a live call; whether YouTube's upload scope is "sensitive" is unconfirmed; Mastra's enterprise-code interpretation is unconfirmed.
  All are marked in the research and none blocks phase 1 to 4.
- **Cost.**
  One measured carousel run is the only data point, and T6 sits at the hosted stage.
  **Changed:** the roadmap's phase 4 exit now records cost per approved artifact from the run records, so cost is known long before pricing.

## 4. Likely migration failures

| Failure | Why it is likely | Mitigation in the plan |
|---|---|---|
| The deploy gate tests the wrong tree | The publisher moves into a subfolder, so a gate that tests the repository root would not test it | The deploy command tests `publisher/` at the pinned commit, with a test that fails otherwise |
| Paths that assume a different repository root | A moved tree can break relative paths | Configuration is read from a configured path, and the suite runs from `publisher/` in CI before cutover |
| Tests that only pass on macOS | The suite stubs macOS commands; Linux runners may expose assumptions | CI runs the suite on hosted Linux and macOS runners |
| A private identifier slips into the public snapshot | Identifiers can sit in configuration, docs, docstrings and test fixtures | Snapshot plus scanner plus a private identifier list; independent review |
| Fake test credentials trip secret scanning | The suite contains credential-shaped fakes | Mark them as fixtures before import |
| Duplicate or missing alerts during the notification switch | Two senders, or none, for a window | One delivery owner per alert, switched in one change |
| A rollback cannot open the database | A schema change after cutover | Schema frozen from the shadow step until the rollback window ends |
| A post misses its slot on a closed laptop | Local publishing needs the machine awake at the slot | Keep-awake covers idle sleep only; the plan records this as a known limit of local-first publishing, alerted; a cloud publishing path is decided separately (AD-28) |

## 5. Sequencing risk

Running the publisher import (phase 3) before containment (phase 1) finishes puts publishing code inside the folder the Design Agent currently runs from.
The import adds code that becomes public anyway and exposes no credential, because credentials stay in the OS keychain outside the repository.
The cutover is different: from then the live runner deploys from this repository, and an unconfined agent with a shell can write to that checkout.
**Changed:** the migration plan's cutover step (P4) waits for M1's confinement ticket to merge, which must deny agent writes outside the agent's own carousel folder, and for T1's baseline to be recorded; the import itself (P2) may proceed in parallel.

## 6. What this revision may still get wrong

- It is the work of one author drawing on parallel research; the independent reviewer and the founder are the checks.
- Platform policies and licences move quickly; every fact carries a date and source, and the matrix should be re-verified before each phase that depends on it.
- The Video Studio owners may prefer a different home for the shared research contract; the RFC names WS1 and WS9 as co-owners for that reason.
