# Future concept: CreatorBrio Research Intelligence Engine

**Status:** FUTURE / PARKED. Concept preservation only. **No implementation authorized.**  
**Captured:** 2026-11-19  
**Tracking:** [#230](https://github.com/mk-global/creatorbrio/issues/230) (keep open as an idea record, not an execution ticket)  
**Authority:** [content-platform overview](../README.md), [architecture RFC](../ARCHITECTURE-RFC.md), [roadmap](../ROADMAP.md), [decision register](../DECISION-REGISTER.md). Those documents, accepted Video Studio decisions and shipped code take precedence. This document proposes no architecture decision.

## 1. Problem and potential product impact

Existing CreatorBrio planning envisions researching **a creator-supplied objective or topic**, preparing a research dossier, obtaining human approval, producing content, publishing it and reading performance back. A *future* research intelligence extension would also help answer the upstream question: **What is worth creating next, for this brand, and on what evidence?**

A reported industry workflow uses cross-platform signals, experimental channels and many creative concepts to identify promising topics. Treat that account as inspiration, **not** evidence that its predictions, its claimed scale or 30–40-way thumbnail tests can be reproduced economically or scientifically. We need to validate the mechanism independently.

**Hypothesized value, not a proven outcome:** better topic selection, less wasted production time, differentiated content, and a traceable loop from audience signal through human-approved creative decisions to measured distribution outcomes. A possible broader product use case is agencies or small teams managing several brands, but do not claim product-market fit.

**Non-goals:** a guaranteed virality predictor; indiscriminate scraping; automated medical advice; a social scheduler replacement; unattended publication; a new standalone platform or duplicate research/insights domain; 100 synthetic social channels; a requirement to generate 40 near-identical thumbnails.

## 2. Four initial channels and distinct objective functions

| Brand/channel | Discovery question | Candidate signals | Primary success criteria (to validate) | Safeguard |
| --- | --- | --- | --- | --- |
| **Personal brand** | Which AI automation, SRE, DevSecOps and engineering-leadership problems are emerging among people we want to reach? | Relevant Reddit discussions, engineering YouTube, professional communities and permitted LinkedIn data | Relevant followers, qualified inquiries, guide consumption, meaningful discussion; reach as secondary | Firsthand expertise and credible claims; avoid broad trends that attract the wrong audience |
| **Leaders Mantra** | Which verified true-hero, counter-move or business-decision stories have compelling overlooked angles? | News/public archives, licensed or permitted social discussions, audience questions and prior post performance | Opening retention, completion, shares, follows, story quality | Independently verify names, dates and factual claims; avoid sensationalized fiction |
| **Logic Brief** | Which evergreen or emerging explanatory questions justify long-form production effort? | YouTube search and comparable videos, questions/comment themes, general search signals | Production hours per qualified view, click-through, watch time, long-term discovery | Separate evergreen demand from short-lived spikes; test against opportunity cost |
| **Latika Wellness** | What concerns and language recur among women aged 35–55? | Public questions, search patterns and consented audience feedback | Saves, shares, return readership, relevant engagement and trust | Popularity identifies **questions**, not medical evidence; cite credible health sources and apply editorial/claims review |

**Ranking must be channel-specific.** Do not use a universal “virality” score, or treat follower counts, engagement or commercial value as interchangeable. Benchmark each brand against its own content and audience before comparing projects.

## 3. Candidate workflow, strictly conceptual

1. **Observe:** discover permitted, attributable signals from Reddit, YouTube, X, LinkedIn, Instagram, search and first-party channel analytics. Each platform requires an independently verified access and licensing path; access is not assumed.
2. **Normalize and cluster:** deduplicate near-identical discussions and group recurring questions or story angles. Preserve original source, retrieval timestamp, jurisdiction/terms, and limitations; avoid retaining restricted source payloads.
3. **Detect opportunities:** assess momentum over time, audience fit, competition/saturation, evergreen potential, novelty, factual verifiability, production cost and predicted commercial relevance. Report components and uncertainty rather than an unsupported single “probability of virality.”
4. **Recommend:** present a small, diverse shortlist, with *why now*, provenance, counterevidence, alternatives, production effort and brand suitability. Human selects or rejects direction at existing Gate 1.
5. **Package creative options:** suggest titles, first-three-second hooks, story structures and thumbnail/cover concepts in a deliberately varied set. Exploratory starting point: 5–8 meaningfully different concepts, not a mandatory 30–40; brand and format decide which asset matters.
6. **Experiment when legitimate:** test the best 2–3 variants through supported platform capabilities and adequate traffic, recording allocation, eligibility, sample size, objective and inconclusive results. Shorts hook/retention learning and long-form thumbnail tests are different methodologies. AI-only aesthetic rankings are **not observed CTR**.
7. **Learn:** link signal/topic candidates -> versioned dossier -> creative variant -> approved content -> published destination -> performance snapshot. Compare with a baseline; flag selection bias, attribution limits, platform drift and correlation-versus-causation.

No external action, experiment, paid inference, publication or human approval is delegated to agents by this proposal.

## 4. Fit with current CreatorBrio architecture

**Reuse existing planned boundaries, subject to the actual state when revisited:**

- **Research:** Phase 2's shared research dossier, source/claim provenance and human approval remain authoritative; discoverable opportunity suggestions would feed research, not create a second approval system.
- **Brands/planning:** channel-specific editorial profiles and proposals belong with existing brand and planning records. Planning entries do not schedule publication.
- **Insights:** Phase 5's read-only performance readback supplies measured inputs. Advanced experiments and benchmarking remain future capabilities; the publisher retains the sole publication scheduler and credential custody.
- **Identity/provenance:** follow the existing identifiers linking research revision, creative work, publication and performance (AD-41/AD-42). Never redesign immutable records just for hypothetical intelligence features.
- **Security and trust:** external text is untrusted; fetching and crawling must stay inside the retrieval boundary and agent containment. No secrets or publishing credentials enter research prompts.
- **Authority:** one modular repository, one shared workflow, two human approvals where applicable; separate worker/runtime only when an accepted outcome and isolation requirements justify it.

This is a **capability concept**, not approval for data schemas, architectural additions, vendor selection, new services, a new agent, separate data lake or modifications to existing decisions.

## 5. Data access and testing limitations

Before designing connectors, verify per-platform **current** commercial API permissions, permitted fields, quotas, storage/caching, retention, deletion, privacy, redistribution, and account-review requirements. Public visibility does not confer a scraping or reuse license. Do not assume privileged LinkedIn/Instagram/X data or unrestricted Reddit commercial access.

Distinguish:

- **Leading signals:** interest, discussions, growth velocity, search demand and comparable content. These suggest hypotheses, not causal forecasts.
- **Model judgment:** relevance, novelty, clarity and creative appeal. These are predictions with calibration requirements, **not** platform-tested performance.
- **Measured experiments:** genuine exposure and performance data from permitted experiments, with sufficient sample sizes. YouTube long-form title/thumbnail testing, where available and eligible, is limited in variant count and may optimize watch time; Shorts and other platforms have different capabilities. Reconfirm rules at implementation time.
- **Post-publication analytics:** observational outcomes subject to confounding from audience, timing, distribution, platform algorithms and editorial execution.

Store only what policy allows, minimize personal data, preserve source pointers and retrieval dates, and define deletion rules before ingestion. For wellness content, medical-quality evidence review is mandatory and independent of trend scores.

## 6. Potential progressive validation, not a committed milestone

| Exploration stage | Question | Evidence required before proceeding |
| --- | --- | --- |
| A. Manual / low-cost pilot | Can a person use public/permitted signals to find better topics for two frequent-posting channels? | Predeclared selection rubric, 4–8 weeks of candidate and rejected ideas, measured editorial effort and actual outcomes; small samples treated cautiously |
| B. Assisted suggestions | Does a lightweight recommendation shortlist outperform the existing editorial baseline? | Matched or randomized selection where practical, independent editorial quality review and per-brand metrics; record null results |
| C. Platform-backed creative evaluation | Do alternate hooks/titles/thumbnails improve audience outcomes? | Tested platform eligibility, valid exposure data, clear experiment objective, adequate traffic and known costs |
| D. Multi-brand extension | Is there repeatable value for the other two brands and eventually paying teams? | Brand-specific objective weights, evidence/compliance gates, repeatability and customer willingness-to-pay research |
| E. Predictive forecasting, only if justified | Do historical outcomes produce calibrated, useful forecasts? | Sufficient representative history, out-of-time validation, calibration, and lift above simpler baseline heuristics |

The sequence above is a research hypothesis, not a Phase 10 or a ticket backlog. Channel prioritization is provisional: personal brand and Leaders Mantra offer frequent short-form learning; Logic Brief is especially valuable for avoiding costly long-form topic mistakes; Latika Wellness requires an evidence-first treatment. Reassess with actual publishing volume.

## 7. Revisit triggers and decision questions

**All triggers are required before admitting build work:**

- Current end-to-end research -> human approval -> publication flow works and post-performance readback is reliably available.
- Measurable baseline and enough brand-specific content history exist to judge whether new topic suggestions add value.
- Legally/permissibly obtainable data sources, attribution/retention requirements, platform limits and expected monthly expense are verified.
- An explicit founder decision selects target channel(s), success metric, allowed spend and a bounded pilot.
- An independent architecture/security review confirms no duplicated domain model, scheduler, approval path or weakening of containment.

**Open questions for that later decision:** What is a “signal” we may legally retain? How will candidate topics be identified across platforms? What time horizon distinguishes emergence from a one-day spike? What is the baseline editorial selection method? What level of evidence makes a story eligible? Which actual experiments are statistically feasible for each platform/channel? How will the system avoid feedback loops toward clickbait? How much time and money does it save relative to a human researcher? Can it support creators beyond these four brands without costly customer-specific integrations?

## 8. Explicit stop line

**Parked. No implementation now.** Do not add acceptance criteria to M1, change current phase ordering, open engineering subtasks, schedule jobs, procure API access or report any imagined lift. On reactivation, perform fresh data-platform/legal research and write an independently reviewed, founder-accepted implementation proposal tied to a demonstrated product outcome.

Related: [roadmap](../ROADMAP.md) (Phase 2 shared research; Phase 5 readback; Phase 9 advanced insights); [RFC](../ARCHITECTURE-RFC.md) (research, brand, insight and publication authorities); [tracking issue #230](https://github.com/mk-global/creatorbrio/issues/230).
