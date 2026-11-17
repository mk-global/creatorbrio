# R1: Agent frameworks, durable execution and evaluation for CreatorBrio

Retrieved 2026-11-17.

Scope: category A (agent frameworks, tool calling, structured output, memory), category B (durable jobs, human approvals, scheduling, recovery), category D (script and creative-direction quality, evaluation, prompt versioning, tracing).

Method: GitHub REST API (`gh api repos/...`, `/license`, `/releases`, `/commits`, `/contents`), npm and PyPI registry metadata, unpkg file listings of published tarballs, and official documentation pages.
No code was installed, cloned or copied.
This is an engineering reading of licences and terms, not legal advice.
Contributor licence agreements were not checked for any candidate; they bind contributors to upstream projects, not CreatorBrio as a consumer.

Evidence markers:
- [F] fetched from a primary source (LICENSE file, GitHub API, registry metadata, official docs page), with the URL.
- [S] seen only through search results.
- UNVERIFIED means the claim was not confirmed from a primary source in this session.

Decision vocabulary:
- ADOPT: take it as a direct dependency of the MIT core now.
- INTEGRATE: use it behind a CreatorBrio-owned port or as an optional, separately installed tool, or at a named later stage.
- STUDY: read for design ideas or keep as a named escalation option; no dependency now.
- BUILD: CreatorBrio implements the capability itself.
- REJECT: do not use, for the stated reason.

Inputs refreshed rather than repeated: section 7, section 12 and finding P1-1 of `docs/roadmap/content-platform/reviews/2026-11-17-pr215-independent-review.md`; section 3 of `docs/research/video-studio/evidence/e8-tts-sourcing-providers.md`; and `docs/research/video-studio/spec/08-licensing-and-commercial.md`.

## Summary matrix

| Candidate | Cat. | Licence (from LICENSE file) | Latest release (date) | Decision | One-line reason |
|---|---|---|---|---|---|
| Anthropic TypeScript SDK (`@anthropic-ai/sdk`) incl. beta tool runner | A | Apache-2.0 | sdk 1.9.0 (2026-11-16) | ADOPT | Permissive, first-party API client; use the manual tool loop, not the beta runner, for approval-gated tools |
| Vercel AI SDK (`ai` + `@ai-sdk/*`) | A | Apache-2.0 | ai 7.0.173 (2026-11-13) | INTEGRATE | Actively maintained multi-provider adapter (Anthropic, OpenAI-compatible, local); keep it behind CreatorBrio's `AgentBackend` port |
| MCP TypeScript SDK v2 (`@modelcontextprotocol/server`, `/client`) | A | Apache-2.0, with not-yet-relicensed MIT contributions | 2.4.0 (2026-10-23) | ADOPT | Standard tool surface for external agents (Claude CLI, local hosts); licence changed since spec/08 |
| Claude Agent SDK (TypeScript) | A | Proprietary ("All rights reserved", Commercial Terms) | 0.3.326 (2026-11-16) | REJECT | Proprietary, runs the Claude Code binary, API-key-only for products; cannot be bundled into the MIT core |
| Mastra (`@mastra/core`) | A, B | Apache-2.0 outside `ee/`; source-available Mastra EE licence inside `ee/` | 1.83.0 (2026-11-12) | REJECT | Second state model; and the Apache-labelled npm package statically imports `ee/`-sourced code whose licence restricts distribution |
| LangGraph JS / Python | A, B | MIT | JS 1.7.5 (2026-11-17); Py 1.2.22 (2026-11-14) | REJECT | Graph runtime and checkpointer duplicate CreatorBrio's domain state; interrupts re-run the node on resume |
| OpenAI Agents SDK (JS) | A | MIT | 0.22.0 (2026-11-12) | REJECT | Exports traces to OpenAI by default in Node; adds a second loop and model abstraction |
| BAML | A, D | Apache-2.0 | npm 0.226.3 (2026-10-28) | STUDY | Schema-aligned parsing is useful for local models without JSON-schema output, but adds a DSL, codegen and native binary |
| TanStack AI | A | MIT | 1.5.0 (2026-11-17) | STUDY | Credible young provider abstraction; fallback if the AI SDK becomes unsuitable |
| LlamaIndex.TS | A | MIT | 0.12.1 (2025-12-02) | REJECT | Deprecated and archived by its owner |
| Pydantic AI | A, D | MIT | v2.69.0 (2026-11-17) | REJECT | Python only; stack mismatch |
| Other 2026 TS entrants (VoltAgent, Google ADK JS, Cloudflare Agents, Strands TS, Microsoft Agent Framework) | A | MIT / Apache-2.0 | see section A.12 | REJECT | Overlap with what CreatorBrio needs to own, platform coupling, archived, or no TypeScript |
| Domain state machine + file-backed job records (existing) | B | CreatorBrio MIT | n/a | BUILD | Already has leases, failure classes, recovery and human-decision records; approvals belong in domain state |
| pg-boss | B | MIT | 12.38.2 (2026-11-10) | INTEGRATE | Hosted-stage job runner on the product's own PostgreSQL; no extra service |
| pg-boss on embedded PGlite | B | MIT + Apache-2.0 | PGlite 0.5.16 (2026-11-09) | STUDY | In-process, single-connection; does not fit a separate worker process without a development-grade socket bridge |
| Graphile Worker | B | MIT | 0.18.0 (2026-09-08) | STUDY | Credible hosted alternative to pg-boss; pre-1.0 and slower cadence |
| BullMQ | B | MIT (Pro is commercial) | 6.7.7 (2026-11-17) | REJECT | Redis-first; Pro tier carries the advanced features; pg-boss covers the need on PostgreSQL |
| DBOS Transact (TS) | B | MIT | v5.5 (2026-11-10) | STUDY | Escalation option; distributed recovery and resource-free suspension are paid Conductor features |
| Hatchet | B | MIT | server v0.114.2 (2026-10-26) | STUDY | Escalation option; separate engine service; Lite image only for low-throughput production |
| Temporal | B | MIT | server v1.32.2 (2026-11-02) | REJECT | Production cluster footprint disproportionate to a one-machine product; revisit only with measured need |
| Trigger.dev v4 | B | Apache-2.0 | v4.8.5 (2026-11-12) | REJECT | Multi-container self-host; checkpoints and warm starts are Cloud-only |
| Inngest | B | Server SSPL 1.0 (delayed Apache-2.0); SDK Apache-2.0 | server v1.53.0 (2026-11-12) | REJECT | SSPL server cannot be a required part of the distributed product |
| Restate | B | Server BSL 1.1; SDK MIT | server v1.8.1 (2026-10-21) | REJECT | Source-available server excluded by spec/08 |
| Absurd | B | Apache-2.0 | 0.5.1 (2026-10-20) | STUDY | PostgreSQL-only, no server, clean design; self-described "experiment" |
| Vercel Workflow SDK (formerly Workflow Development Kit) | B | Apache-2.0 | workflow 5.5.0 (2026-11-10) | STUDY | Next.js-native; Local World is development-only; hosted would need its Postgres World |
| OpenWorkflow | B | Apache-2.0 | 0.11.0 (2026-10-12) | STUDY | Only candidate with SQLite and PostgreSQL backends; young; signals sent before a wait are dropped |
| Sidequest | B | LGPL-3.0 | v1.17.0 (2026-10-19) | REJECT | Adopting a new LGPL library contradicts spec/08 as written (LGPL only as a separate, user-installed process, never linked or shipped in the repository), and pg-boss covers the need |
| Mastra workflows suspend/resume, LangGraph interrupts (as approval mechanisms) | B | as above | as above | REJECT | Put the approval's authority in a framework snapshot instead of the domain record |
| promptfoo | D | MIT | 0.125.1 (2026-10-25) | INTEGRATE | Dev-time regression and judge harness (devDependency, telemetry off); now OpenAI-owned [S] |
| Langfuse | D | MIT core; `ee/` directories under a commercial licence | v4.82.0 (2026-11-17) | INTEGRATE | Optional OTLP export target for hosted mode only; four-store footprint; ClickHouse-owned |
| OpenTelemetry GenAI semantic conventions | D | Apache-2.0 | repo active 2026-11-17 | ADOPT | Vendor-neutral attribute names for run, tool and token telemetry |
| Inspect AI | D | MIT | 0.3.290 (2026-11-14) | STUDY | Best-designed eval framework, but Python |
| DeepEval | D | Apache-2.0 | PyPI 4.3.4 | REJECT | Python; PostHog telemetry on by default |
| OpenAI Evals | D | MIT (datasets vary) | no releases; last commit 2026-04-14 | REJECT | Dormant |
| Arize Phoenix | D | Elastic License 2.0 (server, Python evals) | arize-phoenix 21.0.0 | REJECT | Source-available server; JS clients declare Apache-2.0 but ship no licence text |
| Braintrust platform | D | Proprietary control plane; SDK Apache-2.0/MIT | braintrust 3.44.0 (2026-11-11) | REJECT | Proprietary hosted control plane |
| autoevals | D | MIT | 0.4.1 (2026-10-21) | STUDY | Scorer prompts worth reading; small dependency if ever needed |
| Opik | D | Apache-2.0 | 2.2.145 (2026-11-17) | STUDY | Permissive Langfuse alternative; local install "not production-ready" |
| evalite | D | MIT | 0.19.0 (2025-11-06) | REJECT | Deprecated and archived |
| Creative-quality rubric judge and run cost ledger | D | CreatorBrio MIT | n/a | BUILD | No tool scores branded carousel and video quality; approval outcomes are the ground truth |

