# R2 · Research, speech, audio, video and image-composition technologies

Retrieved and assessed on 2026-11-17.
This is an engineering reading of licences and terms, not legal advice.

## Scope and method

This report covers five categories for CreatorBrio: C (research and evidence gathering), E (speech recognition and alignment), F (speech synthesis, audio and music), G (video, animation, image generation and rendering) and H (thumbnails, covers, templates and brand consistency).
For E, F and G it re-verifies the media research completed on 2026-11-04 (`docs/research/video-studio/02-ecosystem-inventory.md`, evidence E1 to E8, `spec/05-capability-matrix.md`, `spec/08-licensing-and-commercial.md`) and states per candidate whether anything changed.
It also reads the decisions the repository made after that research, notably the G1 renderer gate of 2026-11-06 (`docs/roadmap/video-studio/gates/g1-renderer.md`), because that gate changed one of the research's verdicts.

Evidence came from four places.
GitHub metadata came from `gh api repos/OWNER/REPO`, `/releases?per_page=3`, `/commits?per_page=1`, licence files and README files.
Package versions came from the npm registry and PyPI JSON.
Model weight licences came from the Hugging Face model API (`https://huggingface.co/api/models/<id>`, field `cardData.license`) and model cards.
Terms of service came from WebFetch of the providers' own pages, with WebSearch only where a page could not be fetched.
Nothing was installed, cloned or executed.
One exception to "no download" must be disclosed: to read Polotno's licence, the npm tarball for `polotno@4.20.1` was downloaded to a temporary folder and only its `LICENSE.md` was extracted and read; nothing was installed or run.

A material difference from the 2026-11-04 research: `huggingface.co` is reachable from this session, so most weight licences that were marked "unverified" there are now verified from the primary model API.

**Evidence labels**

