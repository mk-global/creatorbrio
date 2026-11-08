[← Research index](../README.md) · [Specification](../spec/README.md) · Evidence appendix

> **About this appendix.** Working notes for the product specification ([#66](https://github.com/mk-global/creatorbrio/issues/66)), kept close to how they were written so conclusions can be traced. Repositories were cloned and **read only**: nothing was installed, built or executed. Dates and SHAs come from `git log` of fresh clones taken on 2026-11-04. Labels such as *unverified* mark claims that could not be checked from primary sources in the research session (huggingface.co was unreachable). Paths shown as `<local clone>/…` refer to the researcher's temporary clone.

# 07 · OpenMontage, character animation and local illustration models (Workflow B)

Examined 2026-11-04. Clones are read-only (`--filter=blob:none` or `--filter=tree:0`); nothing was installed or executed.
"90d" = commits since 2026-08-05 from `git rev-list --count --since=2026-08-05 HEAD`.
**Network limits:** huggingface.co and mocap.cs.cmu.edu are blocked in this session (proxy 403 / DNS refusal), and the `gh api` repo endpoints are refused for repositories not attached to the session. Model-card licences were therefore checked from GitHub repository files and READMEs where they exist. Items marked *(unverified)* come from a secondary source or memory.

Verdicts use the vocabulary in `02-ecosystem-inventory.md` (Adopt / Integrate / Adapt / Learn / Skill / Exclude). Not covered here because earlier research already covers them: HyperFrames, GSAP, lottie-web, dotLottie, rive-wasm, Motion Canvas, Mermaid, Excalidraw-animate, Kokoro, ACE-Step, BiRefNet ([E4](e4-creative-and-audio-tools.md), [E5](e5-building-blocks.md)).

---

## 1. OpenMontage

### 1.1 Which repository

| Repo | What | Licence | HEAD / dates / 90d | Verdict |
|---|---|---|---|---|
| **calesthio/OpenMontage** (canonical) | Agent-first video production "system": YAML pipeline manifests, Markdown director skills, ~209 Python tool files, Remotion and HyperFrames composition, Backlot storyboard board | **AGPL-3.0** (LICENSE file read) | `d21f5d4eaa08422b09c7091757a05affcbabb35b`; first 2026-03-29, last 2026-11-03; 501 total, **160** in 90d; 76k stars (not a quality signal) | **Learn**; Exclude as dependency |
| charliewwdev/OpenMontage | Fork of the above (same first commit, 2026-03-29) plus a self-hosted "studio" for short dramas and ads; 424 of its commits by the fork owner | AGPL-3.0 | `1ef66bc0268085cbebb20c2ce4d9594fb666169f`; last 2026-11-02; 228 in 90d | Exclude (same licence, more cloud-oriented) |
| digimads-lab/OpenMontage | Unrelated "collaborative filmmaking" project: README and docs only (9 commits, no code) | Apache-2.0 | `0bc572483e8e963cebeeb6f8dbd1c7d3a5021ffd`; 2026-02-14 → 2026-03-03; 0 in 90d | Exclude (nothing to use) |
| 47thtechcorner/RayCodes_OpenMontage, ~15 other mirrors | Copies and mirrors; RayCodes has **no licence** | — | — | Exclude |

### 1.2 What calesthio/OpenMontage really is

- **No code orchestrator.** "Your AI coding assistant IS the orchestrator": the agent reads a pipeline YAML, then each stage's director skill, calls Python tools, self-reviews, checkpoints JSON and asks for approval ([README L399-L430](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/README.md#L399-L430)). The stages are `research → proposal → script → scene_plan → assets → edit → compose`. There are 13 pipeline YAMLs, including `character-animation.yaml` and `animated-explainer.yaml`.
- **Render path:** Remotion (React) or HyperFrames (HTML/GSAP), chosen per project and locked as `render_runtime`; FFmpeg for encoding, mixing and burn-in ([README L273-L292](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/README.md#L273-L292)). HyperFrames is driven through `npx hyperframes` ([README L603](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/README.md#L603)). Remotion has its own company licence; see E3.
- **AI/API dependencies:** the LLM is the user's coding agent (cloud). Local LLMs via Ollama are "coming soon" ([README L694](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/README.md#L694)). 93 of 209 tool `.py` files reference API keys (fal, Veo, Kling, ElevenLabs, Google TTS, Suno, OpenAI and others). `requirements.txt` pulls in `google-genai` and `openai` as core dependencies. The showcase films cost $1–5 each in cloud generation.
- **Local capability (zero keys):**
  - Piper TTS ([tools/audio/piper_tts.py L36-L42](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/tools/audio/piper_tts.py#L36-L42)). `pip install piper-tts` now installs **OHF-Voice/piper1-gpl**, whose COPYING is **GPL-3.0** (HEAD `10880972db9e`); the archived rhasspy/piper was MIT.
  - Stock and archive footage.
  - "Local diffusion": Stable Diffusion 2.1 base on **CUDA or CPU only**, with no MPS path ([tools/graphics/local_diffusion.py L114-L123](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/tools/graphics/local_diffusion.py#L114-L123)).
  - Local video generation (WAN, LTX) needs a CUDA GPU.
  - The `character-animation` pipeline and Ink Theater are fully local.
- **Licence:** AGPL-3.0, and every contribution "remain[s] available under that license". There is no CLA ([CONTRIBUTING.md L3-L5](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/CONTRIBUTING.md#L3-L5)), so a permissive relicence is not available.

### 1.3 Parts relevant to Workflow B

| Part | What it does | Evidence | Use for CreatorBrio |
|---|---|---|---|
| `character-animation` pipeline | Stages from character spec through `rig_plan` and `pose_library` to an action timeline and SVG/GSAP render; "deterministic local motion, not remote video-gen replacement"; $2 default budget | [pipeline_defs/character-animation.yaml L1-L10](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/pipeline_defs/character-animation.yaml#L1-L10), [rig-plan-director.md L1-L30](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/skills/pipelines/character-animation/rig-plan-director.md#L1-L30) | **Learn**: "character differences are data"; every moving part has a pivot, a layer order and constraints; named poses; action cycles only when reused. Its `svg_rig_builder` and `pose_library_builder` emit fairly trivial starter data (blink, look_left and so on) ([tools/character/character_animation.py L185-L366](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/tools/character/character_animation.py#L185-L366)) |
| **Ink Theater** (`ink-theater.js`) | Deterministic, seek-safe hand-drawn engine for HyperFrames | [README L1-L44](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/ink-theater/README.md#L1-L44); [ink-theater.js L118-L175](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/ink-theater/ink-theater.js#L118-L175) | **Learn and re-implement**: (a) closed-form damped-spring eases as pure functions of progress; (b) line "boil" by stepping an `feTurbulence` seed from the timeline at about 9 fps, never SMIL; (c) 2D FABRIK IK whose target is set from the timeline; (d) a seeded PRNG with no `Math.random`; (e) only finite repeats. All are public techniques; write them ourselves rather than copy AGPL code |
| **Ink Puppet** + `mocap/bvh2clip.mjs` | Offline BVH → 2D per-frame joint tracks (hips-relative pose, root motion, fixed figure height); runtime stick figure with draw-on reveal; `choreograph(tl, puppet, [{clip:"walk"},…])` takes named clips only ("an agent … must never hand-tune motion"); 12 CMU-derived clips | [README L53-L80](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/ink-theater/README.md#L53-L80); [THIRD_PARTY_NOTICES.md](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/ink-theater/THIRD_PARTY_NOTICES.md); [mocap/catalog.json](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/ink-theater/mocap/catalog.json) | **Learn**: this is the strongest design idea found for Workflow B (mocap → 2D clip library → the LLM picks clips by name). Do not reuse the AGPL converter or its emitted clip files; convert CMU BVH with our own tool |
| `/animated-drawing` skill | Wraps Meta AnimatedDrawings (raster ARAP warp of a user's drawing) and composites the result into HyperFrames | [skills/creative/animated-drawing.md L1-L20](https://github.com/calesthio/OpenMontage/blob/d21f5d4eaa08422b09c7091757a05affcbabb35b/skills/creative/animated-drawing.md#L1-L20) | Learn (see §2) |
| Backlot | Local storyboard board; asset generation pauses on a scene-by-scene contact sheet showing takes, prompts, cost and quality scores | README L141-L169 | **Learn**: a storyboard approval gate before the costly render matches CreatorBrio's change-set review |

### 1.4 Verdict

**Learn (techniques and process); Exclude as a dependency; do not integrate as an external tool.** Reasons:

- AGPL-3.0 with no CLA cannot be combined into MIT CreatorBrio.
- Running it as an external tool would put an agent-as-orchestrator Python system, which is cloud-provider-centric (93 tools need keys), beside CreatorBrio's own validated edit document. Two orchestrators would compete.
- Its local image path is CUDA/CPU SD 2.1, and its TTS is now GPL.
- What is worth taking is ideas, reimplemented clean-room:
  - the seek-safe primitives;
  - the mocap clip library chosen by name;
  - rig and pose data as JSON;
  - the storyboard gate with per-asset cost.

---

## 2. Character and stick-figure animation for a seek-based renderer

### 2.1 Runtimes and authoring tools

| Name | What | Licence (source) | Activity (HEAD, last, 90d) | Local? | Seekable in HyperFrames? | Verdict |
|---|---|---|---|---|---|---|
| **Own SVG rig + pose JSON** (proposed) | Bones, parts, poses and clips evaluated as `pose(t)` | ours (MIT) | — | yes | yes: pure function of time, driven from a paused GSAP/WAAPI timeline or a custom seek hook | **Build** (recommended) |
| rough.js | Hand-drawn SVG/Canvas strokes; a fixed `seed` gives reproducible output | MIT (LICENSE) | `56a2762171b1`, 2023-11-19, 0 | yes | yes, with a fixed seed per frame or step | **Adopt** (sketch style); stable but unmaintained |
| bassimeledath/stix | Claude Code skill: asset-first SVG stick figures (16 poses, 9 expressions, 21 props, 11 transitions); seeks CSS animations via `document.getAnimations()…currentTime` ([SKILL.md L532-L557](https://github.com/bassimeledath/stix/blob/20806f1552f1d7a75b5f9e54a6624bd95e2be95d/SKILL.md#L532-L557)) | MIT (LICENSE) | `20806f1552f1`, single day 2026-02-28, 0 | yes | yes (CSS adapter) | **Skill/Learn**: pose and expression library as prompt material; a reusable-asset-first approach keeps scenes consistent |
| CMU Graphics Lab mocap (BVH) | Thousands of human motion clips | "Free for research and commercial projects; may include in commercial products but **may not resell the data, even converted**" *(from memory; the CMU site was unreachable; verify)*. Some derivatives such as the 4TU FBX conversion are **CC BY-NC** | static (mirror una-dinosauria/cmu-mocap `09a07f54f3bb`, 2015) | yes | yes, after offline 2D conversion | **Adopt as a data source after legal check**; ship only our converted, curated clips |
| Meta AnimatedDrawings | Auto-rig a drawn humanoid, then ARAP raster warp driven by BVH | Code MIT (LICENSE); **archived 2025-09-03** (README L5); detector/pose `.mar` weights need TorchServe/Docker; weight licence not separately verified | `b85968485751`, 2025-09-03, 0 | yes (Docker, about 16 GB RAM per OpenMontage) | offline pre-render to an alpha clip only | **Learn/Optional** (user-drawing feature later); not core |
| Lottie (lottie-web, dotLottie) | Import designer animations | MIT (E4) | see E4 | yes | yes (HyperFrames adapter) | **Adopt for imported assets** (as E4) |
| lottie-js / relottie (LottieFiles) | Programmatic Lottie JSON build/parse | MIT (LICENSE) | `a1bc6c566832` 2024-07-10, 0 / `068457b2b9b4` 2026-08-13, 2 | yes | n/a (authoring) | Learn; LLM-authored Lottie JSON is verbose and error-prone, so not the primary format |
| Glaxnimate | Desktop vector/Lottie editor | **GPL-3.0-or-later** (COPYING → LICENSES/); GitHub is a stale mirror (last 2023-10-21), development is on GitLab/KDE | — | yes | n/a | Integrate as a **user's external authoring app** only (its outputs are user data); never bundle |
| Lottie Creator (LottieFiles) | Web Lottie editor | Proprietary SaaS; free plan exports 5 animations and its commercial-use table **prohibits commercial use on the Free plan** ([help](https://help.lottiefiles.com/hc/en-us/articles/15418024472345-Is-Lottie-Creator-free), [policy](https://help.lottiefiles.com/commercial-use-guide)) | — | no | n/a | Exclude as a requirement |
| Rive runtime | State-machine runtime (C++/WASM) | MIT (rive-runtime LICENSE) | `60e398ba2d47`, 2026-11-04, 561 | yes | needs a custom fixed-dt adapter (E4) | **Defer**: the editor is proprietary SaaS; reports conflict on whether the free tier exports `.riv` *(unverified)* |
| Spine runtimes | Skeletal runtime | **Spine Runtimes Licence: "each user of the Products must obtain their own Spine Editor license"** ([LICENSE L6-L15](https://github.com/EsotericSoftware/spine-runtimes/blob/175a1e05073a406f305bde2621c065b8c2256c42/LICENSE#L6-L15)) | `175a1e05073a`, 2026-10-30, 49 | yes | yes | **Exclude** (incompatible with free open-source distribution) |
| DragonBonesJS | Skeletal runtime | MIT (LICENSE) | `64b6c69ae357`, 2025-05-24, 0; editor reported discontinued *(unverified)* | yes | possible | **Learn** (armature/slot/skin data model); stagnant |
| Synfig | Desktop 2D animation app | **GPL-3.0** (LICENSE) | `751779eedc3e`, 2026-11-01, 38 | yes | no (own renderer) | Exclude (external-app use only) |
| OpenToonz | Desktop 2D animation app | **BSD-3-Clause** (LICENSE.txt), with third-party parts | `572d59ac5fed`, 2026-10-28, 201 | yes | no (own renderer) | Exclude from the pipeline (not browser/seek based) |
| Theatre.js | Keyframe sequencing library and studio | Apache-2.0 (LICENSE); studio package licence not checked | `6ea82b938ea4`, 2024-04-11, 0 | yes | yes | Exclude (stagnant; GSAP/WAAPI already cover it) |
| StykAnimate-App | Pivot-style stick-figure animator | GPL-3.0 (GitHub metadata) | `def97214c2b4`, 2026-10-19, 525 (started 2026-09-09) | yes | — | Exclude (copyleft) |
| gestura-ai/stick-gen | Text-to-stick-figure motion model | **"Prosocial Public License PPL-3%"** (non-OSI), trained on AMASS/HumanML3D-family data | `c36d8a98e0a0`, 2026-01-13, 0 | yes | — | Exclude |
| MDM (motion-diffusion-model) | Text-to-motion research model | Code MIT; weights trained on HumanML3D/AMASS, whose data terms are **non-commercial** *(AMASS terms not re-read here)* | `ef8edce6a53c`, 2025-09-30, 0 | yes | offline → BVH | Exclude weights; possible later research |

### 2.2 Diagram layout

| Name | Licence (file) | Activity | Verdict |
|---|---|---|---|
| Mermaid | MIT | very active (E4) | **Adopt** (as E4): text → SVG; animate nodes and edges with stroke-dashoffset |
| ELK (elkjs) | **EPL-2.0** (LICENSE.md): weak copyleft; fine to use unmodified as a dependency, and changes to ELK itself must stay EPL | `bddee3a807b5`, 2026-10-28, 33 | **Adopt (optional)** for layered layout when Mermaid's control is not enough |
| dagre | MIT | `877ead2bb0d5`, 2026-10-24, 31 | Adopt (lightweight layout; used by Mermaid) |
| D2 | **MPL-2.0** (LICENSE.txt): file-level copyleft; a Go binary | `6a7b4837838a`, 2026-10-11, 289 | Integrate as an optional CLI only |
| svg.js | MIT | `4b8809b1554c`, 2026-08-04, 0 | Optional DOM helper |

### 2.3 Recommended approach: LLM-authored stick figures and simple characters

1. **CreatorBrio-owned `character` and `motion` documents** (JSON, schema-validated, part of the edit document):
   - `rig`: joints with parent, length, rest angle and angle limits, plus pivots.
   - `parts`: one SVG path or primitive per bone, with z-order; a style preset (stroke width, colours, rough.js roughness, seed).
   - `face`: expression set and mouth shapes, including visemes.
   - `poses`: named joint-angle maps.
   - `clips`: either a reference to a bundled mocap-derived 2D clip, or keyframes `[ {t, pose|angles, ease} ]`.
   - `ik`: named targets for reaching, pointing and holding props.
   - `props` and attachments.
2. **The LLM never writes motion curves.** It writes a **choreography list** per character, aligned to narration word timestamps: `{at, clip|pose, dur, facing, x→x2, ikTarget?, expression, say?}`. This follows OpenMontage's Ink Puppet rule and stix's pose library. The validator checks joint limits, clip names, overlaps and on-screen bounds.
3. **Renderer:** a small TypeScript module (ours, MIT) compiled into the HyperFrames composition.
   - `evaluate(t)` computes a pure-function pose: clip sampling, keyframe interpolation, closed-form spring eases, two-bone analytic IK or FABRIK, and root motion.
   - It writes SVG `transform` attributes.
   - It is driven from one paused timeline registered with HyperFrames (GSAP `onUpdate`, or a WAAPI/CSS proxy if GSAP's licence sign-off fails; E4).
   - Hand-drawn look: rough.js with a seed stepped from time at 8–12 fps ("boil"). There is no `Math.random`, no SMIL, and no wall-clock time.
4. **Motion library:** about 30–60 curated clips converted offline from CMU BVH by our own converter. Check the CMU terms first: they allow inclusion in products but not resale of the data. Hand-authored pose libraries cover gestures (point, shrug, think, explain).
5. **Characters beyond stick figures** reuse the same rig with richer `parts` (head shapes, clothing paths, accessories). A user drawing could later go through AnimatedDrawings offline (MIT code, archived) and come back as an alpha video clip.
6. **Diagrams and motion graphics:** Mermaid/dagre (ELK optional) layout → SVG → timeline reveals. rough.js gives an Excalidraw-like style.

---

## 3. Local illustrated scenes and characters on Apple Silicon

Runner: **mflux** (MLX, MIT; `a9b4342f6588685144198cfff04b724326e9d4c5`, 2026-11-04, 247 in 90d; moved to the `mflux-community` org in 2026-08). Its README lists Z-Image, FLUX.2 klein, FLUX 3 Image Klein, Qwen-Image and Qwen-Image 2.1, Krea 2, Iris, FIBO 2 and others. It supports LoRA, LoRA training for some models, ControlNet and multi-reference editing ([README L118-L165](https://github.com/filipstrand/mflux/blob/a9b4342f6588685144198cfff04b724326e9d4c5/README.md#L118-L165)). The alternative is diffusers on MPS.

| Model | Licence (source checked) | Commercial OK? | Size / mflux | Consistency features | Verdict |
|---|---|---|---|---|---|
| **FLUX.2 [klein] 4B** (+4B Base) | **Apache-2.0** (flux2 README licence table L24, L27, L75); FLUX.2 VAE Apache-2.0 (L111) | yes | 4B; mflux yes (training yes) | text-to-image plus **single and multi-reference editing** in one model | **Adopt (default)** |
| **Z-Image / Z-Image-Turbo** | **Apache-2.0** (Tongyi-MAI/Z-Image LICENSE; HF card unverified) | yes | 6B; mflux yes, LoRA training, ControlNet Union | LoRA | **Adopt** (fast and high quality; second default) |
| **Qwen-Image / Qwen-Image-Edit-2511** | Apache-2.0 (QwenLM/Qwen-Image LICENSE; HF card unverified) | yes | 20B, slow; text encoder about 14–15.5 GB; mflux yes | instruction editing, multi-image edit | **Optional** (quality and knowledge; 128 GB fits) |
| FLUX.1 [schnell] | Apache-2.0 (flux README L39) | yes | 12B; mflux legacy | none | Optional/legacy |
| HiDream-I1 | MIT (README L147-L149) **but needs Llama-3.1-8B-Instruct** (Llama licence; README L53) | yes, with Llama terms | 17B *(unverified)* | — | Optional; not default |
| Iris-3B | Apache-2.0 *(per mflux README L195-L196; unverified at source)* | probably | 3B | — | Watch |
| SDXL 1.0 (+ IP-Adapter) | CreativeML **OpenRAIL++-M** (generative-models `model_licenses/LICENSE-SDXL1.0`); IP-Adapter code Apache-2.0 (weights unverified) | yes, with use restrictions that must be passed on | 3.5B; diffusers/MPS | IP-Adapter, plenty of LoRAs | Fallback only (older quality) |
| SD3.5 | Stability Community Licence: free below US$1M annual revenue, Enterprise above ([stability.ai/license](https://stability.ai/license)) | conditional | — | — | Exclude as default (revenue cap) |
| FLUX.1 [dev] / Kontext [dev] / Krea [dev] / Redux | **FLUX.1-dev Non-Commercial** (flux README L40-L48) | no (outputs are usable commercially, but *using* the model commercially is not) | — | Kontext editing | **Exclude** |
| FLUX.2 [dev], FLUX.2 [klein] 9B / 9B-KV | **FLUX Non-Commercial** (flux2 README L25-L29; licence §2(b) non-commercial use only, §2(d) outputs usable commercially) | no | — | multi-reference | **Exclude** |
| FLUX 3 Image Klein | "FLUX Kommunity License v1.0": non-commercial, plus commercial *output* for qualifying users under US$5M *(per mflux flux3 README L13; unverified)* | conditional | 5.6B | up to 10 references | Exclude as default; revisit |
| Qwen-Image 2.1 | "Qwen Research License" *(per mflux qwen21 README L157; unverified)* | no | 7.1B | multi-reference | Exclude |
| FIBO 2 (Bria) | CC BY-NC 4.0 (per mflux fibo2 README L13) | no | 8.1B | edit | Exclude |
| InstantCharacter (Tencent) | "academic, research and education purposes" only (License.txt L9) | no | — | character consistency | Exclude |
| OmniGen2 | Code Apache-2.0 (LICENSE); weight licence unverified | ? | — | subject-driven | Watch |
| Krea 2, Anima, ERNIE-Image, Lens, Ming, MOSS, Ideogram 4 | not checked (huggingface.co blocked) | ? | in mflux | — | Unverified; do not ship until checked |

**Consistency methods**, in order of preference for Workflow B:

1. **Vector-first.** Stick figures and simple cartoon characters are SVG rigs (§2), so they are consistent by construction. Use diffusion only for backgrounds and illustrated scenes.
2. **Character sheet + multi-reference editing.** Generate or approve one turnaround sheet per character. Then condition each scene on it with FLUX.2 klein 4B multi-reference or Qwen-Image-Edit-2511, both Apache-2.0. Fix seeds and a style-preset prompt.
3. **LoRA for recurring brand characters or styles:** `mflux-train` on Z-Image or FLUX.2 klein 4B Base, using 10–30 approved images. Train locally and record base model, revision and licence in the model manager (R11).
4. **Cut-out compositing.** Generate the character on a plain background, matte it with BiRefNet (MIT, E5), and composite in HyperFrames with parallax. This keeps one character asset across scenes.
5. IP-Adapter on SDXL as a legacy fallback only.

Risks: model licences change, and huggingface.co could not be checked here. Before shipping any model, read its card and `LICENSE` at a pinned revision in an environment with HF access.
