# Provenance

This document records where Framewoven's source code comes from, under what license it is distributed, and how its history relates to the projects it was derived from.

The product was named Framewoven until 2026-10-30, when it was renamed CreatorBrio (#29).
This document keeps the name the product had when each recorded event happened.

## Summary

Framewoven is an independently maintained product.
It is a derivative of [Open Carrusel](https://github.com/Hainrixz/open-carrusel), an MIT-licensed project, by way of a maintained fork of that project.
Framewoven does not claim authorship of the original implementation.

| | Repository | Role |
|---|---|---|
| Original project | https://github.com/Hainrixz/open-carrusel | Source of the original implementation |
| Maintained fork | https://github.com/manishkumarglobal/open-carrusel | Reliability and correctness fixes, releases `v0.1.1` and `v0.1.2` |
| Framewoven | https://github.com/manishkumarglobal/framewoven | Canonical repository from 2026-10-27 onward |

## Source baseline

Framewoven's history begins from the maintained fork at commit `0fda76c0c82af563eada04bd1ea6c140ced72890` (`chore: release v0.1.2 (#16)`), which is the commit tagged `v0.1.2`.

The Git history was imported unchanged.
Every commit keeps its original SHA, author, and date, and the historical tags `v0.1.1` and `v0.1.2` point at the same tag objects and commits as in the fork.
No history was squashed, rewritten, or re-authored.

## License

Framewoven is distributed under the MIT License in [`LICENSE`](../LICENSE).
That file is carried over unchanged from the original project, including its copyright notice:

```
Copyright (c) 2026 Open Carrusel Contributors
```

The MIT License requires that the copyright notice and permission notice be included in all copies or substantial portions of the Software.
`LICENSE` must therefore stay in the repository with that notice intact, and it must accompany any redistribution.
Framewoven adds no licensing terms beyond the MIT License.

## Attribution

The original Open Carrusel implementation was created in the [Hainrixz/open-carrusel](https://github.com/Hainrixz/open-carrusel) repository.
At the source baseline, the original project's README credits [tododeia](https://www.tododeia.com) as its maker and Enrique Rocha ([@soyenriquerocha](https://www.instagram.com/soyenriquerocha)) as tododeia's founder.
The original commits are authored in Git as Enrique Henry.

The original project's README also acknowledges the people and projects whose work shaped it:

- [Emil Kowalski](https://emilkowal.ski), whose animation philosophy the `oc-*` CSS motion utilities in `src/app/globals.css` encode.
- [Anthropic](https://www.anthropic.com), for Claude and Claude Code, which power the design agent.
- [Vercel](https://vercel.com), for Next.js and Turbopack.
- [Radix UI](https://www.radix-ui.com) and [shadcn/ui](https://ui.shadcn.com), for the patterns underneath the dialog, button, and input primitives.
- [dnd-kit](https://dndkit.com), for drag and drop.
- [Puppeteer](https://pptr.dev) and [Sharp](https://sharp.pixelplumbing.com), for the export pipeline.

The UI primitives in `src/components/ui/` and the `cn()` helper in `src/lib/utils.ts` follow the shadcn/ui component patterns, which shadcn/ui publishes under the MIT License for copying into projects.
Third-party dependencies are installed from npm and are distributed under their own licenses, as recorded in `package-lock.json`.

## Who wrote what

The imported history separates cleanly into three stages.

| Stage | Commits | Author in Git |
|---|---|---|
| Original Open Carrusel | `633bb60` through `8ba717b` (2026-04-12 to 2026-04-15) | Enrique Henry |
| Maintained fork | `c06ed82` through `0fda76c` (2026-09-01 to 2026-09-02) | Manish Kumar |
| Framewoven | Everything after `0fda76c` | See `git log` |

To list only the original project's commits, run `git log 8ba717b`.
To list everything added after the original project, run `git log 8ba717b..main`.

## Historical records

The maintained fork's Issues, pull requests, and releases remain on the fork and are not recreated here.

- Issues: https://github.com/manishkumarglobal/open-carrusel/issues?q=is%3Aissue
- Pull requests: https://github.com/manishkumarglobal/open-carrusel/pulls?q=is%3Apr
- Release `v0.1.1`: https://github.com/manishkumarglobal/open-carrusel/releases/tag/v0.1.1
- Release `v0.1.2`: https://github.com/manishkumarglobal/open-carrusel/releases/tag/v0.1.2

Every `(#N)` in a commit subject at or before `0fda76c`, that is `(#1)`, `(#7)` through `(#11)`, and `(#14)` through `(#16)`, refers to a pull request in the maintained fork, not to an Issue or pull request in this repository.
In particular, `(#1)` in `7d8bbdd` is the fork's pull request #1, not Framewoven's Issue #1.
GitHub may still render these as links to this repository's numbering, so follow the fork links above instead.

## Changes outside the baseline

The original repository's `main` branch continued after the fork point, `8ba717b`.
For example, commit `27ea3cd` on 2026-10-25 adds copyright, notice, and credit material.
Commits made upstream after `8ba717b` are not part of Framewoven and have not been imported.

Framewoven does not track the original project.
Any upstream change considered in the future is reviewed on its own merits, including its license and notice implications, and adopted only through a tracked Issue and pull request.
See [`MAINTAINING.md`](./MAINTAINING.md).

## Independent maintenance

From 2026-10-27, Framewoven is developed, versioned, and released independently in https://github.com/manishkumarglobal/framewoven.
The maintained fork is retained as a historical reference.
The canonical repository later moved to https://github.com/mk-global/framewoven, and on 2026-10-31 it was renamed to https://github.com/mk-global/creatorbrio; [`MAINTAINING.md`](./MAINTAINING.md) records its current location.
