# Video Studio Production API

[← Architecture](README.md) · Store: [video-production-store.md](video-production-store.md)

The local HTTP API over the [production store](video-production-store.md) (WS1 #120).
It lives in `src/lib/video/production/api/`, with thin route files under `src/app/api/video/productions/`.
No UI uses it yet.

## One mutation path

Every handler makes exactly one `ProductionStore` call.
The store decides each change through the change-set engine (#115), which admits every new document with `admitProduction()` (#113), and commits it with its cross-process compare-and-swap (#119).
Handlers parse, authorise and map results; they never edit a production.

## Who is calling

The server decides the caller's authority from a credential. It never takes it from the body.

| Authority | Credential | How it is obtained |
|---|---|---|
| Human | Header `X-CreatorBrio-Human-Key: <key>` | The key is 32 random bytes in `data/video-studio.key`, created with owner-only permissions (0600) on first use. It is never served over HTTP. |
| Agent | Header `Authorization: Bearer cbrun_…` | Returned once when a person begins an agent run. It is bound to that production and run, and kept only as a SHA-256 hash in the server's memory. It ends when the run ends, is replaced on resume, and does not survive a server restart. |
| None | — | Every endpoint answers 401 `authority_required`. |

A request with both credentials is refused (`ambiguous_credential`).
The fields `by`, `actor`, `role`, `userId`, `user`, `runId`, `agentRunId`, `id`, `at`, `approved`, `approval`, `approvals`, `human`, `isHuman`, `authority`, `override`, `force`, `revision` and `generation` are refused by name with `server_owned_field`.
A forged actor therefore fails loudly instead of being ignored.
The server sets the change set's id, time, actor and run itself.
Agents also cannot approve: the engine refuses person-only statuses and operations for any change set made with an agent token.

### What this does and does not protect against

- **Protected:** web pages and other sites (by the loopback Host and Origin checks, and because they cannot read the key); agents, which the specification limits to MCP tools with no shell and no access to `data/` (spec 06 §9); any process that can reach the port but cannot read the user's files; and an agent changing a request field to act as a person.
- **Not protected:** a process running as the same operating-system user with a shell can read the key file, as it can read and edit `data/` directly. That includes today's carousel Design Agent, which has Bash. Separating such a process from the person needs operating-system isolation, which is outside this local, single-user design.
- **How the Studio UI obtains the key:** this is left to the UI ticket. Embedding the key in a page would let any local process that can fetch the page read it, so the UI needs its own pairing step, for example a one-time code shown in the terminal that is exchanged for an HttpOnly, SameSite=Strict cookie.

## Endpoints

All bodies are JSON (`Content-Type: application/json`), at most 2 MiB, and a JSON object.
Each body may carry only the fields listed for its endpoint.

| Method and path | Who | Body | Success |
|---|---|---|---|
| `GET /api/video/productions` | human | — | 200 `{ productions }`: summaries; damaged productions are listed with their status |
| `POST /api/video/productions` | human | `{ production }`: a whole document, admitted | 201 `{ productionId, revision, generation }` |
| `GET /api/video/productions/:id` | human, or the agent of this production's run | — | 200: the document, the history as revisions, labels, the run and `recoveryRequired` |
| `POST /api/video/productions/:id/changes` | human, agent | `{ baseRevision, summary, ops, scope? }` | 200 `{ changeSetId, fromRevision, revision, generation }` |
| `POST /api/video/productions/:id/undo`, `…/redo` | human | `{ expectedGeneration }` | 200 |
| `POST /api/video/productions/:id/labels` | human | `{ name, expectedGeneration? }` | 200 |
| `POST /api/video/productions/:id/labels/:name/restore` | human | `{ expectedGeneration }` | 200 |
| `POST /api/video/productions/:id/runs` | human | `{ scope? }` | 201 `{ runId, token, generation }`; the run id is issued by the server |
| `POST /api/video/productions/:id/runs/:runId/decision` | human | `{ decision: "keep" \| "discard" \| "resume", expectedGeneration }` | 200; `resume` (interrupted runs only) returns a new `token` |
| `POST /api/video/productions/:id/recover` | human | `{ fromGeneration, expectedGeneration }` | 200 |

Each route exports only the methods listed, so Next.js answers any other method with 405.

### Confirmation

Commands that replace content or end a run need `expectedGeneration`: the `generation` from the caller's latest read, or from the `production_corrupt` error for recovery.
These are undo, redo, restore, every run decision and recovery.
The store checks it inside its commit loop, against the state the command would be committed on top of.
If anything was committed in between, including by another process, the command is refused with `generation_mismatch` and nothing changes.
A change set's `baseRevision` is checked the same way by the engine at commit.

## Errors

Every error is `{ "error": { "code", "message", …details } }`, sent with `Cache-Control: no-store`.

| Status | Code | When |
|---|---|---|
| 400 | `invalid_json`, `invalid_body`, `invalid_id`, `invalid_field`, `missing_field`, `unknown_field`, `server_owned_field`, `invalid_request` | The request is malformed, or names a field the server owns |
| 401 | `authority_required`, `invalid_credential`, `ambiguous_credential` | No valid credential |
| 403 | `request_refused` | Non-loopback Host, or a cross-site Origin on a write |
| 403 | `forbidden` | The authority may not do this, or the token is for another production |
| 404 | `not_found`, `run_not_found` | No such production, or no such open run |
| 409 | `stale_revision` (with `expectedRevision`, `actualRevision`), `run_in_progress`, `no_open_run`, `already_exists`, `generation_mismatch` (with both generations), `run_not_interrupted`, `unsupported_version` | Conflicts with the current state |
| 413 | `body_too_large` | The body exceeds 2 MiB |
| 415 | `unsupported_media_type` | The body is not JSON |
| 422 | `rejected` (with `stage` and `issues`) | The engine refused the change; nothing was written |
| 423 | `recovery_required` (with `runId`, `ownerAlive`) | An agent run is open and is not this server's; a person must decide |
| 428 | `confirmation_required` | A destructive command lacks `expectedGeneration` |
| 500 | `production_corrupt` (with `generation`), `storage_error`, `internal_error` | Damaged data or a storage failure; no paths or file contents are returned |
| 503 | `contended` (with `Retry-After`) | Other writers kept committing first |

## Not built yet

- **Studio UI pairing** for the human key, with the UI ticket.
- **Stage-exit approvals** and **media-ledger checks** when edits are applied.
- **Bundle export and import.**
