[← Research index](../README.md) · [Specification](../spec/README.md) · Evidence appendix

> **About this appendix.** Working notes for the product specification ([#66](https://github.com/mk-global/creatorbrio/issues/66)), kept close to how they were written so conclusions can be traced. Repositories were cloned and **read only**: nothing was installed, built or executed. Dates and SHAs come from `git log` of fresh clones taken on 2026-11-04. Labels such as *unverified* mark claims that could not be checked from primary sources in the research session (huggingface.co, Wikimedia, Openverse, Freesound, Pexels, Pixabay, archive.org, NASA, Library of Congress and Smithsonian sites were unreachable; terms were read from project repositories, registries or search results as marked). Paths shown as `<local clone>/…` refer to the researcher's temporary clone.


# 08 — Local TTS, media-sourcing APIs, AI provider terms (research notes, 2026-11-04)

Scope: CreatorBrio Video Studio product spec. Target: Apple Silicon Mac, local-first, MIT-licensed app that may later sell services. Builds on `docs/research/video-studio/02-ecosystem-inventory.md` and `evidence/e5-building-blocks.md` (ASR, Qwen3-ForcedAligner, Pexels/Pixabay limits, and Freesound basics are already covered there and are not repeated, except where this pass changes a conclusion).

## Method and access limits

- **Primary evidence:** blobless clones (`git clone --filter=blob:none --no-checkout`) of each project under `<local clone>/<owner>_<repo>`. I read LICENSE, README and docs with `git show HEAD:<path>` and did not execute anything. Release dates come from PyPI JSON, git tags and commit dates.
- **Anthropic pages:** fetched directly with curl from `code.claude.com` (`legal-and-compliance.md`, `agent-sdk/overview.md`, `authentication.md`), `www.anthropic.com/legal/consumer-terms`, and the npm tarball of `@anthropic-ai/claude-agent-sdk`.
- **Blocked in this session:** curl and WebFetch both failed for `huggingface.co`, `api.openverse.org`, `commons.wikimedia.org`, `meta.wikimedia.org`, `foundation.wikimedia.org`, `freesound.org`, `archive.org`, `pexels.com`, `pixabay.com`, `images-api.nasa.gov`, `loc.gov`, `api.si.edu`, `ollama.com` and `lmstudio.ai`, which were refused by the proxy or did not resolve. `raw.githubusercontent.com`, `github.com` (git), `pypi.org`, `registry.npmjs.org`, `code.claude.com` and `anthropic.com` worked.
  - Consequence: **Hugging Face model-card weight licences are unverified** unless the GitHub README states them. Those are marked *(HF, unverified)*.
  - Pexels, Pixabay, Internet Archive, NASA, LoC and Smithsonian terms come from **web-search snippets** *(web)*.
  - Openverse and Freesound terms come from their **own GitHub repositories**, which hold the API's source and docs.

---

## 1. Local TTS for narration on Apple Silicon

### 1.1 Candidate table

Legend: ✅ commercial use OK under the stated licence · ⚠️ restricted or custom · ❌ non-commercial.

| Model | Code licence | Weights licence | Cloning | Controllability | Word timestamps | Languages | Apple Silicon path | Latest release / activity |
|---|---|---|---|---|---|---|---|---|
| **Kokoro-82M** (hexgrad) | Apache-2.0 | ✅ Apache-2.0 ("With Apache-licensed weights", README) | No (fixed voice packs; voices can be blended) | `speed`; misaki G2P accepts inline phoneme overrides `[word](/fonemz/)`; per-chunk phoneme output | **Yes, English only:** `KPipeline.join_timestamps` sets `token.start_ts/end_ts` from predicted durations (`kokoro/pipeline.py` L291–328). Ported to mlx-audio (`mlx_audio/tts/models/kokoro/pipeline.py` L363–396) | EN (US/UK), JA, ZH, FR, ES, IT, PT, HI | MLX (mlx-audio `mlx-community/Kokoro-82M-*`), MPS (`PYTORCH_ENABLE_MPS_FALLBACK=1`), ONNX (kokoro-onnx 0.6.1, 2026-08-19, MIT code) | PyPI `kokoro` 0.9.4 (2025-04-05); repo commit 2025-08-06. Stable but quiet; mlx-audio port active (0.6.4, 2026-11-02) |
| **Piper** (OHF-Voice/piper1-gpl) | ⚠️ **GPL-3.0** (moved from MIT rhasspy/piper, now archived: "Development has moved") | ⚠️ **Per voice**: "The MODEL_CARD file for each voice contains important licensing information… Piper is intended for personal use and text to speech research only… Some voices may have restrictive licenses" (docs/VOICES.md) | No | `--length-scale`-style rate, `--sentence-silence`, raw espeak phonemes `[[ … ]]` (docs/CLI.md) | Experimental **phoneme** alignments (samples per phoneme id) after patching the ONNX file (docs/ALIGNMENTS.md). No word timing | ~40 languages | ONNX on CPU | v1.8.0 (PyPI 2026-09-04); commits 2026-11-02; "Looking for Maintainers" |
| **Chatterbox** (Resemble AI): original 0.5B EN, Multilingual V3 0.5B, Turbo 350M, Nano 110M | MIT | ✅ MIT *(secondary sources; HF card unverified, and one sibling repo `chatterbox-hf` shows Apache-2.0)* | **Yes**, zero-shot from a reference clip | `exaggeration`, `cfg_weight` (pacing); Turbo/Nano: paralinguistic tags `[laugh]`, `[cough]`, `[chuckle]` | No → forced alignment | 23+ (Multilingual V3) plus single-language packs | MPS ("cuda/cpu/mps" in README); **MLX** in mlx-audio (v2, v3, Turbo). Nano is CPU-friendly | V3 2026-06-10; Nano 2026-07-21; PyPI 0.1.7 (2026-03-26) |
| F5-TTS | MIT | ❌ **CC-BY-NC** ("due to the training data Emilia", README) | Yes | speed, NFE steps | No | ZH/EN (+community) | MPS; f5-tts-mlx (community) | 1.1.22 (2026-07-23); commit 2026-11-03 |
| XTTS-v2 (Coqui) | MPL-2.0 (idiap fork, v0.28.0, 2026-10-19) | ❌ Coqui Public Model Licence, non-commercial *(HF, unverified)*. Coqui the company has closed, so a commercial licence is likely unobtainable *(unverified)* | Yes | speed, temperature | No | 17 | MPS/CPU | Fork active; weights frozen |
| Orpheus 3B (Canopy) | Apache-2.0 | ⚠️ Llama-3.2 community licence (Llama backbone) *(HF, unverified)* | Partial (pretrained model only; "Fix voice cloning" still a TODO) | Emotive tags `<laugh>`, `<sigh>`… | No | EN (+ research multilingual) | llama.cpp/GGUF path; MLX community | Commit 2025-12-05 |
| Dia 1.6B / **Dia2** 1B, 2B (Nari) | Apache-2.0 | Apache-2.0 *(HF, unverified)* | Yes (audio prompt) | `[S1]/[S2]` speakers, `(laughs)` etc. | **Dia2: yes**, "word timestamps relative to Mimi's ~12.5 Hz frame rate" (README) | EN only; Dia2 ≤2 min per generation | Dia in mlx-audio; Dia2 README requires CUDA 12.8+ | Dia2 commit 2025-11-29 |
| Sesame CSM-1B | Apache-2.0 | Apache-2.0 *(HF, unverified)*; **needs gated Llama-3.2-1B** | Yes (context) | Conversational context | No | EN ("likely won't do well" otherwise) | MPS; mlx-audio `csm-1b` | Commit 2025-05-27 |
| IndexTTS-2 / 2.5 (bilibili) | ⚠️ **bilibili Model Use License** covers code *and* weights | ⚠️ Custom: royalty-free, but a separate licence is needed above 100M MAU or RMB 1bn revenue. The downstream must be bound to the same terms. **"Model outputs" are defined as Derivative Works.** Using it to improve other models is prohibited (LICENSE §1.5, §2.2, c) | Yes | Emotion reference audio, `emo_alpha`, `duration_factor` 0.5–2.0× (2.5) | No | ZH, EN, JA, ES, AR | mlx-audio has `indextts` | v2.5.0 (2026-08-10); commit 2026-09-30 |
| **Qwen3-TTS** 0.6B/1.7B (Alibaba) | Apache-2.0 | ✅ Apache-2.0 *(HF, unverified; repo LICENSE is Apache)* | **Yes**, 3-second clone (Base); VoiceDesign from a text description | Natural-language `instruct` (emotion, rate, prosody); 9 preset timbres (CustomVoice) | No (pair with Qwen3-ForcedAligner) | 10 (ZH, EN, JA, KO, DE, FR, RU, PT, ES, IT) | MLX (mlx-audio `Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16`) | qwen-tts 0.1.1 (2026-02-06); commit 2026-03-17 |
| VibeVoice (Microsoft) | MIT | MIT; README: "intended for research and development purposes only… do not recommend… commercial" | Long-form TTS code **removed** 2025-09-05 for misuse; 1.5B "Disabled"; Realtime-0.5B available | Fixed speakers | No | EN (+ experimental) | mlx-audio has `vibevoice` | Repo is now mostly ASR (2026-10-08) |
| Kyutai TTS 1.6B (DSM) | MIT (Python) / Apache-2.0 (Rust) | CC-BY-4.0 *(HF via web)* | **No open cloning**: only precomputed voice embeddings (kyutai/tts-voices; per-voice licences unverified) | Streaming | **Yes**: "outputs the exact timestamps of the words" *(kyutai.org, web)* | EN, FR | MLX script `scripts/tts_mlx.py`, Rust server | Commit 2026-01-26 |
| MeloTTS (MyShell) | MIT | ✅ MIT | No | speed | No | EN (accents), ES, FR, ZH, JA, KO | MPS/CPU; mlx-audio English port | Stale: commit 2024-12-24 |
| StyleTTS2 | MIT (inference needs GPL phonemizer) | ⚠️ Pretrained-model condition: you must "inform the listeners that the speech samples are synthesized… unless you have the permission" | Yes (style ref) | α/β style, diffusion steps | No | EN | MPS | Stale: commit 2024-03-06 |
| Fish Speech / OpenAudio / Fish Audio Drama 3 | ⚠️ **Fish Audio Community License v1.0** (2026-10-13) now in the repo LICENSE | ⚠️ Commercial use only while the licensee's annual revenue is < **USD 500k**. **No hosted service** without a licence. "Built with Fish Audio" must be displayed. Using outputs to train speech models is banned. **Consent required** to imitate a voice | Yes | Inline cues; multi-speaker | No | 83 (Drama 3) | MLX (mlx-audio 4-bit Drama 3, a 35B MoE) | v3.0.0-beta; commit 2026-10-30 |
| Supertonic 3 (Supertone) | MIT | ⚠️ **OpenRAIL-M** (use restrictions; commercial allowed) | No (voice styles; cloning only in their paid service) | speed, steps | No | 31 | **ONNX** (CoreML EP possible), Swift/Node/WebGPU SDKs; `supertonic serve` exposes OpenAI `/v1/audio/speech` | **Archived** 2026-09-09: "No updates, bug fixes, security patches" |
| KittenTTS 0.8 / kitten-tts-2 1.7B | Apache-2.0 | ⚠️ "Models are licensed separately": kitten-tts-2 is under the **Stellon Labs Community License** (terms unverified) | kitten-tts-2: yes (5–30 s) | Expression control | No | 20 (v2); EN (0.8) | ONNX CPU; MLX (mlx-audio 0.8) | Commit 2026-10-26 |
| **VoxCPM2** 2B (OpenBMB) | Apache-2.0 | ✅ "Weights and code released under the Apache-2.0 license, free for commercial use" (README) | **Yes**, plus controllable cloning (style text) and voice design | Control instructions: speed, emotion, style | No | 30 | MLX (mlx-audio `VoxCPM2-bf16/8bit/4bit`) | voxcpm 2.0.3 (2026-05-11); commit 2026-10-08 |
| OmniVoice (k2-fsa) | Apache-2.0 | Apache-2.0 *(HF, unverified)* | Yes, plus voice design (`instruct`) | `speed`, **`duration`** (fixed output length, useful for fitting a beat), nonverbal tags | No | 600+ | MPS (`device_map="mps"`); MLX (mlx-audio `OmniVoice-bf16`) | 0.2.1 (2026-07-16); commit 2026-08-24 |
| Higgs Audio v3 (Boson) | Apache-2.0 (v2 repo) | ❌ v3: "Research and Non-Commercial License"; v2: Boson community licence *(unverified)* | Yes | Inline control tokens | No | 100+ | mlx-audio | 2026-06-04 |
| Voxtral TTS 4B (Mistral) | — | ❌ **CC-BY-NC-4.0** ("inherits" from reference voices; HF card via web) | Reference voices | 20 voices | No | 9 | mlx-audio | 2026-03 |

Other mlx-audio TTS entries were not licence-checked because HF was blocked: Audio8, Maya2, MOSS-TTS(-Nano), Ming-3.0, LongCat-AudioDiT, KugelAudio, Soprano, Phonon, Spark, OuteTTS, rumik-oss, and more. mlx-audio itself is MIT, 0.6.4 (2026-11-02), and exposes an **OpenAI-compatible `/v1/audio/speech`** server (`mlx_audio/server.py` L989).

### 1.2 Observations

- **SSML:** none of these models implements SSML. Control comes from model-specific knobs: `speed`, Kokoro/misaki phoneme overrides, Piper `[[phonemes]]`, natural-language `instruct` (Qwen3-TTS, VoxCPM2, OmniVoice), emotive tags (Chatterbox Turbo, Orpheus, Dia), and `duration` (OmniVoice, IndexTTS-2.5).
  - CreatorBrio should define its **own minimal narration markup** and compile it per engine: sentence segmentation, pause (insert silence between generated segments), a rate multiplier, and a pronunciation lexicon (phonemes where the engine supports them, otherwise respelling). Emphasis is best effort.
- **Timestamps:** only Kokoro (English), Dia2 and Kyutai TTS emit word timing natively.
  - Always running **Qwen3-ForcedAligner (mlx-audio, Apache-2.0)** on the *known script* gives one caption path for every engine. It is already "adopt after validation" in E5.
  - Synthesising **per sentence** and concatenating gives exact sentence boundaries for free.
- **Watermarking:** upstream Chatterbox embeds a PerTh watermark, but the **mlx-audio Chatterbox port does not** (no `perth`/`watermark` references in `mlx_audio/tts/models/chatterbox*`). CreatorBrio would need to add its own provenance marking.
- **GPL exposure:** Kokoro/misaki falls back to **espeak-ng (GPL-3.0)** for out-of-vocabulary English and for some languages, and Piper is GPL-3.0. Run both as separate processes and do not bundle or link them into the MIT app; document them as optional user-installed dependencies.

### 1.3 Recommendation

- **Primary narration engine: Kokoro-82M via mlx-audio**, with kokoro-onnx as the fallback.
  - Apache-2.0 code and weights; tiny and fast.
  - Native English word timestamps; phoneme overrides for brand names; 8 languages.
  - Risks: the upstream PyPI release is from 2025-04; there is no cloning; espeak-ng (GPL) is an optional fallback that should not be bundled.
- **Voice cloning (commercially usable): Chatterbox Multilingual V3, with Turbo for English expressiveness, via mlx-audio.**
  - MIT; 23 languages; paralinguistic tags; small (0.5B/350M).
  - Before shipping, verify the HF weight licence (MIT reported). Re-add PerTh watermarking with `resemble-perth`, whose licence also needs verifying.
  - **Alternative: VoxCPM2** (Apache-2.0 weights stated in its own README; 30 languages; voice design plus controllable cloning; 48 kHz), or Qwen3-TTS (Apache-2.0, instruction control).
- **Exclude from the default registry:**
  - non-commercial: F5-TTS, XTTS-v2, Higgs v3, Voxtral TTS;
  - custom or revenue-capped: Fish/OpenAudio, IndexTTS, KittenTTS-2;
  - research-only or disabled: VibeVoice;
  - archived: Supertonic;
  - per-voice licences: Piper, unless the voice is vetted.
- **Ethics and consent requirements to put in the spec:**
  - Cloning is allowed only from a voice the user attests is theirs or is backed by **recorded consent**: a checkbox, plus a short spoken consent phrase recorded with the sample and stored alongside it.
  - No cloning of public figures.
  - Write voice-profile provenance (`consentAt`, `consentAudio`, `sourceSampleHash`) into the project.
  - Apply an AI-disclosure label and an audio watermark or C2PA manifest on export.
  - Several licences demand these anyway: Fish IV(b), StyleTTS2, the Dia2/CSM misuse clauses, VibeVoice's "disclose the use of AI".
  - EU AI Act Art. 50 transparency duties for synthetic audio apply from 2026-08-02. That date comes from my training data and was not re-verified here.

---

## 2. Media-sourcing APIs

| Source | Access / key | Rate limits | Licence metadata | Attribution and terms that matter |
|---|---|---|---|---|
| **Wikimedia Commons** (MediaWiki Action API `commons.wikimedia.org/w/api.php`) | No key. A compliant **User-Agent with contact info** is required by the WMF User-Agent policy | **New global API rate limits rolled out Mar/Apr 2026**, tiered from "low" (unauthenticated, compliant UA only) to "very high" (approved bots); "subject to experimentation and change" (mediawiki.org *Wikimedia APIs/Rate limits*, web). Honour 429 / `Retry-After` per the Robot policy | `prop=imageinfo&iiprop=url|extmetadata|sha1|mime|size`. `extmetadata` holds `LicenseShortName`, `LicenseUrl`, `UsageTerms`, `Artist` (HTML), `Credit`, `Attribution`, `AttributionRequired`, `Copyrighted`, `Restrictions`, each as `{value, source}`. "For multi-licensed files these licence values are currently unreliable" (Extension:CommonsMetadata, web) | Per-file licence. Many files are **CC BY-SA**: ShareAlike may attach to the exported video if it is an adaptation (legally unclear), so warn the user or exclude by default. `Restrictions` flags personality and trademark rights. Strip HTML from `Artist` but keep it for the credit |
| **Openverse** (`api.openverse.org/v1`) | Anonymous allowed. Registration is OAuth2 client-credentials (`/v1/auth_tokens/register`, `/token`, then a Bearer token). Source: `api/conf/settings/spectacular.py` | Code defaults (`api/conf/settings/rest_framework.py`): anonymous **5/hour burst, 100/day sustained** (env-overridable, so production values are unverified); OAuth2 **100/min, 10,000/day**; "enhanced" 200/min, 20,000/day. Third-party reports: anonymous ~1 req/s and `page_size` ≤ 20, authenticated up to 500 *(web)*. Response headers report usage; over the limit you get 429. "the ToS disallow scraping under all circumstances" | Fields: `license`, `license_version`, `license_url`, `creator`, `creator_url`, `foreign_landing_url`, `provider`, `source`, `attribution` (ready-made string), `mature`, `filetype`. Filter `license_type=commercial,modification` (excludes `nc` and `nd`) per `api/constants/licenses.py` | Openverse **aggregates** and does not license; the upstream licence governs, so re-verify at `foreign_landing_url`. Use the `attribution` string. Includes CC0/PDM and all CC licences, including NC and ND |
| **Freesound** (`freesound.org/apiv2`) | API key (`token=`) for search and **previews** (mp3/ogg). **OAuth2 is required for original-quality downloads** (`_docs/api/source/overview.rst` L68–79) | 60/min and 2,000/day; downloads 30/min and 500/day (overview.rst L162–163) | `license` ∈ "Attribution", "Attribution NonCommercial", "Creative Commons 0" (resources.rst); plus `username` and the sound URL | **"You can use the Freesound API for free only for non-commercial purposes. To use the Freesound API for commercial purposes, please contact us"** (`_docs/api/source/terms_of_use.rst`, updated 2026-10-01). Moderators have said that even a free app letting users search and download counts as commercial *(web, Google Group)*. Credit Freesound and the users. Do not replicate Freesound. **This changes E5**: Freesound can only be a user-brings-own-key opt-in, documented as "non-commercial API terms"; it is not a built-in source in a product that will sell services |
| **Internet Archive** (`archive.org/advancedsearch.php?output=json&fl[]=…`, `archive.org/metadata/<id>`) | No key | Not documented *(unverified)* | `licenseurl` (CC URL when set), `rights` (free text), `possible-copyright-status` on some collections *(field names from prior knowledge; unverified, site blocked)* | Rights are per item and **often absent or unreliable**. The site ToS grants access "for scholarship and research purposes only" with noncommercial use *(web; quoted in a court filing; current text unverified)*. Allow only items whose `licenseurl` is CC0/PDM/CC-BY, and mark them as "user must verify" |
| **Pexels** | Free key | 200/hour, 20,000/month (E5); can be raised for free after review | Per asset: photographer name and URL | "Always credit our photographers when possible" plus a **prominent link to Pexels**. **Do not replicate a Pexels-like service**. No selling unaltered copies. No depicting identifiable people offensively or implying endorsement *(web, help.pexels.com)* |
| **Pixabay** | Free key | ~100 requests / 60 s *(web, conflicting)*; responses **must be cached 24 h**; no permanent hotlinking, so download first *(archived docs, web)* | Per asset: user and page URL | Link to Pixabay required when showing results. Content Licence **prohibits standalone redistribution** (including via stock platforms) and use for **training ML or in AI generation tools** *(Pixabay FAQ/terms, web)*. Consequence: do not send Pixabay assets to generative models (img2vid, style transfer) |
| **NASA Images** (`images-api.nasa.gov`) | No key *(unverified)* | — | Item `center`, `photographer`, `secondary_creator`; some items are third-party © | "Generally not subject to copyright in the United States". **No implied endorsement**. NASA insignia and logotype are not public domain. Third-party © items are labelled *(nasa.gov guidelines, web)* |
| **Smithsonian Open Access** (`api.si.edu/openaccess/api/v1.0`) | api.data.gov key (free) | 1,000/hour per key *(web, secondary)*; bulk set on AWS S3 | Open Access items are CC0; filter on the item's usage/access flag (field name unverified) | Not every Smithsonian record is open access, so filter before use |
| **Library of Congress** (`loc.gov/…?fo=json`) | No key | **20 req/min, one-hour block if exceeded**; 150/min for `/storage-services/` media (loc.gov "working within limits", web) | `rights_advisory` per item *(unverified)* | Many items say "no known restrictions", but rights vary; record the advisory text |

### 2.1 Policy implications for CreatorBrio (download into project, export video)

1. **Licence allow-list by default:** CC0, PDM / public domain (US government works, with a note that this is US-only), CC BY, Pexels licence, Pixabay licence.
   - **Excluded by default:** NC (the product may become commercial and creators monetise their posts), ND (cropping, overlays and timing are adaptations), and unknown.
   - **CC BY-SA:** allowed only after the user acknowledges the ShareAlike risk.
   - The filter is enforced server-side and not only in the UI. For Openverse, query with `license_type=commercial,modification`.
2. **Per-asset provenance record** (store as `assets/<id>.json` and keep it with the project):
   - `sourceProvider`, `sourceId`, `landingUrl`, `fileUrl`;
   - `title`, `creator`, `creatorUrl`;
   - `license` (SPDX-like id plus version), `licenseUrl`, `attributionText` (provider-supplied when available), `attributionRequired`;
   - `modifications` (crop, colour, trim and so on: CC BY requires indicating changes);
   - `retrievedAt`, `sha256`, raw API metadata snapshot, `restrictions`/flags (personality, trademark, mature);
   - `apiTermsVersion`/notes (for example `pixabay:no-ai-input`, `freesound:noncommercial-api`).
3. **Export:**
   - Auto-generate a **credits block**: an end-card slide and/or a caption/description text file, and a `CREDITS.txt`/JSON sidecar in the export ZIP.
   - Block or warn on export when a required attribution is missing.
4. **Provider-ToS gates:**
   - Pixabay assets are never fed to generative or ML features.
   - Freesound and Internet Archive are opt-in only, labelled non-commercial or research.
   - Pexels and Pixabay results are cached (24 h for Pixabay) and downloaded rather than hotlinked.
5. **Network etiquette:**
   - Descriptive User-Agent with a contact URL on every request (Wikimedia requires it).
   - Respect 429 / `Retry-After`; cache per provider.
   - No bulk or pagination scraping (Openverse ToS).
   - **User-supplied API keys** stored locally and never shipped in the repo, so usage is attributed to the user's key.
6. **Downloads are untrusted:**
   - Verify the MIME type by magic bytes (as `/api/upload` already does), cap the size, and re-encode media through FFmpeg before use.
   - Store the original hash.

---

## 3. AI provider terms for a distributed open-source product

### 3.1 Anthropic: exact current text (fetched 2026-11-04)

- **Agent SDK overview** (`https://code.claude.com/docs/en/agent-sdk/overview`):
  > "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."
  - Also: "Use of the Claude Agent SDK is governed by Anthropic's Commercial Terms of Service, including when you use it to power products and services that you make available to your own customers and end users."
  - Branding: "Your product should maintain its own branding and not appear to be Claude Code or any Anthropic product."
- **Claude Code legal and compliance** (`https://code.claude.com/docs/en/legal-and-compliance`), section "Authentication and credential use":
  > "OAuth authentication is intended exclusively for purchasers of Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans and is designed to support ordinary use of Claude Code and other native Anthropic applications."
  >
  > "Developers building products or services that interact with Claude's capabilities, including those using the Agent SDK, should use API key authentication through Claude Console or a supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow."
  >
  > "…Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?*"
  - "Can customers offer Claude Code in their products?": "preinstalling or running Claude Code in your products or services … requires agreeing to our Commercial Terms … The Claude Code binary must not be modified … may not remove, disable, or restrict any authentication method … **Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf.** Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential."
  - Also: "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK." "Anthropic reserves the right to take measures to enforce these restrictions … without prior notice."
- **Consumer Terms** (effective 2025-10-08) prohibit accessing the Services "through automated or non-human means, whether through a bot, script, or otherwise", "Except when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it".
- **Licences:**
  - `@anthropic-ai/claude-agent-sdk` 0.3.318 (npm, 2026-11-03) and `@anthropic-ai/claude-code` 2.1.318 are **proprietary**: "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements…".
  - PyPI `claude-agent-sdk` 0.2.178 declares MIT.
  - `@anthropic-ai/sdk` 1.4.0 is Apache-2.0.

**Interpretation (not legal advice):**

- **Local app spawning the user's own installed, unmodified `claude` CLI (today's `/api/chat`)** fits the explicit carve-out ("an end user … signing in to the unmodified Claude Code binary with their own Claude subscription"), provided CreatorBrio:
  - never ships, modifies or wraps the binary's auth;
  - never reads, stores or forwards `~/.claude` credentials or `CLAUDE_CODE_OAUTH_TOKEN`;
  - never presents its own "Sign in with Claude" button;
  - leaves login to `claude /login`;
  - never multiplexes several people onto one login.

  Two things keep it grey: "ordinary, individual usage" and the Consumer Terms' automation clause (Claude Code `-p` is Anthropic's own product, so this is arguably "explicitly permitted"). Keep agent runs user-initiated and avoid unattended batch farms on a subscription. Do not embed the Claude Code or Anthropic name in CreatorBrio's product name.
