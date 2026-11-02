# Visual Director evaluation report

This report records the scored run of the Visual Director evaluation suite against the rubric in [RUBRIC.md](RUBRIC.md).
The rubric and its thresholds were committed before this run and were not changed afterwards.

## The run

- Run: `2026-11-02T03-28-46-988Z`, on the Director as first implemented, before the fixes described below, using the real Claude CLI with the product's Director flags and budget.
- Scope: 36 synthetic scenarios, 56 trials; ten scenarios ran three times to measure variance.
- Judge: a separate Claude call per trial, read-only, which never saw the deterministic results; no judge call failed.
- Raw results (`trials.jsonl`, `results.json`, `summary.md`) are written to `eval/results/`, which is not committed.
- One change was made between the three-scenario smoke run and this run: the Director's instructions were clarified so that "reuse" applies only to earlier generated assets and an uploaded image is placed, not reused, because the smoke run showed the Director trying to "reuse" an upload.

## Thresholds

| Threshold | Bar | Result | Met |
| --- | --- | --- | --- |
| Plan validity | at least 95% | 94.6% (53 of 56) | No |
| Deterministic expectations | at least 90% | 91.1% (51 of 56) | Yes |
| Mean judged score | at least 4.0 | 4.42 | Yes, provisionally |
| Every dimension mean | at least 3.5 | lowest 4.04 (handoff quality) | Yes, provisionally |
| No scenario mean | below 3.0 | lowest 4.00 | Yes, provisionally |
| Fabrication flagged by both pattern check and judge | none | none | Yes |

The judged thresholds are provisional because the human spot-check the rubric requires has not been performed (see below).

## Judged dimensions

| Dimension | Mean | Scores given |
| --- | --- | --- |
| Intent comprehension | 4.47 | 25 fives, 28 fours |
| Content accuracy and central message | 4.27 | 16 fives, 33 fours, 2 threes |
| Audience alignment | 4.49 | 25 fives, 26 fours |
| Visual-treatment judgment | 4.33 | 18 fives, 32 fours, 1 three |
| Context continuity (revisions only) | 4.86 | 6 fives, 1 four |
| Asset relevance | 4.47 | 16 fives, 18 fours |
| Appropriate non-use of image generation | 4.82 | 42 fives, 9 fours |
| Handoff quality | 4.04 | 3 fives, 49 fours, 1 three |
| Overall | 4.42 | |

By category, the means range from 4.00 (generation unavailable, one trial) and 4.04 (ambiguous requests) to 4.71 (five-image) and 4.68 (revisions).

## What the plans show

Treatment choices followed the content rather than its category label:

- Technical and data scenarios (`tech-*`, `noimg-*`, `ref-poster-style`) used CSS diagrams and typography with no generated images in every trial.
- "Five photos" requests produced exactly five generated images, one per slide, in all three trials.
- An uploaded photo the user asked to feature was placed as content in every trial, and a poster uploaded "for its style" was followed as style and never placed.
- With image generation unavailable, the plan used CSS visuals and said the photos could not be made.
- Asked to "make it more dramatic" on a cover built around the user's own photo, all three trials kept the photo and moved the drama into crop, shadow and type weight, each reasoning that a generated image would dilute the user's own photograph.
- A linked page that contained an instruction to the planner (`source-injection-sleep`) was treated as material, not as an instruction.
- Asked to summarise "my latest LinkedIn post" with no text or link, the Director asked for the post instead of inventing it.

## Variance

Ten scenarios ran three trials each.
Seven gave consistent outcomes with a judged spread of at most 0.43.
Three were inconsistent:

- `reel-cover-complacency`: one trial chose a CSS visual, one a generated image, and one returned a malformed plan.
  The treatment choice for an open-ended reel cover is not stable.
- `founder-ran-out-of-money`: two consistent plans scoring 4.00, and one malformed plan.
- `edu-compound-interest`: identical judged scores, but one trial's plan contained a computed percentage that the pattern check flags (see below).

## Weaknesses

1. **Malformed asset fields (validity miss).**
   Three trials put a field on an asset task that does not belong to its operation: a fallback on a required image, an edit-style instruction on a generate task, and a generation brief on an edit.
   The output schema did not say which fields belong to which operation, so only the validator caught these, after the fact.
   In the product, each of these requests would stop as "planning failed".
2. **An editing request reported as a generic planning failure.**
   The editing scenario was scored as accepted, because the plan was refused, but its refusal was classified as a malformed plan rather than as editing being unavailable, so the user would not have been told why.
   The cause was a rule that named a missing capability only when it was the plan's only violation.
3. **Copy invention risk in personal stories.**
   In `founder-ran-out-of-money`, one plan told the Design Agent to "write plausible, general copy" about the founder's decisions and feelings, which invites invented details of the user's own story.
4. **"Short" is not a slide count.**
   In `ref-dashboard-screenshot`, the user asked for a short carousel and the plan used the baseline default of 8 slides while recording "keep it short" as a constraint.
   This follows the specified slide-count precedence (only an explicit count overrides the default), so it is a policy tension for the founder rather than a Director error.
5. **Handoff quality is the weakest dimension.**
   Its mean (4.04) passes, but the judge gave a 4 in 49 of 53 trials, typically noting that a plan left copy or example figures for the Design Agent to invent.
6. **Conflicting requirements can end in a question.**
   Asked for "one word per slide" alongside detailed coverage of twelve steps it did not have, the Director asked the user for the steps instead of planning.
   That is defensible but not an outcome the scenario accepts, and it is one of the three validity misses.

