[← Research index](../README.md) · Evidence appendix

> **About this appendix.** These are the working notes of one research slice, kept close to how they were written so a reviewer can trace each conclusion in the main documents to its source. Every repository was cloned and **read only**: nothing was installed, built or executed. Dates and commit SHAs come from `git log` of fresh clones taken on 2026-11-03, and package versions from the npm and PyPI registries. Labels such as *implemented*, *claimed*, *unverified* and *[web]* mark how each claim was established. Paths shown as `<local clone>/…` refer to the researcher's temporary clone, not to anything in this repository.

# 05: Foundational building blocks for a local AI Video Studio (Apple Silicon)

Research slice: media processing, speech/transcript, computer vision, audio, video understanding/B-roll, and local AI runtime integration for CreatorBrio's planned short-form reel studio (talking-head content).
Target machine: M5 Max, 128 GB unified memory, macOS 26 (Tahoe). Everything local, nothing paid on the required path.

Research date: 2026-11-03.

## How this was verified, and the limits

- **Release versions and dates** come from PyPI JSON (`pypi.org/pypi/<pkg>/json`), the npm registry, and git metadata. For git, each repo was bare-cloned with `--filter=tree:0` into `<local clone>/*.git`, then tag and commit dates were read. For FFmpeg, only the release tags were fetched. Homebrew formulae were read from `raw.githubusercontent.com/Homebrew/homebrew-core`. Nothing downloaded was executed or installed.
- **Licences** were read from LICENSE or README files in the cloned repos where possible. Anything taken from web search instead is marked "(web)".
- **Blocked hosts.** `huggingface.co` (both the API and Bash curl), `ffmpeg.org`, `stability.ai`, `pixabay.com` and `formulae.brew.sh` were outside the session's network allowlist. As a result:
  - Hugging Face model-card licences and gating could not be read directly. They are marked "(web)" or "verify".
  - Pixabay and Stability terms come from search snippets only.
- **Numbers.** No benchmark numbers were produced here. Every number quoted is labelled "reported by X" with its source.

---

## 1. Media processing

### 1.1 FFmpeg / FFprobe

**Versions and dates**
- The current release is **FFmpeg 9.0.2**: tag `n9.0.2`, tagged 2026-09-18.
- 9.0 "Lei" was tagged 2026-08-03. Earlier releases: 8.1 on 2026-03-16 and 8.0 on 2025-08-22. All dates are from the git tag dates.
- Homebrew `ffmpeg` and `ffmpeg-full` both build 9.0.2, with arm64 Tahoe bottles.

**Changelog items that matter here**
- 8.0 added a `whisper` audio filter (whisper.cpp). It only outputs segment-level text/SRT/JSON, with options such as `model`, `vad_model`, `format` and `max_len`. That is not word-level timing, so it is not enough for captions.
- 9.0 added:
  - "ProRes RAW VideoToolbox hwaccel"
  - "Bitstream filter to split Dolby Vision multi-layer HEVC"
  - "ONNX Runtime DNN backend with GPU execution provider support"
  - SMPTE 2094-50 metadata passthrough

**Critical Homebrew packaging caveat**
- The default `brew install ffmpeg` formula is deliberately slim. Its comment says "Only add dependencies required for dependents in homebrew-core… Add other dependencies to ffmpeg-full".
- It has **no libzimg (`zscale`), no libass (`subtitles`/`ass`), no freetype/fontconfig/harfbuzz (`drawtext`), no libplacebo, no rubberband and no whisper**.
- It does include VideoToolbox/AudioToolbox, x264, x265, SVT-AV1, dav1d, libvpx, opus, lame and libvmaf.
- `ffmpeg-full` adds `--enable-libzimg`, `--enable-libass`, `--enable-libfreetype`, `--enable-libfontconfig`, `--enable-libharfbuzz`, `--enable-libplacebo`, `--enable-librubberband`, `--enable-libvidstab`, `--enable-libsoxr`, `--enable-whisper` and more.
- `ffmpeg-full` is **keg-only**. Call it by absolute path (`$(brew --prefix)/opt/ffmpeg-full/bin/ffmpeg`), or make the path configurable (an `FFMPEG_PATH` setting like the existing `CLAUDE_CLI_PATH`).
- Both formulae are built with `--enable-gpl --enable-version3`, so the binaries are **GPL-3.0-or-later**. Calling them as a separate process from an MIT app is the usual arm's-length arrangement. Do not bundle or redistribute those binaries without GPL compliance.

**Filters needed by the studio**

All of these exist in the 9.0.2 source tree (`libavfilter/`):

| Need | Filter | External lib? | Notes |
|---|---|---|---|
| Loudness normalisation | `loudnorm` (EBU R128) | built in | Use two passes: a measure pass printing JSON, then a linear-mode pass. For social, aim at about -14 LUFS integrated with a -1 dBTP ceiling. That is a convention, not a published Instagram spec. |
| Classic denoise | `afftdn` | built in | Spectral denoise. A cheap fallback or pre-stage before an ML enhancer. |
| RNN denoise | `arnndn` | built in, but needs a `.rnnn` model file | RNNoise-quality. Weaker than DeepFilterNet3 on non-stationary noise; use as a fallback. |
| Ducking | `sidechaincompress` | built in | Good for a "live" auto-duck. For editor-grade results prefer keyframed gain (`volume` with `enable`/expressions, or gain automation computed in the worker), so ducks are deterministic and editable. |
| Silence detection | `silencedetect`, `silenceremove` | built in | Amplitude threshold only. Use Silero VAD for speech/non-speech decisions in noisy rooms (§2). |
| Scene cuts | `scdet` (also `select='gt(scene,x)'`) | built in | A cheap first pass. PySceneDetect or TransNetV2 are better (§5). |
| Colour / HDR | `zscale`, `tonemap`, `colorspace`, `libplacebo`, `scale_vt` | `zscale` needs libzimg (`ffmpeg-full` only); `libplacebo` needs libplacebo plus Vulkan (MoltenVK on macOS); `scale_vt` is VideoToolbox | `scale_vt` exposes `color_matrix`, `color_primaries` and `color_transfer` output options (seen in `vf_scale_vt.c`). Whether VideoToolbox's transfer conversion gives an acceptable HLG→SDR tone map is **untested**; validate it before relying on it. |
| LUTs | `lut3d` (.cube) | built in | For brand looks and for an HLG→709 LUT path. |
| Burned captions | `subtitles`/`ass`, `drawtext` | libass, freetype (`ffmpeg-full` only) | CreatorBrio will likely render captions in its own HTML/Chromium compositor instead (it already has the `wrapSlideHtml` and Puppeteer pattern). |