- **Agent SDK inside CreatorBrio** → **API key** (or Bedrock / Vertex / Foundry) only, unless Anthropic approves otherwise. A distributed app can let each user paste their own key (BYOK), billed to them.
- **Hosted paid CreatorBrio service:**
  - Must use API keys under the Commercial Terms.
  - If it runs the Claude Code binary for users, "may not pay for, resell, or intermediate Claude usage on their end users' behalf", so each user would bring their own credential.
  - If the operator wants to pay for and bill usage, use the **Claude API / Agent SDK with the operator's key under the Commercial Terms**. Whether the bundled-binary clause also binds Agent SDK deployments is ambiguous, so **confirm with Anthropic sales** before launch.
  - A user's Claude.ai subscription can never back a hosted service.

### 3.2 Provider-agnostic options

| Runtime | OpenAI-compatible chat | Tool calling | JSON-schema structured output | Vision | Anthropic `/v1/messages` (so the `claude` CLI can target it) | Notes |
|---|---|---|---|---|---|---|
| **Ollama** (v0.40.14; docs 2026-10-27) | `/v1/chat/completions`, `/v1/responses` | ✅ `tools` (no `tool_choice`) | ✅ `response_format`; native `format: <JSON schema>` (docs/capabilities/structured-outputs.mdx) | ✅ base64 images (no image URL) | ✅ messages, streaming, tools, vision, thinking; `ANTHROPIC_BASE_URL=http://localhost:11434` | Most complete local option; MLX backend on Mac *(not re-verified)* |
| **LM Studio** | ✅ | ✅ all models, "Native" vs "Default" quality levels | ✅ `response_format.json_schema` (GGUF via llama.cpp grammars, **MLX via Outlines**) | ✅ (VLMs) | ✅ `/v1/messages`; Claude Code guide | Desktop app (closed source; free) |
| **llama.cpp `llama-server`** (b12098) | ✅ | ✅ (`--jinja`, on by default; native and generic handlers for ~any model) | ✅ `json_schema` / `grammar` | ✅ experimental (`--mmproj`) | ✅ "Anthropic Messages API compatible" | MIT; most portable |
| **mlx-lm server** (0.32.2) | ✅ `/v1/chat/completions` | ✅ (tool parser) | ❌ no `response_format`/`json_schema` in `server.py` (grep) | partial (image parts handled; VLMs via mlx-vlm 0.7.11) | — | "not recommended for production as it only implements basic security checks" |

