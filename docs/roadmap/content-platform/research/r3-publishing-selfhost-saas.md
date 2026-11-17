# R3: Publishing, self-hosting and SaaS foundations

Research date: 2026-11-17.

Scope: category I (social OAuth, uploading, scheduling, publication tracking, analytics), category J (self-hosted installation, credentials, storage, logging, monitoring, notifications, SaaS and mobile foundations), and the economics and licensing of the open-core model.

Method: official developer documentation, LICENSE files, the GitHub API and the npm registry; no code was installed, cloned or copied.

This report refreshes and extends section 12 of `docs/roadmap/content-platform/reviews/2026-11-17-pr215-independent-review.md` (the "previous review").

Evidence marks:
- [F] fetched from the primary source (official page, LICENSE file, GitHub API or npm registry) on 2026-11-17.
- [S] seen only in a search-engine snippet of an official page.
- UNVERIFIED: not confirmed by any official source.

Limitations:
- `developers.tiktok.com` refused or timed out on every attempt from this environment (WebFetch `ECONNREFUSED`, curl timeout), so every TikTok fact is [S].
- Fetched pages pass through a summarising fetch tool; quoted strings are as reported by that tool, and the most decision-relevant ones were cross-checked against a second page where possible.
- Nothing here is legal advice; licence readings are a technical assessment of the licence texts.

## 1. Summary matrix

| Candidate | Category | Licence | Last release | Decision | One-line reason |
|---|---|---|---|---|---|
| Postiz | I scheduler | AGPL-3.0 (FSFE FLA for contributions) | v2.26.0, 2026-11-13 | STUDY (read only); REJECT as code or sidecar | Copying makes the core AGPL; its stack (Temporal, Redis, Elasticsearch 7.17 under ELv2/SSPL) dwarfs the five-platform publisher it would replace |
| Mixpost Lite / Pro / Enterprise | I scheduler | Lite MIT; Pro and Enterprise source-available | Lite 2.6.0, 2026-03-16 | REJECT | Lite covers only Facebook Pages, X, Mastodon; PHP; the useful editions forbid redistribution |
| Activepieces | I automation | MIT outside `ee` directories; `ee` commercial | 0.93.0, 2026-11-08 | STUDY (MIT pieces); REJECT as runtime | A second platform to replace one module |
| n8n | I automation | Sustainable Use License plus enterprise licence | 2.48.4, 2026-11-13 | REJECT | Source-available; no commercial redistribution |
| OpenPost, Brightbean Studio, trypost | I scheduler | AGPL-3.0 | 2026 releases | REJECT | Same contamination risk as Postiz |
| CogSend | I scheduler | MIT | v1.32.0, 2026-11-14 | STUDY | Only MIT TypeScript self-hosted publisher found; two months old, single maintainer, Cloudflare-bound, no YouTube, TikTok or Facebook |
| Nango | I OAuth broker | Elastic License 2.0 | v0.72.6, 2026-11-16 | REJECT | Source-available; forbids offering as a managed service |
| Meta Business SDK for Node | I SDK | "Platform License" (field-of-use restricted, not OSI) | v26.0.3, 2026-11-05 | REJECT; BUILD a thin Graph client | Non-OSI licence, Marketing-API oriented, publishing needs only three calls |
| `@googleapis/youtube` | I SDK | Apache-2.0 | 40.1.0, 2026-11-12 | ADOPT | Typed resumable upload, thumbnails and status from the vendor |
| `twitter-api-v2` | I SDK | Apache-2.0 | 1.31.0, 2026-10-25 | INTEGRATE when X is added | Mature, but X is pay-per-post and low priority |
| `@atproto/api`, `@atproto/oauth-client-node` | I SDK | MIT or Apache-2.0 | 0.32.1 / 0.5.16, 2026-11-17 | ADOPT when Bluesky is added | Official, permissive, active |
| LinkedIn API JS client | I SDK | LinkedIn proprietary licence agreement | v0.3.0, 2023-02-07 | REJECT; BUILD | Proprietary terms, stale since 2023 |
| `oauth4webapi` / `openid-client` | I OAuth | MIT | 3.8.8 / 6.9.0 | ADOPT | Standards-strict PKCE, DPoP, OIDC, no dependencies |
| Arctic | I OAuth | MIT | 3.7.0 | REJECT | Deprecated by its author in July 2026 |
| Ayrshare, Upload-Post, Zernio, Outstand, bundle.social | I unified API | Proprietary services (SDKs MIT or Apache-2.0) | n/a | REJECT for core; optional user-chosen adapter at most | Lock-in, competitor terms, platform terms pass-through |
| Better Auth | J auth | MIT | 1.7.25, 2026-11-15 | ADOPT (hosted stage) | In-process TypeScript, organizations and teams, Expo package, telemetry off by default |
| Auth.js | J auth | ISC | 4.24.15; v5 still beta | REJECT | Maintenance-only since joining Better Auth |
| Ory Kratos | J auth | Apache-2.0 | v26.2.0, 2026-03-20 | REJECT | Go service; enterprise builds hold guaranteed CVE fixes |
| Keycloak | J auth | Apache-2.0 | 26.8.2, 2026-11-05 | REJECT | JVM service, oversized |
| Zitadel | J auth | AGPL-3.0-only (with exceptions) | v4.20.3, 2026-11-13 | REJECT | AGPL service with no advantage over a library |
| Logto | J auth | MPL-2.0 | v1.46.0, 2026-11-05 | STUDY | Clean fallback if a separate identity service is ever needed |
| SuperTokens | J auth | Apache-2.0 plus paid `ee/` | v12.5.0, 2026-11-06 | REJECT | Tenancy features sit in `ee/` |
| Clerk, Auth0, WorkOS | J auth | Proprietary | n/a | REJECT for core | Hosted lock-in |
| `@napi-rs/keyring` | J secrets | MIT | v2.1.2, 2026-10-19 | ADOPT (local) | Maintained N-API keychain binding; `keytar` is archived |
| OpenBao | J secrets | MPL-2.0 | v2.7.2, 2026-10-26 | INTEGRATE (hosted, optional) | Open fork of Vault under OpenSSF |
| HashiCorp Vault | J secrets | BUSL-1.1 (IBM) | v2.2.2, 2026-11-12 | REJECT | Source-available |
| Infisical | J secrets | MIT plus `ee/` enterprise | v0.167.11, 2026-11-16 | REJECT | Stock image carries `ee` code |
| SOPS + age | J secrets | MPL-2.0 / BSD-3-Clause | v3.13.3 / v1.3.2 | INTEGRATE (operator config) | Small, standard, file-based |
| SQLite (`better-sqlite3`) | J database | MIT / public domain | v13.2.0, 2026-11-14 | ADOPT (local ledger) | Publisher ledger is relational and concurrency-sensitive |
| `node:sqlite` | J database | Node.js | Release candidate in Node 26 | STUDY | Not yet stable |
| PostgreSQL | J database | PostgreSQL Licence | n/a | ADOPT (hosted) | Standard multi-tenant store |
| PGlite | J database | Apache-2.0 or PostgreSQL | 0.5.16 | STUDY | One dialect locally and hosted |
| libSQL / Turso | J database | MIT | libSQL stale; Turso 0.8.3 | REJECT / STUDY | Vendor moved to the 0.x rewrite |
| Drizzle ORM | J ORM | Apache-2.0 | 0.45.4 | ADOPT | SQLite, PGlite and PostgreSQL; Better Auth adapter |
| Kysely | J ORM | MIT | 0.29.9 | Acceptable alternative | Query builder only |
| Prisma | J ORM | Apache-2.0 | 7.10.1 (npm `latest` is an 8.0 RC) | REJECT | Generator and adapter weight; RC tagged `latest` |
| MinIO | J storage | AGPL-3.0 | 2025-10-15 | REJECT | Archived, source-only, vendor pushes proprietary AIStor |
| Garage | J storage | AGPL-3.0 | v2.5.0, 2026-10-24 | REJECT as a dependency (user-supplied service only) | Small-scale self-hosting is its design goal, but AGPL is excluded by `spec/08`; a self-hoster may point the S3 adapter at their own |
| SeaweedFS / RustFS / Silo | J storage | Apache-2.0 / Apache-2.0 / AGPL-3.0 | 4.54 / 1.0.6 / 2026-11-12 | Alternatives / STUDY / acceptable | See section 4.4 |
| Hosted S3-compatible stores | J storage | Proprietary services | n/a | INTEGRATE | One S3 adapter with presigned URLs |
| Pino | J logging | MIT | v10.4.0 | ADOPT | Structured logs with redaction |
| OpenTelemetry JS | J telemetry | Apache-2.0 | v3.1.1 | ADOPT (hosted) | Vendor-neutral traces and metrics |
| Sentry SDK / server | J errors | SDK MIT; server FSL-1.1 | 11.13.0 / 26.11.0 | INTEGRATE SDK; REJECT server for distribution | Server is source-available and needs 16 GB RAM |
| GlitchTip | J errors | MIT | 2026 | INTEGRATE | Sentry-SDK-compatible at 512 MB RAM |
| SigNoz | J telemetry | MIT plus `ee/` | v0.150.0 | REJECT for distribution | Enterprise directories |
| Grafana stack | J telemetry | AGPL-3.0 | 2026 releases | Operator-side only | Never bundled |
| Web Push (`web-push`) | J notify | MPL-2.0 | v4.0.0 | ADOPT | Browser and PWA notifications |
| ntfy / Apprise | J notify | Apache-2.0 or GPLv2 / BSD-2-Clause | v2.38.1 / v2.2.0 | INTEGRATE (optional, separate) | Self-hosted push channels |
| Novu | J notify | MIT plus proprietary `enterprise/` | v3.20.0 | REJECT | Too large; proprietary parts |
| Expo push service | J notify | Proprietary free service | n/a | INTEGRATE (mobile) | Behind an interface that can switch to APNs and FCM |
| Docker image | J packaging | n/a | n/a | INTEGRATE at hosted stage | GPL userland needs source offer and SBOM |
| Tauri / Electron | J packaging | MIT or Apache-2.0 / MIT | v2.12.5 / v45.3.3 | REJECT / STUDY | Next.js server needs a Node sidecar |
| Expo + React Native | J mobile | MIT | 58.0.26 / 0.88.1 | ADOPT (after hosted identity) | Shared TypeScript, Better Auth Expo package |