## What changed since the prior review (section 7 and 12)

- The MCP TypeScript SDK split into v2 packages (`@modelcontextprotocol/server` and `/client`) under Apache-2.0, and v1 (`@modelcontextprotocol/sdk`, MIT) is on a maintenance branch; spec/08's "MCP SDK MIT" is stale for v2 [F].
- The Claude Agent SDK overview now says it is "A library that runs the Claude Code binary" [F], which makes it the same proprietary runtime as today's CLI spawn, not a separate open library.
- Mastra published a new Enterprise Edition licence (version 2.0, effective 2026-09-22) and its `ee/` code ships inside the Apache-labelled `@mastra/core` npm package [F].
- Vercel's Workflow Development Kit is now branded "Workflow SDK" at workflow-sdk.dev; its Local World stores state in SQLite but holds the queue in memory and is development-only [F].
- pg-boss gained an embedded PGlite backend [F]; this is new since the prior review, but it does not overturn the local recommendation (see B.3).
- BullMQ lists PostgreSQL 13+ as an alternative backend [F] (not in the prior review; when it was added is UNVERIFIED).
- Absurd and OpenWorkflow are new PostgreSQL- or SQLite-backed durable-execution libraries [F].
- Promptfoo was announced as acquired by OpenAI on 2026-03-09 [S]; Langfuse joined ClickHouse on 2026-01-16 [F].
- LlamaIndex.TS and evalite are deprecated and archived [F].
- Prior-review facts not re-fetched in this session and carried forward: Temporal's development-only `start-dev` server and production persistence requirements; Restate and Inngest footprints (licences were re-fetched).

---

## Category A: agent frameworks, tool calling, structured output, memory

### A.1 Anthropic TypeScript SDK and its tool runner

- Repository: <https://github.com/anthropics/anthropic-sdk-typescript> [F].
  Docs: <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner> [F].
  Owner: Anthropic.
- Maintenance: sdk-v1.9.0 published 2026-11-16, sdk-v1.8.0 2026-11-10; last commit 2026-11-16; weekly or faster cadence [F] (GitHub API).
- Licence: Apache-2.0 per GitHub licence API and npm `license` [F].
- CreatorBrio may copy, link, bundle, modify and distribute it commercially; obligations are keeping the licence and any NOTICE file, and marking modified files.
- Tool runner: `client.beta.messages.toolRunner(...)` with `betaZodTool()` or `betaTool()`; status "beta" on every platform listed [F].
- The docs state: "When you need human-in-the-loop approval, custom logging, or conditional execution, use the manual loop instead." [F]
- The runner loops until a message has no tool use or until `max_iterations` [F].
- Stack fit: plain Node library, works in route handlers and in a separate worker process; no extra services.
- Security: API key handling is the caller's; nothing is sent anywhere except the configured API endpoint (no SDK telemetry is documented; absence of telemetry UNVERIFIED).
- Replaces: nothing CreatorBrio has; it is the `anthropic-api` backend spec/08 already names.
- Decision: **ADOPT** the SDK.
  Use the manual tool loop for any tool that changes a change-set or publishing package, because CreatorBrio must persist the pending tool call as domain state before a human acts on it.
  The beta tool runner is acceptable only for read-only research loops.

### A.2 Vercel AI SDK

- Repository: <https://github.com/vercel/ai> [F].
  Docs: <https://ai-sdk.dev/docs> [F].
  Owner: Vercel.
- Maintenance: `ai@7.0.173` and `ai@6.0.332` both published 2026-11-13, so two major lines are maintained in parallel; last commit 2026-11-16; about 28k stars [F].
- Licence: root LICENSE is Apache-2.0 text, "Copyright 2023 Vercel, Inc." (GitHub reports NOASSERTION because the file lacks the standard header) [F].
  `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai-compatible` and `@ai-sdk/mcp` declare Apache-2.0 on npm [F].
