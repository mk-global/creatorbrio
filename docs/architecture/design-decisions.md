# Design decisions

This page records why CreatorBrio's creative workflow is shaped the way it is, so contributors can extend it without undoing a deliberate choice.
Each decision states what was chosen, why, and what it costs.

## The Design Agent stays independent

The Design Agent's system prompt is frozen at a recorded baseline and pinned by a test; the Visual Director's plan reaches it only as a delimited section of the task message.

Why: the Design Agent is good at composition, and its prompt is the product's most tuned asset.
Mixing strategy into it would make every planning change a risk to design quality, and would make it impossible to tell whether a result came from the plan or the prompt.

Cost: the frozen prompt can pull against a plan.
It always plans an eight-slide arc and tells the agent to follow the style of every reference image.
The slide-count rules relay that same default rather than fighting it, and the conformance check measures any remaining conflict instead of hiding it.
Changing the prompt needs a separate, explicit decision.

## Strategy belongs to the Director

A separate Visual Director decides what the content is for, who it is for, the central message and the visual treatment; the Design Agent decides the copy, layout and typography.

Why: deciding what to communicate and deciding how to lay it out are different jobs.
Asking one agent to do both in one pass tends to skip the first: it starts composing before it has asked whether imagery helps at all.
A separate, stateless step with its own budget makes that reasoning explicit, reviewable and testable.

Cost: every chat message pays for one extra model call (up to $0.25 and two minutes, typically far less), including small edits.

## Plans have advisory and binding parts

A plan's `strategy` (objective, audience, direction, reasoning, success criteria) is advisory text; its `execution` (slide count, treatments, image placements, reference roles, image tasks) is binding data.

Why: creative guidance cannot be validated mechanically, but placements and counts can.
Separating them means code only ever acts on parts it can check, and the model's prose can never smuggle in a command.

## Deterministic code executes the plan

The Director never calls tools that change anything.
Server code validates the plan, generates images, attaches them, and writes the handoff from a fixed template.

Why: a plan validated in full before anything happens is predictable, testable and safe to retry.
An agent that executed its own plan would need write access, and every failure would be a model behaviour to debug instead of a typed outcome.

Cost: the plan's vocabulary is fixed.
A new kind of work (for example motion) needs a capability row, a plan operation and an executor in code.

## Generated images are assets, not style references

Generated images live in their own typed list on the carousel, separate from uploaded reference images.

Why: the Design Agent is told to imitate the style of every reference image.
A generated photograph is content for a specific slide, not a style to copy; recording it as a reference would turn it into one.
The separate list also carries what references never needed: a hash, the run that made it, and its origin.

## Images are staged, then attached all or nothing

Generated images are written to a private folder first and moved into the served uploads folder only when every required image is ready, through a crash-consistent protocol.

Why: a design built around half the planned images is worse than no design, and a crash must never leave a record pointing at a missing or partial file.
The cost is a little more machinery in one module, covered by fault-injection tests after every step.

## No silent fallback, no automatic retry

When a required source or image cannot be obtained, the run stops before design with the reason; nothing is substituted and nothing is retried automatically.
Retry is a button, and it only remakes what is missing.

Why: a quietly different result is harder to notice and fix than a clear stop.
Automatic retries against a busy local machine make contention worse.

## Editing is gated

Editing an uploaded image is listed as a capability but is not available.
A request that genuinely needs it stops with "editing uploaded images is not available yet" rather than producing something else.

Why: the image service has no editing operation yet, and whether editing can preserve a person's likeness well enough has not been shown.
Listing the capability lets the Director recognise the need honestly, and adding it later is the documented three-step extension.

## Local JSON storage stays

Runs, briefs and asset records use the existing JSON files with a per-file lock and atomic writes.

Why: CreatorBrio is a single-user local app.
The data is small, and plain files are easy to back up, inspect and repair.
A database, queue or workflow engine would add installation and operational weight with no benefit at this scale.

Cost: the JSON writes rename without flushing, so an operating-system crash or power loss can lose the latest writes.
Writing files before the records that name them, and checking hashes before reuse, contains that loss.

## The Director runs on every message

There is no rule that skips planning for "small" requests.

Why: deciding which requests need planning is itself a planning decision, and a wrong skip would silently drop the Creative Brief's continuity.
The Director is told that a plan with no images is often the right answer, so a small edit stays a small edit.

Cost: planning time and cost on every message; measured figures are in the pull request that introduced the workflow.

## Evaluation is a separate harness

The Director's judgment is measured by an opt-in suite of synthetic scenarios scored by deterministic checks and a model judge, with thresholds committed before the scored run.
Creative-outcome review of finished slides happens in an acceptance harness (`eval/acceptance/`), not in the product.

Why: valid output is not good output, so quality needs its own measurement.
Running a review model on every request would exceed the latency and cost budgets, and a review that could change a design would undermine the user's control.

## Limitations

- Tool restrictions on both agents are Claude CLI policy, not operating-system isolation: they run as the same account as the app.
- The Design Agent's shell can overwrite files in the uploads folder; asset hashes make that detectable, not preventable.
- A cancelled image keeps the local image service busy until it finishes.
- Model-judged evaluation scores are evidence with stated uncertainty, not measurements of audience response.

## Extension points

- A new capability: a row in `src/lib/creative-capabilities.ts`, a plan operation or treatment accepted by `validatePlan`, and an executor in `src/lib/creative-run.ts`.
- A new stage event or outcome: the typed stream contract in `src/lib/chat-stream.ts`, which older clients ignore.
- A new blocking reason: a code in that contract and a message the user can act on.
