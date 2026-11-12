# Design C: the CreatorBrio 2.0 interface

Design C is CreatorBrio's approved design and the single reference for its interface.
The founder approved it in [#174](https://github.com/mk-global/creatorbrio/issues/174), and [#175](https://github.com/mk-global/creatorbrio/issues/175) built it into the app.
How the screens are built and which module owns what is in [../architecture/app-shell.md](../architecture/app-shell.md); this page is the design language they follow.

## Where it came from

Three directions were prototyped for #172 with synthetic data.
Design A ([#173](https://github.com/mk-global/creatorbrio/pull/173), closed unmerged) had the structure: a sidebar, informative format cards, templates on Home, a detailed brand panel and a Video Studio panel.
Design B had the visual language: a light table for the work, ink for actions, coral crop marks for selection, condensed display type, and work drawn large at its true proportions.
Design C is A's structure in B's visual language.
The prototypes were throwaway code and are not kept in the repository; the issues and the closed pull request record the decision.

## Subject

A local-first studio where one person makes branded social posts with Claude: Instagram carousels, LinkedIn documents, Reel covers and, early, Reels.
Every screen's job is to get from an idea to finished, on-brand work, and the work itself is the most important thing on screen.

## Colour

The tokens are defined once, in `src/app/globals.css` (`@theme`), and the older token names used by the editor and the Studio are mapped onto them.

| Token | Value | Use |
|---|---|---|
| Ground | `#F1F2F4` | The cool light table the work lies on |
| Sheet | `#FFFFFF` | Panels and the active navigation item |
| Ink | `#1C1B29` | Text and every action |
| Graphite | `#585767` | Secondary text, 6.5:1 on ground |
| Rule | `#D9DBE1` | Dividers and outlines |
| Field | `#80838F` | Edges of inputs, 3.37:1 on ground |
| Crop | `#E94560` | CreatorBrio's coral, used only for the mark and the crop marks around selected work |
| Early | `#6B4300` on `#FCEBC4` | The Early label |
| Alert | `#A3243B` on `#FBE3E7` | Errors and destructive actions |

Brand colours appear only inside work and inside brand samples, never in the interface itself.

## Type

Instrument Sans for everything, self-hosted at build time, using its width axis.
Display headings are condensed (75% width), section headings 82%, and body text is normal width at 15 px.
Geist Mono is kept for commands and codes.
Brand fonts appear only inside work and brand samples.

## Layout

- Content is left aligned on one column edge; nothing is centred except inside work.
- Navigation is a sidebar (248 px, or a 76 px rail) at 768 px and wider, and a header plus a five-tab bar on phones; each destination appears once at every width.
- Home's four formats stand in four equal columns on one baseline, so the row ends evenly.
- Recent work and templates share one column grid, so the rows line up; previews are sized from their column with container units, not from breakpoints.
- Every screen works without horizontal scrolling from 1440 px down to 320 px.

## Principles

1. **The work is the hero; chrome stays quiet.** Only work casts a shadow.
2. **Every structural device carries information.** The baseline means "these are formats", crop marks mean "selected", the Early tag means "not finished".
3. **One bold thing:** work drawn at its real shape. A carousel fans sideways because it swipes, a document stacks downwards because it pages, a Reel cover is one sheet. Everything else is disciplined.
4. **Honest availability.** Early is labelled, features that are not built are not offered, and Settings says what is and is not set up on this computer.
5. **Nothing happens behind the person's back.** Creating a project never starts a design; the words go into the message box, and the person presses Send.

## Screenshots

The README shows Home and the editor as they are in the app: [Home](../screenshots/dashboard.png) and [the editor](../screenshots/editor.png).
