# CreatorBrio Brand Guidelines

Version 1.0, approved by the founder on 2026-11-12 (Balanced Creative direction), implemented in [#189](https://github.com/mk-global/creatorbrio/issues/189).

This guide is the source of truth for CreatorBrio's own identity: the product's interface, its logo and icons, and its marketing.
It does not govern the brands people create inside CreatorBrio, which are entirely theirs (see [Product brand and user brands](#product-brand-and-user-brands)).
[Design C](../design/design-c.md) describes the interface's layout and structure; this guide sets the identity it wears.
To see the identity without reading CSS, open [specimen.html](specimen.html) in a browser.

## Contents

1. [Positioning and personality](#positioning-and-personality)
2. [Audience](#audience)
3. [Visual principles](#visual-principles)
4. [Colour](#colour)
5. [Typography](#typography)
6. [Logo](#logo)
7. [Iconography](#iconography)
8. [Spacing, radius and elevation](#spacing-radius-and-elevation)
9. [Motion](#motion)
10. [Buttons and component hierarchy](#buttons-and-component-hierarchy)
11. [Light and dark editing surfaces](#light-and-dark-editing-surfaces)
12. [Illustration and creative previews](#illustration-and-creative-previews)
13. [Writing and tone](#writing-and-tone)
14. [Marketing and social media](#marketing-and-social-media)
15. [Product brand and user brands](#product-brand-and-user-brands)
16. [Do and don't](#do-and-dont)
17. [Where it lives in the code](#where-it-lives-in-the-code)
18. [Changing this guide](#changing-this-guide)

## Positioning and personality

CreatorBrio is a local-first, AI-assisted creative studio for branded social content: Instagram carousels, LinkedIn documents, Reel covers and, early, Reels in the Video Studio.
It is a professional creative workspace with enough personality to feel inspiring, without distracting from the person's content.

The personality is **confident, crafted and calm**.
Confident: it says plainly what it does and what it does not do yet.
Crafted: details are deliberate, from the crop marks to the tabular numbers.
Calm: the interface steps back so the work can be the loudest thing on screen.

The brand has two registers.
The **workspace** is restrained: neutral surfaces, ink, one coral action at a time.
**Marketing** is more expressive: larger type, more coral, bolder compositions.
Both use the same palette, typefaces and mark.

## Audience

Creators, freelancers, social media managers, entrepreneurs and small businesses, mostly aged 25 to 44.
They are fluent in social platforms, short on time, and protective of their own brand.
They want work that looks professional without a design team, and a tool that never imposes its look on theirs.

## Visual principles

1. **The work is the hero.**
   Only work casts a shadow; chrome stays flat and quiet.
2. **Coral means something.**
   Brand Coral marks the logo, the crop marks and what is selected; Deep Coral marks the one action that starts new work.
   Nothing else is coral.
3. **Every device carries information.**
   Crop marks mean selected, a baseline means "these are formats", the Early tag means not finished, monospace means a technical value.
4. **One bold thing per screen.**
   In the workspace it is the work drawn at its true shape.
   In marketing it may be a headline or a composition.
5. **Honest and accessible.**
   Every text pairing meets WCAG 2.2 AA; nothing relies on colour alone.

## Colour

### The palette

| Name | Hex | Token | Purpose |
|---|---|---|---|
| Brand Coral | `#E94560` | `--brand-coral` | Signature: the mark, crop marks, selected indicators, decorative accents |
| Deep Coral | `#BF394F` | `--brand-deep-coral` | Primary creation actions and accessible coral emphasis |
| Midnight Ink | `#1C1B29` | `--brand-ink` | Headings, text, prominent controls, the dark surfaces |
| Studio Canvas | `#F1F2F4` | `--brand-canvas` | The main application background |
| Pure Paper | `#FFFFFF` | `--brand-paper` | Cards, panels, sheets, content surfaces |
| Soft Blush | `#FFF0F3` | `--brand-blush` | Subtle branded backgrounds; invitations to make something |
| Graphite | `#585767` | `--brand-graphite` | Secondary text |
| Fine Rule | `#D9DBE1` | `--brand-rule` | Borders and separators |

The product has no other brand colours.
Do not introduce purple, cyan, blue, yellow or any other competing accent.

### Semantic colours

These are not brand colours; they say something about state and keep their meaning everywhere.

| Role | Text | Surface | Use |
|---|---|---|---|
| Alert | `#A3243B` | `#FBE3E7` | Errors and destructive actions |
| Warning | `#8A5A00` | `#FCF3DC` | Something needs attention but nothing failed |
| OK | `#1A6544` | `#DCF0E4` | Success and verified states |
| Early | `#6B4300` | `#FCEBC4` | Features that are not finished |
| Field edge | `#80838F` | | Outlines of text fields and selects (3.4:1 on canvas) |

**Data colours.**
The Video Studio timeline tints clips by kind (footage, images, titles, captions, sound, graphics), and the editor's safe-zone overlay shades the areas Instagram covers.
These are categorical data colours that must stay distinguishable from each other; they are pale tints inside the timeline and the preview, never accents on chrome, and they are the only place hues outside the palette appear.

### Usage

- **Most of the screen is neutral.** Canvas for the background, Paper for panels, Ink for text and structure.
- **Deep Coral** fills the one action on a screen that starts new work, such as New project, Create brand or the Studio's Create.
  It may also be used as text for coral emphasis, since it passes 4.5:1 on Paper and Canvas.
- **Brand Coral** draws the logo, the crop marks around selected work, the underline of the selected tab, the current page's icon in the sidebar (on a phone, the bar above the current tab), the outline of the chosen brand or size, the current slide and the selected clip.
  Keyboard focus stays an Ink ring, so focus and selection never look alike.
  It is a line or a mark, never a fill under text.
- **Soft Blush** is rare: an empty state that invites someone to start, the "add a slide" tile, and the slide being created.
  It is never a panel, a sidebar or a hover colour for ordinary controls.
- **Ink surfaces** carry toasts, code blocks, the New project summary bar and the logo's dark variant.

### Accessibility

Measured contrast ratios (WCAG 2.x).
`tests/brand-identity.test.ts` recomputes every row from the declared tokens, so this table cannot drift from the code.

| Pairing | Ratio | Passes |
|---|---|---|
| Midnight Ink on Pure Paper | 16.96:1 | Text |
| Midnight Ink on Studio Canvas | 15.14:1 | Text |
| Graphite on Pure Paper | 7.06:1 | Text |
| Graphite on Studio Canvas | 6.30:1 | Text |
| Graphite on Soft Blush | 6.39:1 | Text |
| Pure Paper on Deep Coral (the create button) | 5.37:1 | Text |
| Deep Coral on Studio Canvas | 4.79:1 | Text |
| Alert on Pure Paper (the destructive button) | 7.31:1 | Text |
| Alert on Alert surface (the destructive button on hover) | 6.00:1 | Text |
| Placeholder on Pure Paper | 5.22:1 | Text |
| Placeholder on Studio Canvas | 4.66:1 | Text |
| Success on Pure Paper | 7.03:1 | Text |
| Success on Success surface | 5.90:1 | Text |
| Early on Early surface (the Early tag) | 7.34:1 | Text |
| Graphite on Hover (a disabled action) | 5.76:1 | Text |
| Field edge on Pure Paper | 3.78:1 | UI only |
| Field edge on Studio Canvas | 3.37:1 | UI only |
| Warning on Warning surface (the notice icon) | 5.36:1 | UI only |
| Brand Coral on Studio Canvas | 3.42:1 | Graphics and UI only |
| Brand Coral on Pure Paper | 3.83:1 | Graphics and UI only |
| Brand Coral on Midnight Ink | 4.43:1 | Graphics and UI only |
| Deep Coral on Midnight Ink (button edge) | 3.16:1 | UI only |
| Pure Paper on Brand Coral | 3.83:1 | **Fails** normal text |

Rules that follow from these numbers:

- Never put normal-size text on Brand Coral.
  Use Deep Coral for any coral surface that carries a label.
- Brand Coral indicators are always paired with a second cue (bold text, position, `aria-current` or `aria-pressed`), so selection never depends on colour alone.
- Fine Rule is decorative (1.38:1 on Paper); an edge that identifies a control, such as a text field, uses Field edge instead.

## Typography

CreatorBrio uses two families, both self-hosted at build time, so the app works offline.

- **Instrument Sans** for the interface: navigation, headings, body and controls.
  Its width axis gives the condensed display type of headings.
- **Geist Mono** for technical values only: dimensions (`1080 × 1350`), aspect ratios, slide positions, colour values, timecodes, commands and codes.
  A count written in words, such as "5 slides", is part of a sentence and stays in Instrument Sans, and so do the scale labels on the timeline ruler, which are an axis rather than values to read.

Do not add families for the interface or the logo.

### Hierarchy

A screen picks a role, never a size.
The roles are classes in `src/app/globals.css`.

| Role | Class | Size (phone / 640 px and up) | Setting |
|---|---|---|---|
| Home headline | `.type-hero` | 40 / 48 px | Instrument Sans 600, 75% width |
| Page title | `.type-title` | 28 / 32 px | Instrument Sans 600, 75% width |
| Section heading | `.type-section` | 20 / 24 px | Instrument Sans 600, 82% width |
| Body | (default) | 15 px, line height 1.55 | Instrument Sans 400 |
| Button | `.btn` | 14 px (13 px small) | Instrument Sans 600 |
| Technical metadata | `.meta` | 12 px | Geist Mono, tabular figures, narrowed word spaces |

There is one Home headline in the app, one page title per page, and no heading level is skipped.
Sizes are in pixels so the browser's zoom scales them; nothing disables zoom.
Weights in use are 400, 500 (navigation) and 600; avoid others.
Sentence case everywhere; no all-caps labels.

## Logo

The mark is a sheet of work inside four crop corners: the same crop marks the interface draws around selected work.
It says what CreatorBrio does (frames your work) and ties the identity to a real behaviour of the product.
The wordmark is "CreatorBrio" in Instrument Sans 600 at 82% width, the interface's own heading setting, outlined to paths in the files.

All files are in [assets/](assets/); regenerate them with `scripts/brand/make-logo.py` (instructions in that file).

| Asset | Files | Use |
|---|---|---|
| Primary horizontal logo | `creatorbrio-logo.svg` | Default on light backgrounds |
| Compact lockup (stacked) | `creatorbrio-logo-compact.svg` | Square spaces: avatars, profile images, splash screens |
| Mark | `creatorbrio-mark.svg` | Where the name is already present, at 24 px and larger |
| Application icon | `creatorbrio-app-icon.svg`, `creatorbrio-app-icon-512.png` | Home screens and docks; full-bleed square, platforms round it |
| Favicon | `creatorbrio-favicon.svg` | Browser tabs, 16 to 32 px; switches to a paper sheet in a dark browser theme |
| Dark-background variants | `*-dark.svg` | On Midnight Ink or dark photography: paper sheet and wordmark, coral corners |
| Monochrome variants | `*-mono.svg`, `*-mono-white.svg` | One-colour printing, embossing, watermarks, coloured backgrounds |

In the app the favicon, `icon.svg` and `apple-icon.png` live in `src/app/` (Next.js links them on every page), the sidebar draws the mark with the `Logo` component, and the wordmark next to it is live text in the same setting as the files.

### Construction and clear space

- The mark is drawn on a 30-unit grid: a 16 × 20 sheet with a 1.5-unit corner radius, inside corners 2 units thick with 5-unit arms, 2 units from the sheet.
- In the horizontal logo the wordmark's cap height is 13 units, centred on the sheet, 9 units from the mark.
- **Clear space** on every side is one crop-corner arm (5 units at 30-unit scale, or one sixth of the mark's height).
- **Minimum sizes:** the horizontal logo 96 px wide, the compact lockup 48 px tall, the mark 24 px.
  Below 24 px use the favicon drawing, whose corners are redrawn for the pixel grid.

### Correct use

- Use the files as they are, on Canvas, Paper, Ink or a calm photograph.
- Use the dark variant on dark backgrounds and a monochrome variant on any coloured background, including coral.
- Keep the corners coral in colour versions; the coral corners are the recognisable signature.

### Incorrect use

- Do not recolour the sheet coral, the corners ink in a colour version, or the wordmark coral.
- Do not stretch, rotate, outline, add shadows or gradients, or set the wordmark in another typeface.
- Do not put the colour logo on Brand Coral or on busy imagery where the corners disappear.
- Do not rebuild the mark from social platform logos or use platform iconography in the logo.

## Iconography

Interface icons come from the Lucide set already in the app, at 16 to 20 px with a 1.75 to 2 px stroke.
In the sidebar the current page's icon turns Brand Coral; on a phone the coral bar above the current tab does that job.
Icons accompany a label, or carry an accessible name when they stand alone.
Never use social platform logos as interface icons; name the platform in words.
The crop corners are reserved for the logo and for selection.

## Spacing, radius and elevation

- Spacing follows a 4 px base; the common steps are 8, 12, 16, 24, 32 and 48 px.
  Screens keep a 16 px side gutter on phones.
- Three radii, by material: **paper** 2 px for work (slides, previews), **control** 8 px for buttons and fields, **sheet** 14 px for panels and dialogs.
- Only work casts a shadow (`.paper`).
  Panels are flat sheets with a Fine Rule edge; dialogs and toasts float with one soft ink shadow.

## Motion

Motion answers something the person did, or marks the one orchestrated moment.

- The one orchestrated moment is Home's formats settling onto their baseline.
- Dialogs, menus and toasts open in 140 to 220 ms with a strong ease-out (`--ease-out-strong`); closing is faster than opening.
- Buttons press to 97% scale; crop marks tighten when something becomes selected.
- No looping or decorative motion in the workspace.
  Reduced-motion settings shorten or remove every animation.

## Buttons and component hierarchy

| Level | Class / variant | Look | Use |
|---|---|---|---|
| Create | `.btn-create`, `variant="create"` | Deep Coral fill, paper label | The one action on a screen that starts new work: New project, Set up project, Start a project, New brand, Create brand, Create and open editor, the Studio's Create |
| Primary | `.btn-primary`, `variant="accent"` or default | Ink fill, paper label | The main action that is not creation: Save, Export, Use for new work, a dialog's confirm |
| Secondary | `.btn-quiet`, `variant="outline"` | Paper with a Fine Rule edge | Cancel, Edit brand, Use template |
| Tertiary | `.btn-ghost`, `variant="ghost"` | Text only, Canvas-grey hover | Toolbar actions, close buttons |
| Destructive | `.btn-danger`, `variant="destructive"` | Alert outline on Paper, Alert label | Delete, Stop generating |

- A screen has at most one Create button in its content (the shell's New project is always present and does not count against it).
- Destructive actions are outlined so they can never be mistaken for the filled Create action next to them.
- An action that deletes something asks for confirmation in a dialog whose cancel is the safe default.
  Stop generating acts at once, because it deletes nothing: the slides made so far are kept.
- A disabled Create or Primary button turns flat grey with a Graphite label; it does not fade.
- Focus is a 2 px Ink outline offset by 2 px, white on ink surfaces.

## Light and dark editing surfaces

The application is one light theme: Canvas and Paper.
A dark surface is used only where the content needs it:

- The Video Studio's preview stage stays dark (Midnight Ink to near black) so footage is judged against a neutral, theatre-like ground.
- The Home Video Studio illustration, toasts, code blocks and the New project summary bar are Ink.

Around a dark surface the controls, type, buttons and dialogs are still CreatorBrio's: Instrument Sans, ink or paper controls, coral only for selection and creation.
A full dark theme is not part of v1.0.

## Illustration and creative previews

- The best illustration of CreatorBrio is the person's own work drawn at its true shape: a carousel fans sideways, a document stacks downwards, a Reel cover is one sheet.
- When there is no work yet, previews are samples drawn in the selected brand's own colours and fonts, never in CreatorBrio's.
- CreatorBrio's own drawings (such as the Video Studio card) use only the palette: Ink grounds, Paper shapes, one Brand Coral detail.
- No stock illustration, 3D blobs, gradients as decoration, or AI-generated mascots.

## Writing and tone

- Plain, specific and calm.
  Say what happens: "Create and open editor", not "Let's go".
- Sentence case, active voice, no exclamation marks, no filler.
- Name things the way people think of them: brand, project, template, slide, production.
- Be honest about limits: Early features are labelled, unbuilt features are not offered, and nothing is designed until the person presses Send.
- Errors say what happened and what to do next, and that nothing was lost when that is true.
  They never apologise vaguely or blame the person.
- An empty screen is an invitation to start, with one clear action.

## Marketing and social media

Marketing (website graphics, social posts, announcements, launch visuals and product demonstrations) uses the same palette, typefaces and mark with more volume.

- **Type:** headlines in Instrument Sans 600 at 75% width, set large (72 to 160 px on a 1080 px canvas), tight leading (0.95 to 1.0).
  Body copy in Instrument Sans 400.
  Geist Mono for specifications such as `1080 × 1350` and `4:5`.
- **Colour:** Canvas, Paper or Ink grounds; Brand Coral may be used generously as large shapes, crop marks and full-bleed fields, with white text only at large-text sizes (24 px and larger, or 18.66 px bold) and Ink text otherwise.
  Deep Coral for buttons and calls to action.
  Soft Blush for calm backgrounds.
- **Composition:** show real work at its true proportions, framed by oversized crop marks.
  One idea per visual.
  Left-aligned type on a clear grid; generous margins (at least 80 px on a 1080 px canvas).
- **Product demonstrations:** real screens from the app with synthetic, clearly fictional brands; never a person's real work or data without permission.
  Crop to the area that matters and frame it with crop marks rather than device mockups.
- **Social formats:** 1080 × 1350 (4:5) for feed posts and carousels, 1080 × 1920 (9:16) for stories and Reels, 1200 × 627 for link previews.
  The mark sits in a corner with its clear space; the horizontal logo closes a carousel.
- **Avoid:** platform logos in compositions, competing accent colours, gradients and glows, stock photography of laptops, and claims the product cannot back up.

## Product brand and user brands

CreatorBrio has its own identity.
The people who use it create their own brand identities inside it.
The two systems are independent, and this boundary is a product promise.

What belongs to CreatorBrio: the interface, its chrome, the logo and icons, marketing, and the documentation.
What belongs to the person: their brands (names, colours, fonts, logos, style keywords), their slides, their projects, their productions, and every export.

Rules:

- CreatorBrio's palette and fonts never appear in a person's slides, previews, exports or videos, and never in the Design Agent's instructions.
  The frozen Design Agent prompt is not changed for branding.
- A person's brand colours and fonts appear only inside their work and inside brand samples (the brand panel, brand cards, format previews).
  They never colour the interface.
- No stored brand, project, template or production is rewritten when CreatorBrio's identity changes.
- The default brand that setup creates for a new install happens to use a coral accent; it is the person's starting point, editable like any other brand, and not CreatorBrio's palette.
- Exports never contain a CreatorBrio watermark or logo.

`tests/brand-identity.test.ts` checks this boundary with three deliberately clashing synthetic brands, and the brand identity release compared PNG and PDF exports from before and after the change.

## Do and don't

| Do | Don't |
|---|---|
| Use Deep Coral for the one action that starts new work | Make every button coral, or Save and Export coral |
| Mark selection with Brand Coral lines and icons | Fill a button or badge with Brand Coral under white text |
| Keep panels Paper and the background Canvas | Tint panels, sidebars or menus Soft Blush |
| Use Soft Blush for an empty state that invites creation | Use Soft Blush as a hover colour |
| Put the colour logo on Canvas, Paper or Ink | Put the colour logo on Brand Coral |
| Set dimensions, ratios and timecodes in Geist Mono | Set sentences, names or relative times in Geist Mono |
| Pick a type role (`.type-title`) | Pick a pixel size for a heading |
| Draw samples in the person's brand | Draw samples or exports in CreatorBrio's colours |
| Use an Alert outline for Delete | Use a filled red button next to a Deep Coral one |

## Where it lives in the code

- `src/app/globals.css`: the `--brand-*` palette (declared once), the theme tokens that point at it, the type roles, `.meta`, and the button classes.
- `src/lib/brand-identity.ts`: the palette for code that cannot read CSS, such as the browser theme colour.
- `src/components/app/Logo.tsx`: the mark in the interface, drawn with the tokens.
- `src/components/ui/button.tsx`: the `create` and `destructive` variants for the editor and Studio.
- `src/app/favicon.ico`, `src/app/icon.svg`, `src/app/apple-icon.png`: browser and device icons.
- `docs/brand/assets/`: the logo system; `docs/brand/specimen.html`: the visual reference.
- `tests/brand-identity.test.ts`: palette drift, contrast, action hierarchy, icons and the user-brand boundary.

New screens inherit the identity by using the existing classes and tokens; a component never needs a hex value.

## Changing this guide

The identity changes only with the founder's approval, through a GitHub issue.
A change updates this guide, the tokens, the specimen and the test together, and bumps the version at the top.