## 2. Platform capabilities

### 2.1 Capability table

"Own app" means a self-hoster registers their own developer app and publishes only to accounts they own or manage.

| Platform | Self-hoster with own app | Needed before a hosted service can onboard customers | Key limits | Sources |
|---|---|---|---|---|
| Instagram | **Yes, without App Review.** Business-type app, Standard Access, own professional (Business or Creator) account added to the app; media must sit at a public URL | Advanced Access through App Review plus Business Verification for `instagram_business_content_publish` (Instagram Login) or `instagram_content_publish` (Facebook Login); annual Data Use Checkup; the separate Tech Provider access verification is no longer required | 50 published posts per rolling 24 h per account (read `content_publishing_limit` live); 400 containers per 24 h; JPEG only for images (8 MB, 4:5 to 1.91:1); carousels up to 20 items; Reels 3 s to 15 min, 300 MB; containers expire after 24 h; no scheduling parameter | [F] content-publishing, ig-user/media, overview, access-levels, business-verification, access-verification pages |
| Facebook Pages | **Yes, without App Review** (inferred from the same Standard Access rules; Page admin with the CREATE_CONTENT task) | Advanced Access for `pages_manage_posts`, `pages_read_engagement`, `pages_show_list` with App Review and Business Verification | Reels 3 to 90 s, 30 API Reels per Page per 24 h, schedule 10 min to 29 days ahead; feed and photo posts schedule 10 min to 30 days; photos 10 MB, JPEG, PNG and others; multi-photo via `attached_media` | [F] reels-publishing, pages-api/posts, page/photos |
| Threads | **Yes, without App Review,** for accounts added as Threads Testers | App Review for `threads_basic` and `threads_content_publish` (advanced access), app published | 250 posts per 24 h; text 500 characters and 5 links; carousels 2 to 20; images JPEG or PNG 8 MB; video 5 min, 1 GB; public media URL | [F] threads get-started, create-posts, overview, posts |
| YouTube | **Yes.** Since 2026-11-02 unverified projects may upload public videos. Testing mode means re-consent every 7 days; publishing the project to Production unverified gives long-lived refresh tokens behind an "unverified app" warning and a lifetime cap of 100 users | Google brand verification, and sensitive-scope verification if the YouTube scope is classed sensitive (about 10 business days [S]); YouTube Developer Policies compliance; an API compliance audit only for more than the default upload quota | `videos.insert`: its own bucket of 100 calls per day per project; other calls 10,000 units per day; `thumbnails.set` 50 units; `publishAt` only with private status on never-published videos; Shorts are square or vertical up to 3 min; set `paidProductPlacementDetails` explicitly | [F] revision_history, videos/insert, determine_quota_cost, quota_and_compliance_audits, Google Cloud help 15549945, 13464323, 13464325 |
| TikTok | **Only private posts.** Unaudited clients post SELF_ONLY, to accounts set to private, for at most 5 users per 24 h; the audit expects apps "not limited to internal groups/private use", so a personal app may not pass | App review per scope (`video.publish`, `video.upload`) with demo videos, verified website, terms and privacy policy; the Content Posting audit; the mandated posting UX; domain or URL-prefix verification for `PULL_FROM_URL` | About 15 Direct Posts per creator per day across all apps; photo posts up to 35 images, JPEG or WebP; video up to 4 GB; `creator_info` 20 requests per minute per token | [S] only: content-sharing-guidelines, content-posting-api-get-started, photo-post, media-transfer-guide |
| LinkedIn (member) | **Yes, self-serve.** "Share on LinkedIn" grants `w_member_social` without review: text, image, video and article posts via `/v2/ugcPosts`. Document (PDF) posts are documented under `w_member_social` in the versioned Documents and Posts APIs, but whether a self-serve-only app may call those `rest/` endpoints is UNVERIFIED | Same self-serve product suffices for member posting; tokens last 60 days with no refresh token for non-partners, so each member re-authorises every 60 days | 150 requests per member per day (Share on LinkedIn); organic carousels unsupported; MultiImage 2 to 20; Documents 100 MB, 300 pages | [F] share-on-linkedin, getting-access, posts-api, documents-api, images-api, multiimage, authorization-code-flow, programmatic-refresh-tokens |
| LinkedIn (organization Page) | **No for individuals:** Community Management API is "only available to registered legal organizations for commercial use cases" | Community Management API: Development tier (500 calls per app per 24 h, 100 per member, 12 months to finish), then Standard tier review with screencast and test credentials | As above; marketing version 202601 sunsets 2027-01-15 | [F] community-management-app-review, increasing-access |
| X | **Yes, paid.** Pay-per-use credits, about $0.015 per post and $0.20 per post containing a URL; no self-serve free tier is documented for new developers | No review, but pay-per-use is meant for "applications with limited end-users"; beyond that an Enterprise plan; white-label versions need separate approval | 100 posts per 15 min per user, 10,000 per 24 h per app; chunked media upload v2; access tokens last 2 h | [F] docs.x.com pricing, changelog, rate-limits, developer policy and agreement |
| Pinterest | **Effectively no without review:** Trial access creates only sandbox pins "only visible to their creator"; Standard access needs a demo video of the OAuth flow even for a single-user app | Standard access | Multi-image pins 2 to 5 items; Trial 1,000 requests per day; Standard `org_write` 100 per minute per user | [F] access-tiers, rate-limits, OpenAPI v5.28.0 |
| Bluesky | **Yes, no review.** App password today; OAuth needs a client metadata document at a public HTTPS URL, with a localhost development exception servers are only "encouraged" to support | Nothing from Bluesky beyond a hosted OAuth client metadata document (confidential client for long sessions) | 4 images of 2 MB each; MP4 video up to 300 MB via the video service, daily caps returned at runtime, verified email required; 5,000 points per hour and 35,000 per day (create costs 3) | [F] atproto OAuth spec, bsky-docs repository, lexicons |

### 2.2 Platform notes that change CreatorBrio's design

**Instagram.**
- Images must be JPEG, at most 8 MB, aspect 4:5 to 1.91:1, width 320 to 1440 px, sRGB [F] (<https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media>).
  CreatorBrio exports PNG through Puppeteer today, so the publisher must transcode each slide to sRGB JPEG and verify size; 1080 x 1350 (4:5) is within limits.
- Carousels hold up to 20 images or videos, all cropped to the first item's ratio; captions cannot be set on children [F].
- The publishing quota is contradictory in Meta's own pages: the guide still says 100 posts per 24 h, while the `media_publish` and `content_publishing_limit` references say 50 ("currently 50") [F].
  Read `config.quota_total` at runtime instead of hard-coding either number.