- [F]: fetched from a primary source (repository, registry, model API, the provider's own page) on 2026-11-17, with the URL given in the entry or in Sources.
- [S]: seen only through a web search result or a secondary page.
- UNVERIFIED: not confirmed in this session.
- Documentation URLs are listed as pointers; they were not fetched unless a fact cites them with [F].

**Decision vocabulary**

- ADOPT: use as a dependency of CreatorBrio or of its own media worker.
- INTEGRATE: call as a separate user-installed process, a separately installed model, or an external API, through an adapter.
- STUDY: design reference only, or revisit later; no code or weights used now.
- BUILD: CreatorBrio implements the capability itself.
- REJECT: not used.

**Licensing policy applied** (from the brief and `spec/08`): permissive and MPL-2.0 code may be bundled; GPL tools only as separate user-installed processes, never bundled; AGPL is not copied into the MIT core; source-available components are excluded from anything distributed; non-commercial weights are unusable for the commercial product.

## Summary matrix

"Changed?" is answered for E, F and G candidates against the 2026-11-04 research, and is "new" for candidates that research did not cover.

| Candidate | Cat. | Code licence | Weights / data licence | Last release (date) | Decision | One-line reason | Changed since 2026-11-04? |
|---|---|---|---|---|---|---|---|
| Defuddle | C | MIT | n/a | 0.19.6 (2026-10-24) | ADOPT | Active Node extractor that returns Markdown and metadata, fits behind the existing SSRF-safe retrieval | new |
| Mozilla Readability | C | Apache-2.0 | n/a | npm 0.6.0 (2025-03-03) | STUDY | Proven but slow-moving; keep as a fallback option for Defuddle | new |
| Trafilatura | C | Apache-2.0 | n/a | v2.3.1 (2026-10-06) | STUDY | Strong extractor but Python; only worth it if the Python worker exists and Defuddle underperforms | new |
| Crawl4AI | C | Apache-2.0 plus an extra attribution rider | n/a | v0.9.5 (2026-10-14) | REJECT | Crawler-scale tool with a non-standard attribution clause; CreatorBrio fetches a few user-linked pages | new |
| Firecrawl | C | AGPL-3.0 (server), MIT (SDKs) | n/a | v2.11.0 (2026-06-19) | REJECT | AGPL server; hosted API adds a paid third party to a simple fetch | new |
| Jina Reader | C | Apache-2.0 code, needs non-redistributable assets | MaxMind GeoLite, fonts | no release; last commit 2026-05-22 | REJECT | Self-host needs licensed assets; hosted r.jina.ai is an Elastic service that sees every URL | new |
| SearXNG | C | AGPL-3.0 | n/a | rolling; last commit 2026-11-17 | REJECT as a dependency (user-supplied service only) | AGPL is excluded by `spec/08`; a self-hoster may point the search endpoint setting at their own instance, which scrapes upstream engines, so never for SaaS | new |
| Brave Search API | C | proprietary API | results: no storage beyond transient without a custom plan | n/a | INTEGRATE (BYOK, default web search) | Own index, clear terms, free credits; store only what CreatorBrio fetches itself | new |
| Tavily | C | proprietary API | terms silent on caching; anti-competition clauses | n/a | INTEGRATE (BYOK, optional) | Usable search-plus-extract API; now branded "Tavily by Nebius" | new |
| Exa | C | proprietary API | no copying or redistribution of obtained information except as permitted | n/a | INTEGRATE (BYOK, optional) | Good semantic search, strictest storage wording | new |
| SerpAPI | C | proprietary API | scraped Google results | n/a | REJECT | Resells scraped search-engine results; legal shield only on higher paid plans | new |
| yt-dlp | C | Unlicense (repo, wheel); GPLv3+ (PyInstaller binaries) | platform media under platform terms | 2026.10.26 | REJECT | Licence is fine, but downloading platform media breaches YouTube and Instagram terms | new |
| YouTube Data API (search.list) | C | proprietary API | 30-day refresh-or-delete; no download of media | n/a | INTEGRATE (BYOK, metadata only) | The legitimate route to public Shorts metadata; search has its own 100 calls/day bucket | new |
| Instagram Graph API (Business Discovery, Hashtag Search) | C | proprietary API | Meta Platform Terms | n/a | INTEGRATE (later, needs app review) | The legitimate route to other professional accounts' public metrics | new |
| TikTok Research API | C | proprietary API | research-only | n/a | REJECT | Commercial users are not eligible | new |
| Short-form trend tools (open source) | C | various | downloader-based | n/a | BUILD | No open tool found that uses official APIs; build analysis on first-party and official-API data | new |
| parakeet-mlx (Parakeet TDT 0.6B v3) | E | Apache-2.0 | CC-BY-4.0 [F] | PyPI 0.7.0 (2026-11-04) | ADOPT (in the Python worker) | Primary Apple Silicon ASR with word timings | Minor: new 0.7.0 release; weights licence now verified |
| whisper.cpp | E | MIT | Whisper weights MIT [F] | v1.9.5 (2026-10-06) | INTEGRATE | Second ASR for other languages and Linux | Unchanged |
| faster-whisper | E | MIT | MIT (Systran conversions) [F] | v1.2.1 (2025-10-31) | STUDY (Linux/CUDA hosting) | CPU-only on Mac; relevant only for a CUDA SaaS tier | Unchanged |
| WhisperX | E | BSD-2-Clause | wav2vec2 aligners vary; diarization via gated pyannote | v3.8.6 (2026-05-25) | REJECT | Heavy stack, no Apple GPU path, gated dependency | Unchanged |
| sherpa-onnx | E | Apache-2.0 | per model | rolling (2026-11-16) | INTEGRATE (Linux path) | Runs Parakeet and VAD on CPU on Linux without NeMo | new |
| pyannote.audio | E | MIT | community-1 CC-BY-4.0, gated click-through [F] | 4.1.0 (2026-11-17) | STUDY (defer) | Diarization not needed for single-speaker reels | Changed: 4.1.0 released today (Python 3.11+, MPS fbank) |
| Silero VAD | E | MIT | MIT | v6.2.3 (2026-09-23) | ADOPT | Speech activity for silence and filler gaps | Unchanged |
| stable-ts | E | MIT | n/a | PyPI 2.19.1 (2025-08-16) | REJECT | Repository is now archived | Changed: was "paused", now archived |
| Montreal Forced Aligner | E | MIT | pretrained models CC-BY-4.0 [F] | v3.4.4 (2026-11-16) | STUDY | Accurate phone-level alignment but a conda/Kaldi stack | new (not in earlier research) |
| Qwen3-ForcedAligner (via mlx-audio) | E | Apache-2.0 | Apache-2.0 [F] | weights 2026-01-30 | ADOPT after validation | Realigns known text (narration, corrected transcripts) | Weights licence now verified |
| mlx-audio | E/F | MIT | per model | v0.6.6 (2026-11-16) | ADOPT (runtime in the worker) | MLX host for Parakeet ports, Kokoro, Chatterbox, aligner, DeepFilterNet | Changed: repository moved from Blaizzy to Neywa-Labs |
| Piper (OHF-Voice/piper1-gpl) | F | GPL-3.0 | per voice; a commercial-use allow-list now exists | v1.8.0 (2026-09-04) | INTEGRATE (optional, separate process, allow-listed voices) | Engine is GPL, but voices were retrained off lessac and a commercial list was published | Changed materially on 2026-11-09 |
| Kokoro-82M | F | Apache-2.0 | Apache-2.0 [F] | PyPI 0.9.4 (2025-04-05) | ADOPT (primary narration) | Small, permissive, word timings in English | Unchanged; weights verified |
| Chatterbox | F | MIT | MIT [F] (chatterbox, chatterbox-turbo); Apache-2.0 (chatterbox-hf) | PyPI 0.1.7 (2026-03-26) | INTEGRATE (opt-in consented cloning) | Commercially usable cloning | Weights licence now verified |
| F5-TTS | F | MIT | CC-BY-NC-4.0 [F] | 1.1.22 (2026-07-23) | REJECT | Non-commercial weights | Unchanged; verified |
| Dia / Dia2 | F | Apache-2.0 | Apache-2.0 [F] | none; last commits 2025-11 | REJECT | Dormant, English only, Dia2 needs CUDA | Unchanged; weights verified |
| VoxCPM2 | F | Apache-2.0 | Apache-2.0 [F] | 2.0.3 (2026-05-11) | INTEGRATE (alternative cloning engine, gate G4) | Commercial weights, 30 languages | Unchanged; verified |
| Qwen3-TTS | F | Apache-2.0 | Apache-2.0 [F] | no release; last commit 2026-03-17 | STUDY | Instruction-controlled voice design | Unchanged; verified |
| OmniVoice | F | Apache-2.0 | **CC-BY-NC** [F] | 0.2.1 (2026-07-16) | REJECT | Model card states non-commercial weights | **Corrected: E8 listed Apache-2.0 (unverified)** |
| Audio8-TTS, Zonos 2/3 (2026 entrants) | F | Apache-2.0 [S] | Apache-2.0 [S] | 2026 [S] | STUDY | Reported Apache weights; not verified at source | new |
| DeepFilterNet3 | F | MIT OR Apache-2.0 | MIT OR Apache-2.0, now stated explicitly [F] | v0.5.6 (2023-08-31) | ADOPT (voice denoise) | Best permissive denoiser; weights licence now explicit | Changed: README covers weights since 2026-11-06 |
| Demucs v4 | F | MIT | unclear, likely non-commercial per author [F] | 4.1.0 (2026-07-11) | REJECT (default) | Weights licence unresolved | Unchanged |
| RNNoise | F | BSD-3-Clause | trained only on public datasets per README [F] | v0.2 (2024-04-15) | STUDY (fallback) | Light, permissive, weaker than DeepFilterNet | new |
| MusicGen / AudioGen | F | MIT | CC-BY-NC-4.0 [F] | audiocraft 1.3.0 (2024-06-03) | REJECT | Non-commercial weights | Unchanged; verified |
| Stable Audio Open 1.0 / Small | F | MIT (stable-audio-tools) | Stability AI Community License, gated [F] | tools 0.0.20 (2026-05-20) | REJECT (default); labelled opt-in only | Revenue-capped licence binds the operator | Unchanged |
| ACE-Step 1.5 | F | MIT | MIT [F] | v0.1.8 (2026-05-18) | INTEGRATE (optional music) | Permissive local music generation | Unchanged; verified |
| Freesound | F | AGPL-3.0 (site code, irrelevant) | API free only for non-commercial use [F] | n/a | INTEGRATE (opt-in, user key, labelled) | Terms block commercial API use | Unchanged |
| Pixabay | F | n/a | Pixabay Content License | n/a | INTEGRATE (optional, user key) | Permissive with no-standalone-redistribution and no-AI-input rules | Unchanged |
| OpenCut | G | MIT | n/a | v0.3.0 (2026-04-15); last commit 2026-09-24 | REJECT | Rewrite scaffold only | Unchanged |
| VEED OpenEdit | G | Apache-2.0 + NOTICE | n/a | no versioned release; mirror commit 2026-11-11 | STUDY (adapt named techniques with NOTICE) | Clean TypeScript reference for virtual clock, EDL, safe zones | Unchanged; still active |
| HyperFrames | G | Apache-2.0 | n/a | v0.9.61 (2026-11-17) | REJECT (dependency); STUDY (registry ideas) | Runtime still builds on GSAP, which failed CreatorBrio's G1 gate | Licence unchanged; repo decision changed 2026-11-06 |
| Remotion | G | Remotion License (source-available) | n/a | v4.0.544 (2026-11-16) | REJECT | Company licence above 3 people binds every user | Unchanged in substance (links edited 2026-11-09) |
| Motion Canvas | G | MIT | n/a | v3.17.2 (2024-12-14) | REJECT | Dormant Canvas2D engine | Unchanged |
| Revideo | G | MIT | n/a | v0.11.0 (tag); last commit 2026-07-15 | REJECT | Dormant; Canvas2D, not HTML | Unchanged |
| FFmpeg | G | LGPL-2.1+ core; GPL when built with `--enable-gpl` | codecs vary (x264 GPL) | 9.0.2 (2026-09-18) | INTEGRATE (user-installed process; already done) | Already CreatorBrio's media engine | Unchanged |
| MLT | G | LGPL-2.1 core; GPL modules present | n/a | v7.42.0 (2026-10-03) | REJECT | Second timeline engine; CreatorBrio already compiles its own FFmpeg graphs | new |
| FLUX.2 [klein] 4B | G | Apache-2.0 | Apache-2.0, not gated [F] | weights 2026-02-24 | ADOPT (reference model of the image service) | Best verified permissive image model with editing | Weights licence now verified |
| FLUX.1 [schnell] | G | Apache-2.0 | Apache-2.0, click-through gated [F] | 2024 | STUDY (legacy) | Superseded by FLUX.2 klein 4B | Unchanged |
| FLUX.1 [dev], FLUX.2 [dev], FLUX.2 [klein] 9B | G | Apache-2.0 (code) | FLUX non-commercial licences [F] | 2025-2026 | REJECT | Non-commercial weights | Unchanged; verified |
| Stable Diffusion 3.5 | G | MIT (sd3.5 repo) | Stability AI Community License, gated [F] | 2024-10 | REJECT (default) | Revenue-capped; not needed given Apache models | Unchanged |
| SDXL 1.0 | G | MIT (generative-models) | CreativeML OpenRAIL++-M [F] | 2023 | STUDY (fallback only) | Commercial use allowed with pass-through use restrictions; older quality | Unchanged |
| Qwen-Image / Qwen-Image-Edit-2511 | G | Apache-2.0 | Apache-2.0 [F] | weights 2025-12-23 | INTEGRATE (optional, large) | Strong text rendering and editing; 20B is heavy | Weights licence now verified |
| Z-Image / Z-Image-Turbo | G | Apache-2.0 | Apache-2.0 [F] | weights 2026-01-30 | INTEGRATE (second model) | Fast, permissive | Weights licence now verified |
| mflux | G | MIT | per model | v0.24.0 (2026-10-27) | ADOPT (image-service runner on Apple Silicon) | MLX runner for the models above | Unchanged (org move already known) |
| ComfyUI | G | GPL-3.0 | per model | v0.45.0 (2026-11-10) | INTEGRATE (optional user-run backend) | Popular local host; separate process over HTTP; custom nodes are an execution risk | new |
| diffusers | G | Apache-2.0 | per model | v0.43.0 (2026-11-12) | INTEGRATE (Linux/CUDA image service) | Standard runner off Apple Silicon | new |
| Puppeteer screenshot templating | H | Apache-2.0 | Chrome for Testing | 25.18.0 (2026-11-17) | ADOPT (already in use) | The single rendering contract for slides, covers and overlays | n/a |
| sharp / libvips | H | Apache-2.0 (sharp); LGPL-3.0-or-later (prebuilt libvips) | n/a | sharp 0.35.5 (2026-09-27) | ADOPT (already in use) | Raster post-processing, resizing, encoding | n/a |
| Satori | H | MPL-2.0 | n/a | 0.63.2 (2026-10-20) | STUDY | Fast HTML-to-SVG without a browser, but its own layout engine diverges from Chromium | n/a |
| Takumi | H | MIT OR Apache-2.0 | n/a | 2.20.0 (2026-11-08) | STUDY | Rust layout engine with Chromium-ported text layout; a candidate for SaaS throughput | new |
| resvg | H | Apache-2.0 | n/a | v0.50.0 (2026-11-11) | STUDY | Only needed if SVG is rasterised outside Chromium | n/a (moved to linebender) |
| Polotno SDK | H | proprietary subscription | n/a | 4.20.1 (2026-11-11) | REJECT | Production use, including internal tools, needs a paid subscription | n/a |
| Fabric.js / Konva | H | MIT | n/a | 7.4.0 / 10.9.1 | STUDY | Canvas editors that would fork the HTML-slide model | n/a |
| tldraw | H | tldraw licence (source-available, licence key) | n/a | v5.6.1 (2026-11-16) | REJECT | No production use without a licence | n/a |
| Style Dictionary + DTCG tokens | H | Apache-2.0 | n/a | v5.8.0 (2026-11-03) | BUILD (brand kit as DTCG tokens); STUDY Style Dictionary | Brand consistency is a data-model problem CreatorBrio should own | n/a |

## What changed since the 2026-11-04 research

1. **Piper voices (F).** On 2026-11-09 the Piper project published `docs/LICENSING.md` and `docs/COMMERCIAL_USE.md` and began retraining voices away from the lessac base, whose licence limits use to research [F].
   Voices are now fine-tuned from two from-scratch bases, `nl_BE-rdh-medium` (CC0) and `en_US-hifi_tts_92-medium` (CC BY 4.0), and the project lists voices whose whole training chain is commercially usable [F].
   The engine remains GPL-3.0 and the project still makes "no license grant of its own over voice models" [F].
   This moves Piper from "excluded from default" to an optional separate-process engine restricted to the published list.
2. **OmniVoice weights are CC-BY-NC (F).** E8 listed them as Apache-2.0 "(HF, unverified)"; the model card says "The pre-trained model is licensed under the CC-BY-NC due to constraints from its training data (e.g., Emilia)" [F].
3. **DeepFilterNet weights (F).** A README commit on 2026-11-06 changed "All code in this repository" to "All code and model weights in this repository are dual-licensed" under MIT or Apache-2.0 [F].
   This removes the weights question; the last release is still v0.5.6 from 2023.
4. **HyperFrames (G).** Its licence is unchanged (Apache-2.0), but CreatorBrio's G1 gate failed it on 2026-11-06 because its runtime requires GSAP, which `spec/08` excludes.
   The runtime still pins GSAP 3.15.0 from a CDN and has GSAP parsers and writers in `packages/core/src` [F], so the gate result stands.
5. **mlx-audio moved (E/F).** `Blaizzy/mlx-audio` now redirects to `Neywa-Labs/mlx-audio`, the organisation of a startup its author announced in late October 2026 [F for the redirect; S for the company].
   Licence is still MIT [F].
6. **stable-ts is archived (E)** [F]; E5 recorded only a "paused" README note.
7. **pyannote.audio 4.1.0 (E)** was released on 2026-11-17 with breaking changes (Python 3.11+, renamed audio APIs) and MPS feature computation [F].
8. **parakeet-mlx 0.7.0 (E)** was published on 2026-11-04 [F]; licence unchanged.
9. **Weights now verified at source:** Parakeet v3 (CC-BY-4.0), Kokoro (Apache-2.0), Chatterbox (MIT), Qwen3-ForcedAligner (Apache-2.0), VoxCPM2 (Apache-2.0), Qwen3-TTS (Apache-2.0), Dia and Dia2 (Apache-2.0), F5-TTS (CC-BY-NC), MusicGen (CC-BY-NC), ACE-Step 1.5 (MIT), FLUX.2 klein 4B (Apache-2.0), Z-Image (Apache-2.0), Qwen-Image (Apache-2.0), LAION CLAP checkpoints (Apache-2.0) [F, HF model API].
10. **Remotion** edited only links in its LICENSE on 2026-11-09 [F]; the pending Remotion 5.0 licence (PR #3750, open since 2024) would count contractors towards team size [F].

No other E, F or G candidate in the brief changed licence, home or maintenance status in a way that alters the 2026-11-04 conclusions.

---

## C. Research and evidence gathering

### What CreatorBrio already has

`src/lib/source-retrieval.ts` fetches at most three user-linked pages per message with strict SSRF controls: every hop is a validated URL, every resolved address must be public unicast, the connection goes to the validated address, no cookies or authorisation are sent, and time and size are bounded [F, repository at origin/main].
`src/lib/source-text.ts` turns HTML into plain text with its own tag stripping and entity decoding, capped at 20,000 characters [F].
There is no web search, no main-content detection beyond tag classes, no Markdown, no structured metadata (author, date, canonical URL) and no citation record.
The right shape is therefore: keep the retrieval layer, replace only the HTML-to-text step with a proper extractor, add a search-provider abstraction, and add a citation record.

### C1. Defuddle

- Repository: https://github.com/kepano/defuddle; docs: README and https://defuddle.md (pointer).
  Owner kepano (Obsidian's CEO); created for Obsidian Web Clipper [F, README].
- Maintenance: 0.19.6 on 2026-10-24, last commit 2026-10-25, about 10k stars [F].
  The README warns "Defuddle is very much a work in progress!" [F].
- Code licence: MIT [F, LICENSE via API; npm `defuddle` 0.19.6 MIT].
- Rights: may be copied, bundled, modified and sold from an MIT repository; keep the notice.
- Stack: TypeScript; `defuddle/node` accepts a DOM `Document` from JSDOM, linkedom or happy-dom [F, README].
  Runs in-process in Node; no Python, no GPU.
- Output: cleaned HTML or Markdown plus title, author and schema.org metadata [F, README].
- Security: parses untrusted HTML; with linkedom no script runs.
  It must stay behind the existing SSRF-safe fetch and receive bytes, never a URL to fetch itself.
- Integration: small.
  Replace the extraction in `source-text.ts` with Defuddle over a linkedom document, keep the 20,000-character cap and the "untrusted data" framing.
- Replaces: CreatorBrio's hand-written text extraction.
- **Decision: ADOPT.** Active, permissive, Node-native and Markdown-first, which is what an agent prompt wants.

### C2. Mozilla Readability

- Repository: https://github.com/mozilla/readability.
- Maintenance: npm `@mozilla/readability` 0.6.0 published 2025-03-03; last commit 2026-07-09 [F].
- Code licence: Apache-2.0 [F].
- Rights: bundle with the Apache notice.
- Stack: needs a DOM (jsdom or linkedom); outputs HTML, not Markdown, so it needs turndown (MIT, 7.2.5 on 2026-11-04 [F]) for Markdown.
- **Decision: STUDY.** Use only as a fallback if Defuddle regresses on a page class; Defuddle describes itself as a Readability replacement [F, README].

### C3. Trafilatura

- Repository: https://github.com/adbar/trafilatura; docs https://trafilatura.readthedocs.io.
- Maintenance: v2.3.1 on 2026-10-06, commit on 2026-11-17 [F].
- Code licence: Apache-2.0 [F].
- Stack: Python; would live in the planned media worker, not in Node.
- **Decision: STUDY.** Keep as the benchmark to compare Defuddle against; adopting a Python dependency for three pages per message is not justified.

### C4. Crawl4AI

- Repository: https://github.com/unclecode/crawl4ai.
- Maintenance: v0.9.5 on 2026-10-14, commit 2026-11-17 [F].
- Licence: Apache-2.0 text followed by an "Attribution Requirement" that applies to "All distributions, publications, or public uses of this software", including the About page of web applications and the acknowledgements of articles [F, LICENSE].
  This rider goes beyond Apache-2.0's NOTICE mechanism; it is not a plain OSI licence.
- Stack: Python with a Playwright browser.
- **Decision: REJECT.** It solves crawling at scale, which CreatorBrio does not do, and the rider adds obligations to every public use.

### C5. Firecrawl

- Repository: https://github.com/firecrawl/firecrawl (moved from `mendableai/firecrawl`) [F].
- Maintenance: v2.11.0 on 2026-06-19, commit 2026-11-17 [F].
- Licence: AGPL-3.0 for the server [F]; SDKs were relicensed MIT in 2024 [F, LICENSE commit history "Update SDKs to MIT license"].
- Rights: the server cannot be copied into the MIT core; the hosted API is a paid third party.
- **Decision: REJECT.** AGPL for the self-hosted path and a paid intermediary for the hosted path, for a job CreatorBrio's own retrieval already does safely.

### C6. Jina Reader

- Repository: https://github.com/jina-ai/reader; hosted service `r.jina.ai`.
- Owner: Jina AI, acquired by Elastic, completed 2025-10-09 [S, Business Wire]; Jina's legal page points to Elastic's data-processing terms [S].
- Maintenance: no releases; last commit 2026-05-22 [F].
  README says the open branch was re-synchronised with the SaaS code in 2026-04 [F].
- Licence: Apache-2.0 code [F]; self-hosting needs "non-redistributable artifacts" in `licensed/`, including MaxMind GeoLite databases [F, README].
- Security and privacy: the hosted service receives every URL a user researches.
- **Decision: REJECT.** The self-hosted path depends on non-redistributable assets and the hosted path is an external processor.

### C7. SearXNG

- Repository: https://github.com/searxng/searxng; docs https://docs.searxng.org.
- Maintenance: rolling releases, commit 2026-11-17 [F].
- Licence: AGPL-3.0 [F].
- Rights: never copied into the core.
  `spec/08` excludes AGPL code from the product with no allowance for an unmodified separate service, so CreatorBrio does not integrate, bundle or distribute it.
  A self-hoster may run it themselves and point CreatorBrio's generic search endpoint setting at it.
  If CreatorBrio ever offered a modified SearXNG to users over a network, AGPL source obligations would apply.
- Terms risk: SearXNG works by querying upstream engines (Google, Bing and others) as an automated client, which those engines' terms generally prohibit (UNVERIFIED for each engine's current text).
- **Decision: REJECT as a dependency (user-supplied service only).** Useful to a self-hoster for a no-key local setup; never in the SaaS, where the operator would be the one sending automated queries.

### C8. Proprietary search APIs

All four are external APIs called with the user's or operator's key; none is code CreatorBrio distributes.
The decisive question is what may be stored, because CreatorBrio needs durable citations.

| Provider | Storage and reuse terms | Other relevant terms | Decision |
|---|---|---|---|
| Brave Search API | Customers may not "store, cache, or create a database of Search Results, in whole or in part, other than transient storage", may not "redistribute, resell, or sublicense the Search Results", and may not use them "to create, evaluate, train, re-train, fine-tune, benchmark" models; terms last updated 2026-09-01 [F, api-dashboard.search.brave.com/terms-of-service]. The product page answers "Can I store results or use them to train models?" with "Yes, with a custom plan" [F, brave.com/search/api] | $5 per 1,000 requests with $5 monthly free credits (the page also says "up to $20") [F]; own independent index | **INTEGRATE** as the default BYOK search provider |
| Tavily | Terms do not address caching of results; Output is excluded from "Services"; Tavily may retain Customer Input and Output; no building "a competitive product or service" [F, tavily.com/terms, last updated 2026-05-04]. The page header reads "Tavily by Nebius" [F] | Contracting party "AlphaAI Technologies Inc. dba Tavily" [F] | **INTEGRATE** (optional BYOK) |
| Exa | §4.2(a): may not "download, modify, copy, distribute ... or offer for sale any information contained on, or obtained from or through, the Services, except for temporary files that are automatically cached by your web browser ... or as otherwise expressly permitted"; §4.2(f) no competitive products [F, exa.ai/terms PDF, undated] | Exa may use User Input and Output to improve its services [F] | **INTEGRATE** (optional BYOK), transient use only |
| SerpAPI | "You agree not to reproduce, duplicate, copy, sell, resell or exploit any portion of the Service"; "U.S. Legal Shield" covers "lawful collection of public search data" only on paid plans above Free, Starter and Developer, and "not ... how that data is ultimately used"; search data retained 31 days; last updated 2026-08-27 [F, serpapi.com/legal] | It returns scraped results from Google and other engines | **REJECT** |

**Design consequence (BUILD).**
Treat any search provider's results as transient discovery hints.
When the user or agent selects a result, CreatorBrio fetches that page itself through `source-retrieval.ts` and stores its own record: URL, retrieval time, content hash, extracted title, author and date, and the quoted span.
The citation is then CreatorBrio's own retrieval, not a stored search result, which is the cleanest reading of Brave's and Exa's storage clauses.
Search snippets, rankings and provider answers are not persisted.

### C9. yt-dlp

- Repository: https://github.com/yt-dlp/yt-dlp.
- Maintenance: 2026.10.26, commit 2026-11-17 [F].
- Licence: Unlicense for the git repository, the PyPI sdist and wheel; "the PyInstaller-bundled executables include GPLv3+ licensed code, and as such the combined work is licensed under GPLv3+" [F, README "Licensing"].
  Full YouTube support needs `yt-dlp-ejs` (Unlicense with MIT and ISC parts) [F].
- Platform terms: YouTube's Terms forbid users to "access, reproduce, download ... any part of the Service or any Content" except "as expressly authorized by the Service", and forbid access "using any automated means (such as robots, botnets or scrapers)" [F, youtube.com/static?template=terms, effective 2022-01-05].
  Instagram's Terms prohibit collecting "information in an automated way without our express permission" [S, help.instagram.com via search; the page did not render for fetch].
- Security: parses arbitrary remote media and runs site extractors that change weekly; the output is untrusted media.
- **Decision: REJECT** as a CreatorBrio feature, both for competitor media and for the user's own published posts.
  The user's own source files are uploaded directly, which CreatorBrio already supports.

### C10. YouTube Data API search endpoint

- Docs: https://developers.google.com/youtube/v3/docs/search/list.
- Quota: search.list and videos.insert "have their own quota buckets"; search.list is "100 quota per day.
  Each call costs 1 quota"; other endpoints share 10,000 units per day [F, determine_quota_cost page].
  This is a change from the historic 100-units-per-call model and makes search scarce.
- Useful parameters: `type=video`, `videoDuration=short` (under four minutes), `order=viewCount`, `publishedAfter`, `regionCode`, `maxResults` up to 50 [F].
  View counts need a follow-up `videos.list` call (1 unit) (UNVERIFIED from the search page itself; standard API design).
- Policy constraints [F, developer policies]: stored API data must be deleted or refreshed after 30 days (III.E.4); no download, caching or storage of audiovisual content without approval (III.E.1); no scraping (III.E.6); no separating or modifying audio or video components (III.I.7); and "Do not aggregate API Data or otherwise use API Data or YouTube API Services to gain insights into YouTube's usage" (III.E.2.b), with aggregation only for data "relating to YouTube channels" (III.E.2.a).
- **Decision: INTEGRATE**, BYOK, metadata only: find reference Shorts for a topic, show title, channel, thumbnail by URL, view and like counts, and link out.
  Persist at most 30 days with refresh, never media, never cross-channel "what performs on YouTube" statistics.

### C11. Instagram Graph API (Business Discovery and Hashtag Search)

- Docs: https://developers.facebook.com/docs/instagram-platform/.
- Business Discovery returns other Business or Creator accounts' media with `like_count`, `comments_count` and `view_count` in its sample; it needs `instagram_basic`, `instagram_manage_insights` and `pages_read_engagement`; age-gated accounts are not returned [F].
- Hashtag Search needs "Instagram Public Content Access", allows "a maximum of 30 unique hashtags within a 7-day period" [F]; top media returns `caption`, `comments_count`, `like_count`, `media_type`, `permalink`, `timestamp`, 50 per page, and no view count [F].
- Both need a Meta app with review and a professional Instagram account linked to a Facebook Page.
- **Decision: INTEGRATE later**, as the only legitimate route to competitors' public Reels metrics.
  App review makes it a hosted-SaaS feature first; a self-hosting user would need their own Meta app.

### C12. TikTok Research API

- TikTok's FAQ lists "I am a creator, advertiser, or commercial user" among those not eligible, and access requires an approved research project [S, developers.tiktok.com/docs/en/research-api-faq; the products page refused the connection].
- **Decision: REJECT.**

### C13. Open short-form trend tools

- The open projects found (for example `shortform-ai`, `shorts-trends` on PyPI) accept platform links and depend on downloaders, not official APIs [S].
  Commercial "trend APIs" (Virlo, Shortimize, ShortsIntel) do not state official-API sourcing in the results seen [S].
- **Decision: BUILD.** CreatorBrio should analyse (a) the user's own exported insights, (b) official-API metadata from C10 and C11, and (c) reference posts the user pastes as links, which are cited, not downloaded.
  The existing `ig-viral` and `yt-viral` skills describe the analysis; the product should implement it over official data only.

### Other C candidates, briefly

| Candidate | Facts | Decision |
|---|---|---|
| microsoft/markitdown | MIT, v0.1.9 on 2026-10-21 [F]; Python; converts PDF, DOCX, PPTX to Markdown | STUDY for user-uploaded research documents in the Python worker |
| apify/crawlee | Apache-2.0, v3.18.2 on 2026-09-29 [F]; Node crawling framework | REJECT; no crawling need |
| D4Vinci/Scrapling | BSD-3-Clause, v0.5.1 on 2026-11-04 [F]; built to get past anti-bot protection | REJECT; its purpose conflicts with platform terms |
| extractus/article-extractor | MIT, v9.0.1 on 2026-08-20 [F] | REJECT; Defuddle is stronger and more active |
| postlight/parser | Apache-2.0, last release 2022, last commit 2023 [F] | REJECT; stale |
| Tavily and Exa MCP servers | MIT [F] | Not needed; call the APIs from the server-side provider abstraction |

---

## E. Speech recognition, alignment and subtitles

CreatorBrio today has captions as an overlay capability (`src/lib/video/capabilities/captions.ts`) and no transcription engine in the repository [F, file listing].
The 2026-11-04 plan places ASR in a separate uv-managed Python worker on loopback; nothing below changes that.

### E1. parakeet-mlx with NVIDIA Parakeet TDT 0.6B v3

- Repository: https://github.com/senstella/parakeet-mlx (community); weights https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3.
- Maintenance: PyPI 0.7.0 on 2026-11-04 (0.6.0 at the earlier research); commit 2026-11-17; no GitHub releases [F].
- Code licence: Apache-2.0 [F].
  Weights: CC-BY-4.0, not gated, card modified 2026-08-05 [F]; `mlx-community/parakeet-tdt-0.6b-v3` also CC-BY-4.0 [F].
- Rights: the worker may depend on it; weights are downloaded by the model manager, not committed; CC-BY needs attribution in About and credits.
- Footprint: 0.6B parameters, 25 European languages (tags on the card [F]); MLX on Apple Silicon only.
  Linux needs another runtime (see sherpa-onnx).
- Security: decodes untrusted audio; feed it only FFmpeg-normalised 16 kHz WAV produced by CreatorBrio.
- **Decision: ADOPT** (primary ASR).
  **Changed:** new 0.7.0 release; weight licence now verified at source.

### E2. whisper.cpp

- Repository: https://github.com/ggml-org/whisper.cpp.
- Maintenance: v1.9.5 on 2026-10-06; commit 2026-11-16 [F].
- Licence: MIT; `openai/whisper-large-v3-turbo` weights MIT [F].
- Rights: may be bundled, but it is simplest as a user-installed binary or a worker dependency.
- Footprint: C/C++, Metal and Core ML on Apple Silicon, CPU and CUDA on Linux.
- **Decision: INTEGRATE** (second engine for languages outside Parakeet's set, and the cross-platform path).
  **Unchanged since the 2026-11-04 research.**

### E3. faster-whisper

- Repository: https://github.com/SYSTRAN/faster-whisper.
- Maintenance: v1.2.1 on 2025-10-31; commit 2026-11-12 [F].
- Licence: MIT; `Systran/faster-whisper-large-v3` MIT [F].
- Footprint: CTranslate2; CPU-only on a Mac (E5).
- **Decision: STUDY** for a future Linux CUDA SaaS worker only.
  **Unchanged.**

### E4. WhisperX

- Repository: https://github.com/m-bain/whisperX.
- Maintenance: v3.8.6 on 2026-05-25, 3.8.7rc1 on 2026-06-26, commit 2026-11-12 [F].
- Licence: BSD-2-Clause [F]; depends on faster-whisper and on gated pyannote models for diarization.
- **Decision: REJECT.** No Apple GPU path and a heavier stack than parakeet plus a forced aligner.
  **Unchanged.**

### E5. pyannote.audio

- Repository: https://github.com/pyannote/pyannote-audio.
- Maintenance: 4.1.0 released 2026-11-17, requiring Python 3.11+, renaming `Audio.downmix_and_resample`, and computing WeSpeaker fbank features on MPS [F].
- Licence: MIT code [F].
  `pyannote/speaker-diarization-community-1` is CC-BY-4.0 with `gated: auto` (click-through, Hugging Face token needed); `speaker-diarization-3.1` and `segmentation-3.0` are MIT and also gated [F].
  `precision-2` is a paid hosted model (E5).
- Rights: weights are commercially usable with attribution, but each user must accept the gate with their own Hugging Face account, which a hosted SaaS operator would do once.
- **Decision: STUDY (defer).** Single-speaker reels do not need diarization; when podcast repurposing needs it, compare pyannote community-1 with Sortformer through mlx-audio.
  **Changed:** new major-minor release today; conclusion unchanged.

### E6. Silero VAD

- Repository: https://github.com/snakers4/silero-vad.
- Maintenance: v6.2.3 on 2026-09-23; commit 2026-10-22 [F].
- Licence: MIT, model included [F].
- **Decision: ADOPT.** **Unchanged.**

### E7. stable-ts

- Repository: https://github.com/jianfch/stable-ts.
- Maintenance: archived (`archived: true`), last push 2026-05-30; PyPI 2.19.1 on 2025-08-16 [F].
- Licence: MIT [F].
- **Decision: REJECT.** **Changed:** the repository is now archived, not merely paused.

### E8. Montreal Forced Aligner

- Repository: https://github.com/MontrealCorpusTools/Montreal-Forced-Aligner; docs https://montreal-forced-aligner.readthedocs.io.
- Maintenance: v3.4.4 on 2026-11-16, v3.4.3 on 2026-10-08 [F].
- Licence: MIT code [F]; pretrained models and dictionaries repository `mfa-models` is CC-BY-4.0 [F].
- Footprint: Python with Kaldi binaries, normally installed with conda; CPU.
- Fit: very accurate word and phone boundaries for known text, useful for lip-sync shapes or karaoke-level caption timing.
- **Decision: STUDY.** Qwen3-ForcedAligner in the existing MLX runtime covers word-level realignment with a much lighter install; revisit MFA only if phone-level timing becomes a requirement.
  **New** (not assessed in the earlier research).

### E9. Qwen3-ForcedAligner and Qwen3-ASR

- Weights: `Qwen/Qwen3-ForcedAligner-0.6B` and `Qwen/Qwen3-ASR-1.7B` are Apache-2.0, not gated [F].
  Repository https://github.com/QwenLM/Qwen3-ASR is Apache-2.0, last commit 2026-06-26 [F].
- **Decision: ADOPT after validation** (aligner, via mlx-audio).
  Qwen3-ASR: STUDY as an alternative multilingual ASR.
  **Unchanged; weights now verified.**

### E10. mlx-audio (runtime)

- Repository: https://github.com/Neywa-Labs/mlx-audio (redirected from `Blaizzy/mlx-audio`) [F].
  The author's company Neywa Labs came out of stealth in late October 2026 [S, aiwiki.ai].
- Maintenance: v0.6.6 on 2026-11-16, weekly releases [F].
- Licence: MIT, unchanged since the initial commit [F].
- Risk: governance moved from a personal account to a startup; pin versions and watch for licence or telemetry changes.
- **Decision: ADOPT** as the worker's MLX runtime.
  **Changed:** repository home.

### E11. sherpa-onnx (new, Linux path)

- Repository: https://github.com/k2-fsa/sherpa-onnx.
- Maintenance: multiple artefact releases on 2026-11-16, commit 2026-11-17 [F].
- Licence: Apache-2.0 [F]; models carry their own licences (Parakeet ONNX exports inherit CC-BY-4.0, UNVERIFIED per export).
- Fit: runs Parakeet, Whisper, Silero VAD and diarization on CPU via ONNX on Linux and macOS; already used by Yap Studio and HyperFrames' CLI per E4 and E6.
- **Decision: INTEGRATE** as the Linux and SaaS ASR path, so the product does not need NeMo or CUDA to transcribe.

### Not worth a full entry

- **FluidAudio** (Apache-2.0, v0.18.3 on 2026-11-07 [F]) and **WhisperKit**, now `argmaxinc/argmax-oss-swift` (MIT, v1.1.1 on 2026-10-08 [F]): Swift SDKs; STUDY only if a native helper is built.
  WhisperKit's rename is a change since E5.
- **NVIDIA NeMo** now redirects to `NVIDIA-NeMo/Speech` (Apache-2.0, v3.0.0 on 2026-08-07) [F]; do not install on a Mac; STUDY.
- **CrisperWhisper**: v2.1.0 on 2026-11-10 adds a "nyra forced aligner"; code MIT, weights still "Nyra Health Non-Commercial Research License" [F].
  REJECT, unchanged.
- **ctc-forced-aligner** (BSD-2-Clause, last release 2024) [F]: STUDY only.

---

## F. Speech synthesis, audio processing, music and sound effects

### F1. Piper (moved, GPL engine, voice licensing clarified)

- Home: https://github.com/OHF-Voice/piper1-gpl (Open Home Foundation).
  The original `rhasspy/piper` (MIT) is archived [F].
  Voices: https://huggingface.co/rhasspy/piper-voices.
- Maintenance: v1.8.0 on 2026-09-04; commit 2026-11-15; README still says "The Open Home Foundation is looking for maintainers for Piper!" [F].
- Code licence: GPL-3.0 (`piper-tts` on PyPI declares GPL-3.0-or-later) [F].
- Voice licensing [F, docs/LICENSING.md and docs/COMMERCIAL_USE.md, both added 2026-11-09 and updated through 2026-11-15]:
  - "The Piper project makes **no license grant of its own over voice models**"; each `MODEL_CARD` names only that voice's own dataset, and obligations can flow from the voice it was fine-tuned from.
  - The lessac base's licence "limits use to 'research and exploration of speech technologies' and excludes commercial use of the resulting synthesis".
  - New and retrained voices descend from `nl_BE-rdh-medium` (CC0) or `en_US-hifi_tts_92-medium` (CC BY 4.0, attribution required).
  - The commercial list includes English voices `en_US-joe-medium`, `en_US-mike-medium`, `en_US-kathleen-medium` (CC0 chains), `en_GB-alba-medium`, `en_GB-cori-medium` (CC BY), and public-domain `en_US-ljspeech-*`, `en_US-kristin-medium`, `en_US-norman-medium`, `en_GB-cori-high`, among many other languages.
  - "A copy downloaded before a voice was retrained is still the lessac-derived version"; the project says to check the `MODEL_CARD` of the copy you have and to ship it with the voice.
  - Excluded from the list: anything from lessac or ryan, non-commercial datasets (for example hfc_female, ryan, kss), and voices with undocumented data (for example amy).
- Inconsistency observed: the `en_US-ryan-high` card says "Trained from scratch" with a CC BY-NC-SA dataset, while a 2026-11-11 commit says ryan was retrained from rdh [F].
  Either way ryan's own data is non-commercial.
- Rights: GPL engine as a separate user-installed process only; voices downloaded by the user or the worker, never committed.
  Distribution of voices requires shipping their `MODEL_CARD`.
- Footprint: ONNX on CPU, tens of MB per voice, fast on any machine including Linux servers; about 40 languages.
- **Decision: INTEGRATE**, optional, as a separate process with a CreatorBrio allow-list that pins voice file hashes from the post-retrain copies and checks the `Training` line names rdh or hifi_tts_92 (or "Trained from scratch" with a permissive dataset).
  Kokoro stays primary for English quality; Piper fills languages Kokoro lacks and gives a CPU-only Linux path.
- **Changed materially since the 2026-11-04 research** (which excluded Piper because of per-voice licences).

### F2. Kokoro-82M

- Repository: https://github.com/hexgrad/kokoro; weights https://huggingface.co/hexgrad/Kokoro-82M.
- Maintenance: PyPI 0.9.4 on 2025-04-05; last commit 2025-08-06 [F].
  kokoro-onnx (MIT) last commit 2026-09-01 [F].
  The active port is mlx-audio.
- Licences: code Apache-2.0; weights Apache-2.0 [F].
  The G2P fallback espeak-ng is GPL (E8) and must stay an optional separate install.
- **Decision: ADOPT** (primary narration).
  **Unchanged; weights now verified.**
  Upstream quietness is the main risk.

### F3. Chatterbox

- Repository: https://github.com/resemble-ai/chatterbox.
- Maintenance: GitHub release v0.1.2 (2025-06-13), PyPI 0.1.7 (2026-03-26), commit 2026-11-04 [F].
- Licences: code MIT [F]; `ResembleAI/chatterbox` and `chatterbox-turbo` weights MIT; `chatterbox-hf` Apache-2.0 [F].
  This resolves E8's "MIT (unverified)".
- Ethics: upstream embeds a PerTh watermark that the mlx-audio port drops (E8); CreatorBrio must record provenance itself and require recorded consent.
- **Decision: INTEGRATE** (opt-in consented cloning).
  **Unchanged; weights verified.**

### F4. F5-TTS

- Repository: https://github.com/SWivid/F5-TTS; 1.1.22 on 2026-07-23; commit 2026-11-03 [F].
- Licences: code MIT [F]; weights `SWivid/F5-TTS` CC-BY-NC-4.0 [F].
- **Decision: REJECT.** **Unchanged; verified.**

### F5. Dia and Dia2

- Repositories: https://github.com/nari-labs/dia (last commit 2025-11-19), https://github.com/nari-labs/dia2 (last commit 2025-11-29); no releases [F].
- Licences: Apache-2.0 code; `Dia-1.6B`, `Dia-1.6B-0626`, `Dia2-2B` weights Apache-2.0 [F].
- **Decision: REJECT.** A year without commits, English only, Dia2 needs CUDA (E8).
  **Unchanged; weights verified.**

### F6. Other open TTS engines

| Engine | Facts | Decision | Changed? |
|---|---|---|---|
| VoxCPM2 (OpenBMB) | Apache-2.0 code, weights Apache-2.0 [F]; 2.0.3 on 2026-05-11; commit 2026-11-09 [F] | INTEGRATE as the alternative cloning engine at gate G4 | Unchanged; verified |
| Qwen3-TTS | Apache-2.0 code and weights [F]; no release; last commit 2026-03-17 [F] | STUDY | Unchanged; verified |
| OmniVoice (k2-fsa) | Code Apache-2.0; weights "CC-BY-NC due to constraints from its training data (e.g., Emilia)" [F, model card] | REJECT | **Corrected** (E8 said Apache-2.0, unverified) |
| Audio8-TTS-Realistic (Edge0) | 0.6B, 23 languages, Apache-2.0 weights and code per coverage dated 2026-10-29 [S, marktechpost] | STUDY; verify the card before any use | New |
| Zonos 2 / Zonos 3-Mini (Zyphra) | Reported Apache-2.0 MoE TTS [S] | STUDY | New |
| Kyutai TTS, MeloTTS, Orpheus, IndexTTS, Fish, Higgs, Voxtral, KittenTTS-2, VibeVoice, Supertonic | As E8 | As E8 | Not re-checked in this session |

### F7. DeepFilterNet3

- Repository: https://github.com/Rikorose/DeepFilterNet.
- Maintenance: last release v0.5.6 on 2023-08-31; commit 2026-11-06 changing only the README licence section [F].
  PyPI `deepfilternet` 0.5.6 [F].
  `mlx-community/DeepFilterNet-mlx` is MIT [F].
- Licence: "All code and model weights in this repository are dual-licensed" under MIT or Apache-2.0 [F, README after commit of 2026-11-06].
- **Decision: ADOPT** (voice denoise, via mlx-audio, Rust CLI as fallback).
  **Changed:** the weights licence is now explicit; upstream is otherwise still dormant.

### F8. Demucs

- Home: maintained fork https://github.com/adefossez/demucs (v4.1.0 on 2026-07-11, commit 2026-10-26); `facebookresearch/demucs` archived [F].
- Licences: code MIT; "The license of the weights is not clear", and the 6-source model "likely means CC-NC-BY" [F, README].
- **Decision: REJECT** by default.
  **Unchanged.**

### F9. RNNoise

- Repository: https://github.com/xiph/rnnoise (convenience copy of gitlab.xiph.org) [F].
- Maintenance: v0.2 on 2024-04-15; last commit 2025-02-22 [F].
- Licence: BSD-3-Clause [F].
  README: distributed models "are now trained using only the publicly available datasets listed" [F]; the build downloads model files from Xiph servers [F].
- Fit: tiny C library; FFmpeg's `arnndn` filter can apply RNNoise-format models, but those model files have their own provenance (UNVERIFIED).
- **Decision: STUDY** as a CPU fallback; DeepFilterNet is better on non-stationary noise (E5).
  **New.**

### F10. Music and sound-effect generation

| Model | Facts | Decision | Changed? |
|---|---|---|---|
| MusicGen / AudioGen | `facebook/musicgen-small` and `-large` CC-BY-NC-4.0 [F]; audiocraft last commit 2025-03-13 [F] | REJECT | Unchanged; verified |
| Stable Audio Open 1.0 / Small | Cards list the Stability AI Community License, `gated: auto` [F]; Small is 0.5B with Arm LiteRT builds [F]; the licence covers organisations under US$1M annual revenue, Enterprise above [F, stability.ai/license] | REJECT as a default; a user may opt in with a label. A SaaS operator above US$1M would need an Enterprise licence | Unchanged |
| ACE-Step 1.5 | Code MIT; `ACE-Step/Ace-Step1.5` weights MIT [F]; v0.1.8 on 2026-05-18 [F] | INTEGRATE (optional, separate install) | Unchanged; verified |
| CLAP (retrieval) | `laion/clap-htsat-unfused`, `laion/larger_clap_general` Apache-2.0 [F] | ADOPT for text-to-sound search (resolves G9 check in spec/08) | Weights now verified |
| Earshot | MIT, v0.4.1 on 2026-11-06 [F] | INTEGRATE (as E4) | Unchanged |

### F11. Sound sources

| Source | Terms | Decision |
|---|---|---|
| Freesound | "You can use the Freesound API for free only for non-commercial purposes"; credit Freesound and creators [F, freesound.org/docs/api/terms_of_use.html, undated] | INTEGRATE opt-in with the user's key, labelled non-commercial. Unchanged |
| Pixabay | Free use without attribution; no standalone redistribution; no misleading use [F, license summary]. The no-AI-training and API caching rules come from E8 and were not re-read here | INTEGRATE optional, user key. Unchanged |
| CC0 packs (`uisfx`), user libraries | As spec/08 | Unchanged |

---

## G. Video editing, composition, animation, image generation and rendering

### What CreatorBrio already has

The repository has its own renderer: a hardened Puppeteer overlay browser with JavaScript disabled, a fetch interceptor, CSP, animation timeline at rate 0 and frames seeked through `document.getAnimations()` (`src/lib/video/render/overlay-browser.ts`), plus an FFmpeg graph compiler, audio mastering and durable render jobs (`src/lib/video/render/*`, `src/lib/video/media/*`) [F].
FFmpeg and ffprobe run by absolute path as separate processes, discovered from `CREATORBRIO_FFMPEG` or standard locations, tested with 9.0.2 [F, `src/lib/video/media/tools.ts`].
The ADR was amended on 2026-11-06: HyperFrames failed G1 (GSAP), OpenFilm is the fallback, and CreatorBrio's own script-free renderer was chosen [F, `docs/architecture/adr-creatorbrio-video-studio.md`].
G-category candidates are therefore judged against "does this beat or usefully extend what is already built", not against an empty slot.

### G1. OpenCut

- Repository: https://github.com/OpenCut-app/OpenCut; classic editor https://github.com/OpenCut-app/opencut-classic (archived).
- Maintenance: v0.3.0 on 2026-04-15; last commit 2026-09-24 (an FFmpeg build workflow) [F].
  README: "OpenCut is being rewritten from the ground up", with MCP and headless mode still listed as coming [F].
- Licence: MIT [F].
- **Decision: REJECT.** **Unchanged since the 2026-11-04 research.**

### G2. VEED OpenEdit

- Repository: https://github.com/veedstudio/open-edit, mirrored from VEED's internal `veed-llm-editor` [F].
- Maintenance: mirror commits on 2026-11-02, 11-03, 11-05 and 11-11 [F]; the only release object is `launch-examples` (2026-08-03) [F].
- Licence: Apache-2.0 with a NOTICE file [F].
- Fit: TypeScript CLI with a virtual-clock page runtime, EDL with transcript retiming, range re-render and splice, safe zones and review checks (E2).
  Background removal goes to cloud services (E2).
- **Decision: STUDY**, adapting named techniques with attribution and its NOTICE (safe zones, review checks, range splice) as `spec/05` already plans.
  **Unchanged; still active.**

### G3. HyperFrames

- Repository: https://github.com/heygen-com/hyperframes; docs https://hyperframes.dev (pointer).
- Maintenance: v0.9.61 on 2026-11-17; about 52 releases between 2026-11-04 and 2026-11-17 [F]; still pre-1.0.
- Licence: Apache-2.0 since 2026-04-01 (initially MIT) [F].
  `@hyperframes/core`, `producer`, `engine` and `player` 0.9.61 still have no `license` field on npm; only the `hyperframes` CLI declares Apache-2.0 [F].
- GSAP: `packages/core/src/gsapCdn.ts` pins `GSAP_CDN_VERSION = "3.15.0"` loaded from jsDelivr, and the core contains GSAP adapters, parsers and writers [F].
  Commits since 2026-11-04 show no move away from GSAP [F].
- **Decision: REJECT** as a dependency; STUDY the registry blocks as design references only.
  **Licence unchanged; CreatorBrio's own G1 gate (2026-11-06) reversed the research's "Adopt".**

### G4. Remotion

- Repository: https://github.com/remotion-dev/remotion; licence docs https://www.remotion.dev/docs/license (pointer).
- Maintenance: v4.0.544 on 2026-11-16 [F].
- Licence: the Remotion License: free for individuals, for-profit organisations "with up to 3 employees", non-profits and evaluation; others need a Company License; "It is not allowed to copy or modify Remotion code for the purpose of selling ... your own derivate of Remotion" [F, LICENSE.md].
  GitHub reports `NOASSERTION` [F].
- Change: commit on 2026-11-09 moved pricing and FAQ links from remotion.pro to remotion.dev, with no change to terms [F].
  The planned 5.0 licence (PR #3750, open since 2024-04-22) would count contractors towards team size and bind Company Licenses to new terms and conditions [F].
- **Decision: REJECT** (source-available; would bind every self-hosting company).
  **Unchanged in substance.**

### G5. Motion Canvas and Revideo

- Motion Canvas: https://github.com/motion-canvas/motion-canvas, MIT, last release v3.17.2 (2024-12-14), last commit 2026-07-02 [F].
- Revideo: `redotvideo/revideo` redirects to https://github.com/midrender/revideo, MIT, last commit 2026-07-15, tags v0.11.0 [F]; opt-out PostHog telemetry (E3).
- **Decision: REJECT** both.
  Canvas2D scenes would be a second rendering paradigm next to CreatorBrio's HTML contract.
  **Unchanged.**

### G6. FFmpeg (LGPL versus GPL builds)

- Home: https://ffmpeg.org; mirror https://github.com/FFmpeg/FFmpeg.
- Maintenance: latest release tag n9.0.2 (2026-09-18 per E5); `n9.1-dev` exists [F].
- Licence [F, ffmpeg.org/legal.html]: FFmpeg is LGPL v2.1 or later; optional GPL parts make the whole build GPL.
  The LGPL checklist requires building without `--enable-gpl` and `--enable-nonfree`, dynamic linking, shipping the exactly matching source with a diff and the configure line on the same server, attribution, and no GPL libraries such as libx264.
- Homebrew `ffmpeg` and `ffmpeg-full` are GPL-3+ builds (E5).
- Rights for CreatorBrio:
  - Self-hosted: keep the current model (user-installed GPL build, separate process, absolute path).
    Do not bundle.
  - SaaS: running a GPL build on the operator's servers is not distribution, so GPL obligations are not triggered; a container image that is itself distributed to customers would be.
  - If CreatorBrio ever ships a binary, an LGPL build without x264 is the only bundle-safe option, and H.264 encoding would then rely on VideoToolbox (macOS) or OpenH264 (Cisco binary licence, UNVERIFIED for this use).
- Security: FFmpeg parses untrusted media; CreatorBrio already bounds time and output and never uses a shell [F].
  In SaaS, run it in a per-job sandbox without network.
- **Decision: INTEGRATE** (as built).
  **Unchanged.**

### G7. MLT

- Repository: https://github.com/mltframework/mlt; docs https://www.mltframework.org.
- Maintenance: v7.42.0 on 2026-10-03; commit 2026-11-07 [F].
- Licence: GitHub reports LGPL-2.1; the repository root also carries `GPL` and `GPLv3` files for modules under those licences [F].
- Fit: C/C++ multimedia framework behind Shotcut and Kdenlive, with an XML timeline format and `melt` CLI.
- **Decision: REJECT.** It would be a second timeline model and render engine next to CreatorBrio's production document and FFmpeg graph compiler; its XML is not an interchange format CreatorBrio's users need (OTIO and FCPXML already cover hand-off).
  **New.**

### G8. Image generation models

All weights are downloaded by the user or the operator into a separate image service; none is committed or bundled.
CreatorBrio already has the loopback image-service contract (`src/lib/image-service.ts`, from E5 §6).

| Model | Weights licence [F, HF model API] | Gated | Commercial | Decision |
|---|---|---|---|---|
| FLUX.2 [klein] 4B | apache-2.0 | no | yes | **ADOPT** as the reference model for the public image-service implementation |
| Z-Image / Z-Image-Turbo | apache-2.0 | no | yes | **INTEGRATE** (fast second model) |
| Qwen-Image / Qwen-Image-Edit-2511 | apache-2.0 | no | yes | **INTEGRATE** (optional; 20B with a large text encoder, E7) |
| FLUX.1 [schnell] | apache-2.0 | click-through | yes | **STUDY** (legacy, superseded) |
| FLUX.1 [dev] | flux-1-dev-non-commercial-license | click-through | no | **REJECT** |
| FLUX.2 [dev], FLUX.2 [klein] 9B | flux-non-commercial-license | click-through | no | **REJECT** |
| Stable Diffusion 3.5 Large / Medium | stabilityai-ai-community | click-through | under US$1M revenue only | **REJECT** as default; labelled user opt-in at most |
| SDXL 1.0 base | openrail++ | no | yes, with use restrictions that must be passed on | **STUDY** (fallback only) |

**Changed:** every licence above was "per README" or "unverified" in E7 and spec/08 and is now verified at the model API; none differs from what E7 recorded.
**Repository note:** CreatorBrio's own `spec/08` records that the founder's private image service runs a FLUX.2 Klein variant; only the 4B variant is commercial.

### G9. Image-generation runners

| Runner | Facts | Decision |
|---|---|---|
| mflux | `filipstrand/mflux` redirects to `mflux-community/mflux`; MIT; v0.24.0 on 2026-10-27; commit 2026-11-16 [F] | **ADOPT** as the Apple Silicon runner in the reference image service. Unchanged |
| diffusers | Apache-2.0; v0.43.0 on 2026-11-12 [F] | **INTEGRATE** as the Linux/CUDA runner for the same service contract. New |
| AUTOMATIC1111 WebUI | AGPL-3.0; last release 2025-02-09; last commit 2024-07-27 [F] | **REJECT** (AGPL, stale). New |

### G10. ComfyUI

- Repository: https://github.com/Comfy-Org/ComfyUI (moved from `comfyanonymous/ComfyUI`); docs https://docs.comfy.org.
- Maintenance: v0.45.0 on 2026-11-10, v0.44.0 on 2026-11-04, about weekly; commit 2026-11-17 [F].
  `comfy-cli` 1.26.0 on 2026-11-11 is GPL-3.0-only [F].
- Licence: GPL-3.0 [F].
  Custom nodes carry their own licences.
- Integration surface [F, docs.comfy.org comms_routes]: `POST /prompt` queues a workflow JSON and returns a `prompt_id`; `GET /history/{prompt_id}`; `GET /view` returns images; `POST /interrupt`; `WebSocket /ws` streams `executing`, `progress` and `executed`.
  The docs say nothing about authentication.
- Defaults [F, `comfy/cli_args.py`]: listens on 127.0.0.1:8188; `--listen` without an argument binds all interfaces; TLS and CORS are opt-in flags.
- Rights: as a separate user-installed process called over HTTP, GPL does not reach CreatorBrio's code.
  CreatorBrio must not bundle ComfyUI, its nodes or its workflows' GPL code.
- Security: no authentication on its API; custom nodes execute arbitrary Python; workflows can reference any model on disk.
  CreatorBrio must only talk to a loopback ComfyUI, treat outputs as untrusted images (magic-byte check and re-encode with sharp), and never ship custom nodes.
- Licence enforcement gap: ComfyUI cannot tell CreatorBrio which model licence produced an image; the adapter must take the model identity from a CreatorBrio-owned workflow template and refuse non-commercial checkpoints for commercial productions.
- SaaS: a shared ComfyUI is single-tenant by design; a hosted tier would run one isolated instance per job or use diffusers directly.
- **Decision: INTEGRATE**, optional, as a user-run backend behind the existing image-service contract, with CreatorBrio-owned workflow templates that pin the model.
  The default reference implementation stays mflux (Mac) and diffusers (Linux).
  **New.**

### Not worth a full entry

- **OpenFilm** (MIT, v0.3.2 on 2026-11-09, commit 2026-11-17 [F]) remains the documented fallback renderer per G1; unchanged.
- **Wan, LTX-2 video generation**: as E5; not re-checked; out of scope for v1.

---

## H. Thumbnails, Reel covers, carousels, templates and brand consistency

### What CreatorBrio already has

Slides are body-level HTML wrapped by `wrapSlideHtml()` and screenshotted by Puppeteer at exact Instagram dimensions; preview iframes use `sandbox=""` [F, CLAUDE.md and `src/lib/export-slides.ts`].
`sharp` 0.35.5 and `puppeteer` ^24.40.0 are already dependencies [F, package.json].
Brands exist (`src/lib/brand*.ts`) and templates exist (`src/lib/templates.ts`) [F, file listing].
The one-renderer principle that the Video Studio ADR applies to video also applies here: covers and thumbnails should come from the same HTML contract so preview equals export.

### H1. Puppeteer screenshot templating

- Repository: https://github.com/puppeteer/puppeteer; docs https://pptr.dev.
- Maintenance: puppeteer 25.18.0 on 2026-11-17, weekly releases [F].
  CreatorBrio is on the 24.x line (`^24.40.0`) [F]; 25.x is a major version behind the current line, worth a separate upgrade task.
- Licence: Apache-2.0 [F].
  Downloads Chrome for Testing at install.
- Footprint: one Chromium per render worker, hundreds of MB of RAM; seconds per image.
- Security: the overlay browser already shows the hardened pattern (no JS, request interception, CSP, sandbox on).
  The carousel export path should share the same hardening if it does not already (not verified in this session).
- **Decision: ADOPT** (already in use).
  Keep it as the single image renderer for slides, LinkedIn documents and Reel covers.

### H2. sharp and libvips

- Repositories: https://github.com/lovell/sharp, https://github.com/libvips/libvips.
- Maintenance: sharp 0.35.5 on 2026-09-27, commit 2026-11-16; libvips 8.19.0-rc1 on 2026-11-01, 8.18.7 on 2026-09-26 [F].
- Licences: sharp Apache-2.0; the prebuilt `@img/sharp-libvips-darwin-arm64` 1.3.4 is LGPL-3.0-or-later [F]; libvips LGPL-2.1 [F].
- Rights: sharp loads libvips as a separate dynamically linked npm package, which is the LGPL-compatible arrangement; CreatorBrio must not statically link or modify libvips, and should keep its notices in third-party credits.
- Security: libvips parses untrusted images; keep the existing magic-byte checks and size caps, and set `limitInputPixels`.
- **Decision: ADOPT** (already in use) for resizing, format conversion, thumbnail strips and safe re-encoding of untrusted images.

### H3. Satori

- Repository: https://github.com/vercel/satori.
- Maintenance: 0.63.2 on 2026-10-20; commit 2026-10-20 [F].
  `@vercel/og` 1.0.3 (2026-09-22) wraps it [F].
- Licence: MPL-2.0 since 2022 [F].
  MPL-2.0 is on spec/08's bundle allow-list (file-level copyleft: modified Satori files stay MPL).
- Capability: "Satori supports a limited subset of HTML and CSS features"; "Satori does not guarantee that the SVG will 100% match the browser-rendered HTML output"; layout now uses Taffy for Flexbox, Grid and block [F, README].
- Fit: much faster and lighter than Chromium, but a second layout engine that would make covers render differently from slides, and it requires JSX-like trees rather than CreatorBrio's agent-written HTML.
- **Decision: STUDY.** Revisit only if SaaS throughput for thumbnails becomes a cost problem, and then only for a constrained template class.

### H4. Takumi (new)

- Repository: https://github.com/kane50613/takumi; docs https://takumi.kane.tw/docs (pointer).
- Maintenance: takumi 2.20.0 on 2026-11-08; commit 2026-11-13 [F].
- Licence: MIT OR Apache-2.0 (dual since 2025-09-11) [F]; npm `@takumi-rs/core` 2.20.0 declares the same [F].
- Capability: "a layout engine written in Rust, with text and inline layout ported from Chromium.
  It lays out JSX, HTML, and CSS without launching a browser"; outputs PNG, JPEG, WebP, SVG, animated WebP, APNG, GIF, PDF and a paint tree; the CLI reads "only the directories you allow" [F, README].
- Fit: a closer match to browser text layout than Satori, and accepts HTML, so it is the stronger candidate for a no-browser fast path.
  It is still a different engine from Chromium.
- **Decision: STUDY.** Run a fidelity comparison against the Puppeteer output of existing templates before any adoption.

### H5. resvg

- Repository: https://github.com/linebender/resvg (redirected from `RazrFalcon/resvg`) [F].
- Maintenance: v0.50.0 on 2026-11-11 [F].
  Licence Apache-2.0 [F].
  `@resvg/resvg-js` (MPL-2.0) last published 2024-03-26 [F].
- **Decision: STUDY.** Only needed if Satori or Takumi SVG output must be rasterised; Chromium and sharp already rasterise SVG.

### H6. Polotno and similar commercial editors

- Polotno SDK: npm `polotno` 4.20.1 on 2026-11-11, licence "SEE LICENSE IN LICENSE.md" [F].
  The licence grants 30 days of evaluation; "Production use requires a valid Polotno subscription at any time", including "an internal tool, including a tool that only your own employees use"; no modification or republishing; "An AI agent can use this package for you under the same terms" [F, package LICENSE.md].
- tldraw: licence key enforcement and "Not to use the Software in Production Environments" without an alternative licence [F, LICENSE.md, changed for 4.0 on 2025-09-17].
- **Decision: REJECT** both.
  Proprietary or source-available, and incompatible with a public MIT product.
- IMG.LY CE.SDK and Canva-style SDKs were not examined; they are proprietary by design (UNVERIFIED).

### H7. Fabric.js and Konva

- Fabric.js: MIT, v7.4.0 on 2026-05-18, commit 2026-11-10 [F].
  Konva: MIT (GitHub reports NOASSERTION because of a combined notice) [F], 10.9.1 on 2026-10-31 [F].
- Fit: canvas object models for drag-and-drop editors.
  Adopting one would create a second document model next to HTML slides.
- **Decision: STUDY.** Consider only if a direct-manipulation cover editor is required, and then generate HTML from it rather than rendering canvas.

### H8. Brand kits and templates

- Design Tokens Community Group format: repository https://github.com/design-tokens/community-group, commits to 2026-09-08 [F]; the stable status of the format specification is UNVERIFIED in this session.
- Style Dictionary: https://github.com/style-dictionary/style-dictionary (moved from `amzn/style-dictionary`), Apache-2.0, v5.8.0 on 2026-11-03 [F]; transforms token files into CSS variables and other formats.
- Penpot: MPL-2.0, 2.19.2 on 2026-11-16 [F]; a full design tool, useful only as an import source for tokens.
- **Decision: BUILD** the brand kit as a CreatorBrio-owned, DTCG-shaped token set (colours, type scale, spacing, logo assets, safe zones per format) that `wrapSlideHtml()` and the video overlay compiler both inject as CSS custom properties, with templates referencing tokens only.
  **STUDY** Style Dictionary as the transform library if multiple output formats are needed later.

---

## Legal constraints on competitor analysis

This section summarises what the evidence above means for studying what performs in a niche.
It is not legal advice.

1. **Platform terms forbid automated collection and downloading.**
   YouTube's Terms forbid downloading content unless "expressly authorized by the Service" and access "using any automated means" [F].
   Instagram's Terms forbid collecting "information in an automated way without our express permission" [S].
   TikTok's Research API excludes commercial users [S].
   CreatorBrio must not ship scrapers or downloaders for these platforms, in the self-hosted app or the SaaS.
2. **Logged-out scraping case law is narrow and unstable.**
   In *Meta v.
   Bright Data* (N.D. Cal., 2024-01-23) the court held Meta's terms did not bind logged-out scraping of public data, but the ruling addressed only Meta's then-current terms, did not cover logged-in scraping, and was described by commentators as at odds with most other scraping decisions [S, fbm.com and techcrunch.com].
   A product cannot rely on it.
3. **Official APIs carry their own restrictions.**
   YouTube API data must be refreshed or deleted after 30 days, media may not be downloaded, and API data may not be aggregated "to gain insights into YouTube's usage" beyond per-channel aggregation [F].
   Instagram's Hashtag Search is capped at 30 unique hashtags per 7 days and needs Public Content Access review [F].
   Search APIs (Brave, Exa) forbid storing results beyond transient use without a custom agreement [F].
4. **Copyright in competitor media.**
   Downloading, transcribing or re-editing another creator's video copies a protected work.
   In the EU, the Article 4 DSM text-and-data-mining exception allows commercial mining only of lawfully accessed works and only where the rightholder has not reserved rights, often by machine-readable means [S]; it does not authorise republishing, and platform terms still apply.
   In the US, analysis for commentary may be fair use, but that is case-by-case and does not cure a terms-of-service breach (UNVERIFIED as applied here).
5. **What CreatorBrio can safely do.**
   - Analyse the user's own exported insights and own uploaded files (first-party data).
   - Show official-API metadata (titles, counts, permalinks, thumbnails by URL) with the API's retention limits, attributed and linked.
   - Let the user paste reference links; store the link, the user's notes and short quoted text with citation, not the media.
   - Have the agent describe patterns (hook structure, length, format) from those sources without copying scripts or footage verbatim.
   - Record provenance for every research claim: source URL, retrieval time, content hash and quoted span.

---

## Sources

All retrieved on 2026-11-17 unless stated.

**Repository and registry data [F]**

- GitHub REST API `repos/{owner}/{repo}`, `/releases?per_page=3`, `/commits?per_page=1`, `/contents/{path}` and `/commits?path=` for: mozilla/readability, kepano/defuddle, adbar/trafilatura, unclecode/crawl4ai, firecrawl/firecrawl, jina-ai/reader, searxng/searxng, yt-dlp/yt-dlp, microsoft/markitdown, apify/crawlee, mixmark-io/turndown, extractus/article-extractor, postlight/parser, D4Vinci/Scrapling, tavily-ai/tavily-mcp, exa-labs/exa-mcp-server, m-bain/whisperX, SYSTRAN/faster-whisper, ggml-org/whisper.cpp, senstella/parakeet-mlx, pyannote/pyannote-audio, snakers4/silero-vad, jianfch/stable-ts, MontrealCorpusTools/Montreal-Forced-Aligner, MontrealCorpusTools/mfa-models, FluidInference/FluidAudio, Neywa-Labs/mlx-audio, argmaxinc/argmax-oss-swift, QwenLM/Qwen3-ASR, MahmoudAshraf97/ctc-forced-aligner, NVIDIA-NeMo/Speech, k2-fsa/sherpa-onnx, nyrahealth/CrisperWhisper, OHF-Voice/piper1-gpl, rhasspy/piper, hexgrad/kokoro, thewh1teagle/kokoro-onnx, resemble-ai/chatterbox, SWivid/F5-TTS, nari-labs/dia, nari-labs/dia2, Rikorose/DeepFilterNet, adefossez/demucs, facebookresearch/demucs, xiph/rnnoise, facebookresearch/audiocraft, Stability-AI/stable-audio-tools, OpenBMB/VoxCPM, QwenLM/Qwen3-TTS, k2-fsa/OmniVoice, ace-step/ACE-Step-1.5, Leonxlnx/earshot, MTG/freesound, OpenCut-app/OpenCut, OpenCut-app/opencut-classic, veedstudio/open-edit, heygen-com/hyperframes, remotion-dev/remotion (and pull 3750), motion-canvas/motion-canvas, midrender/revideo, FFmpeg/FFmpeg (tag refs), mltframework/mlt, black-forest-labs/flux, black-forest-labs/flux2, Stability-AI/generative-models, Stability-AI/sd3.5, QwenLM/Qwen-Image, Comfy-Org/ComfyUI (`comfy/cli_args.py`), Tongyi-MAI/Z-Image, mflux-community/mflux, openfilm/openfilm, huggingface/diffusers, AUTOMATIC1111/stable-diffusion-webui, vercel/satori, linebender/resvg, lovell/sharp, libvips/libvips, puppeteer/puppeteer, fabricjs/fabric.js, konvajs/konva, kane50613/takumi, penpot/penpot, style-dictionary/style-dictionary, excalidraw/excalidraw, tldraw/tldraw, design-tokens/community-group, microsoft/playwright.
- Key files read: https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/LICENSING.md and docs/COMMERCIAL_USE.md; https://github.com/Rikorose/DeepFilterNet (README commit of 2026-11-06); https://github.com/remotion-dev/remotion/blob/main/LICENSE.md; https://github.com/unclecode/crawl4ai/blob/main/LICENSE; https://github.com/tldraw/tldraw/blob/main/LICENSE.md; https://github.com/yt-dlp/yt-dlp (README "Licensing"); https://github.com/adefossez/demucs (README "License"); https://github.com/nyrahealth/CrisperWhisper (README "License", release v2.1.0); https://github.com/jina-ai/reader (README "Licensed assets"); https://github.com/heygen-com/hyperframes/blob/main/packages/core/src/gsapCdn.ts.
- npm registry `https://registry.npmjs.org/<pkg>` for @mozilla/readability, defuddle, crawlee, turndown, satori, @takumi-rs/core, sharp, @img/sharp-libvips-darwin-arm64, puppeteer, polotno (and its LICENSE.md), konva, fabric, @vercel/og, @resvg/resvg-js, @hyperframes/core, @hyperframes/producer, @hyperframes/engine, @hyperframes/player, hyperframes.
- PyPI `https://pypi.org/pypi/<pkg>/json` for parakeet-mlx, mlx-audio, trafilatura, crawl4ai, faster-whisper, whisperx, pyannote.audio, silero-vad, stable-ts, montreal-forced-aligner, piper-tts, kokoro, chatterbox-tts, f5-tts, deepfilternet, demucs, yt-dlp, scrapling, markitdown, audiocraft, stable-audio-tools, voxcpm, qwen-tts, omnivoice, mflux, comfy-cli.

**Hugging Face model API and cards [F]**

- `https://huggingface.co/api/models/<id>` for: nvidia/parakeet-tdt-0.6b-v3, nvidia/parakeet-tdt-0.6b-v2, mlx-community/parakeet-tdt-0.6b-v3, pyannote/speaker-diarization-community-1, pyannote/speaker-diarization-3.1, pyannote/segmentation-3.0, openai/whisper-large-v3-turbo, Systran/faster-whisper-large-v3, Qwen/Qwen3-ForcedAligner-0.6B, Qwen/Qwen3-ASR-1.7B, nvidia/canary-1b-v2, hexgrad/Kokoro-82M, ResembleAI/chatterbox, ResembleAI/chatterbox-turbo, ResembleAI/chatterbox-hf, SWivid/F5-TTS, nari-labs/Dia-1.6B, nari-labs/Dia-1.6B-0626, nari-labs/Dia2-2B, rhasspy/piper-voices (and commit log), openbmb/VoxCPM2, Qwen/Qwen3-TTS-12Hz-1.7B-Base, k2-fsa/OmniVoice, facebook/musicgen-small, facebook/musicgen-large, stabilityai/stable-audio-open-1.0, stabilityai/stable-audio-open-small, ACE-Step/Ace-Step1.5, black-forest-labs/FLUX.1-schnell, black-forest-labs/FLUX.1-dev, black-forest-labs/FLUX.2-klein-4B, black-forest-labs/FLUX.2-klein-9B, black-forest-labs/FLUX.2-dev, stabilityai/stable-diffusion-3.5-large, stabilityai/stable-diffusion-3.5-medium, stabilityai/stable-diffusion-xl-base-1.0, Qwen/Qwen-Image, Qwen/Qwen-Image-Edit-2511, Tongyi-MAI/Z-Image-Turbo, Tongyi-MAI/Z-Image, mlx-community/DeepFilterNet-mlx, laion/clap-htsat-unfused, laion/larger_clap_general.
- Piper voice cards: https://huggingface.co/rhasspy/piper-voices/raw/main/en/en_US/{lessac/medium,amy/medium,ryan/high,libritts_r/medium,hfc_female/medium,ljspeech/high}/MODEL_CARD, en/en_GB/alba/medium/MODEL_CARD, de/de_DE/thorsten/high/MODEL_CARD.
- https://huggingface.co/k2-fsa/OmniVoice and https://huggingface.co/stabilityai/stable-audio-open-small (card text).

**Provider terms and documentation [F]**

- https://brave.com/search/api/ and https://api-dashboard.search.brave.com/terms-of-service (last updated 2026-09-01)
- https://www.tavily.com/terms (last updated 2026-05-04)
- https://exa.ai/terms (PDF, undated)
- https://serpapi.com/legal (last updated 2026-08-27)
- https://developers.google.com/youtube/terms/developer-policies
- https://developers.google.com/youtube/v3/docs/search/list and https://developers.google.com/youtube/v3/determine_quota_cost
- https://www.youtube.com/static?template=terms (effective 2022-01-05)
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search, .../ig-hashtag/top-media, .../ig-user/business_discovery
- https://freesound.org/docs/api/terms_of_use.html
- https://pixabay.com/service/license-summary/
- https://stability.ai/license
- https://ffmpeg.org/legal.html
- https://docs.comfy.org/development/comfyui-server/comms_routes

**Search results only [S]**

- Instagram Terms wording: https://help.instagram.com/581066165581870 (page did not render for fetch; quoted via search)
- TikTok Research API eligibility: https://developers.tiktok.com/docs/en/research-api-faq (products page refused the connection)
- Elastic acquisition of Jina AI: https://www.businesswire.com/news/home/20251009619654/en/
- Neywa Labs and mlx-audio: https://aiwiki.ai/wiki/neywa_labs
- Audio8-TTS: https://www.marktechpost.com/2026/10/29/edge0-audio8-tts-realistic-0-6b-voice-cloning/ ; Zonos: https://www.zyphra.com/our-work/zonos2
- Short-form tools: https://pypi.org/project/shortform-ai/ , https://pypi.org/project/shorts-trends/ , https://virlo.ai/for-developers
- Meta v.
  Bright Data: https://www.fbm.com/business-litigation/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/ , https://techcrunch.com/2024/01/24/court-rules-in-favor-of-a-web-scraper-bright-data-which-meta-had-used-and-then-sued
- EU DSM Article 4: https://legalblogs.wolterskluwer.com/copyright-blog/the-new-copyright-directive-text-and-data-mining-articles-3-and-4/

**CreatorBrio repository (origin/main) [F]**

- `docs/research/video-studio/02-ecosystem-inventory.md`, `evidence/e1` to `e8`, `spec/05-capability-matrix.md`, `spec/08-licensing-and-commercial.md`
- `docs/architecture/adr-creatorbrio-video-studio.md`, `docs/roadmap/video-studio/README.md`, `docs/roadmap/video-studio/gates/g1-renderer.md`
- `package.json`, `src/lib/source-retrieval.ts`, `src/lib/source-text.ts`, `src/lib/video/render/overlay-browser.ts`, `src/lib/video/media/tools.ts`
