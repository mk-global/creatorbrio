# 08 · Open-source and commercialisation constraints

[← Specification index](README.md) · Evidence: [E8](../evidence/e8-tts-sourcing-providers.md), [E7](../evidence/e7-openmontage-animation.md), [E5](../evidence/e5-building-blocks.md), [E3](../evidence/e3-sdks-and-renderers.md)

CreatorBrio is MIT-licensed, publicly available and may later offer paid services.
This page states what that means for code, model weights, generated assets, sourced media, audio and AI providers.
It turns those constraints into rules the product enforces (OSS-01 … OSS-03, RGT-01 … RGT-05).

> This is an engineering reading of licences and terms as retrieved on 2026-11-03/04, not legal advice. Items marked *unverified* could not be read from their primary page in the research session. Gate G9 ([11](11-implementation-program.md#1-validation-gates)) confirms them before release, and a legal review is recommended before any paid service launches.

## 1. Position

| Distribution mode | What it means here |
|---|---|
| **Open-source repository** (now) | Every user installs and runs CreatorBrio themselves. Bundled code must be redistributable under the MIT project. Optional tools and models the user installs separately keep their own licences |
| **Self-hosted by a creator or company** | The same, at larger scale: licences that count headcount or revenue (Remotion, Stability Community, Fish Audio) would bind them, which is why such components are excluded from the core |
| **Future paid service** (not designed now) | CreatorBrio or a partner operates the software for others. Network-use copyleft (AGPL), "non-commercial" API terms, personal-subscription AI access and some stock terms become decisive. §7 lists what must change |

## 2. Code and dependencies

| Class | Licences | Rule |
|---|---|---|
| Allowed to bundle | MIT, Apache-2.0 (keep NOTICE files), BSD-2/3, ISC, MPL-2.0 (file-level copyleft; keep modified MPL files open), CC0, OFL (fonts) | Default |
| Separate process, user-installed, never bundled | GPL-3.0 / LGPL builds: FFmpeg (`ffmpeg-full`), espeak-ng (Kokoro's optional fallback), Piper; EPL-2.0 ELK if used as a tool | Allowed as optional external tools that the doctor detects; never linked or shipped in the repository |
| Excluded from the product | AGPL-3.0 (OpenMontage, OpenChatCut, Concat, Ultralytics), GPL application code (Nuzky, SynthCut, etc.), source-available or field-restricted (Remotion, BaoCut, Clipkit runtime BSL, Twick SUL), non-commercial (OneTake PolyForm NC), GSAP "Standard no charge" licence in CreatorBrio-authored output | Reference only; no code copied |
| Anthropic SDKs | `@anthropic-ai/sdk` Apache-2.0 (allowed); `@anthropic-ai/claude-agent-sdk` under Anthropic's own terms (*optional*, not bundled as a requirement) | The API runtime is built on the Apache-2.0 SDK ([07 §7](07-data-models-and-interfaces.md#7-model-gateway-interface)) |

**Key reused components and their licences** (from the evidence): HyperFrames Apache-2.0 (confirm per-package on npm at G9), mediabunny MPL-2.0, `@xzdarcy/react-timeline-editor` MIT, Mermaid MIT, rough.js MIT, anime.js MIT, Lottie runtimes MIT, MCP SDK MIT, mlx / mlx-audio MIT, parakeet-mlx Apache-2.0, whisper.cpp MIT, Silero VAD MIT, DeepFilterNet MIT/Apache-2.0, PySceneDetect BSD-3, Earshot MIT, Manim MIT (external tool).

**Adapted code and techniques** must carry attribution where code or text is derived:

- Ghost Editor (MIT);
- OpenEdit (Apache-2.0, with its NOTICE);
- Lemo-Opuscar (MIT code, CC BY 4.0 films);
- gbro-collage-info (MIT);
- HyperFrames registry blocks (Apache-2.0).

Techniques learned from copyleft or non-commercial projects (OpenMontage, Nuzky, OneTake) are reimplemented from first principles without copying code or text.

**Enforcement:** a dependency licence scan in CI fails on any licence outside the allow-list (OSS-01). `docs/PROVENANCE.md` records any adapted code.

## 3. Model weights

The model manager records each model's weights licence and commercial-use status, and the rights policy treats a model's outputs accordingly (OSS-02, RGT-05).

| Model | Use | Weights licence | Commercial use | Default |
|---|---|---|---|---|
| Parakeet TDT 0.6B v3 | ASR | CC-BY-4.0 (attribution in About and credits) | Yes, with attribution | On |
| Whisper large-v3-turbo (whisper.cpp) | ASR, other languages | MIT | Yes | On |
| Silero VAD | Speech activity | MIT | Yes | On |
| Qwen3-ForcedAligner | Alignment | Apache-2.0 | Yes | On |
| **Kokoro-82M** | Narration | Apache-2.0 | Yes | **On (primary voice)** |
| **Chatterbox** Multilingual V3 / Turbo | Consented voice cloning | MIT (*model card unverified; one sibling repo states Apache-2.0*) | Yes, if confirmed | Opt-in, consent required |
| VoxCPM2, Qwen3-TTS | Alternatives | Apache-2.0 (per their READMEs) | Yes | Candidates at G4 |
| F5-TTS, XTTS-v2, Higgs v3, Voxtral TTS | — | Non-commercial | No | **Excluded** |
| Fish Audio / OpenAudio, IndexTTS, KittenTTS-2 | — | Restrictive custom licences | Restricted | **Excluded** |
| Piper | — | GPL-3.0 code, per-voice licences | Varies | Excluded from default |
| DeepFilterNet3 | Denoise | MIT / Apache-2.0 | Yes | On |
| SigLIP 2 | Visual search | Apache-2.0 | Yes | On |
| CLAP | Audio search | *Checkpoint licence unverified* | Confirm at G9 | On after G9 |
| SAM 3.1 | Open-vocabulary masks | SAM License (gated download) | Yes, with Meta's terms | Opt-in |
| BiRefNet | Matte fallback | MIT | Yes | Optional |
| RMBG-2.0, MatAnyone | — | Non-commercial | No | **Excluded** |
| **FLUX.2 [klein] 4B**, **Z-Image** | Illustrations (via mflux) | Apache-2.0 (*per E7; model cards unverified*) | Yes, if confirmed | Reference model for the image-service contract |
| FLUX.1 schnell, Qwen-Image (Apache-2.0); SDXL (OpenRAIL++-M) | Illustration alternatives | As stated | Yes (OpenRAIL use restrictions apply) | Optional |
| FLUX.1 dev / Kontext / Krea, FLUX.2 dev, FLUX.2 [klein] 9B | — | Non-commercial | No | **Excluded** from commercial productions |
| SD 3.5, Stable Audio 3.0 | — | Stability Community (free under US$1M revenue) | Conditional | Optional, labelled |
| ACE-Step 1.5 | Music generation | MIT (training-data provenance is the user's risk per its README) | Yes | Optional |
| MusicGen / AudioGen, MMAudio, CrisperWhisper | — | Non-commercial | No | **Excluded** (opt-in for personal use only if the founder decides so) |
| CMU motion-capture clips | Stick-figure motion library | *Terms unverified* (site unreachable) | Confirm at G6/G9 | Off until cleared |

**The founder's existing image service** runs a FLUX.2 Klein variant ([#27](https://github.com/mk-global/creatorbrio/issues/27)).
The 4B variant is reported as Apache-2.0; the 9B variant is non-commercial ([E7](../evidence/e7-openmontage-animation.md)).
The service is private and not part of this repository.
Before public distribution, CreatorBrio needs a reference implementation of the image-service contract that uses a commercially licensed model, and the service must report which model produced each image, so the rights policy can label it.

## 4. AI providers and terms

### What Anthropic's terms say (retrieved 2026-11-04)

From the Claude Agent SDK overview (<https://code.claude.com/docs/en/agent-sdk/overview>):

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."

From Claude Code legal and compliance (<https://code.claude.com/docs/en/legal-and-compliance>):

> "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens …"

The same page does not prevent "an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
For products that run Claude Code it adds: "Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf."

### What CreatorBrio does about it

| Runtime | Allowed arrangement | Rules CreatorBrio enforces |
|---|---|---|
| `claude-code-cli` | A person runs CreatorBrio locally and it spawns *their own* installed, unmodified `claude`, signed in through Anthropic's own flow | CreatorBrio never reads, stores or forwards Claude credentials or session tokens, never offers a "Sign in with Claude" button, never modifies the binary, and never serves more than the signed-in person. Runs are user-initiated. It is not used for any hosted or multi-user deployment |
| `anthropic-api` | API key (the user's own in self-hosted use, or the operator's under Anthropic's Commercial Terms for a service) | The required runtime for anything offered to other people. Built on `@anthropic-ai/sdk` (Apache-2.0) |
| `openai-compatible` | Local models (Ollama, LM Studio, llama.cpp server; MLX-LM lacks JSON-schema output) or other providers | Each model's licence recorded (for example Llama-family licences); roles refused when capabilities are missing |
| `manual` | No AI | Always available |

Product naming and branding stay CreatorBrio's own, as the Agent SDK overview asks: CreatorBrio must not appear to be Claude Code or an Anthropic product.
Whether the "may not pay for, resell, or intermediate" clause also applies to an Agent-SDK-based paid service is not clear from the text. It must be confirmed with Anthropic before any paid tier ([§8](#8-decisions-for-the-founder)).

## 5. Generated assets

| Topic | Rule |
|---|---|
| Provenance | Every generated asset records engine, version, weights licence, parameters and seed (RGT-05) |
| Model output restrictions | The model's licence governs outputs. Non-commercial models cannot produce assets for commercial productions; the rights policy blocks them |
| AI disclosure | Generated narration, illustrations and music are labelled AI-generated in the ledger and listed in the credits. A production-level "contains AI-generated media" note is available for platforms that require disclosure |
| Synthetic voices | Cloned voices require recorded consent from the voice's owner; no public figures. Synthetic narration is marked in the render manifest. Because the mlx-audio Chatterbox port drops upstream's audio watermark ([E8](../evidence/e8-tts-sourcing-providers.md)), CreatorBrio records provenance in the manifest and bundle |
| Copyright in AI outputs | Protection for purely AI-generated material is uncertain in several jurisdictions. CreatorBrio records which parts are human-authored (script, edits, selections) and which are generated, and makes no claim about ownership |
| Real people | No generative model alters a real person's face, body or voice; the existing image-editing rule extends to video ([merged research baseline](../01-creatorbrio-baseline.md#existing-product-rules-video-studio-must-keep)) |

## 6. Sourced media and audio

| Source | Default | Obligations recorded and enforced |
|---|---|---|
| Wikimedia Commons | On | Descriptive User-Agent with contact; per-file licence and credit from `extmetadata` (unreliable for multi-licensed files, so the user confirms these); BY-SA needs acknowledgement; personality and trademark restrictions recorded |
| Openverse | On | Query with commercial and modification filters for commercial productions; use the supplied `attribution` string; re-verify at the landing page; no scraping |
| Freesound | **Opt-in**, user's own key | API terms: "free only for non-commercial purposes" (updated 2026-10-01). Assets carry `noncommercial-api`; a commercial production needs review and the user's own Freesound agreement. Credit Freesound and authors |
| Internet Archive | **Opt-in** | Site terms are research-oriented (*current text unverified*); only items with CC0/PDM/CC BY `licenseurl` are offered; all carry `research-use` and need review |
| Pexels | Optional, user's key | Credit the photographer and link to Pexels; no redistribution of unaltered files |
| Pixabay | Optional, user's key | Cache results 24 h; link to Pixabay; **never input to generative features** (`no-ai-input`); no standalone redistribution |
| NASA, Smithsonian Open Access, Library of Congress | Optional | No implied endorsement (NASA); open-access filter (Smithsonian); 20 requests/min and rights advisory recorded (LoC) |
| User libraries | On | The user records the licence when adding a folder; unknown means needs review |
| Music and SFX packs | On for CC0 packs (e.g. `uisfx`); Mixkit excluded (terms forbid several uses) | Licence per file |
| Earshot procedural SFX | On | Generated locally from code (MIT); no third-party rights |
| Fonts | Google Fonts (OFL) via the existing font system | User-uploaded fonts are the user's responsibility; recorded in the ledger |

Defaults across connectors:

- CC0, public domain, CC BY, Pexels and Pixabay are allowed.
- CC BY-SA is allowed after acknowledgement.
- NC, ND and unknown are excluded from commercial productions.

Export writes credits automatically and is refused when a required credit is missing (RGT-03).

## 7. Readiness for a future paid service

Nothing below is built now; it is the checklist a paid service must satisfy.

1. AI runs on `anthropic-api` or another provider under commercial terms, never on a user's Claude subscription. Anthropic's position on operator-paid usage must be confirmed in writing.
2. Freesound and Internet Archive connectors stay disabled unless commercial agreements exist; Pexels and Pixabay terms are reviewed for service use.
3. Only models with commercially usable weights are enabled. The Stability Community licence and the Parakeet attribution obligations are re-checked at the service's scale.
4. FFmpeg and other GPL tools may run server-side without distribution. If binaries are ever distributed with the product, GPL source obligations apply.
5. Apache NOTICE files and MIT attributions ship with the product.
6. Trademarks: no use of HeyGen, OpenFilm, Anthropic, Claude or other marks in product naming.

## 8. Decisions for the founder

These are needed at gate G0:

1. **Usage-intent default** for new productions: `commercial` (recommended, since creators monetise) or `personal`.
2. **CC BY-SA**: allow after acknowledgement (recommended), or exclude entirely.
3. **Freesound and Internet Archive**: ship as opt-in connectors with the terms shown (recommended), or omit.
4. **Non-commercial models for personal use** (CrisperWhisper for fillers, FLUX.1 dev): allow as clearly labelled opt-ins blocked for commercial productions, or exclude entirely.
5. **Voice cloning**: enable for the creators' own voices with recorded consent (recommended), or defer.
6. **Image service**: replace the private FLUX.2 Klein service's model with a confirmed Apache-2.0 model before public distribution, and publish a reference implementation of the contract.
7. **Anthropic confirmation**: seek written confirmation of acceptable arrangements before any paid tier.