- `alt_text` (images only, 1,000 characters), `collaborators` (up to 3), `location_id`, `user_tags`, `is_ai_generated` and trial Reels (`trial_params`) are now supported [F].
- Reels covers: `cover_url` (public JPEG) overrides `thumb_offset` [F].
- Poll container status about once a minute for no more than five minutes; statuses `IN_PROGRESS`, `FINISHED`, `ERROR`, `EXPIRED`, `PUBLISHED` [F].
- A third login option, "Instagram API with Unified Login" using a Business Integration System User token, is marked recommended for new integrations and needs a Business portfolio [F] (<https://developers.facebook.com/docs/instagram-platform/content-publishing>).
- Tokens: long-lived Instagram Login tokens last 60 days and can be refreshed once at least 24 h old [F].
- Graph API v27.0 shipped 2026-11-04; each version lives at least two years after its successor ships [F] (<https://developers.facebook.com/docs/graph-api/changelog>).
- Media must be "hosted on a publicly accessible server at the time of the attempt" [F]; nothing on the pages forbids signed URLs, and the existing private publisher's 24-hour signed links are consistent with that, but signed-URL acceptance itself is UNVERIFIED in documentation.

**Facebook Pages.**
- Reels go through a three-phase `video_reels` upload with `video_state` `DRAFT`, `SCHEDULED` or `PUBLISHED`; Meta CDN URLs and hosts that block Facebook's crawler in `robots.txt` are rejected [F] (<https://developers.facebook.com/docs/video-api/guides/reels-publishing>).
- Pages are the only Meta surface with native scheduling (`scheduled_publish_time`), so CreatorBrio's own scheduler still has to own Instagram and Threads timing.

**YouTube.**
- The upload quota model changed again after the previous review: `videos.insert` now costs "1 unit in the Video Uploads quota bucket" with "100 calls per day", separate from the 10,000-unit general bucket [F] (<https://developers.google.com/youtube/v3/docs/videos/insert>, <https://developers.google.com/youtube/v3/determine_quota_cost>).
  The previous review's "about 100 units per upload" was correct for 2025-12-04 but is superseded.
- No YouTube upload scope is on Google's restricted list, so the CASA security assessment does not apply [F] (<https://support.google.com/cloud/answer/13464325>, <https://support.google.com/cloud/answer/13464321>).
  Whether `youtube.upload` is "sensitive" remains UNVERIFIED (shown only in the Cloud Console); plan as if it is.
- Personal-use exemption: verification is not needed "If the app is for your personal use (fewer than 100 users)" [F] (<https://support.google.com/cloud/answer/13464323>).
- 2026-11-16: `hasPaidProductPlacement` no longer defaults to false, so uploads should set it explicitly; 2026-11-03: Shorts accept custom thumbnails after processing [F] (revision history).
- Developer Policies require a privacy policy, a link to YouTube's Terms of Service, user control over what is published including the title, and refreshing or deleting stored API data after 30 days [F] (<https://developers.google.com/youtube/terms/developer-policies>).

**TikTok** (all [S]).
- Required UX: query creator info before rendering, a privacy dropdown with no default, Allow Comment, Duet and Stitch checkboxes off by default and greyed out when creator settings disable them (photo posts show only Allow Comment), a commercial-content disclosure flow, the Music Usage Confirmation declaration, a preview, explicit consent before upload, and a processing notice (<https://developers.tiktok.com/docs/en/content-sharing-guidelines>).
- Upload mode (`video.upload`, sends to the creator's inbox as a draft) is the realistic self-hosted path: the creator finishes posting in the TikTok app.
  Whether Upload mode is also restricted for unaudited clients is UNVERIFIED and must be tested.

**LinkedIn.**
- Resolves part of the previous UNVERIFIED item: the Documents API, Posts API, Images API, Videos API and MultiImage API pages all list `w_member_social` in their permission tables, and the Documents page says "For documents with person URN owners, the caller must match the document owner" [F] (<https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api>).
- Still open: the self-serve Share on LinkedIn page documents only `/v2/ugcPosts` and `/v2/assets` with media categories `NONE`, `ARTICLE`, `IMAGE`, `VIDEO` (no document type) [F] (<https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin>), and no page states whether a self-serve-only app may call the versioned `rest/` endpoints.
  A one-call live test with a self-serve app (initialise a document upload under the member's URN) settles it; until then the honest promise for a self-hoster is "PDF carousel posts, pending verification".
- A PDF document post is LinkedIn's only route to a swipeable carousel, since organic carousels are "currently not supported" [F].

**X.**
- Pay-per-use launched 2026-02-06; legacy Basic and Pro subscribers were moved to pay-per-use during 2026 ([F] changelog for the launch; [S] for the migrations) (<https://docs.x.com/changelog>).
- The Developer Policy requires "express and informed consent" before posting, and "a person authenticating into your service does not by itself constitute consent" [F] (<https://docs.x.com/developer-terms/policy>).

**Pinterest.**
- Apps registered on or after 2026-09-14 may receive `PINNER_DATA_ACCESS_DENIED` for non-business users without authorisation [F] (<https://developers.pinterest.com/docs/key-concepts/access-tiers/>).

**Bluesky.**
- OAuth requires PKCE (S256), PAR and DPoP for every client; public clients get sessions of at most two weeks, confidential clients up to 180-day refresh tokens; the `transition:generic` scope equals the old app-password level and will be deprecated over time [F] (<https://atproto.com/specs/oauth>).
- `docs.bsky.app` now redirects to a host the fetcher could not read; the same pages were read from the official documentation repository <https://github.com/bluesky-social/bsky-docs> [F].

## 3. Category I candidates: publishing tools, SDKs and OAuth libraries

### 3.1 Postiz

- Repository: <https://github.com/gitroomhq/postiz-app>; documentation: <https://docs.postiz.com> (not fetched).
- Licence: AGPL-3.0 for the whole repository [F] (`gh api repos/gitroomhq/postiz-app/license`).
- Contributions are taken under the FSFE Fiduciary License Agreement 2.1 (`CCLA.md`, `ICLA.md`) [F].
  That agreement lets the company re-license contributions only under licences that are both FSF-free and OSI-approved, so a move to a source-available licence is constrained but a move to another free licence is not [F] (<https://github.com/gitroomhq/postiz-app/blob/main/CCLA.md>).
- Maintenance: release v2.26.0 on 2026-11-13; last commit 2026-11-17; about 41.8k stars [F].
- Footprint: the shipped `docker-compose.yaml` runs the app, PostgreSQL 17, Redis 7.2, Temporal 1.28.1 with its own PostgreSQL, Temporal admin tools and UI, and `elasticsearch:7.17.27` for Temporal visibility, plus a Sentry Spotlight container [F] (<https://github.com/gitroomhq/postiz-app/blob/main/docker-compose.yaml>).
- Licence surprise: Elasticsearch 7.11 and later binaries are distributed under the Elastic License 2.0 or SSPL; the AGPL option Elastic added in 2024 targets 8.16 and later, so the default Postiz stack pulls a source-available component [S] (<https://www.elastic.co/pricing/faq/licensing>).
  Temporal can use PostgreSQL for visibility instead, so this is a deployment default, not a hard dependency.
- Provider coverage: one NestJS provider file per network, including `instagram.provider.ts`, `instagram.standalone.provider.ts`, `facebook.provider.ts`, `tiktok.provider.ts`, `youtube.provider.ts`, `linkedin.provider.ts`, `linkedin.page.provider.ts`, `threads.provider.ts`, `x.provider.ts`, `bluesky.provider.ts`, `pinterest.provider.ts` [F] (`libraries/nestjs-libraries/src/integrations/social`).
- May CreatorBrio copy it?
  No.
  Any copied provider code would make the combined work AGPL-3.0 and, through AGPL section 13, oblige anyone offering the hosted edition to offer its complete corresponding source.
- May CreatorBrio run it as a separate service?
  Legally yes: AGPL obligations attach to modifications of Postiz itself, and an unmodified Postiz reached over its public API does not make the MIT core AGPL.
  CreatorBrio's own policy is stricter: `spec/08` excludes AGPL code from the product, so the answer for CreatorBrio is still no.
  In practice it would bring a second product, a second account model, Temporal and Redis into a local-first app that publishes to five platforms, so the integration cost is larger than the publisher it replaces.
- Decision: **STUDY** (read its provider files as behaviour documentation only, never paste); **REJECT** as a dependency or sidecar.

### 3.2 Mixpost (Lite, Pro, Enterprise)

- Repository (Lite): <https://github.com/inovector/mixpost>; documentation: <https://docs.mixpost.app/lite/>.
- Licence: Lite is MIT [F]; Pro ($299 one-time) and Enterprise ($1,199 one-time) are source-available: "You may not resell or redistribute the code", and "building a SaaS requires an Enterprise license, not Pro" [F] (<https://mixpost.app/pricing>).
- Maintenance: Lite release 2.6.0 and last commit both on 2026-03-16, eight months ago [F].
- Coverage: Lite publishes only to Facebook Pages, X and Mastodon; Instagram, YouTube, TikTok, LinkedIn, Pinterest, Threads and Bluesky are Pro-only [F].
- Stack: PHP/Laravel with Vue, so nothing is reusable in a TypeScript codebase.
- Decision: **REJECT**.
  Lite lacks every platform CreatorBrio needs except Facebook Pages, and the editions that have them are source-available.
  Mixpost's own split (free core with three networks, paid edition with the rest) is a useful pricing comparison but the opposite of CreatorBrio's "fully usable open source" promise.

### 3.3 Activepieces

- Repository: <https://github.com/activepieces/activepieces>; documentation: <https://www.activepieces.com/docs> (not fetched).
- Licence: MIT ("MIT Expat") for everything outside `packages/ee/` and `packages/server/api/src/app/ee`; those directories are under the Activepieces Enterprise license, which permits production use only with a subscription [F] (<https://github.com/activepieces/activepieces/blob/main/LICENSE>, `packages/ee/LICENSE`).
- Maintenance: release 0.93.0 on 2026-11-08; last commit 2026-11-17 [F].
- Fit: a general automation platform; its social "pieces" are thin API wrappers, and running it beside CreatorBrio would add a second server, database and queue to replace roughly one module.
- May CreatorBrio copy MIT pieces?
  Yes, with the MIT notice, provided nothing comes from an `ee` path; check each file's path before reading it.
- Decision: **STUDY** (MIT pieces as reference); **REJECT** as a runtime dependency.

### 3.4 n8n

- Repository: <https://github.com/n8n-io/n8n>; latest stable n8n@2.48.4 on 2026-11-13, with 3.3.0 and 2.49.0 pre-releases on 2026-11-17 [F].
- Licence: Sustainable Use License, usable "only for your own internal business purposes or for non-commercial or personal use" and redistributable only "free of charge for non-commercial purposes"; `.ee.` files need the n8n Enterprise License [F] (<https://github.com/n8n-io/n8n/blob/master/LICENSE.md>).
  It is source-available, not open source.
- Decision: **REJECT** for anything distributed with CreatorBrio.
  A self-hoster may of course point their own n8n at CreatorBrio's API, which needs no decision from CreatorBrio.

### 3.5 Newer open-source schedulers found in this review

All were found through a GitHub repository search on 2026-11-17 [F].

| Repository | Licence | Stack | Latest release | Note |
|---|---|---|---|---|
| <https://github.com/getopenpost/openpost> | AGPL-3.0 | TypeScript | v7.42.2, 2026-11-16 | Created 2026-03-21; fast release cadence |
| <https://github.com/brightbeanxyz/brightbean-studio> | AGPL-3.0 | Python (Django) | none | Created 2026-03-25; about 2.7k stars |
| <https://github.com/trypostit/trypost> | AGPL-3.0 | not checked | v2.0.1, 2026-11-01 | Agent-oriented scheduler |
| <https://github.com/cogsend/cogsend> | MIT | TypeScript, SvelteKit on Cloudflare Workers, D1, R2 | v1.32.0, 2026-11-14 | Created 2026-09-22; one maintainer wrote 326 of about 335 commits; README promotes a proprietary unified API sponsor as an alternative to own developer apps |
| <https://github.com/SamurAIGPT/postiz-cheap> | MIT | JavaScript | v0.2.7, 2026-06-15 | MIT shell, but publishing goes through a proprietary third-party API (MuAPI), so it is not a self-contained publisher |

- Decision for the AGPL projects: **REJECT** as code sources, same reasoning as Postiz.
- Decision for CogSend: **STUDY**.
  It is the only MIT, TypeScript, self-hosted publisher found with per-platform provider modules (`src/lib/server/providers/{instagram,linkedin,threads,x,bluesky,mastodon}.ts`) and an "OAuth apps" guide for self-hosters.
  Its code may be copied with the MIT notice, but it is two months old, effectively single-maintainer and Cloudflare-specific, and it does not cover YouTube, TikTok or Facebook Pages, so it is a reference rather than a dependency.

### 3.6 Nango (unified OAuth and token refresh)

- Repository: <https://github.com/NangoHQ/nango>; release v0.72.6 on 2026-11-16 [F].
- Licence: Elastic License 2.0 [F] (`gh api repos/NangoHQ/nango/license`).
- Decision: **REJECT**.
  ELv2 is source-available and forbids providing the software to third parties as a managed service, which collides with both the policy and the hosted edition.

### 3.7 Official platform SDKs

**Meta Business SDK for Node.js**
- Repository moved from `facebook/` to <https://github.com/meta/facebook-nodejs-business-sdk>; release v26.0.3 on 2026-11-05 [F].
- Licence: npm reports "Platform License" [F]; the LICENSE grants use, copying, modification and distribution "for use in connection with the web services and APIs provided by Facebook" and subjects use to the Facebook Platform Policy [F] (<https://github.com/meta/facebook-nodejs-business-sdk/blob/main/LICENSE>).
  This is a permissive but field-of-use-restricted, non-OSI licence.
- Fit: it is generated around the Marketing API; Instagram publishing is a handful of Graph API calls (`POST /{ig-user-id}/media`, `GET /{container-id}?fields=status_code`, `POST /{ig-user-id}/media_publish`) that a typed `fetch` wrapper covers.
- Decision: **REJECT** as a dependency (licence is not OSI and adds nothing); **BUILD** a thin typed Graph client.

**googleapis for Node.js**
- Repository: <https://github.com/googleapis/google-api-nodejs-client>; `googleapis` 190.0.0 and the single-API package `@googleapis/youtube` 40.1.0, both 2026-11-12, Apache-2.0 [F] (npm registry).
- `google-auth-library-nodejs` has been archived and moved into <https://github.com/googleapis/google-cloud-node-core> [F]; the npm package continues from there.
- Fit: `@googleapis/youtube` gives resumable `videos.insert`, `thumbnails.set` and `videos.list` with typed resources; Apache-2.0 is compatible with an MIT repository (keep the NOTICE if bundled).
- Decision: **ADOPT** `@googleapis/youtube` (not the 190-API umbrella package) for the YouTube publisher.

**twitter-api-v2**
- Repository: <https://github.com/PLhery/node-twitter-api-v2>; 1.31.0 on 2026-10-25; Apache-2.0 [F].
- Decision: **INTEGRATE** only if and when X is added; the platform economics in section 2 make X a low priority.

**AT Protocol SDK (Bluesky)**
- Repository: <https://github.com/bluesky-social/atproto>; `@atproto/api` 0.32.1 and `@atproto/oauth-client-node` 0.5.16, both published 2026-11-17; repository is dual MIT or Apache-2.0 at the user's choice [F] (`LICENSE.txt`).
- Decision: **ADOPT** when Bluesky is added.

**LinkedIn API JavaScript client**
- Repository: <https://github.com/linkedin-developers/linkedin-api-js-client>; last release v0.3.0 on 2023-02-07, last commit 2023-03-23 [F].
- Licence: "LinkedIn API Development Software License Agreement", which permits use only "to enable the use cases permitted under your existing agreement with LinkedIn" [F].
- Decision: **REJECT** (proprietary terms, stale); **BUILD** against the REST endpoints.

**TikTok**
- The official `tiktok/tiktok-business-api-sdk` (MIT, last commit 2026-02-27) targets the Marketing API, not the Content Posting API [F].
- Decision: **BUILD** a small client for the Content Posting endpoints.

### 3.8 OAuth client libraries

| Library | Licence | Latest | Fit |
|---|---|---|---|
| `oauth4webapi` <https://github.com/panva/oauth4webapi> | MIT | 3.8.8 (2026-09-05); commit 2026-11-12 | Low-level, standards-strict OAuth 2.0/OIDC primitives with PKCE and DPoP; zero dependencies |
| `openid-client` <https://github.com/panva/openid-client> | MIT | 6.9.0 (2026-11-13) | Higher-level wrapper over `oauth4webapi`; best for OIDC providers (Google) |
| `arctic` <https://github.com/pilcrowonpaper/arctic> | MIT | 3.7.0 on npm (2026-07-29) | **Deprecated in July 2026**: the README now says "Arctic was deprecated on July 2026" and the repository keeps only example code under `/code`, released under a 0BSD-style permission notice [F] |

All three were checked through the npm registry and GitHub API [F].
- Decision: **ADOPT** `oauth4webapi` (or `openid-client` for Google) as the protocol layer; **REJECT** Arctic as a dependency because it is deprecated, though its permissively licensed example code may be read or copied.
  Social platforms deviate from the specifications (Meta and TikTok use non-standard token exchanges, LinkedIn issues refresh tokens only to some apps), so the publisher needs its own per-platform token adapter regardless; a library that hides those differences would hide exactly what must be tested.

### 3.9 Unified social posting APIs (proprietary services)

All are proprietary hosted services; only their client SDKs are open source.

| Service | Pricing seen 2026-11-17 | Whose platform apps | Multi-tenant support | Terms that matter | SDK licence |
|---|---|---|---|---|---|
| Ayrshare <https://www.ayrshare.com/pricing> | Premium $149/month (1 profile), Launch $299 (10), Business $599 (30 to 300), Enterprise custom [F] | X requires your own OAuth 1.0a credentials from 2026-03-31 [F]; other networks not stated (UNVERIFIED) | JWT-based white-label connect page per user profile [F] | No "licensing, selling, renting, leasing, transferring"; may not be used "to build a similar or competitive product"; not responsible for account suspensions [F] (<https://www.ayrshare.com/terms>, revised 2026-08-20) | MIT |
| Upload-Post <https://www.upload-post.com/pricing> | Free 10 uploads/month, paid $24 to $438/month [F] | Its own apps: "No TikTok developer app, review or audit required"; X without buying API access [F] | Profiles with JWT connect links; white-label from Professional [F] | Reselling terms not checked (UNVERIFIED) | MIT |
| Zernio (formerly Late, getlate.dev) <https://zernio.com/pricing> | First 2 accounts free, then $6, $3 or $1 per account per month by volume [F] | White-label OAuth connect flows; an undocumented "BYOK required" error exists [F] | One profile per end customer [F] | Not checked | Apache-2.0 (`@zernio/node`) |
| Outstand <https://www.outstand.so/> | $19/month for 3,000 posts, then per post; Business $129 with "Reselling explicitly permitted" [F] | "We run the OAuth app" for LinkedIn, Instagram, Facebook, Threads, Bluesky, YouTube, Pinterest, TikTok; bring your own for X [F] | Multiple organisations [F] | Its claim that "Bluesky has no OAuth at all" is contradicted by the AT Protocol specification | Not checked |
| bundle.social <https://bundle.social/pricing> | Free 20 posts/month; Pro $100; Business $400; X billed at X's own per-post rates [F] | Not stated (UNVERIFIED) | Teams as tenants [F] | Not checked | MIT |

- Pattern: X costs pass straight through (or the customer brings an X app) everywhere; for the other networks most vendors run their own reviewed apps, which is exactly the convenience CreatorBrio's hosted edition wants to sell.
- Decision: **REJECT** as the core publisher (proprietary dependency, competitor-protective terms, account risk outside CreatorBrio's control).
  An optional, user-chosen adapter for self-hosters who would rather pay a vendor than pass app review is acceptable later, because it keeps the open-source edition complete without it.

## 4. Category J candidates: self-hosting, credentials, storage, operations, SaaS and mobile foundations

### 4.1 Authentication for the hosted edition (and an optional local login)

Facts below come from the GitHub API, npm registry and repository LICENSE files on 2026-11-17 [F] unless marked.

| Candidate | Repository | Licence | Latest release | Shape | Decision |
|---|---|---|---|---|---|
| Better Auth | <https://github.com/better-auth/better-auth> | MIT | 1.7.25 (2026-11-15); 1.8.0-beta.10 | TypeScript library inside the app; own tables via Drizzle, Kysely or Prisma adapters | **ADOPT** at the hosted stage |
| Auth.js (NextAuth) | <https://github.com/nextauthjs/next-auth> | ISC | 4.24.15 (2026-07-20); v5 still `5.0.0-beta.32` | Library | **REJECT** for new work |
| Ory Kratos | <https://github.com/ory/kratos> | Apache-2.0 | v26.2.0 (2026-03-20); last commit 2026-07-29 | Go service | **REJECT** |
| Keycloak | <https://github.com/keycloak/keycloak> | Apache-2.0 | 26.8.2 (2026-11-05) | Java service | **REJECT** for this product size |
| Zitadel | <https://github.com/zitadel/zitadel> | AGPL-3.0-only (with Apache-2.0 and MIT exceptions) | v4.20.3 (2026-11-13) | Go service | **REJECT** |
| Logto | <https://github.com/logto-io/logto> | MPL-2.0 | v1.46.0 (2026-11-05) | Node service with PostgreSQL | **STUDY** as the fallback if a separate identity service is ever needed |
| SuperTokens | <https://github.com/supertokens/supertokens-core> | Apache-2.0 outside `ee/`; `ee/` needs a paid subscription for production | v12.5.0 (2026-11-06) | Java core service plus SDKs | **REJECT** |
| Clerk, Auth0, WorkOS, Stytch | n/a | Proprietary hosted services | n/a | SaaS | **REJECT** for the core; acceptable only as an optional adapter nobody is forced to use |

**Better Auth.**
- MIT throughout; packages include `expo`, `electron`, `passkey`, `sso`, `scim`, `oauth-provider`, `api-key`, `stripe` and the adapters [F] (`packages/` directory listing).
- The organization plugin provides organizations, members, roles, invitations, optional teams and per-organization access control with an active organization on the session [F] (<https://www.better-auth.com/docs/plugins/organization>).
  That is the workspace-tenancy model the hosted edition needs, and the `expo` package covers the mobile client.
- Telemetry is "optional, transparent, and disabled by default" [F] (<https://www.better-auth.com/docs/reference/telemetry>).
- Auth.js joined Better Auth on 2025-09-22; the team will "keep addressing security patches and urgent issues" and recommends new projects start with Better Auth [F] (<https://www.better-auth.com/blog/authjs-joins-better-auth>), and the next-auth README says the same [F].
- Risks: fast-moving 1.x with frequent betas; a single company steers it.
  Mitigation: keep it behind CreatorBrio's own session and principal types so the rest of the code never imports it directly.
- Local edition: today's loopback-only, single-user app needs no accounts.
  When the local app first listens on a LAN or is exposed for the mobile client, the same Better Auth configuration with SQLite gives one owner account and passkeys, which avoids a second auth stack.

**Why not the services.**
- Ory Kratos is Apache-2.0, but its README now steers production users to the Ory Enterprise License builds "for guaranteed CVE fixes, current enterprise builds, advanced features", and the open-source release cadence has slowed (last release 2026-03-20) [F].
- Keycloak is mature but a JVM service with a heavy footprint for a Node product, and its realm model is more than a creator workspace needs.
- Zitadel is AGPL-3.0-only; running it unmodified as a separate service is legal, but the operator then carries AGPL compliance for any patch, and its own LICENSING.md recommends legal counsel [F].
- SuperTokens' useful multi-tenancy features sit in `ee/`, which "may only be used in production" with a subscription [F].
- Logto (MPL-2.0, file-level copyleft) is the cleanest separate-service option if a later requirement such as enterprise SSO for many tenants outgrows a library; MPL lets CreatorBrio use it unmodified with no obligation on the MIT core.

### 4.2 Credentials and secrets

| Candidate | Repository | Licence | Latest release | Decision |
|---|---|---|---|---|
| `@napi-rs/keyring` | <https://github.com/Brooooooklyn/keyring-node> | MIT | v2.1.2 (2026-10-19); commit 2026-11-10 | **ADOPT** for the local edition |
| `keytar` | <https://github.com/atom/node-keytar> | MIT | v7.9.0 (2022-02-17); **archived** | **REJECT** |
| `cross-keychain` | <https://github.com/magarcia/cross-keychain> | MIT | v2.0.0 (2026-11-08); 18 stars | **REJECT** (too small to trust with credentials) |
| OpenBao | <https://github.com/openbao/openbao> | MPL-2.0; OpenSSF sandbox project | v2.7.2 (2026-10-26) | **INTEGRATE** as an optional hosted KMS/secret store |
| HashiCorp Vault | <https://github.com/hashicorp/vault> | BUSL-1.1, licensor now IBM; each version converts to MPL-2.0 after four years | v2.2.2 (2026-11-12) | **REJECT** (source-available) |
| Infisical | <https://github.com/Infisical/infisical> | MIT except `ee/` directories (production use needs an Enterprise licence) | v0.167.11 (2026-11-16) | **REJECT** for distribution; the stock image contains `ee` code |
| SOPS | <https://github.com/getsops/sops> | MPL-2.0; CNCF sandbox | v3.13.3 (2026-07-23) | **INTEGRATE** for operator-side configuration secrets in the hosted deployment repository |
| age | <https://github.com/FiloSottile/age> | BSD-3-Clause | v1.3.2 (2026-08-29) | **INTEGRATE** with SOPS |

All rows [F] from `gh api` and LICENSE files on 2026-11-17.

- `@napi-rs/keyring` ships prebuilt N-API binaries for macOS Keychain, Windows Credential Manager and Linux Secret Service, which matches what the existing private publisher already does through the macOS Keychain.
  Linux servers without a Secret Service daemon (headless VPS, containers) need a fallback: an age-encrypted file whose key comes from an environment variable or a mounted secret, documented as weaker.
- Hosted edition: envelope encryption of each tenant's platform tokens with a data key wrapped by a cloud KMS (AWS KMS, Google Cloud KMS) or OpenBao's transit engine, with key identifiers and rotation dates stored beside the ciphertext in PostgreSQL.
  OpenBao is a separate MPL service, so running it carries no obligation on the MIT code.
- Vault's BUSL additional use grant permits production use unless the offering competes with IBM's paid versions [F]; that is probably fine for CreatorBrio but it is source-available, which the policy excludes from anything distributed.

### 4.3 Databases and ORMs

| Candidate | Licence | Latest | Status | Decision |
|---|---|---|---|---|
| SQLite via `better-sqlite3` <https://github.com/WiseLibs/better-sqlite3> | MIT (SQLite public domain) | v13.2.0 (2026-11-14) | Mature, synchronous, native addon | **ADOPT** for local business state when files outgrow their usefulness (publication ledger, schedules, tokens metadata) |
| `node:sqlite` <https://nodejs.org/api/sqlite.html> | Node.js (MIT) | Node v26 docs | "Stability: 1.2 - Release candidate"; not stable in any release line [F] | **STUDY**; switch when stable to drop the native addon |
| libSQL <https://github.com/tursodatabase/libsql> | MIT | last "latest" release libsql-server-v0.24.32 (2025-02-14); commits to 2026-11-07 | Turso's README says the Rust rewrite "replaces libSQL as our intended direction" | **REJECT** |
| Turso (Rust rewrite) <https://github.com/tursodatabase/turso> | MIT | v0.8.3 (2026-10-12) | 0.x | **STUDY** |
| PGlite <https://github.com/electric-sql/electric-pglite> (moved from `electric-sql/pglite`) | Apache-2.0 or PostgreSQL licence | npm `@electric-sql/pglite` 0.5.16 (2026-11-09) | WASM PostgreSQL in process | **STUDY** as a way to run one PostgreSQL schema locally and hosted |
| PostgreSQL | PostgreSQL Licence | n/a | Mature | **ADOPT** for the hosted edition |
| Drizzle ORM <https://github.com/drizzle-team/drizzle-orm> | Apache-2.0 | 0.45.4 (2026-10); 1.0.0-beta.22 | Pre-1.0 for years | **ADOPT** (schema-as-TypeScript, supports SQLite, PGlite and PostgreSQL, works with Better Auth) |
| Kysely <https://github.com/kysely-org/kysely> | MIT | v0.29.9 (2026-11-12) | Query builder only | Acceptable alternative to Drizzle |
| Prisma <https://github.com/prisma/orm> (moved from `prisma/prisma`) | Apache-2.0 | GitHub latest 7.10.1 (2026-10-19); npm `latest` tag currently points at `8.0.0-rc.34` | Prisma 7 needs a driver adapter for every database and a new Rust-free client | **REJECT** (heavier generator workflow; an RC tagged `latest` on npm on 2026-11-17 is a supply-chain hygiene warning) |

All rows [F] from `gh api`, npm and the linked pages on 2026-11-17.

- The previous review's call (files behind ports locally, PostgreSQL hosted) still holds.
  The one change this review suggests: the publisher module's ledger (attempts, platform media IDs, idempotency keys, token metadata) is relational and concurrency-sensitive, so it should start on SQLite inside the publisher module, as the private Python publisher already does, rather than on JSON files.
- One schema in Drizzle with SQLite locally and PostgreSQL hosted is workable but not free: dialect differences (JSON, timestamps, partial indexes) need two migration sets or PGlite locally; T8 in the previous review should decide.

### 4.4 Object storage

| Candidate | Licence | Latest | Status | Decision |
|---|---|---|---|---|
| MinIO <https://github.com/minio/minio> | AGPL-3.0 | RELEASE.2025-10-15 | **Archived**; README: "THIS REPOSITORY IS NO LONGER MAINTAINED" and "distributed as source code only"; vendor steers users to proprietary "AIStor Free" [F] | **REJECT** |
| Silo <https://github.com/pgsty/silo> (community MinIO fork, renamed from `pgsty/minio` on 2026-08-06) | AGPL-3.0 | RELEASE.2026-11-12 | Maintained release line with console | **REJECT** as a default; acceptable for users who already run MinIO |
| Garage <https://git.deuxfleurs.fr/Deuxfleurs/garage> | AGPL-3.0 | v2.5.0 (2026-10-24); commit 2026-11-17 | "designed for self-hosting at a small-to-medium scale"; single node supported [F] | **REJECT** as a dependency (user-supplied service only): `spec/08` excludes AGPL, so CreatorBrio does not integrate, bundle or distribute it; a self-hoster may point the S3 adapter at their own |
| SeaweedFS <https://github.com/seaweedfs/seaweedfs> | Apache-2.0 (separate Enterprise edition) | 4.54 (2026-11-16) | Mature, broader than needed | Acceptable alternative |
| RustFS <https://github.com/rustfs/rustfs> | Apache-2.0 | 1.0.6 (2026-11-15); 1.0 GA 2026-09-16 | Young; some features "Preview" | **STUDY** |
| Ceph RGW | LGPL-2.1 or LGPL-3 | v22.0.0 (2026-10-28) | Far too heavy for this product | **REJECT** |
| Hosted S3-compatible stores (AWS S3, Cloudflare R2, Backblaze B2, Google Cloud Storage) | Proprietary services | n/a | n/a | **INTEGRATE** through one S3 adapter for the hosted edition and for self-hosters who prefer them |

Rows [F] from `gh api` and READMEs on 2026-11-17; hosted stores not separately checked.

- MinIO is the main change since the previous review's era: the community edition is archived and binary-less, so no CreatorBrio document should tell users to "just run MinIO".
- What the product actually needs locally is narrower than S3: Instagram, Threads and Facebook pull media from a public URL at publish time.
  The local edition can satisfy that with any S3-compatible bucket that issues short-lived presigned GET URLs (the existing private publisher's design), or with a user-provided tunnel to a single signed media route; the AWS SDK v3 S3 client (Apache-2.0) and presigner cover both hosted stores and any S3-compatible store a self-hoster runs.

### 4.5 Logging, monitoring and error reporting

| Candidate | Licence | Latest | Decision |
|---|---|---|---|
| Pino <https://github.com/pinojs/pino> | MIT | v10.4.0 (2026-10-02) | **ADOPT** for structured JSON logs with redaction paths for tokens and signed URLs |
| OpenTelemetry JS <https://github.com/open-telemetry/opentelemetry-js> | Apache-2.0 | v3.1.1 API (2026-11-09); `@opentelemetry/sdk-node` 0.301.2 | **ADOPT** at the hosted stage (traces and metrics through OTLP); optional locally |
| Sentry JavaScript SDK <https://github.com/getsentry/sentry-javascript> | MIT | 11.13.0 (2026-11-16) | **INTEGRATE** as an optional, off-by-default reporter (works with GlitchTip or Sentry) |
| Sentry server / self-hosted <https://github.com/getsentry/self-hosted> | FSL-1.1-Apache-2.0 (source-available for two years per version) | 26.10.1 (2026-10-29); 16 GB RAM minimum, 7 GB for errors-only | **REJECT** for distribution; Sentry's SaaS is acceptable for the operator's own hosted edition |
| GlitchTip <https://gitlab.com/glitchtip> | MIT | 512 MB RAM recommended, PostgreSQL 14+ | **INTEGRATE** as the documented self-hosted error tracker |
| SigNoz <https://github.com/SigNoz/signoz> | MIT except `ee/` and `cmd/enterprise/` (production use needs a licence) | v0.150.0 (2026-11-13) | **REJECT** for distribution; acceptable for the operator to run unmodified community builds |
| Grafana, Loki, Tempo, Mimir | AGPL-3.0 | v13.3.1, v3.7.10, v3.1.1, 3.2.5 | Operator-side only, unmodified; never bundled |
| Prometheus | Apache-2.0 | v3.16.0 (2026-11-05) | Operator-side metrics |

All rows [F] from `gh api` and LICENSE or install files on 2026-11-17.

- Critical-workflow events for the publisher should carry job, attempt, platform, account and platform-media identifiers, never tokens or signed URLs; Pino's `redact` option enforces the second half mechanically.

### 4.6 Notifications

| Candidate | Licence | Latest | Decision |
|---|---|---|---|
| Web Push via `web-push` <https://github.com/web-push-libs/web-push> | **MPL-2.0** (not MIT) | v4.0.0 (2026-11-10) | **ADOPT** for browser and installed-PWA notifications; unmodified use is fine |
| ntfy <https://github.com/binwiederhier/ntfy> | Apache-2.0 or GPLv2 (dual) | v2.38.1 (2026-11-16) | **INTEGRATE** as an optional self-hosted channel (HTTP POST to a topic) |
| Apprise <https://github.com/caronc/apprise> | BSD-2-Clause, Python | v2.2.0 (2026-11-08) | **INTEGRATE** only as a user-installed separate process via its API; do not bundle Python |
| Novu <https://github.com/novuhq/novu> | MIT plus `enterprise/packages` under a proprietary licence | v3.20.0 (2026-11-16) | **REJECT** (a whole notification platform for a handful of events; proprietary parts) |
| Expo push service | Free service; Expo "may suspend or terminate your access ... for any or no reason"; 600 notifications per second per project; contents held only in memory and queues [F] (<https://docs.expo.dev/push-notifications/faq/>, <https://expo.dev/terms>) | n/a | **INTEGRATE** for the mobile client, behind an interface that can switch to direct APNs and FCM |
| Email (SMTP via Nodemailer, MIT) | MIT | not checked | **ADOPT** as the lowest-common-denominator channel |

### 4.7 Packaging and distribution

- **Plain npm or `git clone` plus Node** remains the right local distribution (previous review); nothing found changes that.
- **Docker images.**
  Publishing an image is distribution of every binary inside it.
  The GPL FAQ treats the MIT app and GPL userland as an "aggregate", so the app stays MIT, but "if you distribute binaries, you must distribute the complete corresponding source code too" for each GPL or LGPL package [F] (<https://www.gnu.org/licenses/gpl-faq.html>), and Docker Hub's Debian page makes compliance "the image user's responsibility" [F].
  Mitigations: a distroless or minimal base, a pinned digest, an SBOM in each release, links to the distribution's source packages, and an LGPL (not `--enable-gpl`) FFmpeg build [F] (<https://ffmpeg.org/legal.html>).
  Decision: **INTEGRATE** an official image at the hosted stage, when the same image serves the operator.
- **Tauri** <https://github.com/tauri-apps/tauri>: MIT or Apache-2.0; tauri-cli v2.12.5 (2026-11-16) [F].
  A Next.js server app would need a Node sidecar inside Tauri, which defeats its small-binary advantage.
  Decision: **REJECT** for now.
- **Electron** <https://github.com/electron/electron>: MIT; v45.3.3 (2026-11-14) [F].
  It could wrap the existing server and add a tray-resident scheduler that keeps running when the browser is closed, but it adds code-signing, notarisation and auto-update work for every OS.
  Decision: **STUDY**; revisit only if self-hosters struggle with "keep a Node process running".

### 4.8 Mobile client foundations

- **Expo** <https://github.com/expo/expo> (MIT; `expo` 58.0.26, 2026-11-17) and **React Native** (MIT; moved to <https://github.com/react/react-native>, v0.88.1, 2026-10-27) [F].
- `@better-auth/expo` (MIT) gives the mobile client the same sessions as the web app [F].
- `expo-server-sdk` (MIT, 8.0.0) sends through Expo's push service; the client can also obtain native device tokens for direct APNs and FCM [F].
- EAS Build and EAS Update are optional proprietary services; local builds remain possible (not re-verified here).
- Decision: **ADOPT** Expo for the later mobile client, after the hosted identity and API exist.
  A mobile client against a self-hosted, loopback-only install is not reachable from a phone without a tunnel or LAN exposure, so the mobile client is realistically a hosted-edition feature; that should be stated, not discovered.

## 5. Corrections and updates to the previous review's section 12

| Previous statement | Status on 2026-11-17 | Evidence |
|---|---|---|
| Instagram page states both 100 and 50 posts per 24 h | Still contradictory in the guide, but both API references say 50 and the limit endpoint reports "currently 50"; treat 50 as current and read it at runtime | [F] ig-user/media_publish, content_publishing_limit |
| Instagram carousel limit not stated | Up to 20 items, images and videos mixed | [F] content-publishing |
| Advanced Access needs App Review and Business Verification | Confirmed; the separate access verification (Tech Provider) step is "no longer required"; an annual Data Use Checkup applies | [F] access-levels, access-verification |
| YouTube upload costs about 100 units | Superseded: `videos.insert` costs 1 unit in a dedicated Video Uploads bucket of 100 calls per day | [F] videos/insert, determine_quota_cost |
| Whether `youtube.upload` needs verification: UNVERIFIED | No YouTube upload scope is restricted (no CASA); sensitive status still UNVERIFIED; personal-use apps under 100 users are exempt from verification; unverified Production apps keep long-lived refresh tokens | [F] Google Cloud help 13464325, 13464321, 13464323, 15549945 |
| TikTok rules seen through search only | Still search-only (site unreachable from this environment), now extended: posting accounts must be private, about 15 posts per creator per day, interaction-checkbox rules, audit expects wide-audience apps | [S] |
| LinkedIn Document posts under `w_member_social`: UNVERIFIED | Resolved at the permission level (Documents and Posts API tables list `w_member_social`); product-level gating for self-serve apps still UNVERIFIED; self-serve tokens get no refresh token | [F] documents-api, posts-api, programmatic-refresh-tokens |
| Mixpost Lite is MIT; Pro source-available | Confirmed; Lite has had no release since 2026-03-16 and supports only Facebook Pages, X and Mastodon | [F] mixpost.app/pricing, GitHub API |
| Postiz is AGPL-3.0 | Confirmed; also uses the FSFE FLA, and its default compose file pulls Elasticsearch 7.17 (ELv2/SSPL) | [F] repository; [S] Elastic licensing FAQ |

Other changes since the previous review's era that affect decisions: MinIO's community repository is archived; Arctic is deprecated; Auth.js is maintenance-only; `keytar` is archived; `web-push` is MPL-2.0, not MIT; `google-auth-library-nodejs` moved to `googleapis/google-cloud-node-core`; React Native moved to `react/react-native`; Prisma moved to `prisma/orm`; PGlite moved to `electric-sql/electric-pglite` (all [F]).

## 6. Direct answers

### 6.1 What the open-source edition can honestly promise a self-hoster, per platform

The common preconditions: the self-hoster registers their own developer app on each platform, keeps a process running at publish time, and exposes media at a public HTTPS URL for Meta platforms (a bucket with presigned links or a tunnel).

- **Instagram:** "Publish Reels, image posts and carousels of up to 20 JPEG slides to your own Business or Creator account, through your own Meta app in Standard Access, with no App Review."
  Caveats to state: about 50 API posts per day, JPEG conversion, public media URLs, 60-day tokens that CreatorBrio refreshes, scheduling done by CreatorBrio.
- **Facebook Pages:** "Publish Reels and single or multi-photo posts to Pages you administer, with optional native scheduling up to 29 or 30 days ahead, with no App Review."
- **Threads:** "Publish text, image, video and carousel posts to your own account added as a Threads Tester, with no App Review."
- **YouTube:** "Upload public videos and Shorts, with titles, thumbnails and scheduled publication, to your own channel through your own Google Cloud project."
  Recommend publishing the project to Production unverified (a one-time warning screen, long-lived tokens) rather than Testing (re-consent every seven days); up to 100 uploads per day.
- **TikTok:** "Send videos and photo carousels to your TikTok drafts (pending verification of Upload mode for unaudited apps), or post privately (SELF_ONLY) from a private account."
  Do not promise public TikTok posting: it needs TikTok's audit, which expects apps that are not limited to private use.
- **LinkedIn:** "Post text, images and video to your own LinkedIn profile through a self-serve app, re-authorising every 60 days."
  PDF carousel (Document) posts: promise only after the live test in section 2.2.
  Company Pages: not for individuals; only registered organisations can obtain the Community Management API.
- **X:** "Post to your own account, paid per post to X from your own developer account (about $0.015 per post, $0.20 with a link)."
- **Pinterest:** "Pin to your own boards after Pinterest grants your app Standard access (requires a demo video)."
  Before that, Trial pins are visible only to you.
- **Bluesky:** "Post text, up to four images and video to your own account with an app password, no review."
  OAuth for a localhost install depends on the server accepting the development client; production OAuth needs a public metadata URL.

### 6.2 What the hosted edition needs from each platform, and how long it might take

Prerequisites for almost every review: a registered legal entity (Meta Business Verification, LinkedIn Community Management "registered legal organizations"), a public homepage on an owned domain, a privacy policy and terms of service, a support contact, and recorded screencasts of each OAuth and publishing flow.
Platforms rarely publish timelines; the figures below are official where marked and otherwise estimates.

| Platform | Requirement | Time | Evidence |
|---|---|---|---|
| Meta (Instagram, Facebook Pages) | Business Verification of the operator's business portfolio; App Review for Advanced Access to publishing and Pages permissions; annual Data Use Checkup | App Review "typically ... less than one week ... often only 2-3 days, but may take longer during peak periods"; Business Verification timing not published; plan 2 to 6 weeks including one rejection cycle (estimate) | [F] <https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction> |
| Threads | App Review for `threads_basic` and `threads_content_publish`; app published | Same review system; estimate as Meta | [F] Threads get-started |
| YouTube | Brand verification; sensitive-scope verification if applicable; Developer Policies compliance; audit and quota extension once usage exceeds 100 uploads per day per project | Sensitive verification about 10 business days [S]; audit timing not published (estimate: weeks) | [S] <https://support.google.com/cloud/answer/9110914>; [F] quota_and_compliance_audits |
| TikTok | App review per scope with demo videos; Content Posting audit; mandated UX; domain verification for `PULL_FROM_URL` | Not published; UNVERIFIED (plan for weeks and possible rejection) | [S] |
| LinkedIn member posting | Self-serve Share on LinkedIn; no review | Immediate | [F] |
| LinkedIn Pages | Community Management API Development tier, then Standard tier review with screencast and test credentials | Not published; Development tier must complete within 12 months | [F] increasing-access, community-management-app-review |
| X | No review for pay-per-use; Enterprise plan and white-label approval for a multi-tenant product at scale | Commercial negotiation | [F] developer policy |
| Pinterest | Standard access (demo video) | "reviewed regularly"; not published | [F] access-tiers |
| Bluesky | None | Immediate | [F] |

Useful sequencing facts:
- A hosted alpha can onboard up to 100 YouTube users before Google verification (the unverified lifetime cap, which never resets).
- Meta and Threads users can be added as app testers before App Review, but Meta describes Standard Access as "intended for apps that will only be used by people who have roles on them, during app development, or for testing", so this suits a closed test with a handful of accounts, not paying customers.
- TikTok should launch in the hosted edition as "send to drafts" or private until the audit passes.
- Start Business Verification and the legal-entity paperwork first; it gates Meta and LinkedIn Pages and is the slowest item the operator cannot speed up with engineering.

### 6.3 Where the open-core model leaves genuine paid value, and what could undermine it

**Genuine paid value (things a self-hoster cannot get by running the MIT code).**
1. **Reviewed platform apps.**
   Meta Advanced Access (App Review plus Business Verification), a verified Google OAuth app with audited YouTube quota, an audited TikTok client, LinkedIn Community Management API approval and Pinterest Standard access all belong to the app owner and cannot be transferred or shared.
   A self-hoster's own app is limited to accounts they own or manage, to SELF_ONLY on TikTok, to a 100-user lifetime cap or weekly re-consent on YouTube, and to sandbox pins on Pinterest (section 2).
   "Connect your account in one click and post publicly" is therefore the single largest convenience the hosted edition can sell, and the one a competitor hosting the MIT core must earn separately, platform by platform, over months.
2. **A public, always-on media and scheduling plane.**
   Instagram, Threads and Facebook pull media from a public URL, and posts must go out while the creator's laptop is asleep.
   A local-first install needs a tunnel or a bucket and a machine that stays awake; the hosted edition provides both, plus signed, expiring links and retries.
3. **Credential custody and rotation.**
   Instagram and Threads long-lived tokens expire after 60 days unless refreshed, Google Testing-mode refresh tokens expire after seven days, X access tokens after two hours, and Bluesky public-client sessions after two weeks.
   The hosted edition can refresh, encrypt under a KMS, rotate and alert before expiry; a self-hoster must do the same on their own machine.
4. **Operations the user never sees:** Graph API version upgrades (two-year lifetime per version), metric deprecations, quota monitoring, publication tracking and failure alerts.
5. **Teams and approvals across people**, the mobile client with push notifications (which needs a server that holds device tokens), retained analytics history, support and an SLA.

None of these require withholding product features from the open-source edition; they are operational, legal and relationship assets.
That is consistent with the "fully usable open source" promise.

**Licensing and business risks that could undermine it.**
1. **Anyone may host the MIT core commercially.**
   MIT imposes no network-use or share-alike obligation, so a competitor can run CreatorBrio as a SaaS without contributing back.
   What they cannot copy: the operator's reviewed platform apps, the CreatorBrio name and logo (MIT grants no trademark rights, so a written trademark policy and a registered mark are the practical defence), the hosted-only operational code if it lives in a separate private repository, and the operator's relationship with the platforms.
   A competitor can shorten the app-review path by sitting on a proprietary unified API (Ayrshare, Zernio, Outstand, Upload-Post), which runs its own reviewed apps (section 3.9); that weakens moat 1 and means the hosted edition must also win on product quality, not only on approvals.
2. **Changing the core licence is not a clean option.**
   The repository is derived from an MIT project and its instructions require `LICENSE` to stay unchanged.
   New code could be offered under a different licence, but a split-licence core would confuse contributors, and AGPL or a source-available licence would contradict the stated policy.
   The open-core boundary should therefore be repository-level: MIT core in public, hosted control plane (tenancy, billing, KMS integration, fleet scheduling, operator dashboards) in a private repository that depends on the core through its public API.
3. **Copyleft contamination.**
   Copying AGPL publisher code (Postiz, OpenPost, Brightbean Studio, trypost) into the core would make the combined work AGPL and impose AGPL section 13 source-offer duties on the hosted edition, destroying the private control plane.
   This is the highest-impact, easiest-to-commit mistake; a licence check in CI (for example an SPDX allow-list over `package.json` dependencies) and a contribution rule against pasting third-party code catch most of it.
4. **Source-available components slipping into distribution.**
   Examples found in this review: Postiz's default stack pulls Elasticsearch 7.17 (ELv2/SSPL), Nango is ELv2, n8n is under the Sustainable Use License, Mixpost Pro is non-redistributable, and HashiCorp Vault is BUSL-1.1 (section 4).
   None should appear in a CreatorBrio image, compose file or install script.
5. **Platform terms rather than software licences.**
   X's Developer Policy limits pay-per-use to "applications with limited end-users", forbids white-label versions without separate approval and forbids registering multiple apps for one use case; Meta, Google and TikTok all bind the reviewed app to the operator who passed review.
   A hosted edition that let customers bring their own app would be legitimate; one that shared a single unreviewed app among tenants, or encouraged self-hosters to share credentials, would not.
   The open-source documentation should say plainly that each self-hoster registers their own apps.
6. **Unified-API lock-in.**
   Ayrshare's terms forbid using the service "to build a similar or competitive product", and every vendor can change prices or drop a network; using one as the hosted edition's primary publisher would put a competitor's terms under the product.
   Treat them, if at all, as an optional adapter the user chooses.

## 7. Sources

All retrieved 2026-11-17.
GitHub repository metadata, releases, commits and LICENSE files were read with `gh api repos/OWNER/REPO`, `/license`, `/releases` and `/commits`; npm metadata with `npm view` (registry read only).

**Meta**
- <https://developers.facebook.com/docs/instagram-platform/content-publishing> [F]
- <https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media> [F]
- <https://developers.facebook.com/docs/instagram-platform/overview> [F]
- <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login> [F]
- <https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/get-started> [F]
- <https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/insights> [F]
- <https://developers.facebook.com/docs/instagram-platform/changelog> [F]
- <https://developers.facebook.com/docs/graph-api/overview/access-levels> [F]
- <https://developers.facebook.com/docs/development/release/business-verification/> [F]
- <https://developers.facebook.com/docs/development/release/access-verification> [F]
- <https://developers.facebook.com/docs/development/build-and-test/app-modes> [F]
- <https://developers.facebook.com/docs/development/build-and-test/app-roles> [F]
- <https://developers.facebook.com/docs/resp-plat-initiatives/app-review/introduction> [F]
- <https://developers.facebook.com/docs/video-api/guides/reels-publishing> [F]
- <https://developers.facebook.com/docs/pages-api/posts> [F]
- <https://developers.facebook.com/docs/graph-api/reference/page/photos/> [F]
- <https://developers.facebook.com/docs/graph-api/reference/page/insights/> [F]
- <https://developers.facebook.com/docs/graph-api/changelog> and <https://developers.facebook.com/docs/graph-api/guides/versioning> [F]
- <https://developers.facebook.com/docs/threads/get-started>, <https://developers.facebook.com/docs/threads/create-posts>, <https://developers.facebook.com/docs/threads/overview>, <https://developers.facebook.com/docs/threads/posts>, <https://developers.facebook.com/docs/threads/troubleshooting> [F]

**Google and YouTube**
- <https://developers.google.com/youtube/v3/revision_history> [F]
- <https://developers.google.com/youtube/v3/docs/videos/insert> [F]
- <https://developers.google.com/youtube/v3/determine_quota_cost> [F]
- <https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits> [F]
- <https://developers.google.com/youtube/v3/docs/thumbnails/set> and <https://developers.google.com/youtube/v3/docs/videos> [F]
- <https://developers.google.com/youtube/terms/developer-policies> [F]
- <https://developers.google.com/identity/protocols/oauth2> and <https://developers.google.com/identity/protocols/oauth2/scopes> [F]
- <https://support.google.com/cloud/answer/15549945>, <https://support.google.com/cloud/answer/13464321>, <https://support.google.com/cloud/answer/13464323>, <https://support.google.com/cloud/answer/13464325> [F]
- <https://support.google.com/cloud/answer/9110914> [S]
- <https://support.google.com/youtube/answer/15424877> [F]

**TikTok** (all [S]; direct fetch failed)
- <https://developers.tiktok.com/docs/en/content-sharing-guidelines>
- <https://developers.tiktok.com/docs/en/content-posting-api-get-started>
- <https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post>
- <https://developers.tiktok.com/docs/en/content-posting-api-reference-photo-post>
- <https://developers.tiktok.com/docs/en/content-posting-api-reference-query-creator-info>
- <https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide>
- <https://developers.tiktok.com/docs/en/tiktok-api-scopes>, <https://developers.tiktok.com/docs/en/tiktok-api-v2-rate-limit>, <https://developers.tiktok.com/docs/en/add-a-sandbox>, <https://developers.tiktok.com/docs/en/getting-started-create-an-app>

**LinkedIn** [F]
- <https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin>
- <https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access>
- <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api>
- <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/documents-api>
- <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api>
- <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api>
- <https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api>
- <https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review>
- <https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access>
- <https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow>
- <https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens>
- <https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits>

**X** [F]
- <https://docs.x.com/x-api/getting-started/pricing>, <https://docs.x.com/changelog>, <https://docs.x.com/x-api/fundamentals/post-cap>, <https://docs.x.com/x-api/fundamentals/rate-limits>
- <https://docs.x.com/x-api/media/quickstart/media-upload-chunked>, <https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code>
- <https://docs.x.com/developer-terms/policy>, <https://docs.x.com/developer-terms/agreement>
- <https://devcommunity.x.com/t/important-update-legacy-x-api-basic-plans-are-moving-to-pay-per-use-ppu/266305> [S]

**Pinterest** [F]
- <https://developers.pinterest.com/docs/key-concepts/access-tiers/>, <https://developers.pinterest.com/docs/reference/rate-limits/>
- <https://github.com/pinterest/api-description/blob/main/v5/openapi.json>

**Bluesky and AT Protocol** [F]
- <https://atproto.com/specs/oauth>
- <https://github.com/bluesky-social/bsky-docs> (creating-a-post, video, rate-limits, oauth-client pages)
- <https://github.com/bluesky-social/atproto> (LICENSE.txt, lexicons)

**Unified APIs** [F]
- <https://www.ayrshare.com/pricing>, <https://www.ayrshare.com/terms>, <https://www.ayrshare.com/docs/apis/overview>, <https://www.ayrshare.com/docs/multiple-users/business-plan-overview>
- <https://www.upload-post.com/pricing>, <https://docs.upload-post.com/llms.txt>
- <https://zernio.com/pricing>, <https://zernio.com/llms.txt>
- <https://www.outstand.so/>
- <https://bundle.social/pricing>

**Publishing tools and SDKs** [F]
- <https://github.com/gitroomhq/postiz-app> (LICENSE, CCLA.md, docker-compose.yaml, integrations directory)
- <https://www.elastic.co/pricing/faq/licensing> [S]
- <https://github.com/inovector/mixpost>, <https://mixpost.app/pricing>
- <https://github.com/activepieces/activepieces> (LICENSE, packages/ee/LICENSE)
- <https://github.com/n8n-io/n8n/blob/master/LICENSE.md>
- <https://github.com/getopenpost/openpost>, <https://github.com/brightbeanxyz/brightbean-studio>, <https://github.com/trypostit/trypost>, <https://github.com/cogsend/cogsend>, <https://github.com/SamurAIGPT/postiz-cheap>
- <https://github.com/NangoHQ/nango>
- <https://github.com/meta/facebook-nodejs-business-sdk>, <https://github.com/googleapis/google-api-nodejs-client>, <https://github.com/googleapis/google-auth-library-nodejs>, <https://github.com/PLhery/node-twitter-api-v2>, <https://github.com/linkedin-developers/linkedin-api-js-client>, <https://github.com/tiktok/tiktok-business-api-sdk>
- <https://github.com/panva/oauth4webapi>, <https://github.com/panva/openid-client>, <https://github.com/pilcrowonpaper/arctic>

**Authentication** [F]
- <https://github.com/better-auth/better-auth>, <https://www.better-auth.com/docs/plugins/organization>, <https://www.better-auth.com/docs/reference/telemetry>, <https://www.better-auth.com/blog/authjs-joins-better-auth>
- <https://github.com/nextauthjs/next-auth>, <https://github.com/ory/kratos>, <https://github.com/keycloak/keycloak>, <https://github.com/zitadel/zitadel> (LICENSING.md), <https://github.com/logto-io/logto>, <https://github.com/supertokens/supertokens-core> (ee/LICENSE.md)
- <https://github.com/clerk/javascript>

**Infrastructure** [F]
- <https://github.com/Brooooooklyn/keyring-node>, <https://github.com/atom/node-keytar>, <https://github.com/magarcia/cross-keychain>
- <https://github.com/openbao/openbao>, <https://github.com/hashicorp/vault>, <https://github.com/Infisical/infisical>, <https://github.com/getsops/sops>, <https://github.com/FiloSottile/age>
- <https://github.com/WiseLibs/better-sqlite3>, <https://nodejs.org/api/sqlite.html>, <https://github.com/tursodatabase/libsql>, <https://github.com/tursodatabase/turso>, <https://github.com/electric-sql/electric-pglite>, <https://www.postgresql.org/about/licence/>, <https://www.sqlite.org/copyright.html>
- <https://github.com/drizzle-team/drizzle-orm>, <https://github.com/kysely-org/kysely>, <https://github.com/prisma/orm>
- <https://github.com/minio/minio>, <https://www.min.io/download>, <https://github.com/pgsty/silo>, <https://github.com/OpenMaxIO>, <https://git.deuxfleurs.fr/Deuxfleurs/garage>, <https://github.com/seaweedfs/seaweedfs>, <https://github.com/ceph/ceph>, <https://github.com/rustfs/rustfs>
- <https://github.com/pinojs/pino>, <https://github.com/open-telemetry/opentelemetry-js>, <https://github.com/getsentry/sentry>, <https://github.com/getsentry/self-hosted>, <https://github.com/getsentry/sentry-javascript>, <https://gitlab.com/glitchtip>, <https://github.com/SigNoz/signoz>, <https://github.com/grafana/grafana>, <https://github.com/prometheus/prometheus>
- <https://github.com/web-push-libs/web-push>, <https://github.com/binwiederhier/ntfy>, <https://github.com/caronc/apprise>, <https://github.com/novuhq/novu>, <https://docs.expo.dev/push-notifications/faq/>, <https://expo.dev/terms>
- <https://github.com/tauri-apps/tauri>, <https://github.com/electron/electron>, <https://www.gnu.org/licenses/gpl-faq.html>, <https://ffmpeg.org/legal.html>, <https://hub.docker.com/_/debian>
- <https://github.com/expo/expo>, <https://github.com/react/react-native>
- npm registry metadata for `nodemailer` (MIT-0), `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` (Apache-2.0), and the other packages named above
