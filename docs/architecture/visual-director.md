# Visual Director

This document describes the Visual Director: the part of CreatorBrio that decides the visual strategy for a request before any slide is designed.
It is written for contributors and describes only what is merged.

## Status

| Part | Status |
|---|---|
| Director invocation, plan schema and server-side plan validation | Implemented as a library (`src/lib/visual-director.ts`, `src/lib/director-plan.ts`); no chat request calls it yet |
| Creative Brief: types, validation, merge rules and storage on the carousel | Implemented (`src/lib/creative-brief.ts`); written by chat requests once orchestration lands |
| Capability table | Implemented (`src/lib/creative-capabilities.ts`) |
| Intelligence evaluation suite | Implemented as a separate, opt-in harness (`eval/director/`) |
| Running the Director inside a chat request, the image stage and the Design Agent handoff | Planned; tracked in issue #40 |
| Editing uploaded images | Not available; a plan that needs it is refused with a clear message |

## Why there is a Director

CreatorBrio's Design Agent is a capable designer.
It writes the copy, chooses the layout and typography and builds each slide in HTML and CSS.
What it does not do on its own is step back and ask what the content is for before it starts composing.
Left alone, it either uses no imagery or treats imagery as decoration.

The Visual Director answers that earlier question.
It reads the request, the brand, the carousel's history and the user's images, and decides which treatment will communicate best: typography alone, designed CSS visuals, the user's own images, or a newly generated image.
It is a creative director, not an image router.
A plan with no images at all is often its best answer.

## Responsibilities

The split is deliberate and enforced by the code that carries a plan out.

| The Director decides | The Design Agent decides |
|---|---|
| What the request is trying to accomplish, for whom, and what they should understand, feel or do | All copy and wording |
| The central message and its priorities | Layout, composition and hierarchy |
| The creative direction and treatment strategy | Typography and colour within the brand |
| Which slides need imagery, of what kind, and why | How an image is cropped, framed and combined with text |
| Each reference image's role: placed as content, or followed as style | The slide HTML and CSS itself |
| Which images to generate or reuse, and the brief for each | Everything the plan does not bind |
| The slide count, under fixed precedence rules | |

