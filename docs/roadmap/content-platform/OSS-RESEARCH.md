# Open-source technology and platform research

**Status:** research record under [#216](https://github.com/mk-global/creatorbrio/issues/216); the decisions here are PROPOSED until accepted in the [decision register](DECISION-REGISTER.md).

**Retrieved:** 2026-11-17, unless an entry says otherwise.

**Evidence:** three detailed reports, each with per-candidate entries, fact markers ([F] fetched from a primary source, [S] seen through search only, UNVERIFIED) and source lists:

- [R1: agents, durable execution, evaluation](research/r1-agents-workflows-evals.md) (categories A, B, D);
- [R2: research, speech, audio, video, images, covers](research/r2-research-and-media.md) (categories C, E, F, G, H), which verifies and updates the [2026-11-04 Video Studio research](../../research/video-studio/README.md);
- [R3: publishing, self-hosting, SaaS, mobile](research/r3-publishing-selfhost-saas.md) (categories I, J, and the open-core economics).

The code licence of every repository the three reports cite (162 repositories) was re-checked against GitHub's licence metadata on 2026-11-17, independently of the reports, with the licence file read wherever the metadata was ambiguous.
Model weight, voice and dataset licences come from the model cards as verified in R2 and were not re-checked a second time.
Re-check notes:

- the Inngest SDK repository is reported as GPL-3.0 by GitHub, but it has no root licence file and every published package declares Apache-2.0, as R1 records;
- Web Push (MPL-2.0), the Sentry JavaScript SDK (MIT), Takumi (Apache-2.0 file present) and DeepFilterNet (MIT or Apache-2.0) were confirmed from their licence files;
- the Google auth library's repository is archived and the repository it moved to is now archived too, so its current home must be confirmed when a TypeScript YouTube client is adopted.

## Method and policy

- Licences come from LICENSE files, not marketing pages; model weights, voices, datasets and media are assessed separately from code.
- Open source is distinguished from source-available (BSL, SSPL, Elastic, FSL, Sustainable Use, Remotion-style and `ee/` enterprise directories).
- CreatorBrio's distribution policy (`docs/research/video-studio/spec/08-licensing-and-commercial.md`, sections 2 and 3) is:
  - permissive code may be bundled;
  - GPL and LGPL builds (for example FFmpeg and Piper) are allowed only as optional external tools, as separate, user-installed processes, never linked or shipped in the repository;
  - the one pre-existing case is sharp's dynamically linked LGPL libvips, which stays pending the `spec/08` clarification in the [RFC](ARCHITECTURE-RFC.md#13-required-amendments-to-accepted-documents-each-its-own-governed-change), and no new LGPL library is adopted;
  - AGPL code, GPL application code, source-available or field-restricted components and non-commercial code are excluded from the product: reference only, no code copied;
  - non-commercial weights are never defaults.
- Nothing was installed, cloned into the repository or copied.

Decisions: **ADOPT** (use as a dependency), **INTEGRATE** (use as a separate process, service or optional adapter), **STUDY** (read for ideas, no dependency), **BUILD** (CreatorBrio owns it), **REJECT**.
**REJECT as a dependency (user-supplied service only)** means CreatorBrio does not integrate, bundle or distribute the component, while a self-hoster may point a generic CreatorBrio setting at a service they run themselves.

## A. Agent frameworks, tool calling, structured output

| Candidate | Licence | Decision | Reason |
|---|---|---|---|
| Anthropic TypeScript SDK | Apache-2.0 | ADOPT | First-party API client for unattended and hosted runs; use a manual tool loop for approval-gated tools |
| MCP TypeScript SDK v2 | Apache-2.0 (transitioning from MIT) | ADOPT | Standard typed tool surface for contained agents, including the Claude CLI |
| Vercel AI SDK | Apache-2.0 | INTEGRATE | Multi-provider adapter (other APIs, local models) behind CreatorBrio's own provider port |
| BAML, TanStack AI | Apache-2.0, MIT | STUDY | Useful ideas; not needed now |
| Claude Agent SDK | Proprietary | REJECT | Runs the Claude Code binary under commercial terms; cannot be bundled in the MIT core |
| Mastra | Apache-2.0 outside `ee/`, enterprise licence inside | REJECT | Second state model, and its core imports `ee/`-derived code whose distribution terms need confirmation |
| LangGraph, OpenAI Agents SDK, LlamaIndex.TS, Pydantic AI | MIT | REJECT | Duplicate domain state, export traces by default, archived, or Python-only |

**Does CreatorBrio need an agent framework?**
No.
Provider SDKs, one typed tool registry shared by the agent loop, MCP and the REST validators, and a manual loop for anything approval-gated cover the need; Anthropic's own documentation directs human-in-the-loop use to the manual loop ([R1](research/r1-agents-workflows-evals.md)).

## B. Durable execution, human approvals, scheduling

| Candidate | Licence | Decision | Reason |
|---|---|---|---|
| Domain state plus file-backed job records (existing) | MIT (CreatorBrio) | BUILD | Already has leases, failure classes, recovery and human-decision records |
| pg-boss | MIT | INTEGRATE (hosted stage) | Job layer on the product's own PostgreSQL; no extra service |
| Graphile Worker, DBOS, Hatchet, Absurd, OpenWorkflow, Vercel Workflow SDK | MIT or Apache-2.0 | STUDY | Escalation options; each either adds a service, puts the approval in an engine snapshot, or is young |
| Temporal, Trigger.dev | MIT, Apache-2.0 | REJECT | Self-hosting footprint disproportionate to one machine; key Trigger.dev features are cloud-only |
| Inngest server | SSPL 1.0 | REJECT | Source-available server cannot be a required part of the distributed product |
| Restate server | BSL 1.1 | REJECT | Source-available |
| BullMQ, Sidequest | MIT with commercial Pro, LGPL-3.0 | REJECT | BullMQ is Redis-first; adopting Sidequest would add a new LGPL library, which `spec/08` as written does not allow (LGPL only as a separate, user-installed process, never linked or shipped in the repository), and pg-boss covers the need |

**How to model a human approval that waits days.**
As a domain record bound to the exact revision or package fingerprint, in local and hosted mode alike.
Engine wait primitives each weaken an approval: one drops a signal sent before its wait starts, another keeps its local queue in memory, and framework interrupts place authority in a snapshot rather than the domain ([R1](research/r1-agents-workflows-evals.md)).

## C. Research, evidence and competitive analysis

| Candidate | Licence or terms | Decision | Reason |
|---|---|---|---|
| Defuddle | MIT | ADOPT | Node extractor returning Markdown and metadata, behind the existing SSRF-safe retrieval |
| Mozilla Readability, Trafilatura | Apache-2.0 | STUDY | Fallbacks |
| Brave Search API | Proprietary API | INTEGRATE (bring-your-own key, default) | Own index; results may not be stored beyond transient use, so dossiers store only pages CreatorBrio fetches itself |
| Tavily, Exa | Proprietary APIs | INTEGRATE (optional keys) | Usable; Exa has the strictest storage terms |
| SearXNG | AGPL-3.0 | REJECT as a dependency (user-supplied service only) | AGPL is excluded by `spec/08`, so CreatorBrio does not integrate, bundle or distribute it; a self-hoster may point CreatorBrio's generic search endpoint setting at a service they run themselves |
| YouTube Data API, Instagram Graph API discovery | Platform terms | INTEGRATE | The legitimate routes to public metadata of other creators |
| Crawl4AI, Firecrawl, Jina Reader, SerpAPI | Apache with rider, AGPL server, non-redistributable assets, scraped results | REJECT | Crawler scale, licence or terms problems |
| yt-dlp | Unlicense | REJECT | The licence is fine; downloading platform media breaches platform terms |
| TikTok Research API | Platform terms | REJECT | Commercial users are not eligible |
| Trend analysis and citation records | MIT (CreatorBrio) | BUILD | No open tool does this from official APIs |

## D. Creative quality, evaluation and run telemetry

| Candidate | Licence | Decision | Reason |
|---|---|---|---|
| promptfoo | MIT | INTEGRATE (development only, telemetry off) | Regression and judge harness |
| Langfuse | MIT core, commercial `ee/` | INTEGRATE (optional hosted trace export) | Large footprint; optional only |
| OpenTelemetry GenAI conventions | Apache-2.0 | ADOPT | Vendor-neutral names for run, tool and token telemetry |
| Inspect AI, Opik, autoevals | MIT, Apache-2.0, MIT | STUDY | Good designs, not needed now |
| Arize Phoenix | Elastic License 2.0 (server) | REJECT | Source-available |
| DeepEval, OpenAI Evals, evalite, Braintrust platform | Various | REJECT | Telemetry by default, dormant, archived, or proprietary |
| Creative rubric judge on rendered images, and a run cost ledger from provider usage | MIT (CreatorBrio) | BUILD | Nothing scores branded carousel and video quality; approval outcomes are the ground truth |

## E. Speech recognition, alignment, subtitles

| Candidate | Code / weights | Decision |
|---|---|---|
| parakeet-mlx (Parakeet TDT 0.6B v3) | Apache-2.0 / CC-BY-4.0 | ADOPT in the Python worker (Apple Silicon) |
| Silero VAD | MIT / MIT | ADOPT |
| mlx-audio (moved to a new owner) | MIT / per model | ADOPT as the worker's runtime |
| Qwen3-ForcedAligner | Apache-2.0 / Apache-2.0 | ADOPT after validation |
| whisper.cpp; sherpa-onnx | MIT; Apache-2.0 | INTEGRATE (other languages, Linux) |
| pyannote, Montreal Forced Aligner | MIT with gated weights; MIT | STUDY (defer) |
| WhisperX, stable-ts | BSD-2-Clause; MIT, now archived | REJECT |

## F. Speech, audio processing, music and effects

| Candidate | Code / weights | Decision |
|---|---|---|
| Kokoro-82M | Apache-2.0 / Apache-2.0 | ADOPT (narration) |
| DeepFilterNet3 | MIT or Apache-2.0 / MIT or Apache-2.0 (now stated explicitly) | ADOPT (voice denoise) |
| Chatterbox, VoxCPM2 | MIT / MIT; Apache-2.0 / Apache-2.0 | INTEGRATE (voice cloning only with recorded consent) |
| Piper (moved; engine GPL-3.0) | GPL-3.0 / per voice, commercial allow-list published 2026-11-09 | INTEGRATE (optional separate process, allow-listed voices only) |
| ACE-Step 1.5 | MIT / MIT | INTEGRATE (optional music) |
| F5-TTS, OmniVoice, MusicGen | Weights CC-BY-NC | REJECT (non-commercial); OmniVoice corrects the earlier research, which recorded Apache-2.0 |
| Demucs, Stable Audio Open | Unresolved or revenue-capped weights | REJECT as defaults |

## G. Video, composition, animation, images, rendering

| Candidate | Licence | Decision |
|---|---|---|
| FFmpeg | LGPL core, GPL with `--enable-gpl` | INTEGRATE as a user-installed process (unchanged) |
| FLUX.2 [klein] 4B with mflux | Apache-2.0 weights; MIT runner | ADOPT as the image service's reference model |
| Z-Image, Qwen-Image, diffusers | Apache-2.0 | INTEGRATE (optional, Linux runner) |
| ComfyUI | GPL-3.0 | INTEGRATE as an optional user-run backend over HTTP |
| VEED OpenEdit | Apache-2.0 with NOTICE | STUDY |
| HyperFrames | Apache-2.0, requires GSAP | REJECT as a dependency (Video Studio G1) |
| Remotion | Source-available | REJECT |
| OpenCut, Motion Canvas, Revideo, MLT | MIT or LGPL | REJECT (scaffold, dormant, or a second timeline engine) |
| FLUX dev models, SD 3.5 | Non-commercial or revenue-capped weights | REJECT as defaults |

## H. Covers, thumbnails, carousels, brand consistency

| Candidate | Licence | Decision |
|---|---|---|
| Puppeteer slide rendering (existing) and sharp | Apache-2.0; sharp's prebuilt libvips is LGPL-3.0-or-later, dynamically linked | ADOPT (already the single rendering contract); sharp adds the JPEG conversion the publisher needs; the libvips arrangement is already in use, a pre-existing position that [R2](research/r2-research-and-media.md#h2-sharp-and-libvips) argues complies |
| Satori, Takumi, resvg | MPL-2.0, MIT or Apache-2.0, Apache-2.0 | STUDY (browser-free rendering for hosted throughput) |
| Polotno, tldraw | Proprietary subscription; restrictive | REJECT |
| Brand kit as design tokens | MIT (CreatorBrio) | BUILD |

## I. Social publishing

| Candidate | Licence | Decision | Reason |
|---|---|---|---|
| The migrated Social Automation publisher | Becomes MIT on import (FQ-1) | ADOPT (as the publishing module) | Working, audited, in production for its owner; see the [migration plan](SOCIAL-AUTOMATION-MIGRATION.md) |
| Postiz | AGPL-3.0 | STUDY only; REJECT as code or sidecar | Copying would make the core AGPL; its stack (Temporal, Redis, source-available Elasticsearch) dwarfs the publisher it would replace |
| Mixpost | Lite MIT (PHP, few platforms); Pro and Enterprise source-available | REJECT | Useful editions forbid redistribution |
| Activepieces, n8n | MIT with commercial `ee/`; Sustainable Use License | REJECT as runtime | A second platform to replace one module; n8n is source-available |
| Other open schedulers (several AGPL); CogSend (MIT) | AGPL; MIT | REJECT; STUDY | Same AGPL risk; CogSend is young and covers few platforms |
| Nango | Elastic License 2.0 | REJECT | Source-available |
| `@googleapis/youtube`; `oauth4webapi` and `openid-client`; AT Protocol SDKs | Apache-2.0; MIT; MIT or Apache-2.0 | ADOPT where a TypeScript client is needed | Vendor or standards libraries |
| Meta Business SDK; LinkedIn JS client | Non-OSI platform licence; proprietary and stale | REJECT; BUILD thin clients | Publishing needs few calls |
| Unified posting APIs (Ayrshare and similar) | Proprietary services | REJECT for the core | Lock-in and terms pass-through |

## J. Self-hosting, credentials, storage, operations, SaaS, mobile

| Candidate | Licence | Decision |
|---|---|---|
| `@napi-rs/keyring` | MIT | ADOPT for TypeScript-side local secrets (`keytar` is archived) |
| SOPS with age | MPL-2.0, BSD-3-Clause | INTEGRATE for operator configuration |
| OpenBao | MPL-2.0 | INTEGRATE (hosted, optional); HashiCorp Vault is BUSL and rejected |
| SQLite | Public domain | ADOPT for the publisher's ledger (its existing store) |
| PostgreSQL with Drizzle | PostgreSQL Licence, Apache-2.0 | ADOPT at the hosted stage |
| Better Auth | MIT | ADOPT at the hosted stage (organizations, teams, mobile package) |
| Auth.js, Ory Kratos, Keycloak, Zitadel, SuperTokens, proprietary auth | Various | REJECT (maintenance mode, separate services, AGPL, or `ee/` tenancy) |
| S3-compatible hosted stores | Proprietary services | INTEGRATE (one S3 adapter with presigned URLs) |
| Garage | AGPL-3.0 | REJECT as a dependency (user-supplied service only): CreatorBrio does not integrate, bundle or distribute it; a self-hoster may point the S3-compatible adapter at a store they run themselves |
| MinIO | AGPL-3.0, repository archived | REJECT |
| Pino, OpenTelemetry JS | MIT, Apache-2.0 | ADOPT |
| GlitchTip; Sentry SDK | MIT; MIT (server is FSL) | INTEGRATE (SDK off by default) |
| Web Push (`web-push`); ntfy; Apprise | MPL-2.0; Apache-2.0 or GPLv2; BSD-2-Clause | ADOPT; INTEGRATE (optional channels) |
| Expo and React Native | MIT | ADOPT after hosted identity |
| Docker images | Depends on contents | INTEGRATE only after the T9 licence review |

## Platform capabilities for publishing

From [R3 section 2](research/r3-publishing-selfhost-saas.md); TikTok facts were seen through search only because its developer site refused automated fetches.

| Platform | Self-hoster with their own app | Hosted edition needs | Notes |
|---|---|---|---|
| Instagram | Yes, without App Review, to their own professional account | Advanced Access through App Review plus Business Verification | About 50 API posts per account per day (read the limit live); JPEG images; media at a public URL; containers expire |
| Facebook Pages | Yes, without App Review, to Pages they administer | Advanced Access and Business Verification | Native scheduling for Reels and posts |
| YouTube | Yes; since 2026-11-02 unverified projects may upload public videos | Google verification, and a quota extension: uploads have their own bucket of about 100 per day per project | A hosted edition sharing one project hits the upload bucket early |
| LinkedIn (member) | Yes, self-serve; document posts are documented under the member permission, but a live call must confirm a self-serve app can use them | Same; tokens last 60 days without refresh | Organization Pages need the Community Management API, for registered organizations only |
| Threads, Bluesky | Yes (Threads testers; Bluesky needs no review) | Threads App Review | Candidates for later adapters |
| TikTok | Private posts only, for at most five users a day | App review and the Content Posting audit | Offer "send to drafts" or a manual handoff to self-hosters |
| X | Yes, paid per post | Enterprise terms at scale | Low priority |
| Pinterest | Sandbox only until Standard access | Standard access | Low priority |

## Open-core economics

- **Paid value a self-hoster cannot copy:** the operator's reviewed platform apps (which cannot be shared or transferred), an always-on public media and scheduling plane, credential custody and rotation, platform API upkeep, teams, mobile push, support.
- **Nothing needs withholding** from the open-source edition to create that value.
- **Risks:** anyone may host the MIT core; the defences are the reviewed apps, operational quality and a trademark policy for the CreatorBrio name.
  AGPL code pasted into the core would compromise the licence; reviews and a licence scan guard it.
- **Lead times:** Business Verification and platform reviews take weeks to months and depend on a registered legal entity, an owned domain, a privacy policy and recorded screencasts, so the paperwork starts before hosted engineering (roadmap phase 6).

## Changes from the 2026-11-04 Video Studio research

- OmniVoice's weights are non-commercial (CC-BY-NC); the earlier entry recorded Apache-2.0 as unverified.
- Piper published voice-licensing and commercial-use pages on 2026-11-09; the engine stays GPL-3.0, usable only as an optional separate process with allow-listed voices.
- DeepFilterNet now states its weights' licence explicitly.
- stable-ts is archived; mlx-audio moved owner; WhisperKit and NeMo were renamed or moved.
- The MCP TypeScript SDK is moving from MIT to Apache-2.0, so `spec/08`'s entry is out of date.
- HyperFrames and Remotion are unchanged in substance; the G1 decision stands.
