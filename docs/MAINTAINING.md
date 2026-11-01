# Maintaining CreatorBrio

This document describes how CreatorBrio is developed, reviewed, and released.

## Canonical repository

The canonical repository is https://github.com/mk-global/creatorbrio.
All development, Issues, pull requests, and releases happen there.

A clone needs only one remote:

```bash
git remote -v
# origin  https://github.com/mk-global/creatorbrio.git (fetch)
# origin  https://github.com/mk-global/creatorbrio.git (push)
```

CreatorBrio does not keep an `upstream` remote and does not routinely synchronize with any other repository.
Where the code came from is recorded in [`PROVENANCE.md`](./PROVENANCE.md), not in remote configuration.

### The rename from `mk-global/framewoven`

The repository was named `mk-global/framewoven` until 2026-10-31, when it was renamed to `mk-global/creatorbrio` under EngineeringToolsMK #294, after the CreatorBrio rebrand (#29) merged.
The repository's ID did not change, so the GitHub App installation and ruleset `25942669` carried over unchanged.
GitHub redirects the old name, but nothing may rely on that redirect: the `mk-github` broker refuses a checkout whose `origin` still names `mk-global/framewoven`, so point every clone at the new name with `git remote set-url origin https://github.com/mk-global/creatorbrio.git`.

The cutover ran as one window, recorded in the CreatorBrio rename window of EngineeringToolsMK's `tools/mk-github/broker/README.md`, which is its single source.
The two names were never configured together, because the broker's `doctor --live` and the independent reviewer's `doctor` both fail on a two-name configuration.

These keep the former name on purpose:

- the provisioned image-service token at `~/.config/framewoven/image-service.token`, which moves only in a founder-coordinated migration together with the path in `src/lib/image-service.ts`;
- local checkout directories named `framewoven`, which running local servers use as their working directory;
- the dashboard's browser-storage key for the selected brand (renaming resets every saved selection) and the server's generation-status registry key (renaming loses generations in progress in a server that reloads), permanently, because nobody sees them;
- the `framewoven*.log` ignore pattern, which still matches logs written before the rename;
- the changelog and `PROVENANCE.md`, which keep the name used at the time.

## No ticket, no work

Every material product or engineering change starts as a GitHub Issue and lands through a pull request that references it, normally with `Closes #N`.
Every change that reaches a protected PR must close at least one OPEN, admitted issue. Do not exempt documentation or administrative changes from the reviewer scope gate.

## Ticket and PR admission — public repository

CreatorBrio is an explicit public-repository exception in EngineeringToolsMK's `tools/repo-onboarding/inventory.json` (decision #234). CI uses GitHub-hosted runners. **Do not** add private self-hosted governance workflows, admit this repository to the private runner group, or run ordinary `onboard.py onboard/verify` against it. EngineeringToolsMK's organisation `onboard.py audit` verifies this exception.

The canonical policy lives in private `mk-global/EngineeringToolsMK/tools/github-policy/validate.py` (`github-policy/v2.0.0`). Every linked engineering issue must be OPEN and contain non-empty Markdown sections with exactly these headings:

- `Problem`
- `Desired Outcome`
- `Scope`
- `Out of Scope`
- `Acceptance Criteria` (at least one Markdown list item)
- `Verification`
- `Dependencies / Blockers`
- `Risks / Constraints`

Every PR description must contain `GitHub Issue` (with `Closes #N`), `Objective`, `Scope`, `Acceptance Criteria` (list item required), `Verification Evidence`, `Risk Assessment`, `Rollback`, and `Decisions / Deviations`. The templates under `.github/` provide **advisory** scaffolds; replace the HTML-comment instructions with actual content. GitHub API and cloud agents can bypass templates.

Before publishing tickets or PRs, run the **canonical installed** validator (do not copy its rules into this repo):

```bash
# Run from the EngineeringToolsMK checkout, with GitHub access:
gh issue view N --repo mk-global/creatorbrio --json body --jq .body | python3 tools/github-policy/validate.py ticket -
gh issue view N --repo mk-global/creatorbrio --json state,body | python3 tools/github-policy/validate.py linked-ticket -
gh pr view N --repo mk-global/creatorbrio --json body --jq .body | python3 tools/github-policy/validate.py pr -
```

For draft bodies not yet published, save the proposed Markdown to a temporary file and run `python3 tools/github-policy/validate.py ticket /path/to/draft.md` (or `pr` for a PR). Check **every** linked issue before opening a PR. These commands are author-side checks, not hard enforcement.

**Actual merge enforcement:** the independent reviewer checks open linked tickets against the canonical policy (`scope: required`), and branch protection requires `local-ai/pr-review/main` pinned to reviewer GitHub App 4577329 with strict freshness. An invalid ticket can cause the reviewer to skip a PR **without publishing any status**. If the reviewer check is absent, validate the linked issues first; then check review queue/service if the issues are valid. Do not invoke manual rereviews as a substitute for ticket admission.