- **Local vision models:** Qwen3-VL (dense and MoE), Qwen3.5, Gemma 4, Mistral 3, Molmo 2, InternVL and SmolVLM are all present in mlx-vlm 0.7.11 (`mlx_vlm/models/`). Weight licences were not verified (HF blocked). Qwen-VL is Apache-2.0 per prior knowledge; Gemma models carry Google's own terms *(verify)*.
- **MCP:** `@modelcontextprotocol/sdk` 1.32.2 (MIT). Claude Code, Codex-style CLIs, LM Studio (MCP host) and most agent runtimes consume MCP, so it is the right **tool interface**, independent of the model.

### 3.3 Recommended model interface shape

Two layers.

1. **Tools: MCP server owned by CreatorBrio** (stdio and loopback HTTP). One tool schema set (JSON Schema) is used by every agent runtime:
   - `project.read`, `timeline.applyOps` (with dry-run, diff and checkpoint);
   - `assets.search` (with licence filter), `tts.synthesize`, `captions.align`, `render.preview`.
   - The existing REST routes stay as the implementation.
2. **Agent backends behind one internal interface:**

   ```ts
   interface AgentBackend {
     id: "claude-cli" | "anthropic-api" | "openai-compatible";
     capabilities(): { tools: boolean; jsonSchema: boolean; vision: boolean; streaming: boolean; maxContext?: number };
     run(input: { system: string; messages: Msg[]; mcpServers?: McpConfig[]; tools?: ToolDef[];
                  responseSchema?: JSONSchema; images?: ImageRef[]; signal: AbortSignal }): AsyncIterable<AgentEvent>;
   }
   // AgentEvent = token | tool_call | tool_result | structured(json) | error{code,message} | done{sessionId}
   ```

   - **`claude-cli`:** today's spawn of the user's `claude` with `--mcp-config` and allowed tools. Subscription or the user's own key; CreatorBrio never touches credentials.
   - **`anthropic-api`:** BYOK, via the Agent SDK or `@anthropic-ai/sdk`. Required for any hosted or paid tier.
   - **`openai-compatible`:** `baseURL` + `model` + optional key. Covers Ollama, LM Studio, llama.cpp, mlx-lm and cloud OpenAI-compatible vendors. A small CreatorBrio-side loop bridges MCP tools to function calls.
   - Structured output is used when `capabilities().jsonSchema` is true, otherwise prompt plus validate (Zod/Ajv) plus retry.
   - Alternatives: the Vercel `ai` SDK (7.0.162, Apache-2.0) as the TS abstraction, or simply pointing the `claude` CLI at a local server through `ANTHROPIC_BASE_URL`, which Ollama, LM Studio and llama.cpp all document.
   - Treat every model output, local or remote, as untrusted. Validate every tool call against the schema server-side, as `src/lib/api-input.ts` already does for REST.