**VideoToolbox on macOS**
- Decode uses `-hwaccel videotoolbox`. Encoders: `h264_videotoolbox`, `hevc_videotoolbox` (8- and 10-bit), `prores_videotoolbox`. The configure flag `--enable-videotoolbox` is in both Homebrew formulae.
- Use VideoToolbox for proxies, previews and fast drafts. For the final Instagram master, x264 (CRF) usually gives better quality per bit, and VT HEVC/H.264 at a high bitrate is the fast option. Instagram re-encodes uploads, so a high-bitrate H.264 High 1080×1920 yuv420p BT.709 master with AAC 48 kHz is the safe deliverable.
- This quality comparison is general knowledge and should be checked on sample footage. No numbers are claimed.

**Node integration: bindings vs spawning the CLI**
- `fluent-ffmpeg` is **deprecated**. The npm registry shows 2.1.3 (2024-05-19) with "Package no longer supported", and the repo's last commit is 2025-05-22 ("deprecate").
- `ffmpeg-python` (PyPI) was last released in 2019.
- `ffmpeg-static` 5.3.0 (2025-11-14, GPL-3.0) ships builds that are unlikely to include libzimg or libass.
- **Recommendation:** spawn the `ffmpeg`/`ffprobe` CLIs directly with `child_process.spawn`, behind a thin typed TypeScript wrapper:
  - arguments built as arrays, never a shell string;
  - `-progress pipe:1` parsed for progress;
  - `ffprobe -of json` for metadata;
  - a filter-graph builder kept as data, so the agent proposes edits as JSON, not raw filter strings.
- This matches CreatorBrio's existing pattern of spawning the Claude CLI and avoids native addons. libav* bindings (for example `beamcoder`) add ABI and build pain for no gain.

### 1.2 Browser side: mediabunny / WebCodecs

- **mediabunny** (Vanilagy): npm 1.65.1, 2026-11-03, licence **MPL-2.0**. It is pure TypeScript with zero dependencies and reads, writes and converts MP4/WebM/MP3/HLS in the browser using WebCodecs (README).
- Use it for client-side frame extraction for the filmstrip and scrub thumbnails, waveform peaks, and quick metadata, all from **proxies**.
- MPL-2.0 is file-level copyleft. Using it unmodified from npm is fine. Modified mediabunny files must stay MPL.
- Do not make the browser decode the iPhone originals (HEVC 10-bit HLG). Generate SDR H.264 proxies server-side, so the preview and the export share the same colour pipeline.
- `@remotion/media-parser` is under the Remotion licence, which is not OSI, so avoid it unless the Remotion licence is accepted. That decision belongs to the rendering slice.

### 1.3 Proxies, VFR and HDR (pitfalls)

**Proxy generation (ingest step)**
- Run ffprobe and store JSON (streams, `r_frame_rate` vs `avg_frame_rate`, colour tags, rotation display matrix, `side_data` for Dolby Vision).
- Produce an SDR H.264 proxy: 540×960 or 720×1280, short GOP (for example `-g 15`) so seeking is fast in a `<video>` element, `-movflags +faststart`, and `h264_videotoolbox` for speed.
- Extract a 16 kHz mono WAV for ASR/VAD and a 48 kHz WAV for the audio chain.
- Generate a thumbnail sprite and waveform peaks.

**VFR in iPhone footage**
- iPhone clips can be variable frame rate (low light, slow motion, Cinematic mode), and `.MOV` files carry edit lists and extra metadata tracks.
- **Policy:** keep the timeline in seconds (rational time base), not frame indices.
- Conform the edit master/proxy to constant frame rate at ingest (`-fps_mode cfr -r 30` or the project rate). The original stays the source of truth for final renders, which re-conform the same way.
- Verify A/V sync after conforming, and keep word timestamps from the ASR relative to the **audio** stream's start, accounting for stream `start_time` offsets.

**HDR → SDR (iPhone HLG / Dolby Vision 8.4)**

iPhone 12 and later record HDR by default: HEVC Main10, BT.2020, HLG transfer (`arib-std-b67`), with Dolby Vision profile 8.4 metadata. Known pitfalls:
1. Scaling or converting to 8-bit yuv420p without tone mapping gives **washed-out, flat** images (web).
2. The common chain `zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p` (web) needs `zscale`, so it **does not work with Homebrew's default `ffmpeg`**. `npl` and the operator choice change results visibly, and HLG behaves differently from PQ. Build a regression set of real iPhone clips and compare against Photos/QuickTime output.
3. `libplacebo` is the highest-quality FFmpeg path and handles Dolby Vision RPU reshaping (web). On macOS it needs Vulkan through MoltenVK, an extra moving part that should be validated.
4. Apple's own path: Apple's Dolby Vision/HDR integration note says "H.264 presets will convert HDR to SDR", and TN2227 says AVFoundation colour-matches to the `AVVideoColorPropertiesKey` you set (web: Apple docs). A small Swift helper using AVAssetReader/Writer or AVAssetExportSession could therefore produce Apple-consistent SDR conversions. Developer forum threads report washed-out 10-bit BT.709 output when settings are wrong, so this also needs testing.
5. Always tag outputs explicitly: `-color_primaries bt709 -color_trc bt709 -colorspace bt709 -color_range tv`. Untagged files are guessed differently by Chrome, QuickTime and Instagram.
6. With mixed HDR and SDR sources, decide on **SDR-only output in v1** and tone-map at ingest, so proxies, previews, the agent's thumbnails and the export all agree.

**Recommendation for layer 1**
- **Primary:** FFmpeg 9.0.x CLI from Homebrew **`ffmpeg-full`**, spawned from Node with a typed wrapper.
- **Second (distinct responsibility):** mediabunny in the browser, for proxy-based thumbnails and waveforms.
- **Optional:** a Swift `avhelper` for Apple-native HDR→SDR if the FFmpeg tone map does not match Photos.

| Candidate | Maintainer | Latest (verified) | License | Apple Silicon evidence | Best at | Limitations |
|---|---|---|---|---|---|---|
| FFmpeg CLI (`ffmpeg-full`) | FFmpeg project | 9.0.2, 2026-09-18 | LGPL core; Homebrew builds are GPL-3+ | Homebrew `arm64_tahoe` bottle; `--enable-videotoolbox --enable-audiotoolbox --enable-neon` in formula | Everything server-side | Keg-only; GPL binaries; filter-string complexity |
| Homebrew `ffmpeg` (default) | Homebrew | 9.0.2 | GPL-3+ | same | Fast codecs | Lacks zscale, libass, drawtext, libplacebo |
| fluent-ffmpeg | community | 2.1.3, 2024-05-19 | MIT | n/a | — | **Deprecated** on npm |
| ffmpeg-static | community | 5.3.0, 2025-11-14 | GPL-3 | prebuilt binaries | Zero-install | Limited filter libs; stale FFmpeg |
| mediabunny | Vanilagy | 1.65.1, 2026-11-03 | MPL-2.0 | WebCodecs in Chrome/Safari on macOS | Browser decode, thumbnails, waveforms, muxing | Browser codec support varies; keep to proxies |

---

## 2. Speech and transcript

### 2.1 Candidates