**Reviewer infrastructure failures are different from ticket refusal.** A PR-scoped status such as `local-ai/pr-review/pr-<number>` with `containment_unverified` means the reviewer could not verify its own sandbox/tools and refused to run; this is **not** a code-review verdict. Do not modify application code, fake a PASS, or relax the required branch context to address it. Restore the reviewer through its EngineeringToolsMK operator procedure and verify doctor/isolation. A PR whose infrastructure failures exhausted its retry limit may require a new **substantive** head commit to trigger another review: first check the installed reviewer's supported recovery behavior and preserve the ticket/review requirements.

Creation pathways differ: GitHub web UI uses the advisory templates; browser/cloud Claude or API clients must validate explicitly; local `mk-agent` uses the approved `mk-github` broker and should also validate before publication. Enforcement at client write-time and an explanatory non-authoritative reviewer status are tracked under CreatorBrio #24 and require separate reviewed EngineeringToolsMK changes. They are **not** yet active, and this documentation does not implement them.

## Branches

Work happens on a short-lived branch cut from `main`, named `<type>/<short-description>`.
The types match the conventional commit prefixes: `feat`, `fix`, `docs`, `test`, `chore`.
For example: `fix/export-timeout`, `docs/install-steps`, `chore/release-v0.1.4`.

`main` is protected.
It cannot be deleted or force-pushed, and it changes only through a pull request whose required checks have passed at its current head.

## Pull requests

1. Open the pull request against `main` and reference its Issue with `Closes #N`.
2. Use the canonical PR template. Describe objective, scope, acceptance criteria, verification evidence, risks, rollback, and decisions/deviations. The `GitHub Issue` section must include a closing reference.
3. Two checks are required at the pull request's exact head: `typecheck / lint / test / build` from GitHub Actions, and `local-ai/pr-review/main` from the pinned independent reviewer App.
   No approving review is required, and nobody can bypass the rules.
4. Freshness is strict: a pull request must be up to date with `main` before it merges.
   When `main` moves, update the branch; the new head needs both checks again, including a fresh independent review.
5. Merge by squash only, with a conventional title that becomes the commit subject on `main`, for example `fix: surface export failures (#12)`.
   The usual path is GitHub's native auto-merge, armed with the squash method as soon as the pull request is open, so GitHub merges it only when every rule above is satisfied.
   A maintainer may still merge by hand under the same rules, never by bypassing them.

The repository is certified for auto-merge under EngineeringToolsMK #256.
A red, missing or stale check holds an armed pull request; it is never a reason to merge another way.

## Tests

Run the full gate before opening a pull request:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

CI runs the same four steps on every pull request and on every push to `main`.

Every behavior change needs automated coverage proportional to its risk.
Every bug fix needs a regression test that fails on the old behavior and passes after the fix.
Do not disable or weaken existing tests to make a change pass.

## Changelog and release notes

Pull requests never edit [`CHANGELOG.md`](../CHANGELOG.md), and nobody edits it by hand.
It remains the historical record of the releases it already describes.

What changed in a release is recorded in that release's notes, which GitHub generates from the squash-merged pull request titles since the previous tag.
A pull request's title is therefore written for the people who use CreatorBrio: a conventional prefix and what changed for them, for example `fix: surface export failures`.

## Releases

CreatorBrio uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html) and continues the version line inherited from the maintained fork.
Historical tags are never moved or deleted.

1. Open an Issue for the release and a `chore/release-vX.Y.Z` branch.
2. Bump the version with `npm version X.Y.Z --no-git-tag-version`, which updates `package.json` and `package-lock.json` together.
3. Merge the release pull request under the rules in [Pull requests](#pull-requests).
4. Create an annotated tag on the merge commit and push it:

   ```bash
   git switch main && git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z - <summary>"
   git push origin vX.Y.Z
   ```

5. Create the release as a draft with GitHub-generated notes:

   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z - <summary>" --generate-notes --draft --verify-tag
   ```

6. Review the generated notes, correct anything a reader would misunderstand in the release's description on GitHub, and publish it:

   ```bash
   gh release edit vX.Y.Z --draft=false
   ```

## Source provenance

`LICENSE` and its copyright notice are carried over from the original project and must not be removed or altered.
[`PROVENANCE.md`](./PROVENANCE.md) is the record of where the code came from and must stay accurate.

Changes from the original Open Carrusel project, or from any other source, are never imported automatically.
If one is worth considering, open an Issue that links the specific change, review it on its own merits including any license or notice implications, and adopt it through a normal pull request.
Record anything adopted this way in the pull request that adopts it, which carries it into the release notes, and, where it affects origin or attribution, in `PROVENANCE.md`.

## Roadmap

CreatorBrio owns its roadmap.
Planned capabilities are listed in the README and get a tracked Issue when work on them is scheduled.
They are described as shipped only after they are released.
