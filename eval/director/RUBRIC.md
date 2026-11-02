# Visual Director evaluation rubric

This rubric was written and committed before any scored run of the suite in `eval/director/`.
Thresholds are fixed here so that results are judged against a bar set in advance, not one chosen after seeing the numbers.
Changing a threshold or an anchor after a scored run requires a note in the run report explaining why.

## What is evaluated

The suite measures the Visual Director's planning judgment: whether its plan understands the request and gives the Design Agent a useful, honest visual strategy.
It does not evaluate finished slides, image quality or the Design Agent.
Those belong to the end-to-end acceptance harness of the orchestration work.

Each scenario is a synthetic carousel (brand, aspect ratio, optional existing slides, reference images, stored Creative Brief and linked page text) plus one user message.
The real Director runs once per trial, with the same isolation flags and budget as the product.
Every trial produces two independent signals: deterministic checks computed from the plan, and scores from an LLM judge that never sees the deterministic results.

## Deterministic checks

These are computed by code and are pass or fail per trial.

1. Outcome: the Director's result is one of the outcomes the scenario accepts.
   Most scenarios accept only a valid "ready" plan.
   Source-dependent scenarios accept only "source-required".
   The editing scenario accepts either a plan refused because editing is unavailable, or a ready plan that does not pretend to edit.
2. Slide-count basis: when the scenario names an expected basis, the plan uses it.
3. Image use: the number of generated images is inside the scenario's band (minimum and maximum).
4. Reference roles: each reference the scenario names is used in the expected role (placed as content, or followed as a style source) on at least one slide, and never in the other role.
5. Constraint retention: each keyword the scenario marks as must-keep appears in the plan's strategy or brief update, and is never retired.
   A revision is not required to restate an inherited constraint in its brief update, because the brief update holds only what changes.
6. No fabricated evidence: the strategy contains no invented statistics, engagement or performance predictions, or claimed audience research.
   This is a pattern check (percentages, "studies show", "will increase engagement" and similar) and is backed by the judge's own flag.

A trial counts as a deterministic pass when every applicable check passes.

## Judged dimensions

The judge scores each dimension from 1 to 5, or marks it not applicable.
Anchors describe the minimum for each score; intermediate plans take the lower score.

### 1. Intent comprehension

- 5: The objective names what the user is actually trying to achieve, including the implied purpose, and every later choice follows from it.
- 4: The objective is correct and specific; one minor nuance is missed.
- 3: The objective is broadly right but generic ("educate the audience") and does not shape the plan.
- 2: The objective misreads part of the request.
- 1: The plan serves a different goal than the one requested.

### 2. Content accuracy and central message

- 5: The central message is faithful to the user's words and any supplied source, with no added claims.
- 4: Faithful, with a slight loss of emphasis.
- 3: Mostly faithful but blurs or simplifies the point.
- 2: Changes the point or adds unsupported claims.
- 1: Contradicts the request or the source, or invents content.

### 3. Audience alignment

- 5: The audience is stated or reasonably inferred and marked as an assumption, and tone and treatment fit it.
- 4: Audience is reasonable; fit is good with small gaps.
- 3: Audience is generic and does not influence the plan.
- 2: Audience is wrong for the content or presented as researched fact.
- 1: Audience is ignored or contradicts what the user said.

### 4. Visual-treatment judgment

- 5: The mix of typography, CSS visuals, user images and generated images is the one an experienced creative director would choose, and the reasoning says why.
- 4: A sound choice with one debatable slide.
- 3: Workable but default-feeling; imagery or typography is used without clear purpose.
- 2: The treatment works against the message (for example a photograph where a diagram is needed).
- 1: The treatment is arbitrary or contradicts explicit instructions.

### 5. Context continuity (revisions only)