| Candidate | Maintainer | Latest (verified) | License (code / weights) | Apple Silicon evidence | Best at | Limitations |
|---|---|---|---|---|---|---|
| **parakeet-mlx** (Parakeet TDT 0.6B v3) | senstella (community) | PyPI 0.6.0, 2026-11-02; repo commit 2026-11-03 | Apache-2.0 code; **CC-BY-4.0** weights (NVIDIA model card, web) | Pure MLX; default model `mlx-community/parakeet-tdt-0.6b-v3` (README) | Fast, punctuated, word/token-aligned transcripts (`AlignedToken` start/end); English plus 24 European languages; chunking with overlap; streaming | 25 languages only. Whether fillers ("um/uh") are transcribed is **unverified**, so test. Attribution is required by CC-BY. |
| **whisper.cpp** | ggml-org | v1.9.5, 2026-10-06; commit 2026-11-03 | MIT; Whisper weights MIT | README: "Apple Silicon first-class citizen… Metal and Core ML"; Core ML encoder on the ANE ("more than x3 faster compared with CPU-only", reported by the whisper.cpp README); ANEForge encoder ("about 2x faster than the Core ML encoder", reported by the README) | Many languages; mature C/C++ CLI and server; built-in Silero VAD (`--vad`, ggml silero-v6.2.0); DTW token timestamps (`--dtw` presets incl. large-v3-turbo; DTW fix 2026-10-19) | Word timestamps are still labelled "experimental" (`-ml 1`). Whisper omits fillers and can hallucinate on silence. |
| mlx-whisper | Apple ml-explore (mlx-examples) | PyPI 0.4.3, 2025-08-29; mlx-examples last commit 2026-04-06 | MIT | MLX | Simple Python Whisper on GPU, `word_timestamps=True` | Slower release cadence; same Whisper filler and timing caveats |
| lightning-whisper-mlx | community | PyPI 0.0.10, 2024-04-02; repo 2024-05-08 | (no licence field) | MLX | — | **Stale**; avoid |
| WhisperX | m-bain | v3.8.6, 2026-05-25 (3.8.7rc1 2026-06-26); commit 2026-10-22 | BSD-2-Clause | README says to use `--device cpu --compute_type int8` "for running on Mac OS X" | wav2vec2 forced alignment plus pyannote diarization | Transcription is faster-whisper/CTranslate2, which is CPU-only on Mac; MPS crashes reported historically (issue #109). Heavier stack. |
| faster-whisper | SYSTRAN | 1.2.1, 2025-10-31 | MIT | CTranslate2 has no Metal backend (web: VoiceStudio docs) | Good on CUDA/CPU | CPU-only on a Mac |
| **Qwen3-ForcedAligner-0.6B** (via mlx-audio) | Alibaba Qwen; MLX port in Blaizzy/mlx-audio | mlx-audio 0.6.4, 2026-11-02 | Apache-2.0 (Qwen3-ASR technical report, arXiv 2601.21337, web) | mlx-audio README lists `mlx-community/Qwen3-ForcedAligner-0.6B-8bit` | Word-level alignment of a **given text** to audio, in 11 languages (report) | New; validate timing precision on our footage. The report's claim that it beats three strong aligners is unverified here. |
| Apple SpeechAnalyzer / SpeechTranscriber | Apple | macOS 26 SDK | Apple platform (no model download) | `SpeechTranscriber.ResultAttributeOption.audioTimeRange` (Apple docs, web) | Zero-download, on-device, long-form | Swift only. Forum reports of **missing `audioTimeRange` on many results** and volatile results without times (web). Locale set limited. Treat as an experiment. |
| WhisperKit | Argmax | v1.1.1, 2026-10-07 | MIT | Swift + Core ML | Native Swift Whisper with word timestamps | Swift package; overlaps with whisper.cpp |
| FluidAudio | FluidInference | v0.18.2, 2026-11-01 | Apache-2.0 SDK; models "MIT/Apache 2.0" per README | Core ML on the ANE, "avoiding GPU/MPS entirely" (README) | Swift: Parakeet TDT v3, Silero VAD, offline and streaming diarization incl. Sortformer | Swift SDK; Python only through a wrapper (Senko example) |
| Silero VAD | snakers4 | v6.2.3, 2026-09-23 | MIT | Tiny ONNX/JIT; also in whisper.cpp (ggml), mlx-audio and FluidAudio | Speech/non-speech segmentation for silence removal | Frame-level; tune thresholds and padding per creator |
| pyannote.audio + `speaker-diarization-community-1` | pyannote / pyannoteAI | 4.0.7, 2026-06-30; commit 2026-11-02 | MIT code; community-1 weights **CC-BY-4.0, gated** (accept terms plus HF token) | Pure PyTorch (CPU; MPS unverified) | Best open diarization pipeline | HF gating; `precision-2` is a **paid** API (keep off the required path). Talking-head reels rarely need diarization. |
| NeMo / Sortformer | NVIDIA | nemo_toolkit 3.0.0, 2026-08-07 | Apache-2.0 code; model cards vary (verify) | NeMo is CUDA-centric; Sortformer v1/v2.1 run in **mlx-audio** and **FluidAudio** | End-to-end diarization up to 4 speakers | Do not install NeMo on the Mac; use the MLX/Core ML ports |
| stable-ts | jianfch | PyPI 2.19.1, 2025-08-16 | MIT | PyTorch | Whisper timestamp stabilisation | README since 2026-05-30: "**Development on this repository is indefinitely paused**" |
| **CrisperWhisper 2.0** | Nyra Health / nyralabs | PyPI 2.0.3, 2026-09-14 | MIT code; weights **Nyra Health Non-Commercial Research License**; "Pro" models are commercial-only | "Pure PyTorch: runs anywhere torch does (macOS…)" (README) | Verbatim transcripts **with fillers**, repetitions and cut-offs; "intended" mode; word timings (about 30 ms mean boundary error on read speech, 41 ms on conversational, reported by Nyra's README) | **Non-commercial weights.** Usable only as an opt-in for personal use, or under a commercial licence. |

### 2.2 Filler words ("um/uh")

- Whisper-family models are trained on cleaned transcripts and **tend to omit fillers**. OpenAI's prompting guide suggests an `initial_prompt` such as "Umm, let me think like, hmm… Okay, here's what I'm, like, thinking." (web: OpenAI community thread and HF discussion). It is a hint, not a guarantee; users report it still misses fillers on small models.
- CrisperWhisper 2.0 is purpose-built for verbatim output but has non-commercial weights (above).
- **License-clean recommended approach** (engineering design):
  1. Run Silero VAD for speech regions.
  2. Get word timings from the primary ASR.
  3. Find **"voiced but un-worded" gaps**: VAD says speech but no word covers it, typically 150–800 ms.
  4. Classify each candidate gap as filler, breath, laugh or other.
- Classifier options for step 4:
  - a small audio classifier (YAMNet via MediaPipe Audio Classifier, Apache-2.0) or CLAP zero-shot ("person saying um");
  - re-decoding just that slice with Whisper plus the filler prompt;
  - training a tiny classifier on PodcastFillers. Adobe's dataset has 35K annotated fillers (reported by Adobe Research). Check its licence before training. The community "Wren" model is GPL-3 code with CC-licensed weights (web).
- Also try Parakeet v3 directly on filler-heavy samples. If it transcribes fillers reliably, the gap classifier becomes a fallback. This is unverified.

### 2.3 Retake and duplicate-speech detection

Detection is a deterministic candidate generator; the existing Claude agent then makes the keep/drop decision.
1. Segment the transcript into utterances using sentence punctuation plus pauses longer than about 400 ms.
2. Score candidate pairs within a sliding window (for example the next 1–6 utterances):
   - normalised lexical similarity: token-level Levenshtein or `rapidfuzz` partial ratio, so a "restart" prefix matches a full take;
   - **sentence embeddings** for paraphrased retakes (any local text embedder, for example Qwen3-Embedding via mlx-lm/mlx-vlm, or a MiniLM/E5-class model);
   - cue phrases such as "let me start again", "one more time" or "cut";
   - acoustic cues such as a long pause, a restart at a high pitch, or an incomplete final word (cut-off).
3. Cluster near-duplicates. The default keeps the **last complete take**, which is the usual creator workflow, and the agent can override.
4. Present the clusters as "takes" in the UI with a one-click swap.

This needs no new model beyond an embedder. Word timings make the cut points exact.

### 2.4 Recommendation for layer 2

- **Primary ASR:** **parakeet-mlx** (Parakeet TDT 0.6B v3). It is fast on MLX, gives native token/word timings and punctuation, and has a permissive licence (CC-BY: show attribution in Settings/About).
- **Second, for languages outside Parakeet's 25:** **whisper.cpp** with large-v3-turbo plus DTW, or mlx-whisper.
- **Word-timing refinement and script alignment:** Qwen3-ForcedAligner through mlx-audio, after validation.
- **VAD:** Silero VAD.
- **Diarization:** deferred. When needed, use Sortformer through mlx-audio, which avoids the HF gating that pyannote requires.

---

## 3. Computer vision

| Candidate | Maintainer | Latest (verified) | License | Apple Silicon evidence | Best at | Limitations |
|---|---|---|---|---|---|---|
| **Apple Vision** (`VNGeneratePersonSegmentationRequest`, `VNGeneratePersonInstanceMaskRequest`, `VNGenerateForegroundInstanceMaskRequest`, `VNDetectFaceRectanglesRequest`, `VNDetectHumanBodyPoseRequest`, `VNTrackObjectRequest`, attention/objectness saliency) | Apple | macOS 26 SDK (person segmentation since macOS 12; instance masks macOS 14+, up to 4 people (web)) | OS framework, free to use in apps | Runs on the ANE/GPU; Apple sample "Applying matte effects to people in images and video" | Person matte per frame (quality levels fast/balanced/accurate); per-person masks for text-behind-subject; face boxes for reframing; zero model downloads | Swift/ObjC only, so a small Swift CLI is needed. Mask edges are soft but not hair-level matting. Use `VNSequenceRequestHandler` for temporal context (community guidance; per-frame handlers flicker). |
| MediaPipe Tasks (Python) | Google AI Edge | 1.2.0, 2026-10-27 (PyPI wheel `macosx_11_0_arm64`) | Apache-2.0 | arm64 macOS wheel | Face detector, face/pose landmarker, image segmenter (selfie), interactive segmenter, **audio classifier (YAMNet)** | Python on Mac runs on CPU (GPU delegate not assumed). Legacy `mp.solutions` API is retired in favour of Tasks. |
| **SAM 3 / SAM 3.1** | Meta | SAM 3.1 released 2026-03-27 (repo README); repo commit 2026-10-23 | **SAM License** (custom, royalty-free incl. commercial, with Meta's acceptable-use and trade terms); **gated** HF checkpoints | Official repo requires CUDA 12.6+. **MLX ports in mlx-vlm** (`mlx_vlm/models/sam3`, `sam3_1`, `mlx-community/sam3.1-bf16`) | Text-prompted detection plus segmentation plus video tracking ("a person", "the coffee cup"); Object Multiplex, about 7x faster at 128 objects (reported by Meta / mlx-vlm README, on H100) | Binary masks, not alpha mattes. Gated weights. MLX video tracker is newer than the CUDA reference; validate. |
| SAM 2.1 | Meta | `sam2` PyPI 1.1.0, 2024-12-21; repo last commit 2024-12-15 (an MPS fix) | Apache-2.0 | PyTorch MPS works with fixes | Click-prompted video tracking | **Superseded by SAM 3.x**, effectively unmaintained |
| Robust Video Matting | PeterL1n | v1.0.0 (2021); last commit 2023-03-13 | **GPL-3.0** | Official **Core ML** exports (fixed resolutions), ONNX | Temporally stable alpha matting of people | Stale. GPL. Fixed-resolution Core ML models. |
| BiRefNet (incl. `BiRefNet_HR`, `_HR-matting`, `_dynamic`) | ZhengPeng7 | repo commit 2026-10-25 (model releases through 2025) | **MIT** | PyTorch (SDPA attention since Sep 2025); MPS feasible | Best open high-res image matting/segmentation; good per-keyframe quality | Image model, so per-frame video flickers without temporal smoothing. Heavy at 2048². |
| RMBG-2.0 | BRIA | — | **CC BY-NC 4.0, gated**; commercial use needs a BRIA agreement (web) | (BiRefNet architecture) | — | **Non-commercial**; avoid |
| BackgroundMattingV2 | PeterL1n | v1.0.0 (2021); last commit 2023-12-22 | MIT | — | Needs a clean background plate | Requires a captured background; stale |
| MatAnyone / MatAnyone 2 | pq-yang (NTU S-Lab) | v1.0.0 2025-02; MatAnyone 2 announced | **NTU S-Lab License 1.0: non-commercial** | PyTorch | State-of-the-art target-guided video matting | **Non-commercial**; avoid by default |
| OpenCV | OpenCV.org | `opencv-python` 5.0.0.93, 2026-07-02 | Apache-2.0 | arm64 wheels | Optical flow, Kalman filters, guided filter, morphology | Utility, not a model source |
| Ultralytics YOLO | Ultralytics | 8.4.201, 2026-11-03 | **AGPL-3.0** (enterprise licence for closed use) | MPS/Core ML export | Detection plus tracking (ByteTrack/BoT-SORT) | AGPL obligations; avoid in the core |
| RF-DETR | Roboflow | `rfdetr` 1.11.2, 2026-10-04 | Apache-2.0 | Also an MLX port in mlx-vlm (`rfdetr`) | Permissive real-time detector, if generic object detection is needed | Not needed for talking-head v1 |

**Auto-reframe to 9:16** (design, no model beyond face detection)
1. Detect faces at 5–10 fps on the proxy with Vision `VNDetectFaceRectanglesRequest`. MediaPipe face detector is the cross-platform fallback.
2. Associate detections over time with IoU plus Kalman or `VNTrackObjectRequest`.
3. Choose the subject. For one talking head, take the largest or most central face. For multiple people, use the speaker turn from diarization; audio-visual active-speaker detection is optional later.
4. Compute the crop with headroom/eye-line rules and a **dead zone**, plus critically-damped or One-Euro smoothing, so it moves like a camera operator rather than jittering.
5. Emit keyframes as `{t, x, y, w, h}` that the renderer applies. Store them as editable data so the user and agent can adjust.
6. Add scene-cut awareness: reset smoothing at shot boundaries.

**Masks for text-behind-subject and background removal**

Vision person masks are the primary path. Refine edges with a guided filter, and stabilise over time with a short EMA on the matte and optional flow-warp. SAM 3.1 (MLX) is the second option, for "any object" or text-prompted subjects. BiRefNet-HR is an opt-in for hero still frames.

**Recommendation for layer 3**
- **Primary:** **Apple Vision through a small Swift CLI** (`creatorbrio-vision`) that writes masks (PNG sequence or ProRes 4444 alpha) and JSON face tracks.
- **Second (distinct: open-vocabulary segment and track):** **SAM 3.1 via mlx-vlm**. The SAM License and HF gating must be shown to the user at model download.

---

## 4. Audio

| Candidate | Maintainer | Latest (verified) | License | Apple Silicon evidence | Best at | Limitations |
|---|---|---|---|---|---|---|
| **DeepFilterNet3** | Rikorose (Hendrik Schröter) | v0.5.6, 2023-08-31; last commit 2024-10-17 | MIT OR Apache-2.0 | Release asset **`deep-filter-0.5.6-aarch64-apple-darwin`** (Rust CLI); **pure-MLX port in mlx-audio** (`mlx-community/DeepFilterNet-mlx`, v1/2/3) | Real-time-class speech denoise at 48 kHz, with a controllable attenuation limit | Upstream dormant. Can over-suppress breaths and room tone, so expose strength and a wet/dry mix. |
| MossFormer2 SE (48 kHz) | Alibaba/ModelScope; MLX port | via mlx-audio 0.6.4 | verify per checkpoint | `starkdmi/MossFormer2_SE_48K_MLX` | Alternative enhancer for an A/B test | Licence to verify |
| Resemble Enhance | Resemble AI | 0.0.1, 2023-12-14; last commit 2024-12-03 | MIT | PyTorch | Denoise plus bandwidth "enhance" | Stale; generative enhancer can alter the voice or hallucinate |
| Apple **AUSoundIsolation** | Apple | macOS 13+ (Apple docs, web) | OS component | System Audio Unit (`kAudioUnitSubType_AUSoundIsolation`, wet/dry param) | Apple "Voice Isolation"-class quality, no download | Offline file rendering is **not documented** by Apple (community project QuietNow exports files, web). Swift host needed. `AVAudioEngine` voice processing is for live mic I/O (AEC), not file cleanup. |
| Demucs v4 (HTDemucs) | facebookresearch repo (**archived**, last commit 2023-11-16) → maintained fork **adefossez/demucs** | v4.1.0, 2026-07-11 (PyPI); README edit 2026-10-26 | Code MIT. **Weights licence "not clear"**: the 2026-10-26 README says MusDB has research-only data and the 6-source model "likely means CC-NC-BY". | MPS via audio-separator | Music/vocal stem separation | **Treat weights as non-commercial-risk.** Not needed for voice-first reels unless the source has background music. |
| audio-separator (UVR models: MDX, MDXC/RoFormer, VR, Demucs) | nomadkaraoke | 0.48.0, 2026-10-29 | MIT (tool); **model weights vary**, many community-trained with unclear licences | README: PyTorch MPS for VR/Demucs/RoFormer, CoreML EP for MDX ONNX; requires PyTorch ≥ 2.13 on Apple Silicon | Best practical stem separation | Licence diligence per model |
| SAM-Audio | Meta; MLX port in mlx-audio | — | SAM licence family (verify) | `mlx-community/sam-audio-large` | Text-prompted source separation ("remove the dog bark") | New; verify licence and quality |
| FFmpeg `loudnorm` / `sidechaincompress` / `afftdn` / `arnndn` | FFmpeg | 9.0.2 | LGPL/GPL build | built in | Final loudness, ducking, light cleanup | See §1 |
| pyloudnorm | community | 0.2.0, 2026-01-04 | MIT | pure Python | Measuring LUFS in the worker, for keyframed gain plans | — |
| pedalboard | Spotify | 0.9.26, 2026-10-07 | **GPL-3.0** | arm64 wheels | EQ, compression, de-essing, VST3/AU hosting (could host AUSoundIsolation) | GPL; keep in its own process if used |

**Sound-event detection and SFX search**
- **YAMNet** (Apache-2.0) via MediaPipe Audio Classifier tags events such as laughter, applause and music.
- PANNs (`audioset_tagging_cnn`, MIT) is stale (2021).
- BEATs (Microsoft, MIT) is research-grade.
- **CLAP** handles text→audio retrieval over a local SFX library. LAION-CLAP code is CC0, last commit 2025-05-15; checkpoint licences need to be verified on HF. Embed every SFX file once, then let the agent query in text ("whoosh", "pop", "camera shutter").

**Placing SFX** is rules plus agent logic: on cuts, zooms, caption pops and B-roll entries, snap to word timings and the transient-free gaps found by VAD.

**Free music and SFX sources** (licence is per item; filter at ingest)
- **Freesound**: free API key; each sound is CC0, CC-BY or CC-BY-NC. Filter to CC0/CC-BY and store attribution.
- Pixabay music/SFX: Pixabay Content Licence. The public API documents image and video endpoints only (web). No music endpoint was found, so music would be manual downloads only.
- Free Music Archive: per-track CC.
- Kevin MacLeod / Incompetech: CC-BY.
- Avoid BBC Sound Effects (RemArc licence is non-commercial) and YouTube Audio Library (no API; terms are YouTube-oriented).
- A **user-supplied library folder** with a manifest `{file, license, attribution}` is the robust default.

**Local music and SFX generation**

| Model | License | Mac | Note |
|---|---|---|---|
| **ACE-Step 1.5** | MIT (repo README); last commit 2026-08-29, tag v0.1.8 2026-05-18 | README: macOS launch scripts use **MLX (Apple Silicon)**; portable Mac package | Best permissive local music generator. Training-data provenance is the user's risk, as the README disclaimer notes. |
| Stable Audio 3.0 Small / Small SFX / Medium | **Stability AI Community License**: free under US$1M annual revenue, enterprise above (web) | Small (459M) targets on-device (web) | Released 2026-05-20 (web); "trained on fully licensed data" (Stability, web). Small SFX is the cleanest SFX-generation option. |
| Stable Audio Open 1.0 / Small | Stability AI Community License (web) | PyTorch (`stable-audio-tools` 0.0.20, 2026-05-20, needs Python <3.11) | Superseded by 3.0 |
| MusicGen / AudioGen (audiocraft) | Code MIT; **weights CC-BY-NC 4.0** (README) | PyTorch | **Non-commercial**; audiocraft stale (last commit 2025-03) |
| MMAudio (video-to-audio) | Code MIT; **checkpoints CC-BY-NC 4.0** (README) | PyTorch | **Non-commercial** |
| AudioLDM / AudioLDM2 | weights reported non-commercial (verify) | PyTorch | Avoid |

**Recommendation for layer 4**
- **Primary:** **FFmpeg** for the deterministic chain (high-pass, `loudnorm` two-pass to about -14 LUFS / -1 dBTP, limiter) and **DeepFilterNet3** for voice denoise. Run DeepFilterNet3 through mlx-audio inside the worker, with the official Rust `deep-filter` arm64 binary as a fallback.
- Ducking is computed as keyframed gain from VAD/word timings and rendered by FFmpeg. `sidechaincompress` is only for a quick preview.
- Retrieval uses CLAP over a licence-tagged library.
- Generation is optional: ACE-Step 1.5 (MLX) for music and Stable Audio 3.0 Small SFX for effects, behind a licence acknowledgement.

---

## 5. Video understanding and B-roll

| Candidate | Maintainer | Latest (verified) | License | Apple Silicon | Best at | Limitations |
|---|---|---|---|---|---|---|
| **PySceneDetect** | Breakthrough | 0.7.2, 2026-10-12; commit 2026-11-01 | BSD-3 | CPU (OpenCV/PyAV) | Reliable content/adaptive shot detection; CLI and API | Not learned; gradual transitions are weaker |
| TransNetV2 | soCzech | last commit 2021-07-28 (no PyPI) | MIT | TensorFlow (PyTorch ports exist) | Learned shot boundaries incl. dissolves | Stale; TensorFlow |
| FFmpeg `scdet` | FFmpeg | 9.0.2 | — | built in | Cheap first pass | Threshold-based |
| SigLIP / SigLIP 2 via open_clip / transformers / mlx-vlm (`siglip`) | Google weights; open_clip (mlfoundations) | open_clip 3.3.0, 2026-02-27; commit 2026-10-29 | MIT code; SigLIP weights Apache-2.0 (web) | MLX (mlx-vlm) or MPS | Text↔image embeddings for local stock and footage search | Per-frame; sample keyframes per shot |
| Qwen3-VL embedding / reranker (mlx-vlm `qwen3_vl_embedding`; README: Qwen3-VL rerankers accept `video`) | Qwen; Blaizzy | mlx-vlm 0.7.11, 2026-10-28 | MIT (mlx-vlm); Qwen weights generally Apache-2.0 (verify per checkpoint) | MLX | Multimodal embeddings plus reranking incl. video inputs | Heavier than SigLIP |
| **Qwen3-VL / Qwen2.5-VL via mlx-vlm** | Qwen; Blaizzy | mlx-vlm 0.7.11 | as above | MLX; README "Video Understanding" lists Qwen2/2.5-VL etc. with `--video … --fps` | Describing shots ("what is in this clip, is it B-roll-worthy, mood, motion") to index the library | Slow per clip; run at ingest on a 1–2 fps sample; output must be validated JSON |
| Pexels API | Pexels | — | Pexels licence (free use) | n/a | Free stock video and photos | **Free API key required**; 200 requests/hour and 20,000/month by default (reported by Pexels docs/help, web); cache responses |
| Pixabay API | Pixabay | — | Pixabay Content Licence | n/a | Free stock video and images | **Free key**; about 100 requests per 60 s (reported by third-party SDK docs, web); images and videos only |
| Wan 2.2 (TI2V-5B, A14B) | Wan-Video (Alibaba) | repo commit 2026-09-21 | **Apache-2.0** (README) | No official MPS/MLX; Wan 2.1 example in mlx-examples (2026-04-06) | Open text/image-to-video | **Very slow on Mac**: a GGUF Wan 2.2 run took **82 min per 2-second clip on an M1 Max 64 GB** (reported by lilting.ch) |
| LTX-2.x (2.3 / 2.5) | Lightricks | v1.5.0, 2026-10-18 | **LTX-2.x Community License** (revenue thresholds in §2.1; read before shipping) | README: the fast VAE backend is CUDA-only and "on macOS… falls back"; community MLX ports need 64 GB+ RAM (web) | Fastest open video generation, with audio | About **7 min per clip on an M1 Max** (reported by lilting.ch, LTX-2 GGUF). M5 Max will be faster, but this is minutes, not seconds. |

**Recommendation for layer 5**
- **Primary:** an **ingest indexer** in the worker:
  - PySceneDetect shots;
  - keyframe SigLIP-2 embeddings into a local vector index (SQLite with `sqlite-vec`, or a flat NumPy file; scale is small);
  - optional VLM captions through mlx-vlm (Qwen3-VL).
- B-roll selection is transcript phrase → text embedding → nearest shots in the user library, then Pexels/Pixabay (cached, attribution stored), then the Claude agent picks among the top results.
- Local video generation is **out of v1**. It is technically possible on 128 GB but takes minutes per clip, and licences vary.

---

## 6. Local AI runtime integration with Next.js

**Existing CreatorBrio pattern** (`src/lib/image-service.ts`): an optional **separate loopback service** (`http://127.0.0.1:8791`, `IMAGE_SERVICE_URL`; non-loopback refused). Its properties:
- a bearer token held only server-side;
- a fixed JSON contract (`POST /generate`, `POST /edit`);
- a fixed vocabulary of admission reasons;
- explicit timeouts and byte limits;
- strict validation of outputs before use.
The app works fully without it.

**Options compared**

| Option | Pros | Cons |
|---|---|---|
| CLI per job (spawn Python/Swift each time) | Simple, no daemon, crash isolation | Pays the model-load cost every job (seconds to tens of seconds for MLX/PyTorch models); no shared GPU scheduling |
| **Persistent Python worker (uv-managed venv), loopback HTTP + job queue** | Models stay warm; one scheduler for GPU memory; progress via SSE; mirrors the image-service contract | A daemon to supervise; Python packaging |
| Node-native inference (onnxruntime-node, transformers.js) | One runtime | No MLX; weaker Mac GPU paths; most audio/video models are Python-first |
| Core ML everywhere | ANE efficiency | Conversion burden per model; many models don't convert cleanly |

**MLX vs PyTorch MPS vs Core ML**
- **MLX** first: mlx 0.32.4 (2026-10-14), mlx-vlm 0.7.11 and mlx-audio 0.6.4, all actively released in Oct/Nov 2026. Together they cover Parakeet, Whisper, Qwen3-ForcedAligner, Silero VAD, Sortformer, DeepFilterNet, MossFormer2, SAM-Audio, SAM 3/3.1, SigLIP and Qwen-VL. Apple's ML research reports MLX gains on M5's GPU neural accelerators ("Exploring LLMs with MLX and the neural accelerators in the M5 GPU", machinelearning.apple.com).
- **PyTorch MPS** (torch 2.15.0, 2026-10-28) only where no MLX port exists (BiRefNet, PySceneDetect-adjacent tooling, audio-separator).
- **Core ML / Apple frameworks** through Swift for Vision, AVFoundation HDR and AUSoundIsolation.

**Recommended pattern**

1. **`creatorbrio-media-worker`**: a Python 3.12 project managed by **uv** (uv 0.13.7, 2026-11-03) with a committed `uv.lock`, started by `/start` when enabled.
   - **Network and auth:** listens on `127.0.0.1:<port>` and takes a bearer token from `.env.local`, the same rules as `IMAGE_SERVICE_URL`.
   - **Job API:**
     - `POST /jobs {kind, input_paths, params}` → `{job_id}`
     - `GET /jobs/:id`
     - `GET /jobs/:id/events` (SSE progress)
     - `DELETE /jobs/:id` (cancel)
     - `GET /capabilities` (which models are installed and licence-acknowledged)
   - **Job kinds:** `transcribe`, `align`, `vad`, `denoise`, `masks` (delegates to Swift), `track_faces`, `index_shots`, `embed`, `describe`, `separate`, `generate_music` and so on.
   - **Files, not bytes:** inputs and outputs are **paths under `data/media/<projectId>/`**. The worker refuses paths outside that root. Outputs are JSON (transcripts, tracks, keyframes) plus media files written atomically. Node then validates the JSON with schemas before storing it through `src/lib/data.ts`.
   - **Scheduling:** one GPU queue with concurrency 1 for heavy MLX/PyTorch work, plus a CPU queue. Models are LRU-cached with a memory budget; 128 GB allows several resident models.
   - **Models:** an explicit **model manager** step:
     - `huggingface_hub.snapshot_download` with **pinned revisions** into a CreatorBrio-owned cache (`data/models/`);
     - a recorded licence acknowledgement per model, with gated models (SAM 3.x, pyannote) needing the user's HF token once;
     - at runtime `HF_HUB_OFFLINE=1`, so jobs never download silently.
   - **Licence policy:** non-commercial-licensed models (CrisperWhisper, MatAnyone, RMBG-2.0, MusicGen, MMAudio) are not in the default registry. They are allowed only as explicit opt-ins labelled "non-commercial".
2. **FFmpeg stays in Node** (spawned directly) for probe, proxy, render and loudness. These are deterministic, need no model and should work even when the worker is off. The worker may also call FFmpeg for its own pre-processing.
3. **`creatorbrio-vision` Swift CLI** (Swift package built with Xcode Command Line Tools; per-job process). It covers Vision person and instance masks, face tracks, AVFoundation HDR→SDR, and optionally AUSoundIsolation and SpeechAnalyzer experiments. The worker or Node invokes it with paths. It is per-job because Apple frameworks load fast and there is no model download.
4. **Degradation:** as with the image service, the studio still opens and plays without the worker. AI features show "not installed" from `/capabilities`.

---

## Recommended stack

| Layer | Primary tool | Why | License | Install on macOS |
|---|---|---|---|---|
| Media I/O, filters, render | **FFmpeg 9.0.x (`ffmpeg-full`)** spawned from Node | Complete filter set (zscale, libass, drawtext, libplacebo, loudnorm, sidechaincompress, scdet, lut3d) plus VideoToolbox | GPL-3+ build (separate process) | `brew install ffmpeg-full` (keg-only; configure path) |
| Browser thumbnails and waveforms | **mediabunny** | Pure-TS WebCodecs toolkit, zero dependencies, active | MPL-2.0 | `npm i mediabunny` |
| ASR + word timings | **parakeet-mlx** (Parakeet TDT 0.6B v3) | MLX-native, word/token timing, punctuation | Apache-2.0 / CC-BY-4.0 weights | `uv add parakeet-mlx` |
| ASR for other languages | **whisper.cpp** (large-v3-turbo, DTW, Core ML encoder) | Covers languages beyond Parakeet's 25; built-in VAD | MIT | `brew install whisper-cpp` or build with `-DWHISPER_COREML=1` |
| Alignment refinement | Qwen3-ForcedAligner (mlx-audio) | Text→audio word alignment for scripts and corrections | Apache-2.0 | `uv add mlx-audio` |
| VAD and silence | **Silero VAD** | Robust speech/non-speech | MIT | via mlx-audio / `silero-vad` / whisper.cpp |
| Fillers | VAD-gap + classifier design (YAMNet/CLAP), Whisper filler prompt as a fallback | License-clean; CrisperWhisper is non-commercial | Apache/MIT | in worker |
| Retakes | Transcript similarity + embeddings + Claude adjudication | Deterministic candidates, editable | — | in worker |
| Person masks, faces, reframe | **Apple Vision** (Swift CLI) | ANE-fast, no downloads, commercial-safe | OS framework | Xcode CLT, `swift build` |
| Open-vocabulary segment and track | **SAM 3.1 via mlx-vlm** | Text-prompted video tracking on MLX | SAM License (gated) | `uv add mlx-vlm` + HF token acceptance |
| Voice denoise | **DeepFilterNet3** (mlx-audio; Rust `deep-filter` fallback) | Best permissive speech enhancer; arm64 binary exists | MIT/Apache-2.0 | `uv add mlx-audio` or GitHub release binary |
| Loudness, ducking, mix | **FFmpeg** `loudnorm` (2-pass) + keyframed gain; pyloudnorm for measuring | Deterministic, standard (EBU R128) | LGPL/GPL; MIT | as above; `uv add pyloudnorm` |
| SFX and music retrieval | **CLAP** embeddings over a licence-tagged library (Freesound CC0/CC-BY, user folders) | Text search of sounds | CC0 code (verify weights) | `uv add` (transformers/laion-clap) |
| Music / SFX generation (optional) | ACE-Step 1.5 (MLX) / Stable Audio 3.0 Small SFX | Local, permissive or community licence | MIT / Stability Community (<$1M revenue) | uv / their installers |
| Shot detection | **PySceneDetect** | Maintained, BSD | BSD-3 | `uv add scenedetect` |
| B-roll search | **SigLIP 2** embeddings + Pexels/Pixabay (free keys) | Fast local text↔image search | Apache-2.0 weights | `uv add open-clip-torch` or mlx-vlm |
| Footage description | **Qwen3-VL via mlx-vlm** | Rich shot captions for the agent | Apache-2.0 (verify) | `uv add mlx-vlm` |
| Runtime | **uv-managed Python worker on loopback** (job API, SSE) + Swift CLI + Node-spawned FFmpeg | Warm models, one GPU scheduler, mirrors the image-service contract | — | `brew install uv`; `uv sync` |

## Key caveats

1. **Homebrew `ffmpeg` is not enough.** It lacks zscale, libass, drawtext and libplacebo. Require `ffmpeg-full`, which is keg-only, and check capabilities at startup with `ffmpeg -filters`.
2. **iPhone HDR.** Tone-map at ingest and validate against Photos/QuickTime on real clips. Neither the FFmpeg zscale+tonemap chain nor `scale_vt`/AVFoundation is guaranteed correct for HLG/Dolby Vision 8.4 without testing.
3. **Licence traps.** All of the following are non-commercial or unclear: CrisperWhisper weights, MatAnyone (1/2), RMBG-2.0, MusicGen/AudioGen, MMAudio, Demucs weights (by the author's own 2026-10-26 note), many UVR models, and pyannote `precision-2` (paid). Additional obligations: RVM is GPL, Ultralytics is AGPL, and SAM 3.x and pyannote community-1 are gated.
4. **Stale but usable:** DeepFilterNet (2023/2024), RVM, TransNetV2, PANNs, Resemble Enhance. **Paused or deprecated:** stable-ts, fluent-ffmpeg, lightning-whisper-mlx. **Superseded:** SAM 2.1.
5. **Fillers are unsolved by permissive ASR out of the box.** Plan the VAD-gap classifier and test Parakeet on filler-heavy speech.
6. **Apple SpeechAnalyzer** timestamps are reported unreliable on macOS, so treat it as an experiment.
7. **Local video generation** on Mac takes minutes per clip (reported M1 Max figures). Keep it out of v1.
8. **Network allowlist.** huggingface.co, ffmpeg.org, stability.ai and pixabay.com were not reachable from this research session. Model-card licences above marked "(web)/verify" must be re-checked on the model pages before shipping.

## Sources

- FFmpeg tags and Changelog/RELEASE_NOTES: `github.com/FFmpeg/FFmpeg` (tags n8.0, n8.1, n9.0, n9.0.2)
- Homebrew formulae: https://github.com/Homebrew/homebrew-core/blob/main/Formula/f/ffmpeg.rb, .../ffmpeg-full.rb
- mediabunny: https://github.com/Vanilagy/mediabunny ; npm registry
- whisper.cpp README: https://github.com/ggml-org/whisper.cpp
- parakeet-mlx: https://github.com/senstella/parakeet-mlx ; https://pypi.org/project/parakeet-mlx/
- Parakeet TDT v3 model card (CC-BY-4.0): https://catalog.ngc.nvidia.com/orgs/nvidia/-/collections/parakeet-tdt-0.6b/ ; https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
- WhisperX: https://github.com/m-bain/whisperX ; MPS issue https://github.com/m-bain/whisperX/issues/109
- pyannote: https://github.com/pyannote/pyannote-audio
- CrisperWhisper 2.0: https://github.com/nyrahealth/CrisperWhisper
- stable-ts paused note: https://github.com/jianfch/stable-ts
- Apple SpeechTranscriber audioTimeRange: https://developer.apple.com/documentation/speech/speechtranscriber/resultattributeoption/audiotimerange ; forum reports https://developer.apple.com/forums/tags/speech
- Whisper filler prompt: https://huggingface.co/spaces/openai/whisper/discussions/30 ; https://community.openai.com/t/how-to-avoid-hallucinations-in-whisper-transcriptions/125300
- PodcastFillers: https://research.adobe.com/publication/filler-word-detection-and-classification-a-dataset-and-benchmark ; https://arxiv.org/abs/2203.15135
- Qwen3-ASR / ForcedAligner report: https://arxiv.org/pdf/2601.21337
- mlx-audio: https://github.com/Blaizzy/mlx-audio ; mlx-vlm: https://github.com/Blaizzy/mlx-vlm
- SAM 3 / 3.1: https://github.com/facebookresearch/sam3 ; https://ai.meta.com/blog/segment-anything-model-3/ ; https://www.labellerr.com/blog/sam-3-vs-sam-3-1-performance-comparison/
- Apple Vision: https://developer.apple.com/documentation/vision/applying-matte-effects-to-people-in-images-and-video ; https://developer.apple.com/documentation/vision/vngeneratepersoninstancemaskrequest
- RMBG-2.0 licence: https://github.com/Bria-AI/RMBG-2.0 ; BiRefNet: https://github.com/ZhengPeng7/BiRefNet
- MatAnyone: https://github.com/pq-yang/MatAnyone ; MatAnyone 2: https://pq-yang.github.io/projects/MatAnyone2
- RVM: https://github.com/PeterL1n/RobustVideoMatting
- MediaPipe: https://github.com/google-ai-edge/mediapipe ; https://pypi.org/project/mediapipe/
- DeepFilterNet release assets: https://github.com/Rikorose/DeepFilterNet/releases/tag/v0.5.6
- AUSoundIsolation: https://developer.apple.com/documentation/audiotoolbox/kaudiounitsubtype_ausoundisolation ; https://developer.apple.com/forums/thread/829792
- Demucs fork and licence note: https://github.com/adefossez/demucs
- audio-separator: https://github.com/nomadkaraoke/python-audio-separator
- audiocraft licence: https://github.com/facebookresearch/audiocraft ; MMAudio: https://github.com/hkchengrex/MMAudio
- ACE-Step 1.5: https://github.com/ace-step/ACE-Step-1.5
- Stable Audio 3.0: https://stability.ai/news-updates/meet-stable-audio-3-the-model-family-built-for-artistic-experimentation-with-open-weight-models ; https://the-decoder.com/stability-ai-launches-stable-audio-3-0-with-up-to-six-minute-tracks-and-open-weights/ ; licence tiers https://stability.ai/license
- Pexels limits: https://help.pexels.com/hc/en-us/articles/900005851863-Do-I-have-to-pay-for-higher-limits ; Pixabay (third-party SDK): https://docs.rs/crate/pixabay-sdk/latest/source/README.md
- Mac video-gen timings: https://lilting.ch/en/articles/ltx2-wan22-mac-local-video-gen
- LTX-2 licence: https://github.com/Lightricks/LTX-2 (LICENSE, LICENSE-2_x) ; Wan 2.2: https://github.com/Wan-Video/Wan2.2
- HDR guides (secondary): https://ffmpeg-cookbook.pages.dev/en/articles/hdr-to-sdr/ ; Apple Dolby Vision note: https://developer.apple.com/av-foundation/Incorporating-HDR-video-with-Dolby-Vision-into-your-apps.pdf ; TN2227: https://developer.apple.com/library/content/technotes/tn2227/_index.html
- MLX on M5: https://machinelearning.apple.com/research/exploring-llms-mlx-m5
- PyPI JSON for every package version quoted (pypi.org/pypi/<name>/json)