---

## Sources

Anthropic
- https://code.claude.com/docs/en/legal-and-compliance (fetched as `.md`)
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/authentication
- https://www.anthropic.com/legal/consumer-terms
- npm `@anthropic-ai/claude-agent-sdk` 0.3.318 LICENSE.md; npm `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`, `ai`, `openai` registry metadata

TTS (GitHub HEAD, read via blobless clone)
- https://github.com/hexgrad/kokoro (README, `kokoro/pipeline.py` L280–330)
- https://github.com/hexgrad/misaki
- https://github.com/thewh1teagle/kokoro-onnx
- https://github.com/OHF-Voice/piper1-gpl (COPYING, docs/VOICES.md, docs/CLI.md, docs/ALIGNMENTS.md)
- https://github.com/rhasspy/piper
- https://github.com/resemble-ai/chatterbox
- https://github.com/SWivid/F5-TTS (README §License)
- https://github.com/idiap/coqui-ai-TTS
- https://github.com/canopyai/Orpheus-TTS
- https://github.com/nari-labs/dia
- https://github.com/nari-labs/dia2
- https://github.com/SesameAILabs/csm
- https://github.com/index-tts/index-tts (LICENSE)
- https://github.com/QwenLM/Qwen3-TTS
- https://github.com/microsoft/VibeVoice
- https://github.com/kyutai-labs/delayed-streams-modeling
- https://github.com/myshell-ai/MeloTTS
- https://github.com/yl4579/StyleTTS2
- https://github.com/fishaudio/fish-speech (LICENSE, Fish Audio Community License v1.0)
- https://github.com/supertone-inc/supertonic
- https://github.com/KittenML/KittenTTS
- https://github.com/OpenBMB/VoxCPM
- https://github.com/k2-fsa/OmniVoice
- https://github.com/boson-ai/higgs-audio
- https://github.com/Blaizzy/mlx-audio (README model table, `mlx_audio/server.py`)
- PyPI JSON for kokoro, piper-tts, chatterbox-tts, f5-tts, coqui-tts, voxcpm, omnivoice, qwen-tts, supertonic, mlx-audio

