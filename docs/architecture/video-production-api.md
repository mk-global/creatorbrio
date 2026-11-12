# Video Studio Production API

[← Architecture](README.md) · Store: [video-production-store.md](video-production-store.md) · Media: [video-media-registry.md](video-media-registry.md)

The local HTTP API over the [production store](video-production-store.md) (WS1 #120) and the [media registry](video-media-registry.md) (#140).
It lives in `src/lib/video/production/api/`, with thin route files under `src/app/api/video/productions/` and `src/app/api/video/media/`.
The [Studio page](video-studio-page.md) at `/studio` is its user interface.

## One mutation path

Every handler makes exactly one `ProductionStore` call.
The store decides each change through the change-set engine (#115), which admits every new document with `admitProduction()` (#113), and commits it with its cross-process compare-and-swap (#119).
Handlers parse, authorise and map results; they never edit a production.

The store admits every new or restored state against the media registry, its asset ledger: a production may reference only registered media, with the kind each role needs, and every source range must end within its media's duration.
That covers create, change sets, undo, redo, label restores and run decisions.
Stored states are read without the ledger, so a production stays readable even if its media is missing, but it cannot change until the media is registered again.

## Who is calling

The server decides the caller's authority from a credential. It never takes it from the body.

| Authority | Credential | How it is obtained |
|---|---|---|
| Human (API client) | Header `X-CreatorBrio-Human-Key: <key>` | The key is 32 random bytes in `data/video-studio.key`, created with owner-only permissions (0600) on first use. It is for scripts and developer tools on this computer, is never served over HTTP and is never given to a browser. |
| Human (paired browser) | Cookie `cb_studio_session`, plus header `X-CreatorBrio-Request: studio` | Set by [pairing](#pairing-a-browser): `HttpOnly`, `SameSite=Strict`, `Path=/api/video`, valid for 12 hours, revocable. Page JavaScript cannot read it. |
| Agent | Header `Authorization: Bearer cbrun_…` | Returned once when a person begins an agent run. It is bound to that production and run, and kept only as a SHA-256 hash in the server's memory. It ends when the run ends, is replaced on resume, and does not survive a server restart. |
| None | — | Every endpoint answers 401 `authority_required`. |

A request with more than one credential is refused (`ambiguous_credential`).
A paired browser and the human key have the same authority: both are a person.
The fields `by`, `actor`, `role`, `userId`, `user`, `runId`, `agentRunId`, `id`, `at`, `approved`, `approval`, `approvals`, `human`, `isHuman`, `authority`, `override`, `force`, `revision` and `generation` are refused by name with `server_owned_field`.
A forged actor therefore fails loudly instead of being ignored.
The server sets the change set's id, time, actor and run itself.
Agents also cannot approve: the engine refuses person-only statuses and operations for any change set made with an agent token.

### What this does and does not protect against

- **Protected:**
  - web pages and other sites, by the loopback Host and Origin checks, because they cannot read the key, and because they cannot use a paired browser's session (see [cookie requests](#cookie-requests));
  - agents, which the specification limits to MCP tools with no shell and no access to `data/` (spec 06 §9);
  - any process that can reach the port but cannot read the user's files;
  - an agent changing a request field to act as a person.
- **Not protected:** a process running with arbitrary execution as the same operating-system user can read every local secret: the key file, the session and pairing records' directory, and the browser's cookie store. It can also run `npm run studio:pair` itself, or edit `data/` directly. That includes today's carousel Design Agent, which has Bash. Separating such a process from the person needs operating-system account separation, which is outside this local, single-user design. Pairing does not change this, and nothing here claims to be a browser or operating-system sandbox.

## Pairing a browser

Pairing gives a browser a session without the human key ever reaching it.

1. **The operator runs `npm run studio:pair` in a terminal**, as the account that owns the checkout.
   - It prints a 20-character code (100 bits, Crockford base32, shown as four groups of five). The code works once, for five minutes.
   - The code appears only in that terminal. The script refuses to print it when its output is not a terminal, so a tool whose output is captured or logged does not record it by accident. That is a guard against mistakes, not a boundary.
   - Only the code's SHA-256 hash is stored, in `data/video-auth/pairing/` (directory 0700, file 0600). No HTTP endpoint, page or agent tool issues or reveals codes.
2. **The person enters the code in the Studio page.** The page sends `POST /api/video/session` with `{ "code" }`.
   - The request must have a loopback Host and this app's exact `Origin` (present, not merely "not foreign"), carry `X-CreatorBrio-Request: studio`, and must not be marked by the browser as anything other than `Sec-Fetch-Site: same-origin`.
   - Before it creates a session, the server claims the code in three steps, each of which alone refuses a second redeemer:
     1. It renames the code's record out of `pairing/` into `data/video-auth/claimed/` under a name unique to that attempt. Only one rename of a file succeeds, and the code then no longer exists where redemption looks for it.
     2. It creates the marker `claimed/<hash>.won` exclusively, which only one caller can do.
     3. It reads the moved record and checks it has not expired.
   - So a code cannot be replayed, and simultaneous redeemers cannot both win, in any number of processes or across a restart. Deleting the record is not used as the claim: on macOS 27.2 (APFS), concurrent deletes of one file were seen to report success to several callers.
   - A crash at any step leaves the code used and creates no session. Files in `claimed/` are removed once they are ten minutes old. Cleanup runs only after a successful pairing, and inspects at most 128 files and removes at most 32 each time. Removing them cannot make a code redeemable again.
   - On success it answers 201 `{ status: "paired", expiresAt }` and sets the cookie. The body never contains the token.
3. **The session** is 32 random bytes. The server stores only its SHA-256 hash, in `data/video-auth/sessions/` (0600), and checks that record on every request, so revocation takes effect at once in every process.
   - A session lasts 12 hours. It survives a server restart, and pairing again replaces the browser's previous session.
   - At most 16 sessions are kept; the oldest are dropped.

| Request | Purpose |
|---|---|
| `POST /api/video/session` `{ code }` | Pair: 201 and the cookie. 401 `invalid_pairing_code` for a wrong, expired or used code. 429 `rate_limited` (with `Retry-After`) after 5 failures in a minute. |
| `GET /api/video/session` | 200 `{ authenticated, expiresAt }`, or 401 `not_paired` |
| `GET /api/video/session?status=1` | 200 `{ paired: true, expiresAt }` or 200 `{ paired: false }`: whether this browser is paired, for pages outside the Studio, so an unpaired visit logs no error. The same browser checks apply, and it grants nothing |
| `DELETE /api/video/session` | Sign out: the session record is deleted and the cookie cleared, so a copied cookie stops working too |
| `npm run studio:pair -- --revoke-all` | Sign out every paired browser and cancel unused codes |

**Guessing.** After 10 failed attempts, every pending code is cancelled, so guessing gains nothing even if a restart resets the per-minute limit.

### Cookie requests

A cookie is sent automatically, so a request that relies on the session cookie must also:

- carry `X-CreatorBrio-Request: studio`. A cross-origin page cannot send a custom header without a CORS preflight, which this server never approves;
- not be marked by the browser as `Sec-Fetch-Site` other than `same-origin`. Pages on another port of the same host are same-site but not same-origin, so `SameSite=Strict` alone would not stop them;
- when it changes state, carry this app's exact `Origin`.

Otherwise it is refused with 403, before the session is even looked up.

**Media elements.** `<video>`, `<audio>` and `<img>` cannot add a header, so the [derived-file route](#media) makes one narrow exception.
A `GET` or `HEAD` there may omit `X-CreatorBrio-Request` when the browser itself sends both `Sec-Fetch-Site: same-origin` and `Sec-Fetch-Dest` of `video`, `audio` or `image`.
Here the fetch metadata is required, not merely "not foreign": a page on another localhost port is same-site, so its `SameSite=Strict` cookie would be sent, and only `same-origin` tells the two apart.
A navigation (`document`), a script read (`empty`, which must send the header as usual), a missing header and every other route keep the normal rules.
Such a request can only read preview bytes; originals are never served.

DNS rebinding is stopped by the loopback Host check. In addition, a rebound domain's requests never carry this host's cookie.

### Limits

- **A stolen cookie works until it expires or is revoked.** The cookie value is a bearer token: a non-browser client that copies it can send the Studio header itself. Signing out or `--revoke-all` ends it at once.
- **Cookies are not isolated by port.** Another web server on this computer at the same host name receives the cookie if the browser sends a request to it under `/api/video`.
- **The cookie is not `Secure` over plain HTTP** on `localhost` or `127.0.0.1`. It is when the app is served over HTTPS.
- **Single use relies on the local filesystem's `rename` and exclusive create.** Both were tested to give exactly one winner under contention on macOS 27.2 (APFS) and on Linux, the platforms the app runs on. A `data/` folder on a network share or a synced folder is not covered by that evidence.

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
| `GET /api/video/productions/:id/preview` | human | none | 200 `{ productionId, revision, generation, preview }`: `preview` is `{ ok: true, plan, overlay: { html, activeRanges } }`, or `{ ok: false, issues }` when the revision cannot be exported |

Each route exports only the methods listed, so Next.js answers any other method with 405.

The preview is compiled by the same compiler and overlay builder the export uses, for the stored revision, so the Studio draws what the export would draw ([video-studio-page.md](video-studio-page.md#preview)).
A revision that cannot be exported is still a 200, with the compiler's issues; an overlay that cannot be built answers 503 when it is a configuration problem (such as a missing font) and 500 otherwise, with the renderer's code.

### Media

| Method and path | Who | Body | Success |
|---|---|---|---|
| `GET /api/video/media` | human | none | 200 `{ media }`: every record with its facts, provenance and `derived` state |
| `POST /api/video/media` | human | `{ path }`: the absolute path of a local file | 201 `{ status: "created", media }`, or 200 `{ status: "existing", media }` for bytes already registered |
| `GET /api/video/media/:mediaId` | human | none | 200: the record and its `derived` state (`queued`, `running`, `succeeded`, `failed` with `failure`) |
| `POST /api/video/media/:mediaId/proxy` | human | none | 202: a failed derived-files job is queued again |
| `GET`, `HEAD /api/video/media/:mediaId/files/:name` | human, also a paired browser's media element (see [cookie requests](#cookie-requests)) | none | 200 or 206: `proxy.mp4`, `proxy.m4a`, `proxy.png`, `poster.jpg` or `peaks.json`, once the job succeeded |

Imports read a file on this computer, so they are a person's action only; agents get 403 on every media route.
The submitted path is never logged, stored or returned; the record keeps only the file's name.
An import runs within the request: it probes the file, clones or copies it and hashes the copy, so a very large file on a filesystem without copy-on-write holds the request for as long as the copy takes.
Moving it into a job is [#141](https://github.com/mk-global/creatorbrio/issues/141).

Derived files support a single `Range: bytes=` range (206 with `Content-Range`), answer 416 with `Content-Range: bytes */size` past the end, and are served whole for anything else.
They are sent with `Accept-Ranges: bytes`, `X-Content-Type-Options: nosniff`, a sandboxing `Content-Security-Policy` and `Cache-Control: no-store`.
They are never cached: a browser's HTTP cache is shared by every port of the same host, so a cached copy would let a page on another port, or a plain navigation, read the bytes without passing these checks.
A real browser showed exactly that before this was changed.

### Renders

| Method and path | Who | Body | Success |
|---|---|---|---|
| `GET /api/video/productions/:id/renders` | human | none | 200 `{ renders }`: every render of the production, newest first; an unknown production has none |
| `POST /api/video/productions/:id/renders` | human | `{ profile? }`, default `instagram` | 202 `{ status: "queued", render }`, or 200 `{ status: "existing", render }` while a render of this exact document and profile is queued or running |
| `GET /api/video/productions/:id/renders/:renderId` | human | none | 200: the render's state, attempts, progress, `failure`, `verification` and, once it succeeded, its `files` |
| `POST /api/video/productions/:id/renders/:renderId/cancel` | human | none | 202 `{ status: "cancelled" \| "cancelling", render }`; while cancelling, the render carries `cancelRequested: true` |
| `POST /api/video/productions/:id/renders/:renderId/retry` | human | none | 202 `{ status: "queued", render }`: a failed or cancelled render is queued again from its snapshot |
| `GET`, `HEAD /api/video/productions/:id/renders/:renderId/files/:name` | human; for `video.mp4` also a paired browser's media element | none | 200 or 206: `video.mp4`, `captions.srt`, `captions.vtt` or `manifest.json`, once the render succeeded |

A request compiles the production's current revision first.
If it cannot be exported, it is refused with 422 `render_refused`, the `revision` and the compiler's `issues`, and nothing is queued; the codes are in [video-rendering.md](video-rendering.md#the-render-plan).
Otherwise the document that compiled is snapshotted, so later edits never change that render.
Rendering reads originals and runs browsers and FFmpeg on this computer, so it is a person's action only; agents get 403 on every render route.
Render files are sent as downloads (`Content-Disposition: attachment; filename="<productionId>-<renderId>-<name>"`) with the same headers and caching rules as derived files; only `video.mp4` supports Range requests.
A download link cannot send the Studio header, so the Studio page reads a render file with the header and saves it from memory; a navigation without the header is refused like any other cookie request.
A render's lifecycle, failure codes and recovery are in [video-rendering.md](video-rendering.md#render-jobs).

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
| 401 | `authority_required`, `invalid_credential`, `ambiguous_credential`, `invalid_pairing_code`, `not_paired` | No valid credential |
| 403 | `request_refused` | Non-loopback Host, or a cross-site Origin on a write; for pairing, any check in [Pairing a browser](#pairing-a-browser) |
| 403 | `session_request_refused` | A session cookie on a request without the Studio header (outside the media-element exception), with cross-site fetch metadata, or without this app's Origin on a write |
| 403 | `forbidden` | The authority may not do this, or the token is for another production |
| 400 | `invalid_path`, `not_a_file`, `inside_data_directory` | An import path that is not absolute, names a folder, link or device, or lies inside CreatorBrio's data folder |
| 404 | `not_found`, `run_not_found`, `media_not_found`, `render_not_found`, `file_not_found` | No such production, open run, media, render, file to import, or derived or render file name |
| 409 | `job_not_failed`, `not_ready` (with `derived` or `render`), `not_cancellable`, `not_retryable` (with `render`) | Only a failed job can be retried; a derived or render file is not available yet; only a queued or running render can be cancelled, and one that another running server is working on only from that server; only a failed or cancelled render can be retried |
| 413 | `too_large` | The file to import is over the import limit (32 GiB) |
| 415 | `unsupported_media` | The file to import is not video, audio or a still image that ffprobe can read |
| 503 | `tool_missing` | ffprobe is not installed |
| 409 | `stale_revision` (with `expectedRevision`, `actualRevision`), `run_in_progress`, `no_open_run`, `already_exists`, `generation_mismatch` (with both generations), `run_not_interrupted`, `unsupported_version` | Conflicts with the current state |
| 413 | `body_too_large` | The body exceeds 2 MiB |
| 415 | `unsupported_media_type` | The body is not JSON |
| 422 | `rejected` (with `stage` and `issues`) | The engine refused the change; nothing was written |
| 422 | `render_refused` (with `revision` and `issues`) | The current revision cannot be exported; nothing was queued |
| 423 | `recovery_required` (with `runId`, `ownerAlive`) | An agent run is open and is not this server's; a person must decide |
| 428 | `confirmation_required` | A destructive command lacks `expectedGeneration` |
| 429 | `rate_limited` (with `Retry-After`) | Too many failed pairing attempts |
| 500 | `production_corrupt` (with `generation`), `storage_error`, `internal_error` | Damaged data or a storage failure; no paths or file contents are returned |
| 503 | `contended` (with `Retry-After`) | Other writers kept committing first |

## Not built yet

- **Stage-exit approvals** when edits are applied.
- **Browser upload** of media: Next.js keeps only the first 10 MB of a request body that passes `src/proxy.ts`, so uploads need their own route design ([#141](https://github.com/mk-global/creatorbrio/issues/141)).
  Import is by path.
- **Bundle export and import.**