The Design Agent's system prompt is frozen and does not mention the Director.
Once orchestration lands (issue #40), the Director's guidance will reach it only as task-specific instructions in the message for that request.
A test pins the Design Agent's prompt to a recorded baseline so this boundary cannot erode silently.

## How the Director reasons

Before it chooses any capability, the Director works through five questions in order:

1. What is the user trying to accomplish?
2. Who is it for?
3. What must that audience understand, feel or do?
4. Which treatment communicates that best?
5. What would show, by looking at the finished slides, that they serve the objective?

Content types such as educational, technical explanation, founder storytelling, thought leadership, brand awareness, engagement, promotion and data-driven content are lenses, not routes.
A technical explanation usually reads best as diagrams and type, and an emotional founder story often benefits from a real photograph, but nothing in the code maps a category to a treatment.

The Director separates what the user said from what it inferred.
Every brief value and constraint carries a provenance, `explicit` or `inferred`, and the plan lists its main inferences as assumptions.
It is instructed never to invent audience research, statistics, performance predictions or user preferences.
When requirements conflict, the more recent explicit one wins, the rest are kept, and the choice is recorded in the plan's reasoning.

The Director's instructions live in `src/lib/director-instructions.ts`.

## The Creative Brief and continuity

Each carousel stores a small Creative Brief (`Carousel.creativeBrief`, typed in `src/types/creative-brief.ts`).
It records the objective, audience, central message, desired response and brand context, plus lists of constraints, visual decisions and what each reference image or asset is for.
Every entry has a provenance and a timestamp.

The brief is what lets "make it more dramatic" keep the original subject, audience and tone.
The Director reads the stored brief and proposes an update; the server validates the update and merges it under two rules:

- an `inferred` value never replaces or retires an `explicit` one;
- a newer `explicit` instruction replaces or retires an older value, and the Director must quote the retired item and give a reason.

Values a revision does not mention are kept.
Lists are bounded; when one overflows, explicit items are kept first and the oldest inferences go.

The brief is server-owned: update routes never accept it from a request body.
It belongs to one carousel, so it cannot cross to another carousel or brand.
Duplicating a carousel copies it, and the two copies then evolve independently.
Relationships to images the carousel no longer has are dropped before the Director sees the brief.

## Capabilities

The Director chooses among a small, fixed table of capabilities (`src/lib/creative-capabilities.ts`).
Each row says what the capability does, when it is useful, what it needs, what it produces, its limits and how it fails.

| Capability | Available when |
|---|---|
| Design composition (the Design Agent) | Always |
| Placing an uploaded reference image on a slide | The carousel has reference images |
| Following an uploaded reference image as a style source | The carousel has reference images |
| Generating a new image | Image generation is set up on this machine |
| Reusing an image this carousel generated earlier | The carousel has an intact earlier asset |
| Editing an uploaded image | Not available yet |

Availability is computed from local facts only, without a network call, so the same carousel always gets the same description.
Whether the image service is actually running is discovered only when an image is requested.

Image generation needs a separate local image service that is not part of this repository.
Without it, every other capability still works, and the Director plans typography, CSS visuals and the user's own images.

## The plan

The Director returns one structured plan with two parts of different authority.

`strategy` is advisory.
It holds the objective, audience, intended response, central message, content type, priorities, creative direction, treatment strategy, the reasoning behind important choices, success criteria and assumptions.
Code never acts on it; it is bounded, passed to the Design Agent as guidance and kept for evaluation.

`execution` is binding.
It holds the request type, the slide count and its basis, each slide's visual intent and treatment, which images each slide places, which references it follows as style, and the image tasks with their briefs.
Code acts on it, so the server validates every part against what it knows about the carousel (`validatePlan` in `src/lib/director-plan.ts`).
Plan asset keys must look like `a1`, and every placed image must be a plan asset or a reference image of this carousel.
No model-provided path, URL, command or file name is ever used.
There is no partial acceptance and no repair: a plan is used whole or refused.

A plan that needs a capability the machine lacks, for example editing the user's photograph, is refused with a message naming that capability, rather than silently replaced by something else.
A plan that is malformed in any other way is refused with a generic message, and its violations go to the server log only.

When a request depends on a page or document the Director was not given, such as "summarize my latest post" with no text or link, it returns `source-required` and asks the user to paste the text or share a public link.

### Slide count

The Director never picks a slide count of its own.
The first applicable rule wins, and the plan records which one it used:

1. A new request that states a count uses it (`user-explicit`).
2. A revision keeps its current count (`existing`), unless the user asks to add or remove slides (`user-change`).
3. A new request for a cover is one slide (`single-cover`).
4. Any other new request uses the Design Agent's own default arc of eight slides (`baseline-default`).

At most five images are generated per request, and never more than the slide count.

## Isolation and budget

The Director runs as its own Claude CLI invocation, separate from the Design Agent's session.

Director tools: `Read`

- `Read` is limited to a fresh temporary working directory outside the repository, holding neutral copies of the carousel's reference images and intact assets (`reference-1.png`, `asset-1.png`); a read anywhere else is denied.
- No user or project settings, no MCP servers and no automatic memory are loaded.
- No session is written or resumed, so the Director cannot touch the Design Agent's conversation.
- Its input arrives on standard input, never in the process arguments.
- Each run has its own limits: $0.25 and 120 seconds.

These are the CLI's permission rules, a policy boundary rather than operating-system isolation: the CLI runs as the same account as the app.

Every outcome is typed (`runDirector` in `src/lib/visual-director.ts`): planned, start failure, timeout, cancellation, budget exceeded, agent failure, no output, invalid plan, or a missing capability.
There is no automatic re-plan.
The server log records counts and outcome codes only, never the message, page text or plan text.

## Evaluation

Valid JSON is not success.
The intelligence evaluation in `eval/director/` runs the real Director against synthetic scenarios and scores whether its plans are good creative direction, not just well formed.
Its rubric and acceptance thresholds are in `eval/director/RUBRIC.md` and were committed before the scored run.
The scored results are summarised in `eval/director/REPORT.md`.

The suite is opt-in and costs real model usage, so it is not part of `npm test`.
It runs with `npx vitest run --config vitest.eval.config.ts`, and writes raw results to `eval/results/`, which is not committed.

## Adding a capability

A new capability, such as motion, is added in three places:

1. A row in the capability table, with an honest availability rule.
2. A plan operation or treatment that `validatePlan` accepts, with its own shape checks.
3. An executor in the creative run that carries the operation out and records its result.

The Director's reasoning responsibilities do not change, and the Design Agent's prompt is not touched.