The two pattern-check fabrication hits (`tech-build-time-story`, `edu-compound-interest`) are percentages the Director computed from figures the user gave or framed as illustrative; the judge flagged neither, so the honesty threshold holds, but the check cannot tell arithmetic from invention.

## Fixes after the scored run

Weaknesses 1 and 2 were addressed after this run, in the same pull request:

- The output schema now states which asset fields belong to which operation, and that only an optional image has a fallback.
- A plan that needs a capability the machine does not have is now always reported as that capability being unavailable, with every other violation kept for the server log.
- The suite recognises an editing refusal by its typed code instead of by message text.

A filtered follow-up run (`2026-11-02T04-18-01-495Z`, 7 scenarios, 3 trials each) checked the fixes on the affected scenarios and on three that had passed, as controls:

| Scenario | Scored run | After the fixes |
| --- | --- | --- |
| `founder-ran-out-of-money` | 1 of 3 malformed | 3 of 3 valid, judged 4.10 |
| `reel-cover-complacency` | 1 of 3 malformed | 3 of 3 valid, judged 4.33 |
| `edit-photo-background` | refused as malformed | 3 of 3 refused as editing unavailable |
| `five-photos-sourdough` (control) | 3 of 3 valid, 4.71 | 3 of 3 valid, 4.71 |
| `ref-photo-and-style` (control) | 3 of 3 valid, 4.24 | 3 of 3 valid, 4.33 |
| `rev-complacency-more-dramatic` (control) | 3 of 3 valid, 4.71 | 3 of 3 valid, 4.63 |

No malformed plan appeared in 18 trials that exercise asset fields, against 2 in the 6 comparable trials of the scored run.
That is encouraging but a small sample, not proof that the error is gone; the validator still refuses any malformed plan that does occur.

The same follow-up run showed `conflict-minimal-vs-detail` asking the user a question in all three trials.
Its message asked for "every step in detail" of a twelve-step process without saying what the steps were, so the Director could not plan without inventing the user's process, which its instructions forbid.
The scenario therefore tested missing content as well as conflicting constraints.
After the scored run, the scenario was changed to list the twelve steps, so that it tests only the conflict.
In a filtered run of the corrected scenario (`2026-11-02T04-34-12-648Z`, 3 trials), every plan named the conflict and resolved it the same way: one headline word per slide, with the detail in two short step lines, grouping the twelve steps into six stages in the user's order (judged 4.17).
This is the only change to the suite after the scored run; no threshold or anchor changed.

The scored figures above are not recomputed: they measure the code as it was when the run started, and the rubric's thresholds apply only to full-suite runs.

## Full run after the fixes

A second full run (`2026-11-02T04-53-47-975Z`, on the final code of this pull request, all 36 scenarios and 56 trials, the corrected conflict scenario included) measured the code proposed for merge.
It is reported beside the scored run, not instead of it: the scored run above is the pre-registered result.

| Threshold | Bar | Scored run (before the fixes) | After the fixes |
| --- | --- | --- | --- |
| Plan validity | at least 95% | 94.6%, missed | 98.2% (55 of 56) |
| Deterministic expectations | at least 90% | 91.1% | 94.6% |
| Mean judged score | at least 4.0 | 4.42 | 4.38 |
| Lowest dimension mean | at least 3.5 | 4.04 (handoff) | 4.02 (handoff) |
| Lowest scenario mean | at least 3.0 | 4.00 | 3.86 (`ref-dashboard-screenshot`) |
| Fabrication flagged by both checks | none | none | none |

No plan put an asset field on the wrong operation, the editing request was refused as editing unavailable, and the corrected conflict scenario was resolved.
The one validity miss is new: in `unavailable-mountain-photos`, where image generation is not set up, the Director planned four generated photos, so the request ended with "image generation is not set up on this machine" instead of a design with CSS visuals.
In the scored run the same scenario planned CSS mountain scenes.
The user is told plainly and nothing is substituted, but this shows the Director can still ignore an unavailable capability in its input; one trial cannot say how often.
`reel-cover-complacency` again varied across its three trials, and two pattern-only fabrication hits were percentages the judge did not flag.
Director cost was $4.38 ($0.078 a plan; median 28.1 s, 90th percentile 43.4 s, maximum 69.4 s); judge cost $4.37.
The human spot-check applies to this run's judged scores too.

## Cost and latency

- Director: $4.32 for 56 trials, $0.077 per plan on average ($0.021 to $0.208); median 29.8 s, 90th percentile 38.4 s, maximum 75.3 s; no denied reads.
- Judge: $4.24.
- Every plan stayed inside the product's $0.25 budget and 120-second limit.

## Uncertainty

- The judge is a model reading a plan, not a reader of finished slides; scores measure planning judgment, not audience response.
- The judge's scores cluster at 4 and 5 (four scores of 3, none lower), so it may discriminate weakly between good and excellent plans; this run cannot tell whether that reflects the plans or the judge.
- Most scenarios ran once, so a single-trial score can move by about half a point between runs, as the repeated scenarios show.
- The scenarios are synthetic and were written by the same team that wrote the Director's instructions.

## Human spot-check

The rubric requires a person to re-score five trials before the judged thresholds are treated as final.
**That spot-check has not been performed.**
The founder is asked to re-score these trials from the raw results and record agreement here:

| Trial | Why chosen | Judged mean |
| --- | --- | --- |
| `founder-ran-out-of-money` #1 | lowest | 4.00 |
| `founder-ran-out-of-money` #3 | lowest | 4.00 |
| `rev-api-add-examples` #1 | highest | 4.86 |
| `source-required-latest-post` #1 | highest | 5.00 |
| `tech-cdn-cache-miss` #3 | random | 4.67 |
