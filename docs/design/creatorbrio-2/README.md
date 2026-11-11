# CreatorBrio 2.0 product experience: review package

This folder is the design proposal for CreatorBrio 2.0, prepared for the founder's review under [#172](https://github.com/mk-global/creatorbrio/issues/172).
It is a proposal, not an implementation.
No application code, API, data format or workflow was changed to make it.

**Founder approval of the visual direction is required before any implementation starts.**
The decisions that approval covers are in `decisions.html`.

## How to open it

The package is a set of plain HTML pages that work straight from disk, with no server and no build.

1. Check out the branch that contains this folder, or download the folder.
2. Open `docs/design/creatorbrio-2/index.html` in a browser.
   On macOS: `open docs/design/creatorbrio-2/index.html` from the repository root.
3. Start with the overview, then open the prototype from its link.

GitHub shows these files as source code, not as pages, so open them from a local copy.
Fonts load from Google Fonts; offline, the pages fall back to system fonts and look slightly different.

## What is inside

| File | What it is |
| --- | --- |
| `index.html` | Overview: the proposal in brief, before and after, decisions, screenshots |
| `audit.html` | The UX audit of the current app, with evidence and measured contrast |
| `architecture.html` | Navigation, destinations, routes, formats, journeys and the capability matrix |
| `design-system.html` | Tokens, type, components and accessibility, read live from the prototype's stylesheet |
| `blueprint.html` | Milestones 2 to 4: scope, reuse, data, API, risks, acceptance and tests |
| `decisions.html` | Fifteen decisions for the founder, each with a recommendation |
| `prototype/` | The interactive prototype: `prototype/index.html` |
| `screenshots/current/` | The current app, captured from an isolated instance with synthetic data |
| `screenshots/prototype/` | The prototype at 1440, 1280, 768, 390 and 320 pixels |
| `review.css` | Layout for the review pages; tokens come from `prototype/app.css` |

## Using the prototype

A dark bar at the top of the prototype switches its state: populated, empty, loading or failed data; a paired or unpaired Video Studio; Claude Code connected or not.
"Mark illustrative controls" outlines every control that only shows what the real app would do; pressing one explains it instead of pretending to work.
Everything else works within the prototype: navigation, brand switching, the creation flow, filters, search, menus, confirmations, the brand editor and the editor's size and safe-zone controls.
Nothing is saved, and reloading the page resets it.

All projects, brands and videos in the prototype and the screenshots are synthetic.

## How it was checked

The current app was run as a separate instance from its own worktree, port and data folder, so the founder's checkout, data and running app were untouched.
The prototype and the review pages were checked at five widths for layout and sideways scrolling, by keyboard, and for colour contrast.
The repository's typecheck, lint, tests and build pass with this folder in place.