- May copy, link, bundle, modify and distribute; Apache-2.0 obligations as above.
- Capabilities: `ToolLoopAgent` "handles the loop, context management, and stopping conditions" [F] (<https://ai-sdk.dev/docs/agents/overview>).
- Tool approval: configured with `toolApproval`; "`generateText` and `streamText` don't pause execution", the call returns `tool-approval-request` parts and "the manual approval flow requires two calls to the model" [F] (<https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>).
  The application carries the approval state, which matches CreatorBrio's domain-state approach.
- MCP: "The AI SDK supports connecting to Model Context Protocol (MCP) servers to access their tools" [F]; whether `toolApproval` applies to MCP tools is not documented (UNVERIFIED).
- A new `HarnessAgent` runs external harnesses such as Claude Code, Codex and Pi [F]; using it with Claude Code inherits Claude Code's proprietary terms.
- Telemetry: once an OpenTelemetry integration is registered, calls emit telemetry "by default", and "By default, both inputs and outputs are recorded" [F] (<https://ai-sdk.dev/docs/ai-sdk-core/telemetry>).
  Whether Vercel itself collects SDK usage telemetry: UNVERIFIED (not stated).
- Stack fit: Node library; route handlers and workers; no services.
- Integration cost: low if confined to provider calls and structured output; it would replace the hand-written `openai-compatible` bridge described in e8 section 3.3.
- Risks: fast major-version churn (v6 and v7 concurrently); recording inputs and outputs by default once telemetry is enabled would put prompts, brand data and source excerpts into traces unless CreatorBrio sets `recordInputs: false` and `recordOutputs: false`.
- Decision: **INTEGRATE** behind CreatorBrio's `AgentBackend` port as the adapter for non-Anthropic and local providers, pinned to one major line, with telemetry recording off by default.
  Do not use `ToolLoopAgent` as the owner of approval-gated runs.

### A.3 Model Context Protocol TypeScript SDK

- Repository: <https://github.com/modelcontextprotocol/typescript-sdk> [F].
  Docs: <https://ts.sdk.modelcontextprotocol.io/v2/> [F].
  Owner: the MCP project (originated at Anthropic).
- Maintenance: v2.4.0 and v1.32.2 published 2026-10-23; last commit 2026-11-10; about 13.8k stars [F].
- v2 is "the stable release line, implementing the 2026-07-28 MCP spec"; v1.x "continues to receive bug fixes and security updates for at least six months after the v2 release (2026-07-27)" [F].
  That window ends no earlier than about 2027-01-27, so a v1 consumer must plan migration.
- Licence: the LICENSE file says "The MCP project is undergoing a licensing transition from the MIT License to the Apache License, Version 2.0", new contributions are Apache-2.0, and contributions whose authors have not consented remain under MIT [F].
  npm: `@modelcontextprotocol/server` 2.4.0 and `/client` 2.4.0 declare Apache-2.0; `@modelcontextprotocol/sdk` 1.32.2 declares MIT [F].
- May copy, link, bundle, modify and distribute; keep both the MIT notice and Apache-2.0 text.
- Stack fit: Node, Bun, Deno; stdio and Streamable HTTP; optional Express, Fastify, Hono and Node HTTP middleware with Host header validation [F].
- Security: an MCP server exposed on loopback HTTP must authenticate callers (CreatorBrio's run-scoped agent tokens fit) and validate Host headers to resist DNS rebinding.
- Replaces: the agent's shell-plus-curl access to the REST API with typed tools, while the REST routes stay the implementation.
- Decision: **ADOPT** v2 as the external tool surface.
  Update spec/08's licence row.

### A.4 Claude Agent SDK (TypeScript)

- Repository: <https://github.com/anthropics/claude-agent-sdk-typescript> [F].
  Docs: <https://code.claude.com/docs/en/agent-sdk/overview> [F].
  Owner: Anthropic.
- Maintenance: v0.3.326 published 2026-11-16, near-daily releases [F].
- Licence: LICENSE.md reads "© Anthropic PBC. All rights reserved.
  Use is subject to Anthropic's Commercial Terms of Service." [F] (a single quoted notice).
  The npm `license` field is "SEE LICENSE IN README.md" [F].
  GitHub detects no licence [F].
- The Python package `claude-agent-sdk` 0.2.183 declares MIT on PyPI [F], but the overview says the SDK is "A library that runs the Claude Code binary" [F], so the binary's terms apply regardless of the wrapper's licence.
- Terms (re-fetched): "Use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service, including when you use it to power products and services that you make available to your own customers and end users" [F].
- "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." [F]
- Legal and compliance page: developers "should use API key authentication"; Anthropic does not permit them "to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users"; products running Claude Code may not "pay for, resell, or intermediate Claude usage on their end users' behalf" [F] (<https://code.claude.com/docs/en/legal-and-compliance>).
- The same page still does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription" [F], so the existing user-installed CLI backend remains permissible as spec/08 describes.
- Branding: products may not use "Claude Code" or "Claude Code Agent" as names [F].
- CreatorBrio may not bundle or redistribute it in the MIT repository; linking it as an optional peer that the user installs is possible but brings Commercial Terms obligations to every deployment.
- Security: it runs a full coding agent with file, shell and web tools; isolation is the integrator's job.
- Decision: **REJECT** as a dependency of the core.
  Keep the existing `claude-code-cli` backend as an optional, user-installed, user-authenticated runtime, and use `@anthropic-ai/sdk` for every unattended or hosted run.
- Note: Anthropic also offers "Managed Agents", a hosted agent harness with Anthropic-managed or self-hosted sandboxes [F]; it is a proprietary service and was not assessed further.

### A.5 Mastra

- Repository: <https://github.com/mastra-ai/mastra> [F].
  Docs: <https://mastra.ai/docs> [F].
  Owner: Kepler Software, Inc. ("doing business as Mastra") [F].
- Maintenance: `@mastra/core` 1.83.0 published 2026-11-12; weekly minor releases; last commit 2026-11-17; about 29.6k stars [F].
- Licence: root LICENSE.md says content under any directory named `ee/` is under `ee/LICENSE`, and everything else is Apache-2.0 [F].
- `ee/LICENSE` is the "MASTRA ENTERPRISE EDITION LICENSE Version 2.0, Effective September 22nd, 2026" and states, in its preamble (quoted as one passage): "Enterprise Features are made available in source-available form.
  They are not open source.
  ... it does not permit Production Use, and it does not permit redistribution." [F]
- Licence surprise: npm declares `@mastra/core` 1.83.0 as Apache-2.0 [F], yet the published tarball contains `dist/auth/ee/*`, `dist/agent-builder/ee/*` and a shared chunk `dist/ee-iTj2bRDt-By_B9ngH.js` [F] (unpkg file listing).
- That chunk's embedded source path is `../_internals/auth/dist/capabilities-*.js`, and in the source tree `capabilities.ts` exists only under `packages/_internals/auth/src/ee/` [F]; it contains the EE licence client, FGA permission helpers and an EE telemetry bridge [F].
- Non-EE chunks import it with top-level static `import` statements, for example `import { i as MastraFGAPermissions } from "./ee-iTj2bRDt-By_B9ngH.js";` in `utils-*.js` and a similar line in `evented-execution-*.js` (workflows); `channels-*.js` and `agent-controller-*.js` also reference it [F].
- The root licence places all content under `ee/` directories under `ee/LICENSE`, whose section 3.5(a) says you must not "copy, merge, publish, distribute, sublicense, sell, rent, lease, or otherwise make available any Enterprise Feature to any third party" [F].
- Whether these particular helpers are "designated" Enterprise Features (the licence defines them "by designation") is UNVERIFIED and needs Mastra's written answer; until then, any bundle, container or desktop build that includes `@mastra/core` carries code under a no-distribution licence.
- A licence scanner reading only `package.json` would pass this package.
- The EE licence client "fail[s] open" while validation is pending and calls `POST {MASTRA_LICENSE_URL}/validate` when a key is configured [F] (source comment in the chunk); with no key, EE features are disabled.
- Workflows: `suspend()` saves a snapshot "in your configured storage provider" and runs resume via `run.resume({ step, resumeData })` [F] (<https://mastra.ai/docs/workflows/suspend-and-resume>).
- Storage: quickstart uses LibSQL with `file:./mastra.db` [F]; observability can export to the Mastra platform "if MASTRA_PLATFORM_ACCESS_TOKEN is set" [F]; whether the CLI collects anonymous telemetry by default: UNVERIFIED.
- Overlap: agents, memory, workflows, storage, evals and a server, most of which CreatorBrio already owns (stores, job lifecycles, change-set engine).
- Decision: **REJECT**.
  The framework would create a second state model beside CreatorBrio's stores, which alone decides it.
  Separately, distributing a package that statically includes `ee/`-sourced code conflicts with spec/08's exclusion of source-available components unless Mastra confirms otherwise.
  Re-examine only if Mastra moves that code out of `@mastra/core`.

### A.6 LangGraph (JS and Python)

- Repositories: <https://github.com/langchain-ai/langgraphjs>, <https://github.com/langchain-ai/langgraph> [F].
  Docs: <https://docs.langchain.com/oss/javascript/langgraph/interrupts> [F].
  Owner: LangChain, Inc.
- Maintenance: `@langchain/langgraph` 1.7.5 published 2026-11-17; Python 1.2.22 on 2026-11-14; daily commits; Python repo about 45k stars [F].
- Licence: MIT for both repositories [F]; `@langchain/langgraph-checkpoint-postgres` 1.1.4 and `-checkpoint-sqlite` 1.1.1 declare MIT [F].
  The hosted LangGraph Platform / LangSmith deployment server was not assessed (its licence is UNVERIFIED).
- Interrupts: "When you call interrupt, LangGraph saves the current graph state and waits for you to resume execution"; a checkpointer is required [F].
- "The node restarts from the beginning of the node where the interrupt was called when resumed, so any code before the interrupt runs again." [F]
- Interrupt matching is index-based, so calls must stay in the same order [F].
- Stack fit: Node library with SQLite or PostgreSQL checkpointers; no service required for the library.
- Decision: **REJECT** as the runtime.
  The checkpoint becomes a second source of truth beside the production store, and replay-on-resume requires all pre-interrupt side effects to be idempotent.
  Its interrupt semantics are worth reading as a design reference.

### A.7 OpenAI Agents SDK (JS)

- Repository: <https://github.com/openai/openai-agents-js> [F].
  Docs: <https://openai.github.io/openai-agents-js/> [F].
  Owner: OpenAI.
- Maintenance: `@openai/agents` 0.22.0 published 2026-11-12; alpha builds daily; pre-1.0 [F].
- Licence: MIT [F].
- Tracing: "Tracing is enabled by default in server runtimes (Node.js, Deno, Bun)" and "the default tracing setup already exports to OpenAI"; disable with `OPENAI_AGENTS_DISABLE_TRACING=1` or `RunConfig.tracingDisabled` [F] (<https://openai.github.io/openai-agents-js/guides/tracing/>).
- Generation and function spans capture inputs and outputs; the default of `traceIncludeSensitiveData` is not stated (UNVERIFIED).
- Non-OpenAI models are reachable through `@openai/agents-extensions` (MIT) [F]; capability parity with Anthropic features is UNVERIFIED.
- Security: a self-hosted user's prompts and tool payloads would be sent to OpenAI by default unless CreatorBrio disables tracing.
- Decision: **REJECT**.
  It adds a second loop and model abstraction, and its default data flow conflicts with CreatorBrio's no-unexpected-egress posture.

### A.8 BAML

- Repository: <https://github.com/BoundaryML/baml> [F].
  Docs: <https://docs.boundaryml.com> (not fetched).
  Owner: Boundary (BoundaryML).
- Maintenance: nightly tags daily; npm `@boundaryml/baml` 0.226.3 published 2026-10-28; about 9.5k stars [F].
- Licence: Apache-2.0 [F].
- Shape: a separate schema language compiled to TypeScript clients, with a native runtime distributed through npm (native binary distribution UNVERIFIED in this session).
- Value: its parser recovers structured output from models that cannot enforce JSON Schema, which matters for local models such as those behind mlx-lm (e8 notes it lacks `response_format`).
- Cost: a DSL, a code generation step and a native dependency for one capability that Zod validation plus retry already covers for most providers.
- Decision: **STUDY**.
  Revisit if local-model structured-output failure rates measured in D become material.

### A.9 TanStack AI

- Repository: <https://github.com/TanStack/ai> [F].
  Owner: TanStack.
- Maintenance: `@tanstack/ai` 1.5.0 published 2026-11-17; daily provider-package releases; about 3.4k stars [F].
- Licence: MIT [F].
- Capability details were not fetched (UNVERIFIED).
- Decision: **STUDY** as the fallback provider abstraction if the AI SDK's churn or Vercel coupling becomes a problem.

### A.10 LlamaIndex.TS

- Repository: <https://github.com/run-llama/LlamaIndexTS> [F].
  Archived on GitHub; README: "This project is deprecated and no longer maintained." [F]
- Last release `llamaindex` 0.12.1 on 2025-12-02; licence MIT [F].
- Decision: **REJECT** (not worth a full entry).

### A.11 Pydantic AI

- Repository: <https://github.com/pydantic/pydantic-ai> [F].
  MIT; v2.69.0 on 2026-11-17; about 21k stars [F].
- Python only, so it would need a second runtime beside Node.
- Decision: **REJECT** (not worth a full entry).
  Its eval companion is noted under D only as a design reference.

### A.12 Other 2026 TypeScript entrants (short entries)

- VoltAgent (<https://github.com/VoltAgent/voltagent>): MIT; `@voltagent/core` 2.11.1 on 2026-11-04 [F].
  A Mastra-like full framework with the same overlap problem.
  **REJECT**.
- Google ADK for TypeScript (<https://github.com/google/adk-js>): Apache-2.0; `@google/adk` 2.5.0 on 2026-11-12 [F].
  Gemini-first; provider neutrality UNVERIFIED.
  **REJECT** for now.
- Cloudflare Agents (<https://github.com/cloudflare/agents>): MIT; agents@0.33.0 on 2026-11-03 [F].
  Built for Workers and Durable Objects, which is a different runtime.
  **REJECT**.
- Strands Agents TypeScript (<https://github.com/strands-agents/sdk-typescript>): archived; "The TypeScript SDK has moved to the strands-agents/harness-sdk monorepo" [F].
  Not assessed further.
  **REJECT**.
- Microsoft Agent Framework (<https://github.com/microsoft/agent-framework>): MIT; Python and .NET releases only [F].
  **REJECT** (no TypeScript).

---

## Category B: durable jobs, human approvals, scheduling, recovery

### B.1 Domain state machine plus file-backed job records (existing CreatorBrio pattern)

- Evidence (prior review P1-1, from repository docs): render and media jobs already have staged creation, owner-verified leases, transient, permanent and configuration failure classes, bounded retries with backoff, startup recovery, person-initiated retry and sanitized failures; the production store models `recoveryRequired` and `resolveInterruptedRun`.
- Licence: CreatorBrio MIT.
- Footprint: none beyond existing files.
- What every candidate below would add is a second state store and its operational burden; what they would replace is the lease and retry loop, which CreatorBrio already has.
- Decision: **BUILD** (continue).
  Add a due-time scheduler that scans domain records for work (publish times, approval reminders, approval expiry) and enqueues bounded, idempotent jobs.

### B.2 pg-boss

- Repository: <https://github.com/timgit/pg-boss> [F].
  Docs: <https://pgboss.io> [F].
  Owner: an individual maintainer (GitHub user account) [F].
- Maintenance: 12.38.2 published 2026-11-10, 12.38.1 on 2026-11-05; separate dashboard releases; about 4.1k stars [F].
- Licence: MIT [F].
- Requirements: "Node 22.12 or higher, or Bun" and "PostgreSQL 13 or higher" [F] (README).
- Features: jobs created in an existing transaction (Drizzle, Knex, Kysely, Prisma adapters), cron and RRULE scheduling, deferral, dead letter queues with redrive, retries with exponential backoff, job dependency orchestration, OpenTelemetry traces and metrics, multi-master workers [F].
- Tenancy: no tenancy primitive; tenancy comes from CreatorBrio's own records (queue naming or job data per tenant).
- Bus factor: single maintainer; mitigated by MIT licence and plain SQL schema.
- Decision: **INTEGRATE** at the hosted stage behind CreatorBrio's job port, on the product's own PostgreSQL.
  It runs jobs; it does not own approvals.

### B.3 pg-boss on embedded PGlite (local-mode option, new)

- pg-boss lists `pglite` as a backend: "embedded single-connection PostgreSQL" that "is not a distributed backend"; "PGlite serializes everything through one connection"; the intended case is "embedded / local-first / testing workloads" [F] (<https://pgboss.io/database-backends>).
- PGlite: Apache-2.0 [F] (<https://github.com/electric-sql/pglite>); 0.5.16 on 2026-11-09 [F]; pre-1.0.
- A separate worker process (the prior review's local recommendation) cannot share an in-process PGlite; the bridge is `pglite-socket`, which the docs describe as usable "as a drop-in replacement for PostgreSQL in development environments", warning that "not all use cases are guaranteed to work" [F] (<https://pglite.dev/docs/pglite-socket>).
- Multi-process access to one PGlite data directory is not documented (UNVERIFIED; assume unsupported).
- Decision: **STUDY**.
  It would let local and hosted share one job schema, but not with separate web and worker processes today.
  Do not change the local recommendation.

### B.4 Graphile Worker

- Repository: <https://github.com/graphile/worker> [F].
  Owner: Graphile.
- Maintenance: v0.18.0 on 2026-09-08 is the only recent release; last commit 2026-11-05; pre-1.0 [F].
- Licence: MIT [F].
- PostgreSQL only; cron and job keys (carried from prior review, not re-fetched).
- Distribution: MIT; may be copied, bundled and modified with the notice retained.
- Tenancy: none documented (carried from prior review).
- Replaces: the same lease and retry loop pg-boss would replace.
- Decision: **STUDY** as the hosted alternative if pg-boss's single-maintainer risk materialises.

### B.5 BullMQ

- Repository: <https://github.com/taskforcesh/bullmq> [F].
  Docs: <https://docs.bullmq.io> [F].
  Owner: Taskforce.sh.
- Maintenance: v6.7.7 on 2026-11-17; very active [F].
- Licence: MIT [F].
- Requirements: "Redis™ 6.2 or newer" by default, with Valkey and Dragonfly named as compatible, and "PostgreSQL 13 or newer" listed as an alternative backend [F].
- "BullMQ Pro" is "the commercial version of BullMQ, with advanced features such as groups, batches and observables" [F]; its licence terms were not stated (UNVERIFIED, presumably proprietary).
- The Redis server's own current licence was not re-checked in this session (UNVERIFIED); Valkey is the BSD-licensed fork per prior knowledge (UNVERIFIED).
- Decision: **REJECT**.
  Redis is an extra service locally; per-tenant fairness ("groups") sits in the commercial tier; and for a PostgreSQL deployment pg-boss is purpose-built, while the maturity of BullMQ's PostgreSQL backend is UNVERIFIED.

### B.6 DBOS Transact (TypeScript)

- Repository: <https://github.com/dbos-inc/dbos-transact-ts> [F].
  Docs: <https://docs.dbos.dev> [F].
  Owner: DBOS, Inc.
- Maintenance: v5.5 on 2026-11-10, two-week cadence [F].
- Licence: MIT [F].
- System database: the TypeScript configuration reference documents only PostgreSQL (`systemDatabaseUrl` "postgresql://..."); SQLite is not mentioned for TypeScript [F] (<https://docs.dbos.dev/typescript/reference/configuration>).
  SQLite support in TypeScript: UNVERIFIED.
- Paid features (DBOS Pro): "Distributed workflow recovery", "Resource-free workflow suspension", "Workflow management console" and "Workflow data retention policies"; self-hosted Conductor only under Enterprise [F] (<https://www.dbos.dev/pricing>).
- Distribution: the MIT library may be bundled and modified; Conductor is a separate commercial service and is not needed to run the library.
- Tenancy: partitioned queues per key (carried from prior review, not re-fetched).
- Replaces: job lifecycle plus code-defined multi-step workflows; workflows must be deterministic and versioned (carried from prior review).
- Decision: **STUDY** as the escalation option at the hosted stage if code-defined multi-step workflows prove necessary.
  The features that make long human waits cheap are paid.

### B.7 Hatchet

- Repository: <https://github.com/hatchet-dev/hatchet> [F].
  Docs: <https://docs.hatchet.run/self-hosting> [F].
  Owner: Hatchet Technologies.
- Maintenance: server v0.114.2 on 2026-10-26; TS SDK 1.47.3 on 2026-11-16; daily commits [F].
- Licence: MIT root LICENSE; no `ee/` directory at the repository root [F].
- Self-hosting: PostgreSQL stores "workflow state and metadata"; RabbitMQ optional; Hatchet Lite is a "Single docker image with bundled engine and API" for "development, testing, or low-throughput production"; Helm charts for production [F].
- Distribution: MIT server and SDK; CreatorBrio would depend on the SDK and run the engine as a separate service rather than bundle it.
- Tenancy: per-key concurrency and round-robin fairness (carried from prior review, not re-fetched).
- Replaces: job lifecycle, retries and durable sleeps; adds an engine service and determinism between checkpoints.
- Decision: **STUDY** as the alternative escalation option.
  It is a separate engine service, which the local edition should not require.

### B.8 Temporal

- Repositories: <https://github.com/temporalio/temporal>, <https://github.com/temporalio/sdk-typescript> [F].
- Maintenance: server v1.32.2 on 2026-11-02; `@temporalio/client` 1.26.0 on 2026-11-17 [F].
- Licence: MIT for server and TS SDK [F].
- Footprint and determinism burden: carried from the prior review (production cluster with persistence and visibility stores; `start-dev` for development only), not re-fetched.
- Decision: **REJECT** for the foreseeable product; reconsider only with measured scale and an operations team.

### B.9 Trigger.dev v4

- Repository: <https://github.com/triggerdotdev/trigger.dev> [F].
  Licence: Apache-2.0; SDK MIT on npm [F].
  Latest release v4.8.5 on 2026-11-12 [F].
- Self-hosting is "a set of containers"; the webapp "includes the dashboard and other services like Redis and Postgres"; warm starts, auto-scaling and checkpoints are Cloud-only [F] (<https://trigger.dev/docs/self-hosting/overview>).
- The prior review also listed ClickHouse, object storage and a registry; the overview page fetched today does not list them (the Docker guide was not fetched; UNVERIFIED either way).
- Decision: **REJECT** for a self-hostable product.

### B.10 Inngest

- Server repository: <https://github.com/inngest/inngest> [F].
  LICENSE.md is headed "Server Side Public License, Version 1.0" and "Apache 2.0 Future License" [F].
  Latest release v1.53.0 on 2026-11-12 [F].
- SDK repository: <https://github.com/inngest/inngest-js> [F].
  GitHub's API reports GPL-3.0 for this repository, but the repository root has no LICENSE file (404) and every published package directory (`inngest`, `@inngest/ai`, `@inngest/realtime`, and others) carries an Apache-2.0 LICENSE.md; npm `inngest` 4.26.2 declares Apache-2.0 [F].
  The GPL-3.0 label is a GitHub metadata discrepancy, not the SDK's licence.
- Decision: **REJECT**.
  The SSPL server cannot be a required component of an MIT product that others may offer as a service.

### B.11 Restate

- Server: <https://github.com/restatedev/restate> [F].
  LICENSE: "Business Source License 1.1" with an Additional Use Grant forbidding a "Public Restate Platform Service"; "Change Date: 4 years after release" [F].
  Latest release v1.8.1 on 2026-10-21 [F].
- SDK: <https://github.com/restatedev/sdk-typescript> MIT, v1.18.3 on 2026-11-04 [F].
- Decision: **REJECT** under spec/08's exclusion of source-available components.

### B.12 Absurd

- Repository: <https://github.com/earendil-works/absurd> [F].
  Owner: the earendil-works GitHub organisation.
- Maintenance: 0.5.1 on 2026-10-20, 0.5.0 on 2026-08-04, 0.4.0 on 2026-05-27; last commit 2026-11-08; about 2.6k stars [F].
- Licence: Apache-2.0 [F]; npm `absurd-sdk` 0.5.1 Apache-2.0 [F].
- Design: "entirely based on Postgres and nothing else"; one `absurd.sql` schema; pull-based workers ("It does not support push at all"); `ctx.awaitEvent` suspends a task until an event arrives, and "Events are cached like step checkpoints (first emit wins)"; TypeScript and Python SDKs; optional `absurdctl` and a Go web UI [F] (README).
- Maturity: the README calls it "An experiment in durability" and says it was built with substantial AI assistance [F].
- Inference (not stated in the README): "first emit wins" caching suggests an event emitted before the waiter arrives is not lost, which would be the right semantics for approvals.
- Distribution: Apache-2.0 allows copying, bundling and modification with notice and NOTICE-file obligations.
- Tenancy: no tenancy primitive documented; queues are named, so tenancy would come from CreatorBrio's records.
- Replaces: CreatorBrio's file-backed lease and retry loop at the hosted stage, not the approval records.
- Decision: **STUDY**.
  Read its schema as a reference for CreatorBrio's own due-time scheduler; do not depend on an experiment.

### B.13 Vercel Workflow SDK (formerly Workflow Development Kit)

- Repository: <https://github.com/vercel/workflow> [F].
  Docs: <https://workflow-sdk.dev> (the old useworkflow.dev redirects there) [F].
  Owner: Vercel.
- Maintenance: `workflow` 5.5.0 on 2026-11-10, 4.x still patched; daily commits [F].
- Licence: Apache-2.0 for `workflow`, `@workflow/world-local` and `@workflow/world-postgres` [F].
- Integration: `withWorkflow` wraps `next.config.ts`; workflows "can suspend without using compute while they wait" [F] (README).
- Local World: one SQLite `world.db` under `.workflow-data/`; "Queue messages are not stored on disk"; delayed and retried messages are lost on restart (active runs are re-enqueued at startup); "The Local World is designed for development, not production" [F] (<https://workflow-sdk.dev/docs/deploying/world/local-world>).
- Postgres World: "A tested reference implementation of the full World spec" [F].
- Hooks: "A hook token tells the runtime which hook a payload belongs to.
  It is not an authentication mechanism." (quoted as one passage); webhook URLs are public and "anyone who has the URL, or can compute its token, can resume the workflow" [F] (<https://workflow-sdk.dev/docs/foundations/hooks>).
- Distribution: Apache-2.0; may be bundled and modified with notice obligations.
- Tenancy: no tenancy primitive seen in the pages fetched (UNVERIFIED).
- Replaces: CreatorBrio's job lifecycle and parts of the state machine, which is more than CreatorBrio wants to hand over.
- Decision: **STUDY** for the hosted stage only.
  The local edition cannot use a development-only world.
  Inference from the `withWorkflow` Next.js config wrapper (internals not fetched): workflow code is coupled to the framework build.

### B.14 OpenWorkflow

- Repository: <https://github.com/openworkflowdev/openworkflow> [F].
  Owner: the openworkflowdev organisation.
- Maintenance: `openworkflow` 0.11.0 on 2026-10-12; last commit 2026-11-17; about 1.35k stars [F].
- Licence: Apache-2.0 [F].
- Backends: `openworkflow/postgres` and `openworkflow/sqlite` [F]; whether SQLite is meant for production is not stated (UNVERIFIED).
- Design: stateless workers claim runs with `FOR UPDATE SKIP LOCKED` and renew a lease timestamp; `step.sleep` is "a durable pause"; replay from the start with stored step results; versioning by branching on a `version` parameter [F] (ARCHITECTURE.md).
- Signals: "If no workflow is waiting at send time, the signal has no effect and no delivery row is persisted." [F]
  An approval submitted while the run is between steps would be lost.
- Distribution: Apache-2.0; may be bundled and modified with notice obligations.
- Tenancy: none seen in ARCHITECTURE.md (UNVERIFIED beyond that file).
- Replaces: CreatorBrio's job lifecycle in both modes, with one engine over SQLite locally and PostgreSQL hosted.
- Decision: **STUDY**.
  It is the closest open match to CreatorBrio's local-plus-hosted shape, but it is pre-1.0 and its signal semantics are unsafe for approvals unless the approval stays in domain state.

### B.15 Sidequest

- Repository: <https://github.com/sidequestjs/sidequest> [F].
  LICENSE.md is the "GNU LESSER GENERAL PUBLIC LICENSE Version 3", copyright two individual authors; npm declares LGPL-3.0-or-later [F]; v1.17.0 on 2026-10-19 [F].
- Decision: **REJECT**.
  Adopting a new LGPL library contradicts spec/08 as written (only a separate, user-installed process, never linked or shipped in the repository), and pg-boss covers the need; not worth a full entry.

### B.16 Other observed

- pgflow (<https://github.com/pgflow-dev/pgflow>): Apache-2.0, 0.17.2 on 2026-10-02 [F]; capabilities not assessed.
- Effect (`effect` 4.1.4, MIT) [F] has workflow packages; not assessed because adopting Effect is a whole-codebase programming-model decision.

### B.17 Mastra workflows and LangGraph interrupts as human-in-the-loop mechanisms

- Mastra snapshots persist in its storage provider and resume via `run.resume()` [F]; LangGraph checkpoints persist and re-run the interrupted node on resume [F].
- Both put the approval's authoritative state inside a framework snapshot keyed by the framework's run id.
- CreatorBrio's second approval binds a specific, immutable publishing package; that binding must be a domain record (approver, package hash, decision, time) that survives framework upgrades and is queryable by the mobile client.
- Decision: **REJECT** as approval mechanisms.

---

## Category D: script quality, creative direction, evaluation, tracing

### D.1 promptfoo

- Repository: <https://github.com/promptfoo/promptfoo> [F].
  Docs: <https://www.promptfoo.dev/docs> [F].
  Owner: Promptfoo; OpenAI announced on 2026-03-09 that it would acquire Promptfoo, and search summaries paraphrase the announcement as saying Promptfoo will stay open source under its current licence [S] (<https://openai.com/index/openai-to-acquire-promptfoo/> returned HTTP 403; TechCrunch and Bloomberg via search).
  Whether the deal closed: UNVERIFIED.
- Maintenance: 0.125.1 on 2026-10-25; last commit 2026-11-17; about 27k stars [F].
- Licence: MIT, "Copyright (c) Promptfoo 2025" [F].
- Model-graded assertions: `llm-rubric`, `g-eval`, `select-best`, `factuality`, `agent-rubric`, `trajectory:goal-success` and others; image grading through a `rubricPrompt` that includes an image with a vision-capable provider; the grader can be overridden, including "Self-hosted OpenAI-compatible judges" [F] (<https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/>).
- Cost and latency: a `cost` assertion "checks whether the cost reported by the selected provider is at or below a specified threshold" and can record cost as a zero-weight metric; a `latency` assertion requires the cache to be disabled [F] (<https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/>).
- Telemetry: "`promptfoo` collects basic usage telemetry by default"; it excludes prompts, outputs, test cases and keys; disable with `PROMPTFOO_DISABLE_TELEMETRY=1` and `PROMPTFOO_DISABLE_UPDATE=1` [F] (<https://www.promptfoo.dev/docs/configuration/telemetry/>).
- Distribution: MIT; as a devDependency it is not distributed with the product at all.
- Tenancy: not applicable (a CLI run by developers).
- Replaces: nothing in CreatorBrio; it fills the absence of any prompt regression suite.
- Decision: **INTEGRATE** as a development-time regression and judge harness (devDependency, not shipped, telemetry disabled in the scripts that call it).
  It does not belong in the runtime.

### D.2 Langfuse

- Repository: <https://github.com/langfuse/langfuse> [F].
  Docs: <https://langfuse.com/self-hosting> [F].
  Owner: ClickHouse, Inc. (LICENSE: "Copyright (c) 2023-2026 ClickHouse, Inc.") [F]; announced 2026-01-16, "There are no planned changes to licensing" [F] (<https://langfuse.com/blog/joining-clickhouse>).
- Maintenance: v4.82.0 on 2026-11-17, near-daily releases; about 37.5k stars [F].
  JS SDK `@langfuse/client` 6.1.1 on 2026-11-03, MIT [F].
- Licence: MIT Expat outside `ee/`, `web/src/ee/`, `worker/src/ee/` and `packages/shared/src/server/ee/`; those directories are under a commercial "Langfuse Enterprise license" [F].
  Self-hosted EE add-ons named: Organization Creators, Instance Management API, UI Customization [F].
- Self-hosting: two containers (web and worker) plus PostgreSQL, ClickHouse, Redis or Valkey, and S3-compatible storage; Docker Compose is for "Local use and testing" [F].
- Cost tracking: cost is ingested or inferred from usage and model price tables; "ingested costs take priority"; custom model prices by regex; OpenTelemetry `gen_ai.usage.*` attributes accepted [F] (<https://langfuse.com/docs/observability/features/token-and-cost-tracking>).
- Telemetry defaults of the self-hosted server: UNVERIFIED (not stated on the page fetched).
- Distribution: CreatorBrio would not distribute Langfuse; an operator runs it separately and the core only emits OTLP, so no Langfuse code (MIT or EE) enters the MIT repository.
- Tenancy: organisations and projects with per-project API keys (from general product knowledge; UNVERIFIED in this session).
- Replaces: nothing CreatorBrio has; it would add trace browsing, prompt management and cost dashboards for operators.
- Decision: **INTEGRATE** only as an optional OTLP export target in hosted mode, with no Langfuse code in the core.
  Its four-store footprint rules it out as a local requirement.

### D.3 OpenTelemetry GenAI semantic conventions

- Repository: <https://github.com/open-telemetry/semantic-conventions-genai> (moved out of the main semantic-conventions repository) [F].
  Licence: Apache-2.0 [F].
  Last push 2026-11-17 [F].
- Covers spans, metrics and events for GenAI clients and MCP [F]; current stability status UNVERIFIED (the moved page did not state it).
- Decision: **ADOPT** as the attribute vocabulary for CreatorBrio's own run telemetry (model, token usage, tool calls), so any backend (Langfuse, Opik, a plain collector) can read it.

### D.4 Inspect AI

- Repository: <https://github.com/UKGovernmentBEIS/inspect_ai> [F].
  Docs: <https://inspect.aisi.org.uk/> [F].
  Owner: UK AI Security Institute with Meridian Labs [F].
- Maintenance: 0.3.290 on 2026-11-14, several releases a week [F].
- Licence: MIT [F].
- Concepts: dataset, solver, scorer; model-graded scoring (`model_graded_qa()`); over 20 providers including Anthropic and local inference; `inspect view` log viewer; sandboxes for agent code [F].
- Distribution: MIT; usable as a separate Python tool, never bundled into the Node product.
- Tenancy: not applicable (developer tool).
- Replaces: nothing; it would host the eval suite if CreatorBrio ran evals in Python.
- Decision: **STUDY**.
  Its task/solver/scorer separation and log format are the best reference design, but it is Python.

### D.5 DeepEval

- Repository: <https://github.com/confident-ai/deepeval> [F].
  Licence: Apache-2.0 [F]; PyPI `deepeval` 4.3.4 [F].
- Telemetry: "By default, `deepeval` uses PostHog to track only very basic telemetry data", including an anonymous UUID and public IP; opt out with `DEEPEVAL_TELEMETRY_OPT_OUT=1` [F] (<https://deepeval.com/docs/data-privacy>).
- Decision: **REJECT** (Python; default telemetry; overlaps promptfoo).

### D.6 OpenAI Evals

- Repository: <https://github.com/openai/evals> [F].
  LICENSE.md MIT, with separate licences for bundled datasets [F].
  No GitHub releases; last commit 2026-04-14 [F].
- Decision: **REJECT** (dormant; not worth a full entry).

### D.7 Arize Phoenix

- Repository: <https://github.com/Arize-ai/phoenix> [F].
  Owner: Arize AI.
- Licence surprise: the root LICENSE is "Elastic License 2.0 (ELv2)", which forbids providing the software "to third parties as a hosted or managed service" [F].
  PyPI `arize-phoenix` 21.0.0 and `arize-phoenix-evals` 3.10.0 declare Elastic-2.0 [F].
- The JS packages `@arizeai/phoenix-client` 8.0.1 and `@arizeai/phoenix-otel` 3.1.0 declare Apache-2.0 in their `package.json` (in the repository and on npm), but there is no LICENSE file in their package directories, in `js/`, or in the published tarballs [F].
  The only licence text on their repository path is the ELv2 root file, so their licence rests on a metadata field alone and should be confirmed with Arize before use.
- `@arizeai/phoenix-evals` (JS) does ship an Apache-2.0 LICENSE [F].
- OpenInference instrumentation (<https://github.com/Arize-ai/openinference>) is Apache-2.0 [F].
- Decision: **REJECT** the server and clients under spec/08.
  OpenInference is acceptable if ever needed, but OTel GenAI conventions are preferred.

### D.8 Braintrust

- SDK: <https://github.com/braintrustdata/braintrust-sdk-javascript> (the old `braintrust-sdk` name redirects) [F].
  Root LICENSE Apache-2.0; `js/package.json` declares MIT [F] (an inconsistency, both permissive).
  `braintrust` 3.44.0 on 2026-11-11 [F].
- Platform: a self-hosted "data plane" (API, PostgreSQL, Redis, object storage, Brainstore) with a Braintrust-hosted "control plane" providing "the web UI, authentication, user management, and metadata" [F] (<https://docs.braintrust.dev/guides/self-hosting>).
  The platform licence is not stated on that page; classified proprietary because no platform source is published (UNVERIFIED as to plan gating).
- autoevals (<https://github.com/braintrustdata/autoevals>): MIT; js-0.4.1 on 2026-10-21 [F].
- Decision: **REJECT** the platform (proprietary control plane).
  **STUDY** autoevals' scorer prompts.

### D.9 Opik

- Repository: <https://github.com/comet-ml/opik> [F].
  Licence: Apache-2.0 [F].
  Release 2.2.145 on 2026-11-17 [F].
  Owner: Comet ML.
- Local install is "not production-ready"; Kubernetes install "Production ready"; self-hosting lacks "user management features" [F].
  Service list and telemetry: UNVERIFIED.
- Decision: **STUDY** as a permissive alternative OTLP target to Langfuse.

### D.10 evalite

- Repository: <https://github.com/mattpocock/evalite> [F].
  Archived; "Evalite is no longer maintained" and recommends Langfuse [F].
  MIT; 0.19.0 on 2025-11-06 [F].
- Decision: **REJECT** (not worth a full entry).
  Its retirement note documents what a no-server TypeScript eval runner gave developers, which CreatorBrio would now build itself.

### D.11 Other observed

- MLflow (Apache-2.0, v3.18.0 on 2026-11-04) [F] and Laminar (Apache-2.0, v0.3.4 on 2026-11-10) [F] were seen but not assessed; both are servers that duplicate Langfuse or Opik.
- Helicone (Apache-2.0) has no GitHub release since 2025-08-21 [F]; not assessed.

### D.12 Creative-quality judge and run cost ledger (BUILD)

- No candidate scores branded carousel, script or storyboard quality out of the box; promptfoo and Inspect provide only rubric machinery [F].
- CreatorBrio already renders slides to PNG with Puppeteer and frames with FFmpeg, so a vision judge can grade the exact artefact a human will approve.
- Decision: **BUILD** (see answer 3).

---

## Direct answers

### 1. Does CreatorBrio need an agent framework?

No.
The evidence points to provider SDKs plus CreatorBrio's own typed tool layer, with MCP as the external surface.
- The hard parts of this product are approvals, idempotent side effects and crash-safe state, and CreatorBrio already owns those (change-set admission, job leases, stores).
- Every framework examined either brings its own persisted state (Mastra snapshots, LangGraph checkpoints) or its own default data flow (OpenAI Agents tracing to OpenAI), and one ships source-available code inside an Apache-labelled package (Mastra).
- Anthropic's own docs send human-in-the-loop use to the manual tool loop, not the tool runner [F]; the AI SDK's approval flow returns control to the application and needs two model calls [F].
  Both confirm that the approval loop belongs to the application.
- The agent loop itself is small: call the model, validate each tool call against the tool's schema, run it through the same admission path the REST routes use, persist the result, repeat with a step and cost budget.

Recommended shape:
- A CreatorBrio `AgentBackend` port (e8 section 3.3) with three adapters: `anthropic-api` on `@anthropic-ai/sdk` (ADOPT), `openai-compatible` and other providers through the AI SDK (INTEGRATE), and the existing user-installed `claude-code-cli`.
- One typed tool registry (Zod or JSON Schema) that is the single source for the in-process loop, the MCP v2 server, and the REST input validators in `src/lib/api-input.ts`.
- Agents propose change-sets; they never apply them; run-scoped tokens bound every tool call.
- Re-test this answer only if a measured need appears for multi-agent planning that a single loop with sub-calls cannot express.

### 2. Which mechanism best models a human approval that may wait days?

A domain record, in both modes.
The approval is a state of the content item (for example `awaiting_research_approval`, `awaiting_package_approval`) plus an approval record that binds approver, decision, the content hash of the exact publishing package, and time.
A transition enqueues bounded jobs; nothing sleeps.

Why not engine waits:
- OpenWorkflow drops a signal sent before the wait starts [F]; an approval clicked during a retry would vanish.
- The Workflow SDK says of a hook token, "It is not an authentication mechanism", and its Local World loses queued and delayed messages on restart [F].
- LangGraph re-runs the interrupted node on resume [F]; Mastra and LangGraph keep the authoritative state in framework snapshots [F].
- DBOS sells resource-free suspension as a paid feature [F].
- A package approval must invalidate itself if any asset changes; a content hash in a domain record does that, while an engine signal carries no such binding.

Local one-machine mode:
- Domain state in the existing crash-safe stores, the existing file-backed job lifecycle in a separate worker process, and a due-time scanner for scheduled publishing, approval reminders and expiry.
- No database or second service.

Hosted mode:
- The same state machine on PostgreSQL, with pg-boss (INTEGRATE) running the bounded jobs in the same transaction as the state change, cron for the scanner, and per-tenant columns on every record.
- Escalate to DBOS or Hatchet only if a measured requirement for long multi-step compensation appears; Absurd and OpenWorkflow are worth re-checking at that point.
- The mobile client approves through the same API, authenticated as the approver, never through an engine webhook URL.

### 3. What should CreatorBrio use to measure creative quality and cost per run?

Build a small evaluation and cost layer, and use promptfoo only as the development-time harness.

Quality:
- Ground truth is the product's own human decisions: approval and rejection at both gates, rejection reasons, and the size of human edits between the generated package and the approved one.
  These are recorded anyway by the approval records in answer 2.
- A rubric judge, written as versioned prompt files in the repository, grades each script, storyboard and rendered slide set against the brand configuration on named criteria (hook strength, claim support against retrieved sources, brand voice, visual hierarchy and legibility at phone size, slide-to-slide coherence).
- Grade the rendered PNG frames with a vision-capable model, because what the human approves is the image, not the HTML.
- Prefer pairwise comparison against the last approved variant over absolute 1-to-10 scores, and calibrate the judge against the human decisions above before trusting it.
- Use a different model family for judging than for generating where the user has keys for two providers.
- Run the fixture suite (synthetic briefs and brands) through promptfoo in CI or locally: `llm-rubric` with an image `rubricPrompt`, `select-best` for pairwise, `cost` and `latency` assertions [F], with `PROMPTFOO_DISABLE_TELEMETRY=1`.
- Inspect AI is the design reference if the suite grows into a research harness.

Cost per run:
- Record usage from every provider response (input, output, cache-read and cache-write tokens, images, media seconds) on the run record, priced from a versioned price table in the repository, and summed per content item, per approval cycle and per tenant.
- Emit the same values as OpenTelemetry GenAI attributes (ADOPT) so a hosted operator can point OTLP at Langfuse (which accepts `gen_ai.usage.*` and prefers ingested costs [F]) or Opik, without any vendor code in the core.
- Keep telemetry recording of prompts and outputs off by default, since briefs, brand material and retrieved sources are user content.

---

## Sources (all retrieved 2026-11-17)

GitHub API (repository metadata, `/license`, `/releases?per_page=3`, `/commits?per_page=1`, `/contents`), each at `https://api.github.com/repos/<owner>/<repo>`:
- anthropics/anthropic-sdk-typescript; anthropics/claude-agent-sdk-typescript (LICENSE.md); vercel/ai (LICENSE); modelcontextprotocol/typescript-sdk (LICENSE, README); mastra-ai/mastra (LICENSE.md, ee/LICENSE, source tree); langchain-ai/langgraphjs; langchain-ai/langgraph; openai/openai-agents-js; BoundaryML/baml; TanStack/ai; run-llama/LlamaIndexTS (README); pydantic/pydantic-ai; VoltAgent/voltagent; google/adk-js; cloudflare/agents; strands-agents/sdk-typescript (README); microsoft/agent-framework.
- timgit/pg-boss (README); graphile/worker; taskforcesh/bullmq; dbos-inc/dbos-transact-ts; hatchet-dev/hatchet; temporalio/temporal; temporalio/sdk-typescript; triggerdotdev/trigger.dev; inngest/inngest (LICENSE.md); inngest/inngest-js (package LICENSE.md and package.json files); restatedev/restate (LICENSE); restatedev/sdk-typescript; earendil-works/absurd; vercel/workflow (README); openworkflowdev/openworkflow; sidequestjs/sidequest; pgflow-dev/pgflow; Effect-TS/effect; electric-sql/pglite.
- promptfoo/promptfoo (LICENSE); langfuse/langfuse (LICENSE, ee/LICENSE); langfuse/langfuse-js; UKGovernmentBEIS/inspect_ai; confident-ai/deepeval; openai/evals (LICENSE.md); Arize-ai/phoenix (LICENSE, js/packages, packages); Arize-ai/openinference; braintrustdata/braintrust-sdk-javascript (LICENSE, js/package.json); braintrustdata/autoevals; comet-ml/opik; mattpocock/evalite (README); mlflow/mlflow; lmnr-ai/lmnr; Helicone/helicone; open-telemetry/semantic-conventions-genai (README).

Registries:
- npm `npm view <pkg> license version time` for every npm package named above.
- unpkg file listings: <https://unpkg.com/@mastra/core@1.83.0/?meta>, `LICENSE.md`, `package.json`, and `dist/*.js` import scan; <https://unpkg.com/@arizeai/phoenix-client@8.0.1/?meta>, `@arizeai/phoenix-otel@3.1.0`, `@arizeai/phoenix-evals@2.7.1`.
- PyPI JSON: <https://pypi.org/pypi/claude-agent-sdk/json>, `arize-phoenix`, `arize-phoenix-evals`, `deepeval`, `inspect-ai`.

Documentation pages [F]:
- <https://code.claude.com/docs/en/agent-sdk/overview>
- <https://code.claude.com/docs/en/legal-and-compliance>
- <https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-runner>
- <https://ai-sdk.dev/docs/introduction>, <https://ai-sdk.dev/docs/agents/overview>, <https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling>, <https://ai-sdk.dev/docs/ai-sdk-core/telemetry>
- <https://openai.github.io/openai-agents-js/guides/tracing/>
- <https://mastra.ai/docs/workflows/suspend-and-resume>, <https://mastra.ai/docs/observability/overview>
- <https://docs.langchain.com/oss/javascript/langgraph/interrupts>
- <https://workflow-sdk.dev/docs/deploying/world/local-world>, <https://workflow-sdk.dev/docs/foundations/hooks>
- <https://github.com/earendil-works/absurd> (README), <https://github.com/openworkflowdev/openworkflow> (README), <https://raw.githubusercontent.com/openworkflowdev/openworkflow/main/ARCHITECTURE.md>
- <https://pgboss.io/database-backends>, <https://pglite.dev/docs/about>, <https://pglite.dev/docs/pglite-socket>
- <https://docs.bullmq.io/>
- <https://docs.dbos.dev/typescript/reference/configuration>, <https://www.dbos.dev/pricing>
- <https://trigger.dev/docs/self-hosting/overview>
- <https://docs.hatchet.run/self-hosting>
- <https://www.promptfoo.dev/docs/configuration/telemetry/>, <https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/>, <https://www.promptfoo.dev/docs/configuration/expected-outputs/deterministic/>
- <https://langfuse.com/blog/joining-clickhouse>, <https://langfuse.com/self-hosting>, <https://langfuse.com/docs/observability/features/token-and-cost-tracking>
- <https://inspect.aisi.org.uk/>
- <https://deepeval.com/docs/data-privacy>
- <https://docs.braintrust.dev/guides/self-hosting>
- <https://arize.com/docs/phoenix/self-hosting>
- <https://www.comet.com/docs/opik/self-host/overview>
- <https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-spans/> (moved notice only)

Search only [S]:
- OpenAI acquisition of Promptfoo, 2026-03-09: search results citing <https://openai.com/index/openai-to-acquire-promptfoo/> (HTTP 403 on fetch), TechCrunch and Bloomberg.

Local repository inputs:
- [the preserved independent review](../reviews/2026-11-17-pr215-independent-review.md) sections 7, 12 and P1-1.
- `origin/main:docs/research/video-studio/evidence/e8-tts-sourcing-providers.md` section 3.
- `origin/main:docs/research/video-studio/spec/08-licensing-and-commercial.md`.
