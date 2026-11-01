# CreatorBrio

Named Framewoven until #29; the repository was renamed from `mk-global/framewoven` to `mk-global/creatorbrio` on 2026-10-31 (see `docs/MAINTAINING.md`).

AI-powered creative studio for branded social content: design Instagram carousels by chatting with Claude. Next.js 16 + React 19 + TypeScript + Tailwind v4.

Derived from the MIT-licensed Open Carrusel project and now independently maintained. `LICENSE` and its copyright notice must stay unchanged; see `docs/PROVENANCE.md` for origin and attribution and `docs/MAINTAINING.md` for process.

## Architecture

- **Frontend**: React app (localhost:3000 by default; `/start [port]` and `PORT` override it) with chat panel (left), carousel preview (center), slide filmstrip (bottom)
- **Network**: `npm run dev` and `npm start` listen on 127.0.0.1 only. `src/proxy.ts` refuses `/api/*` requests whose `Host` is not loopback, and state-changing requests carrying another site's `Origin`; requests without `Origin` (the agent's curl) are allowed
- **AI Agent**: Claude CLI spawned as subprocess via `/api/chat`, communicates through SSE streaming
- **Storage**: JSON files in `/data/` with async-mutex locking and atomic writes
- **Brands**: `src/lib/brand.ts` owns `data/brands.json`, created once from the original `brand.json`, which the app never writes again (setup only seeds it when missing). The migrated default brand's id is the fixed `"default"`. A carousel's `brandId` is set at creation and never changes; carousels and templates without one belong to the default brand. `/api/chat` passes the carousel's brand to `buildSystemPrompt` unchanged
- **Export**: Puppeteer screenshots HTML slides to PNG at exact Instagram dimensions
- **Slides**: Full HTML documents rendered in sandboxed iframes. `wrapSlideHtml()` in `src/lib/slide-html.ts` is the shared rendering contract between preview and export.

## Key Files

- `src/lib/chat-system-prompt.ts` — Dynamic system prompt (injects brand config + carousel context)
- `src/lib/slide-html.ts` — `wrapSlideHtml()` wraps slide body HTML into full documents
- `src/lib/data.ts` — JSON storage with proper async-mutex and atomic writes
- `src/lib/carousels.ts` — Carousel and slide CRUD with version history
- `src/lib/claude-path.ts` — Portable Claude CLI discovery

## API Routes

Served by the running app, on whichever port it was started with. The origin the
design agent is told to call is derived per request by `resolveAppOrigin()` in
`src/lib/request-origin.ts`; never hardcode a port in the system prompt.

- `POST /api/chat` — Claude CLI subprocess + SSE streaming
- `GET/POST /api/carousels` — List/create carousels
- `GET/PUT/DELETE /api/carousels/[id]` — Single carousel
- `POST /api/carousels/[id]/slides` — Add slide
- `PUT/DELETE /api/carousels/[id]/slides/[slideId]` — Update/delete slide
- `PUT /api/carousels/[id]/slides` — Reorder slides (body: { slideIds: [...] })
- `POST /api/carousels/[id]/slides/[slideId]/undo` — Undo slide change
- `GET/POST/DELETE /api/carousels/[id]/references`: reference images. `POST` takes `{ url, name }`, where `url` must be an image upload's `/uploads/<uuid>.png` path naming an existing PNG file; anything else is refused with 400. The server derives the file's path itself, and only references that still pass this check are listed in the agent's prompt
- `POST /api/carousels/[id]/export` — Export all slides to PNG ZIP (default, or `?format=png`) or to one LinkedIn PDF (`?format=pdf`); a one-slide carousel also as that single PNG (`?format=single-png`). Answers 409 while a chat run is still generating the carousel, or after one was stopped, failed or timed out having changed slides
- `GET/DELETE /api/carousels/[id]/generation` — `{ generating, interrupted }`: whether a chat run is still writing this carousel's slides, and whether the last one ended without finishing (kept in `data/generation-runs.json`). `DELETE` is the user accepting an interrupted carousel's slides as they are
- `GET/PUT /api/brand`: the default brand's configuration (kept for compatibility)
- `GET/POST /api/brands`: list brands with `defaultBrandId`, or create a brand
- `GET/PUT /api/brands/[id]`: one brand's configuration
- `GET /api/carousels?brandId=` and `GET /api/templates?brandId=` filter by brand; `POST /api/carousels` takes an optional `brandId`, fixed for the carousel's life
- `GET/POST /api/templates` — Templates
- `POST /api/upload` — Upload (images PNG/JPG/WebP, fonts WOFF2/TTF; max 10MB, type checked by magic bytes)
- `POST /api/images/generate`: one image from the local image service (`127.0.0.1:8791`); body `{ prompt, aspectRatio }` with 1:1, 4:5, 9:16 or 16:9; stores a validated PNG at its native size in `public/uploads/` and returns `{ url, width, height }`. The token is read server-side from `~/.config/framewoven/image-service.token` and never reaches the agent
- `GET /api/fonts` — Google Fonts list

