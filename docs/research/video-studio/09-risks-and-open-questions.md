# 09 · Risks, unknowns and open questions

[← Research index](README.md) · Checkpoints: [08](08-implementation-plan.md#validation-checkpoints)

## Risk register

Likelihood and impact are judgments (L / M / H).

| ID | Risk | Likelihood | Impact | Evidence | Mitigation | Owner decision needed? |
|---|---|---|---|---|---|---|
| **R1** | HyperFrames' screenshot capture on macOS is too slow or not deterministic enough for 60–90 s reels with footage | M | H | macOS uses screenshot mode, not BeginFrame **[source]** ([03 §2](03-source-analysis.md#2-hyperframes-the-chosen-render-engine)); E1 shows the principle works but on Linux | V1 before W3; the EDD keeps the renderer replaceable; OpenFilm's renderer and our own Puppeteer path are pre-agreed fallbacks | No |
| **R2** | HyperFrames API churn (pre-1.0, 2,989 commits in 90 days, daily releases) | H | M | [E4 §1](evidence/e4-creative-and-audio-tools.md#activity--risk) | Exact version pins; one adapter module; renders covered by determinism and golden tests; upgrades are deliberate tickets | No |
| **R3** | HyperFrames' direction is set by a commercial vendor (HeyGen); upstream skills already steer to sign-in and credits | M | M | [SKILL.md#L17-L32](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/skills/media-use/SKILL.md#L17-L32) | Use only the Apache-2.0 render packages, never upstream skills or the CLI in the product path; telemetry off; fork possible under Apache-2.0 if needed | No |
| **R4** | GSAP's "Standard no charge" licence reportedly restricts products that compete with Webflow's visual animation builder; a Video Studio with a keyframe editor could be read as one | M | M | Licence text not reachable from the research session; excerpts inconsistent ([E0](evidence/e0-experiments.md#direct-verification-by-the-lead-researcher)) | No GSAP in CreatorBrio-authored output or dependencies; HyperFrames' render packages do not depend on GSAP **[source]**; read the licence directly before any GSAP use | Yes, if GSAP is ever wanted |
| **R5** | Video preview needs scripts, which departs from the `sandbox=""` rule | M | M | [05 §9](05-proposed-architecture.md#preview-isolation) | Opaque-origin iframe, strict CSP, existing `Origin: null` refusal **[source]**, no model-authored script; V2 | Yes: record the exception in CLAUDE.md |
| **R6** | Filler detection is weak without a non-commercial model | H | M | [E5 §2.2](evidence/e5-building-blocks.md#22-filler-words-umuh) | V4; ship as review-only candidates if below threshold | No |
| **R7** | Matte quality for hair and motion | M | M | Apple Vision masks are soft-edged **[docs]**; BiRefNet is per-image | V5; temporal smoothing and guided upsampling as in Ghost Editor; keep occlusion partial | No |
| **R8** | iPhone HDR footage looks washed out after conversion | H | H | [E5 §1.3](evidence/e5-building-blocks.md#13-proxies-vfr-and-hdr-pitfalls) | V3; SDR-only output; explicit colour tags; creators can record SDR | No |
| **R9** | UI scope: a usable NLE UI is the largest build item | H | M | No permissive editor UI fits our model ([E3](evidence/e3-sdks-and-renderers.md#ready-made-timeline-component-vs-extracting-one-from-a-full-application)) | V6 picks the interaction layer; scope the UI to reels (one canvas size, ≤ 90 s, a fixed set of lanes) | No |
| **R10** | Agent cost and latency per revision | M | M | Existing caps: USD 0.25 (Director) + 1.00 (Design Agent) per message | V7 measurements; compact MCP outputs (summaries, not raw arrays); deterministic rough cut before any AI | Yes: budgets |
| **R11** | Model licences change or were misread (several checked only through search results because huggingface.co was unreachable) | M | M | [E5 caveats](evidence/e5-building-blocks.md#key-caveats) | Model manager records each model's licence and revision at download; re-verify every default model's card before release | No |
| **R12** | Music and SFX licensing for published content | M | H | Mixkit terms (Ghost Editor), unclear UVR weights, CC-BY attribution duties | Licence-tagged library only; attribution recorded per clip and exported with the reel; no non-commercial assets by default | No |
| **R13** | The person is altered by an effect | L | H | Product rule from image editing | No generative model touches the speaker; mattes cut real pixels; background replacement keeps the person's pixels | No (existing rule) |
| **R14** | GPL FFmpeg build | L | L | Homebrew builds are GPL-3+ **[docs]** | Separate process, user-installed, never bundled or redistributed | No |
| **R15** | Large media fills the disk | M | L | Proxies, mattes and renders accumulate | Hard links for originals; regenerable derived media; a cleanup command; disk check before renders | No |
| **R16** | One-maintainer and very young projects referenced for ideas disappear | H | L | Most discoveries are weeks old | Nothing in the core depends on them; ideas are reimplemented, licences respected | No |
| **R17** | Two Chromium builds (Puppeteer's for slide export, HyperFrames' headless shell) | M | L | Both use Puppeteer **[source]** | Accept initially; unify later if it causes problems | No |

## Unverified assumptions and their significance

| Assumption | Status | Significance | Settled by |
|---|---|---|---|
| HyperFrames renders a 60 s footage-heavy reel deterministically on macOS in acceptable time | Not tested (no Mac) | Decides the renderer | V1 |
| `<hyperframes-player>` runs in an opaque-origin sandbox | Not tested | Decides preview security | V2 |
| HyperFrames supports the gain envelopes, sub-compositions and range renders our compiler needs, at the pinned version | Inferred from source file names and other projects' usage | Compiler design detail | V8 |
| Parakeet TDT transcribes, or the gap classifier finds, filler words | Not tested | Filler feature quality | V4 |
| Apple Vision mattes are good enough | Not tested | Signature effect quality | V5 |
| HyperFrames packages' licence is Apache-2.0 per package (most `package.json` files lack a licence field) | Root licence read; per-package not confirmed on npm tarballs | Legal hygiene | W0 check of published tarballs |
| GSAP's licence restriction wording | Not read directly (gsap.com outside the allowed network) | Only matters if GSAP is used | Read before any use |
| Model licences marked "(web)/verify" in [E5](evidence/e5-building-blocks.md) | From search results | Release hygiene | Model manager plus manual check |
| Edit Agent with MCP-only tools stays within budget | Not measured | Cost per revision | V7 |

## Open questions for the founder

1. **Render time expectation**: what final-render time for a 60 s reel is acceptable on the M5 Max? This sets V1's pass criterion.
2. **Preview sandbox exception**: do you accept a script-enabled, opaque-origin preview iframe for video only ([R5](#risk-register))?
3. **Budgets**: what per-message Claude usage cap is acceptable for video runs, given that agent edits are multi-step?
4. **Stock media**: is a free Pexels/Pixabay key acceptable as an *optional* B-roll source, or should B-roll come only from the creators' own libraries?
5. **Non-commercial models**: should opt-in, clearly labelled non-commercial models (for example CrisperWhisper for fillers) be offered for personal use, or excluded entirely?
6. **Footage for validation**: can each creator provide 10–15 minutes of typical raw footage and two reference reels they admire, for V1, V3, V4, V5 and W9?
7. **Distribution intent**: will CreatorBrio stay a single-user local tool, or be distributed to others? This decides how strictly to treat licences like Remotion's and GSAP's.
8. **Node 22**: raising the minimum Node version is a breaking requirement for existing users; is a release note enough?

## Source limitations of this research

- No Mac was available, so nothing Apple-Silicon-specific was run.
- Cloned code was read but never executed; no third-party project was built.
- GitHub API metadata (releases, issue counts) for third-party repositories was unavailable to the session. Dates come from `git log` of fresh clones; stars come from GitHub pages.
- These domains were outside the session's allowed network, so their content came from search results or was not consulted: gsap.com, remotion.pro, huggingface.co, ffmpeg.org, stability.ai, pixabay.com, hn.algolia.com.
- The canonical EngineeringToolsMK ticket and PR validator was not reachable from this session (see the pull request).
