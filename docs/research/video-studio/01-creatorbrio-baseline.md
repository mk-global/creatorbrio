# 01 · CreatorBrio today: what exists and what Video Studio can reuse

[← Research index](README.md)

Inspected at `main` commit [`ecf5db7`](https://github.com/mk-global/creatorbrio/tree/ecf5db7f443b2424e26ee811ba283c357161cea2) on 2026-11-03.
Everything on this page is **verified directly in source code** unless it says otherwise.

## Summary

CreatorBrio has **no video code**.
No module, type, route, dependency or issue deals with video, audio, timelines, transcription or rendering over time.
Every mention of "reel" in the repository refers to a *reel cover*, a single 9:16 still image designed as a one-slide carousel.
No issue before [#63](https://github.com/mk-global/creatorbrio/issues/63) proposes video work.

The application does contain several patterns that Video Studio should copy rather than reinvent.
These are the controlled Claude CLI subprocess, the plan-then-validate-then-execute split, typed capabilities, crash-consistent assets, locked JSON storage, the loopback-only API and the shared HTML rendering contract.
Those patterns, more than any individual component, are what makes CreatorBrio's existing workflow reliable, and the recommended architecture extends them to video.

## Current stack

| Area | What is used | Evidence |
|---|---|---|
| App | Next.js 16.2.3 (App Router), React 19.2.4, TypeScript 5, Tailwind v4 | [`package.json`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/package.json) |
| Rendering | Puppeteer 24 (one headless Chromium per server process), `sharp` | [`src/lib/export-slides.ts`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/lib/export-slides.ts) |
| Storage | JSON files in `data/` behind a per-file `async-mutex` and write-then-rename | [`src/lib/data.ts`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/lib/data.ts) |
| Agents | Claude CLI subprocesses: Visual Director (`Read` only, `--json-schema`, no session) and Design Agent (`Bash WebFetch Read`, resumable session) | [`src/lib/visual-director.ts#L420-L442`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/lib/visual-director.ts#L420-L442), [`src/lib/design-agent.ts`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/lib/design-agent.ts) |
| Optional local model service | Separate loopback image service (`POST /generate`, `POST /edit` background replacement), bearer token, not in this repository | [`src/lib/image-service.ts#L1-L60`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/lib/image-service.ts#L1-L60) |
| Network boundary | Listens on 127.0.0.1; `src/proxy.ts` refuses non-loopback `Host` and cross-site `Origin` | [`src/proxy.ts`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/proxy.ts) |
| Tests | Vitest suites, opt-in evaluation harnesses in `eval/` | [`tests/`](https://github.com/mk-global/creatorbrio/tree/ecf5db7f443b2424e26ee811ba283c357161cea2/tests), [`eval/`](https://github.com/mk-global/creatorbrio/tree/ecf5db7f443b2424e26ee811ba283c357161cea2/eval) |

## Reusable assets, and how each maps to Video Studio

| Existing module | What it does today | Reuse for Video Studio | Change needed |
|---|---|---|---|
| `src/lib/data.ts` (`mutateData`, `readDataSafe`) | Locked read-modify-write of JSON with atomic rename; refuses to overwrite corrupt files | Index of video projects (`data/video-projects.json`) and job records | None to the module. Project documents themselves should be per-project files, because a timeline with transcripts is too large for one shared JSON file (see [07](07-integration-plan.md)) |
| `src/lib/claude-path.ts` | Finds the `claude` executable portably | Every video agent invocation | None |
| `src/lib/visual-director.ts` (invocation pattern) | Isolated, stateless CLI call: `--tools Read`, path-scoped `Read`, `--json-schema`, `--no-session-persistence`, `--strict-mcp-config`, budget, timeout, stdin input | **Edit Director**: the video planner returns a schema-validated edit plan the same way | New instructions and schema; same isolation flags |
| `src/lib/director-plan.ts` (`validatePlan`) | Validates every binding field of a plan before anything executes | Template for validating edit operations against the project | New validator for the operation vocabulary |
| `src/lib/creative-capabilities.ts` | Fixed table of capabilities with availability computed from local facts | The **capability registry** for video effects (captions, collage, diagram, segmentation, SFX…) | Generalise to a registry keyed by capability ID with a manifest per capability |
| `src/lib/creative-brief.ts`, `src/types/creative-brief.ts` | What the content is for, kept across revisions, with explicit vs inferred provenance | Reused unchanged as the project's brief; video adds style-profile fields | Additive fields only |
| `src/lib/assets.ts` | Private staging, all-or-nothing attach, crash recovery, SHA-256 integrity, 24 h staging sweep | Pattern for generated media (rendered layers, SFX, B-roll, masks) | A media-sized variant: video files cannot be read into memory and hashed in one call; streaming hashes and hard links instead of copies |
| `src/lib/generation-status.ts` | One active run per carousel; interruption classification; export refused while a run is active | One active agent run per video project; render refused while plan execution is active | New keys; same semantics |
| `src/lib/chat-stream.ts` | Typed SSE contract with stable error and blocked codes, stage events | Chat panel for Video Studio reuses the contract, with new stages (`analysing`, `planning-edit`, `applying`, `rendering-preview`) | Additive stage and code values |
| `src/lib/slide-html.ts` (`wrapSlideHtml`, font extraction) and `src/lib/fonts.ts` (inlined font CSS) | One HTML document contract for preview and export; embedded Google Fonts | The same contract for **HTML overlay layers** (titles, captions, lower thirds, diagrams), so brand fonts behave identically in video and carousels | Overlay documents add a time-seek hook; see [05](05-proposed-architecture.md#rendering-contract) |
| `src/lib/export-slides.ts` (single managed browser) | One headless Chromium per server; bounded waits; recycling | Hosts the overlay-frame renderer for video | Frame-sequence capture loop and alpha output; the browser lifecycle code is reused |
| `src/lib/brand.ts`, `src/types/brand.ts` | Multiple brands with colours, fonts, logo, style keywords; fixed `brandId` per carousel | Brand identity for every video project; extended by a per-brand **video style profile** | New optional fields or a sibling `data/video-styles.json` |
| `src/proxy.ts`, `src/lib/request-guard.ts` | Loopback-only API and cross-site refusal | Applies unchanged to the new `/api/video/*` routes and to the local media worker | None |
| `src/lib/reference-images.ts` (confinement) | Proves a reference is an existing PNG inside uploads before an agent sees it | Same rule for media references: agents only ever see server-issued media IDs | New `confineMedia` for video and audio paths |
| Visual Director evaluation harness (`eval/director/`) and acceptance harness (`eval/acceptance/`) | Opt-in scenario scoring with deterministic checks plus a model judge | Edit-plan evaluation: scenario footage + expected operations + judged output | New scenarios |

## What does not fit video, and why

| Existing behaviour | Why it does not carry over |
|---|---|
| `POST /api/upload` buffers the whole file, caps it at 10 MB, and resizes images to 1080 px ([`src/app/api/upload/route.ts#L8`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/app/api/upload/route.ts#L8)) | Footage is routinely several GB. Ingest must stream to disk, or better, register a local file path and copy or link it into the project's media folder without passing bytes through the browser at all |
| `public/uploads/` served through Next.js | Large media should not live under `public/`, where a build step can try to include it; video needs a dedicated `media/` root served by a range-capable route (HTTP `Range` is required for `<video>` seeking) |
| Slide versioning (`previousVersions`, five per slide) | A timeline needs whole-document versions plus an operation log, not per-element string snapshots |
| The Design Agent writing state through `curl` with `Bash` | Acceptable for slide HTML, where one bad slide is visible and isolated. For a timeline, free-form writes risk corrupting cross-references (clip IDs, track sync). Video edits go through validated operations instead (see [05](05-proposed-architecture.md#how-claude-edits-safely)) |
| Everything happens inside the request that asked for it | Transcription, analysis and full renders can take minutes. They need a small persistent local job runner with progress, still in-process and file-backed, not a queue service |

## Existing extension points the code already documents

[`docs/architecture/design-decisions.md`](../../architecture/design-decisions.md#extension-points) states that a new kind of work ("for example motion") needs "a capability row, a plan operation and an executor in code".
The proposed architecture follows that rule.
Every video capability is a capability row, every edit is a typed operation, and every effect has a deterministic executor.

## Existing product rules Video Studio must keep

- **No silent substitution, no automatic retry** of required work ([design-decisions.md](../../architecture/design-decisions.md#no-silent-fallback-no-automatic-retry)).
- **The person stays exactly as recorded.** The image-editing decision that a person's likeness is never regenerated ([design-decisions.md](../../architecture/design-decisions.md#editing-keeps-the-person-exactly-as-photographed)) applies to video: background replacement, masks and relighting must never re-synthesise the speaker's face. Generative video models are therefore excluded from any operation that touches the speaker.
- **Local first, plain files**, no database, queue or agent framework ([architecture README](../../architecture/README.md#local-first-principles)).
- **Agents run as the same OS user**; tool restrictions are CLI policy, not isolation. Media workers must therefore also accept only server-issued IDs, never paths from a model.
