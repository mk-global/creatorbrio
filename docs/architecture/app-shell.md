# The app shell and its screens

CreatorBrio's interface is one Next.js app with a persistent shell around every screen (#175).
This page describes how the screens are organised, which module owns each piece of state, and the contracts the screens rely on.
The visual language they follow is in [../design/design-c.md](../design/design-c.md).

## Screens

| Path | Screen | Owns |
|---|---|---|
| `/` | Home: the brand for new work, the four formats, an idea field, recent projects, templates, the brand panel and recent Video Studio productions | Nothing; reads the library |
| `/create` | New project: format, brand, size, a description or a template, and an optional name | The choices until **Create and open editor** |
| `/projects` | Every project, with search, this brand or all brands, a format filter, sorting, and sheet or list view | Its filters and view |
| `/templates` | Every template, with **Use template** and delete | Nothing |
| `/brands`, `/brands/new`, `/brands/[id]` | Brand cards, and the brand editor | The draft being edited |
| `/settings` | Whether Claude Code and image generation are set up, Video Studio pairing, where your data is and what leaves this computer | Nothing |
| `/carousel/[id]` | The editor | The editor's view state; the project lives on the server |
| `/studio` | The Video Studio ([video-studio-page.md](video-studio-page.md)) | Unchanged by the shell |

All of these live under the route group `src/app/(app)/`, whose layout wraps them in `AppProvider` and `Shell`; the group changes no URL.

## The shell

`src/components/app/Shell.tsx` has two modes.
Pages scroll as a document inside a padded `main`.
The editor and the Studio are workspaces: the shell is a full-height column and the screen manages its own scrolling.

Navigation is the same six destinations at every width, each shown once: Home, Projects, Templates, Brands, Video Studio (labelled Early) and, at the bottom, Settings.
At 768 px and wider it is a sidebar, 248 px wide or a 76 px rail; the rail is the default below 1280 px and in the editor, and the person's choice is kept per context in this browser.
On phones it is a header with the brand and Settings plus a five-tab bar; the editor gives the phone's whole screen to the work and has a back link instead.
A skip link moves focus to `main`, which takes focus without becoming a tab stop.

## State and its owners

- **Brands** come from `/api/brands` once, through `AppProvider` (`src/components/app/AppContext.tsx`), which every screen reads.
- **The brand for new work** is a preference of this browser (`src/lib/brand-selection.ts`), kept under the same storage key as before #175 so an existing choice survives the upgrade.
  It preselects the brand of a new project and filters "this brand" views; it never changes a project's brand, which is fixed when the project is created.
- **The library** reads `GET /api/carousels?view=summary` (`src/lib/project-summary.ts`): each project's name, brand, format, size, slide count and first slide only, so a library of hundreds of projects stays light.
  Filtering by brand happens in the browser from that one list.
- **Project formats** are owned by `src/lib/formats.ts` and described below.
- **Video Studio status** on Home and Settings asks `GET /api/video/session?status=1`, which answers paired or not with a 200, so an unpaired visit logs no 401 ([video-production-api.md](video-production-api.md)).
  Productions are listed only when the browser is paired.
- **Computer status** on Home and Settings asks `GET /api/status`: whether Claude Code is found and whether image generation is set up, with no paths, URLs or secrets.
  Image generation is read through the capability registry (`src/lib/creative-capabilities.ts`), so no API route reaches the image client.

## Project formats

Every project is a carousel; a format only sets its defaults and limits, so one engine, one editor, one design agent and one exporter serve all three.

| Format | Sizes | Slides | Main export |
|---|---|---|---|
| Instagram carousel | 4:5, 1:1, 9:16 | up to 20 | PNG ZIP |
| LinkedIn document | 4:5, 1:1 | up to 20 | PDF |
| Reel cover | 9:16 | exactly 1 | single PNG |

The format is an optional field on a stored carousel or template.
A project without one is an Instagram carousel, which is what every project made before formats was; no stored record is rewritten, and earlier releases still read the data.
The server enforces the limits: a size the format does not allow is refused when creating or resizing, and a Reel cover refuses a second slide with a reason.
The editor's Export button offers the format's main export first and removes nothing.

The design agent's prompt is frozen, so a format reaches it only as visible words at the start of the person's first message, such as "A one-slide Reel cover.", which they can read and change before sending.

## From an idea to the editor

1. On Home a person types an idea and picks a format, or picks a format directly.
2. `/create` receives the idea through this tab's `sessionStorage` (`src/lib/new-project-handoff.ts`), never through the URL or the server.
3. **Create and open editor** creates the project with `POST /api/carousels` (or `POST /api/templates/[id]/use` with an optional name), then hands the composed first message to the editor the same way.
4. The editor puts it in the message box. Nothing is designed until the person presses Send.

A screen reads a handoff while rendering and clears it once mounted, because React may render twice in development.

## Tests

- `tests/app-design-c.test.ts` runs the production build in Chromium over an empty data folder on port 3191, seeded through the API.
  It checks Home's formats and navigation, no horizontal overflow on twelve screens at 1440, 1280, 768, 390 and 320 px, keyboard focus order and visible focus, brand switching and persistence, each format's sizes, Reel cover creation with the prefilled message and the refused second slide, the single PNG and PDF exports, starting from a template, an unpaired Studio visit without a 401, and an empty console.
  The server gets a Claude CLI stub that refuses every call, and the test fails if any request reaches `/api/chat`.
- In CI, `tests/global-setup.ts` builds the app before the suite and the test uses the runner's Chrome; it fails rather than skips when either is missing.
  Locally a missing or stale build skips it with the reason.
- `tests/project-formats.test.ts` covers the format rules at the API, and `tests/design-c-helpers.test.ts` the pure helpers behind the screens.