Web (search snippets)
- https://huggingface.co/mistralai/Voxtral-4B-TTS-2603
- https://huggingface.co/kyutai/tts-1.6b-en_fr and https://kyutai.org/next/tts
- https://www.skills.sh/calesthio/generative-media-skills/resemble-chatterbox and https://huggingface.co/ResembleAI/chatterbox-hf (conflicting Chatterbox licence)

Media
- https://github.com/WordPress/openverse (`api/conf/settings/rest_framework.py`, `api/conf/settings/spectacular.py`, `api/api/serializers/media_serializers.py`, `api/api/constants/licenses.py`)
- https://github.com/MTG/freesound (`_docs/api/source/overview.rst`, `resources.rst`, `terms_of_use.rst`)
- https://freesound.org/docs/api/terms_of_use.html
- https://groups.google.com/g/freesound-api/c/R_shemawHsE
- https://www.mediawiki.org/wiki/Extension:CommonsMetadata
- https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits (via mirror)
- https://phabricator.wikimedia.org/T418997
- https://make.wordpress.org/openverse/handbook/openverse-catalog/provider-api-wikimedia-commons/
- https://www.pexels.com/api/documentation/
- https://help.pexels.com/hc/en-us/articles/360042332714
- https://python-pexels.readthedocs.io/en/latest/guidelines.html
- https://pixabay.com/service/terms/
- https://pixabay.com/en/service/license/
- archived Pixabay API docs: https://apis.emri.workers.dev/https-web.archive.org/web/20220721155320/https://pixabay.com/api/docs
- https://www.nasa.gov/nasa-brand-center/images-and-media/
- https://www.loc.gov/apis/json-and-yaml/working-within-limits/
- https://raw.githubusercontent.com/api-evangelist/smithsonian/refs/heads/main/rate-limits/smithsonian-rate-limits.yml (secondary)
- https://law.resource.org/pub/us/cfr/regulations.gov.aera.case/gov.uscourts.dcd.166323.60.34.pdf (Internet Archive terms quote)
- https://wiki.creativecommons.org/wiki/Case_Studies/Internet_Archive

Local LLM runtimes (GitHub HEAD)
- https://github.com/ollama/ollama (`docs/api/openai-compatibility.mdx`, `docs/api/anthropic-compatibility.mdx`, `docs/capabilities/structured-outputs.mdx`)
- https://github.com/lmstudio-ai/docs (`1_developer/3_openai-compat/structured-output.md`, `tools.mdx`, `4_anthropic-compat/index.mdx`)
- https://github.com/ggml-org/llama.cpp (`tools/server/README.md`, `docs/function-calling.md`)
- https://github.com/ml-explore/mlx-lm (`mlx_lm/SERVER.md`, `server.py`)
- https://github.com/Blaizzy/mlx-vlm (`mlx_vlm/models/`)