- 5: The revision keeps the stored objective, audience, subject, explicit constraints and visual decisions, and changes only what the user asked.
- 4: Keeps everything important; one inferred detail drifts.
- 3: Keeps the subject but loses a stored constraint or decision.
- 2: Treats the revision largely as a new request.
- 1: Contradicts or retires an explicit earlier instruction without the user asking.

Not applicable for new requests.

### 6. Asset relevance

- 5: Every reference is used in the right role, reuse is preferred where it fits, and each generated image has a concrete, specific brief with a text-safe area and an "avoid" that matches the constraints.
- 4: Right roles and useful briefs, one brief slightly vague.
- 3: Roles are right but briefs are generic or stock-like.
- 2: A reference is ignored or misused, or briefs conflict with constraints.
- 1: Assets are irrelevant to the message.

Not applicable when the scenario has no references and the plan uses no images.

### 7. Appropriate non-use of image generation

- 5: Generated images appear only where a concrete scene, subject or atmosphere is needed and nothing the user supplied can carry it; the plan states why imagery was or was not used.
- 4: Correct decision; reasoning is thin.
- 3: One unnecessary generated image, or one missed opportunity the request clearly invited.
- 2: Imagery by default regardless of content, or generation ignored when explicitly requested.
- 1: Generation used against an explicit instruction, or required while unavailable.

### 8. Handoff quality

- 5: The creative direction, priorities, per-slide visual intent and success criteria would let a designer build the slides without guessing, and each success criterion can be checked by looking at the slides.
- 4: Useful and specific; one criterion is not checkable.
- 3: Usable but generic; several criteria are vague ("looks professional").
- 2: The Design Agent would have to re-derive the strategy.
- 1: The handoff is empty, contradictory or describes CSS instead of intent.

For a "source-required" outcome the judge scores only intent comprehension and handoff quality (whether the message to the user is clear and actionable) and marks the rest not applicable.

## Judge flags

Besides scores the judge reports two flags per trial:

- fabricatedClaims: the plan invents statistics, research, predictions or user preferences.
- ignoredConstraint: the plan ignores or contradicts an explicit user constraint.

Either flag on a trial is reported in the run summary with the judge's justification.

## Acceptance thresholds

The Director's planning quality is accepted when all of the following hold in one scored run of the full suite:

- Plan validity: at least 95% of trials end in an outcome the scenario accepts (deterministic check 1).
- Deterministic expectations: at least 90% of trials pass every applicable deterministic check.
- Judged quality: the mean of all applicable judged scores is at least 4.0.
- No weak dimension: every dimension's mean is at least 3.5.
- No weak scenario: no scenario's mean judged score (averaged over its trials) is below 3.0.
- Honesty: no trial is flagged for fabricated claims by both the pattern check and the judge.

A run that misses a threshold is reported as missing it, with the scenarios responsible.
The suite does not fail its own process on a threshold miss; it fails only on harness errors, so a partial result is never lost.

## Repeated trials and variance

The Director is nondeterministic.
About ten representative scenarios run three trials each; the rest run once.
For repeated scenarios the summary reports the spread (highest minus lowest mean judged score) and whether the deterministic outcome was the same in every trial.
A spread above 1.0, or a deterministic result that differs between trials, is reported as instability even when the mean passes.

## Uncertainty

An LLM judge is not ground truth.
It shares blind spots with the Director, may reward fluent text, and its scores drift between runs.
To limit this, the judge sees only the scenario, the plan and this rubric, never the deterministic results, and it is told not to reward a plan for being valid JSON.
The deterministic checks are narrow by design and cannot judge creative quality.
Thresholds are therefore evidence, not proof, and every run report states its sample size.

## Human spot-check

After each scored run a person reviews at least five trials: the two lowest-scoring, the two highest-scoring and one at random.
For each they record, in the run report, whether they agree with the judge's score per dimension (agree, higher, lower) and one sentence of reasoning.
Disagreement on more than a third of reviewed dimensions means the judged thresholds are not trusted for that run, and the report says so.