## Conventions

- Components max ~300 lines per file
- Use `cn()` from `src/lib/utils.ts` for class merging
- Types in `src/types/`, libs in `src/lib/`, components in `src/components/`
- All data mutations go through `src/lib/data.ts` (never direct fs writes for JSON)
- Update routes never pass a parsed request body straight to a mutator. They select the fields the endpoint defines as mutable via `src/lib/api-input.ts`; everything else is server-owned
- iframe slides always use `sandbox=""` attribute (no JavaScript execution)
- The Claude subprocess gets `--allowedTools Bash WebFetch Read`: `Bash` to curl the local API routes, `WebFetch` to research while designing, `Read` to view reference images

## Instagram Dimensions

- 1:1 = 1080x1080 (square)
- 4:5 = 1080x1350 (portrait, recommended)
- 9:16 = 1080x1920 (story)
- Max 20 slides per carousel (`MAX_SLIDES` in `src/types/carousel.ts`)

## Slide HTML Rules

Slides store body-level HTML only (no `<html>`, `<head>`, `<!DOCTYPE>`). The `wrapSlideHtml()` function adds the full document structure, font loading, and dimension constraints. Slides should:

- Use inline styles or `<style>` tags
- Reference images as `/uploads/{filename}` paths
- Use Google Font family names in font-family declarations
- NOT contain `<script>` tags (enforced by iframe sandbox)
- Target the carousel's aspect ratio dimensions

## GitHub governance and ticket validation

- Canonical repository: `mk-global/creatorbrio`. Public-repository exception: do not add EngineeringToolsMK's private-runner workflows or invoke normal repository onboarding here.
- Every material change starts with an OPEN GitHub issue **before implementation**, validated using EngineeringToolsMK `tools/github-policy/validate.py ticket`. Before creating a PR validate each linked issue with `linked-ticket`, and validate the PR body with `pr`. Do not copy or reimplement the validator.
- Required ticket headings: Problem; Desired Outcome; Scope; Out of Scope; Acceptance Criteria; Verification; Dependencies / Blockers; Risks / Constraints. Acceptance Criteria requires a list item. Replace template comments with real text.
- Required PR headings: GitHub Issue (with `Closes #N`); Objective; Scope; Acceptance Criteria; Verification Evidence; Risk Assessment; Rollback; Decisions / Deviations. Acceptance Criteria requires a list item.
- GitHub issue and PR templates guide web contributors but are **advisory**, and cloud/API creation bypasses them. Validate drafted bodies before publishing.
- Hard merge gate is the local reviewer (App 4577329, `local-ai/pr-review/main`, `scope: required`) plus GitHub-hosted CI. An invalid linked ticket silently prevents reviewer admission; if a PR has no reviewer check, validate its linked ticket bodies first.
- Read `docs/MAINTAINING.md` for concrete commands, workflow boundaries and the limitations tracked under issue #24.
