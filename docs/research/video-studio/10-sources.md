# 10 · Sources and freshness

[← Research index](README.md)

**Research date:** 2026-11-03.
Everything below was retrieved on that date.
The ecosystem changes daily, so findings should be re-checked against these commits before acting on any of them more than a few weeks later.

## Method

- **Repositories** were cloned with `git clone --filter=blob:none`, or shallow clones for very large repositories, and **read only**. Nothing was installed, built or executed.
- The GitHub API and GitHub MCP tools were not available for third-party repositories in this session. Dates and SHAs therefore come from `git log`, and star counts, where quoted, from GitHub pages.
- **Package versions** come from the public npm and PyPI registry JSON.
- **Experiments** ran in a temporary workspace on Linux x86_64 ([E0](evidence/e0-experiments.md)).
- **CreatorBrio** was inspected at [`ecf5db7f443b2424e26ee811ba283c357161cea2`](https://github.com/mk-global/creatorbrio/tree/ecf5db7f443b2424e26ee811ba283c357161cea2) on `main`.

### Unreachable sources

These domains were outside the research session's allowed network, so their content came only from search-result summaries or was not consulted:

- gsap.com
- remotion.pro
- huggingface.co
- ffmpeg.org
- stability.ai
- pixabay.com
- hn.algolia.com

Claims that depend on them are marked unverified where they appear.

### Recounted figures

The table below was regenerated from every clone at the end of the research.
"Commits since 2026-08-05" was recounted then, so a few figures differ slightly from those in the evidence appendices, which were counted earlier in the day or in another time zone.
Projects that commit very frequently (HyperFrames, Remotion, BaoCut) had already moved past the SHAs listed here by the time this page was written.

## Key package versions (registry, 2026-11-03)

| Package | Version | Published | Licence field |
|---|---|---|---|
| `@hyperframes/producer`, `engine`, `core`, `player`, `studio` | 0.9.9 | 2026-11-03 | (none; repository root Apache-2.0) |
| `@elah/core`, `@elah/timeline`, `@elah/editor` | 1.0.0 | 2026-10-28 | Apache-2.0 |
| `remotion`, `@remotion/renderer` | 4.0.540 | 2026-11-02 | SEE LICENSE IN LICENSE.md (Remotion License) |
| `mediabunny` | 1.65.1 | 2026-11-03 | MPL-2.0 |
| `gsap` | 3.15.0 | 2026-04-13 | Standard "no charge" licence (gsap.com) |
| `parakeet-mlx` (PyPI) | 0.6.0 | 2026-11-02 (per E6) | Apache-2.0 |
| `mlx-audio` (PyPI) | 0.6.4 | 2026-11-02 (per E6) | MIT |
| FFmpeg | 9.0.2 | 2026-09-18 (tag, per E5) | LGPL/GPL (Homebrew builds GPL-3+) |

## Key source files cited

| Finding | Permalink |
|---|---|
| HyperFrames capture mode by OS | [`browserManager.ts#L871-L878`](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/engine/src/services/browserManager.ts#L871-L878) |
| HyperFrames frame adapter interface | [`adapters/types.ts#L9-L15`](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/core/src/adapters/types.ts#L9-L15) |
| HyperFrames composition determinism rules | [`skills/hyperframes/SKILL.md#L17-L30`](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/skills/hyperframes/SKILL.md#L17-L30) |
| HyperFrames SDK `EditOp` union | [`packages/sdk/src/types.ts#L109`](https://github.com/heygen-com/hyperframes/blob/faae6017dd6ab3ce2031489922e9a1750777e0e2/packages/sdk/src/types.ts#L109) |
| OpenFilm frame capture | [`host.mjs#L606-L653`](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/host.mjs#L606-L653) |
| OpenFilm FFmpeg pipe (encode only) | [`render.mjs#L435-L437`](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/render.mjs#L435-L437) |
| OpenFilm document type | [`film-doc.d.mts#L44-L82`](https://github.com/openfilm/openfilm/blob/4d526294e0a7ad718cbf9bd27e2a562438819c73/packages/openfilm/src/film-doc.d.mts#L44-L82) |
| Ghost Editor `reel.json` | [`references/reel-json.md`](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/references/reel-json.md#L1-L45) |
| Ghost Editor matte pipeline | [`scripts/matte.py#L1-L30`](https://github.com/kurbaitaev/ghost-editor/blob/ce172726c36293722b08eb57b5b307d4f06389e8/scripts/matte.py#L1-L30) |
| OpenEdit virtual clock | [`page-runtime.ts#L1-L80`](https://github.com/veedstudio/open-edit/blob/74b724014e4ca0f6e158afe72671f94fc02e5734/cli/src/render/page-runtime.ts#L1-L80) |
| Nuzky Claude CLI invocation | [`crates/agent/src/claude.rs#L15-L44`](https://github.com/nuzkyapp/nuzky/blob/45004221d7ad4d6448c159df849363ebcbc6c78c/crates/agent/src/claude.rs#L15-L44) |
| OpenChatCut Claude CLI turn runner | [`turn-runner.ts#L10-L60`](https://github.com/0xsline/OpenChatCut/blob/7fa4b7903e7ebecf832a36249f0c0c755200cc17/server/claude-code/turn-runner.ts#L10-L60) |
| vedit Claude CLI invocation | [`llm.py#L629-L662`](https://github.com/metiutek/editorvideo-ai/blob/6e94414c85dde0b0aca53754adc4ecf792536533/backend/vedit/llm.py#L629-L662) |
| Remotion licence eligibility | [`LICENSE.md#L16-L33`](https://github.com/remotion-dev/remotion/blob/cd1bb77f35b839a6fdcd64765725749409c3f4e5/LICENSE.md#L16-L33) |
| Remotion "Automators" definition | [`faq.mdx#L106-L129`](https://github.com/remotion-dev/remotion/blob/cd1bb77f35b839a6fdcd64765725749409c3f4e5/packages/docs/docs/license/faq.mdx#L106-L129) |
| BaoCut licence restrictions | [`LICENSE#L60-L90`](https://github.com/JimLiu/baocut/blob/263aa691ba9df2e6addc5c3be43e9f84bad3c360/LICENSE#L60-L90) |
| Clipkit BSL runtime cap | [`packages/runtime/LICENSE#L10-L57`](https://github.com/clipkit-video/clipkit/blob/dcc26e5bfb170beee8681ecafdeb786da455606e/packages/runtime/LICENSE#L10-L57) |
| Twick licence | [`LICENSE.md`](https://github.com/ncounterspecialist/twick/blob/3044c23e282b87c639c3f0b3fd5fb3fd972aa04c/LICENSE.md) |
| elah limitations | [`CURRENT_LIMITATIONS.md`](https://github.com/elahlabs/elah/blob/d4e8b237778128ac453bbd93fd6cb85c758c9b91/CURRENT_LIMITATIONS.md) |
| CreatorBrio Director isolation flags | [`src/lib/visual-director.ts#L420-L442`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/lib/visual-director.ts#L420-L442) |
| CreatorBrio origin guard | [`src/lib/request-guard.ts`](https://github.com/mk-global/creatorbrio/blob/ecf5db7f443b2424e26ee811ba283c357161cea2/src/lib/request-guard.ts) |

## Web sources

- GSAP licence wording, unverified (search results): [licence mirror](https://open.windriver.com/info/uni-license-list/licenses/gsap-standard-no-charge-2025.html), [Pinegrow forum thread](https://forum.pinegrow.com/t/gsap-has-been-acquired-by-webflow/9906), [Webflow: GSAP becomes free](https://webflow.com/blog/gsap-becomes-free).
- Further web sources for models, licences and Apple frameworks are listed in [E5 · Sources](evidence/e5-building-blocks.md#sources) and per row in [E6](evidence/e6-recent-discovery.md).

## Every repository examined

Columns: HEAD commit at the time of cloning, its commit date, the first commit date in the clone (an import commit for some projects), and commits since 2026-08-05.

| Repository | HEAD | Last commit | First commit | Commits since 2026-08-05 |
|---|---|---|---|---:|
| [0xPasho/agentcut](https://github.com/0xPasho/agentcut) | [`f289afb`](https://github.com/0xPasho/agentcut/tree/f289afbb80bbef64afec07f9dd036f96d1c914e3) | 2026-10-13 | 2026-09-16 | 258 |
| [0xsline/OpenChatCut](https://github.com/0xsline/OpenChatCut) | [`7fa4b79`](https://github.com/0xsline/OpenChatCut/tree/7fa4b7903e7ebecf832a36249f0c0c755200cc17) | 2026-10-21 | 2026-07-20 | 852 |
| [AcademySoftwareFoundation/OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) | [`80c5ff3`](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/tree/80c5ff30938e4adffe9c94f419b1055856cee9f5) | 2026-10-30 | 2016-09-06 | 23 |
| [ace-step/ACE-Step](https://github.com/ace-step/ACE-Step) | [`1bee4c9`](https://github.com/ace-step/ACE-Step/tree/1bee4c9f5b43e30995f8d4d33b3919197ce1bd68) | 2026-02-15 | 2025-03-12 | 0 |
| [ace-step/ACE-Step-1.5](https://github.com/ace-step/ACE-Step-1.5) | [`ca1e85f`](https://github.com/ace-step/ACE-Step-1.5/tree/ca1e85fe9430179831e6bc6be790c332190a3866) | 2026-08-29 | 2025-09-04 | 15 |
| [adefossez/demucs](https://github.com/adefossez/demucs) | [`829d218`](https://github.com/adefossez/demucs/tree/829d21890023800713e5dd231c67e43ecc06069b) | 2026-10-26 | 2019-11-25 | 2 |
| [AIEraDev/Clypra](https://github.com/AIEraDev/Clypra) | [`b6cbc1f`](https://github.com/AIEraDev/Clypra/tree/b6cbc1f49dca63363e504d72b1be8c44ff655bed) | 2026-11-01 | 2026-04-17 | 2646 |
| [airbnb/lottie-web](https://github.com/airbnb/lottie-web) | [`bede03d`](https://github.com/airbnb/lottie-web/tree/bede03d25d232826e0c9dca1733d542d8a7754fb) | 2024-11-19 | 2015-02-20 | 0 |
| [alanveloper-epam/ffmpeg-mcp-server](https://github.com/alanveloper-epam/ffmpeg-mcp-server) | [`038ead9`](https://github.com/alanveloper-epam/ffmpeg-mcp-server/tree/038ead9b9396fbd6204b2188de6bf7f621a7d452) | 2026-10-25 | 2026-10-25 | 2 |
| [ALBERTOGUER/VideoHighlighter](https://github.com/ALBERTOGUER/VideoHighlighter) | [`7cbe8b2`](https://github.com/ALBERTOGUER/VideoHighlighter/tree/7cbe8b2b08353ec9dd30c76eddc5a72c3e785d23) | 2026-10-13 | 2025-09-19 | 232 |
| [andriidrok1/autobroll](https://github.com/andriidrok1/autobroll) | [`4aef3af`](https://github.com/andriidrok1/autobroll/tree/4aef3afb099c866bd2977c184f9912ba57318f77) | 2026-09-29 | 2026-06-10 | 12 |
| [argmaxinc/WhisperKit](https://github.com/argmaxinc/WhisperKit) | [`9f99b5c`](https://github.com/argmaxinc/WhisperKit/tree/9f99b5cb6a907730543823ad271b82532782a899) | 2026-10-10 | 2024-01-30 | 17 |
| [arraypress/swift-speech-transcriber](https://github.com/arraypress/swift-speech-transcriber) | [`e194f56`](https://github.com/arraypress/swift-speech-transcriber/tree/e194f569a5abb8d5b70d7043e59e352279e9c35a) | 2026-10-11 | 2026-06-09 | 6 |
| [artbyjazi/autoclip](https://github.com/artbyjazi/autoclip) | [`5d0eac3`](https://github.com/artbyjazi/autoclip/tree/5d0eac36fa615b79dd2104083bf273a96f8d68bb) | 2026-08-01 | 2026-07-31 | 0 |
| [Augani/openreel-video](https://github.com/Augani/openreel-video) | [`367d7e9`](https://github.com/Augani/openreel-video/tree/367d7e90b61b5181f9861b852bb8b9d7a7d2954a) | 2026-10-17 | 2026-01-19 | 15 |
| [bazodev/open-vids](https://github.com/bazodev/open-vids) | [`119cbe1`](https://github.com/bazodev/open-vids/tree/119cbe17557e2955f0fbe731aa65acc13bfc66f7) | 2026-10-09 | 2026-09-28 | 183 |
| [Blaizzy/mlx-audio](https://github.com/Blaizzy/mlx-audio) | [`97d125f`](https://github.com/Blaizzy/mlx-audio/tree/97d125f423c4b9a61e930da17b5ce97bdfd92f8e) | 2026-11-02 | 2024-11-27 | 544 |
| [Blaizzy/mlx-vlm](https://github.com/Blaizzy/mlx-vlm) | [`d3a16c3`](https://github.com/Blaizzy/mlx-vlm/tree/d3a16c344b9cb9311060fb189019a9582b202fdd) | 2026-11-03 | 2024-04-16 | 778 |
| [Breakthrough/PySceneDetect](https://github.com/Breakthrough/PySceneDetect) | [`c5ce29c`](https://github.com/Breakthrough/PySceneDetect/tree/c5ce29c73751e77139e838bd9ce9ab66a8e71a23) | 2026-11-01 | 2014-06-04 | 77 |
| [browser-use/video-use](https://github.com/browser-use/video-use) | [`43cfc56`](https://github.com/browser-use/video-use/tree/43cfc566833548093455c9d4a46bd69913b7e552) | 2026-10-08 | 2026-04-11 | 5 |
| [cathrynlavery/yap-studio](https://github.com/cathrynlavery/yap-studio) | [`f5a4bc3`](https://github.com/cathrynlavery/yap-studio/tree/f5a4bc35e83a81666084f3b3a159e47247629ceb) | 2026-11-03 | 2026-10-23 | 99 |
| [chandler767/mcp-video-editor](https://github.com/chandler767/mcp-video-editor) | [`31964f1`](https://github.com/chandler767/mcp-video-editor/tree/31964f1ab6cab0def15452e8a84f76b545f966ab) | 2026-02-14 | 2026-02-12 | 0 |
| [clipkit-video/clipkit](https://github.com/clipkit-video/clipkit) | [`dcc26e5`](https://github.com/clipkit-video/clipkit/tree/dcc26e5bfb170beee8681ecafdeb786da455606e) | 2026-08-12 | 2026-06-25 | 2 |
| [Clipwing/skills](https://github.com/Clipwing/skills) | [`edbefcb`](https://github.com/Clipwing/skills/tree/edbefcbc3474869e6cc1e8a7ca583b0efd0dab7e) | 2026-10-21 | 2026-10-13 | 6 |
| [dai-shi/excalidraw-animate](https://github.com/dai-shi/excalidraw-animate) | [`cbd7a23`](https://github.com/dai-shi/excalidraw-animate/tree/cbd7a2366ef855e4af4edaf8590bf8814ea82408) | 2026-05-29 | 2020-05-17 | 0 |
| [designcombo/react-video-editor](https://github.com/designcombo/react-video-editor) | [`9a8c529`](https://github.com/designcombo/react-video-editor/tree/9a8c5296da4b258f66dfb7ad73de96be62478bca) | 2026-06-29 | 2024-08-02 | 0 |
| [diffusionstudio/core](https://github.com/diffusionstudio/core) | [`4e784a7`](https://github.com/diffusionstudio/core/tree/4e784a7136b3b08e7b9b0c69504085897bf18647) | 2025-11-18 | 2024-08-13 | 0 |
| [dongnguyenvie/BashCut](https://github.com/dongnguyenvie/BashCut) | [`7128e31`](https://github.com/dongnguyenvie/BashCut/tree/7128e31ca4d640050b2de719a128ce7091f1ea42) | 2026-10-18 | 2026-10-02 | 952 |
| [dziksu/synkinema](https://github.com/dziksu/synkinema) | [`d93063e`](https://github.com/dziksu/synkinema/tree/d93063e9a785c4668fbc13a24cdc5e4ff5224d18) | 2026-11-03 | 2026-09-14 | 172 |
| [edenfunf/reelmimic](https://github.com/edenfunf/reelmimic) | [`2fcf5b6`](https://github.com/edenfunf/reelmimic/tree/2fcf5b66f95a314ea08cb44f9dcdebd354d4b89f) | 2026-11-03 | 2026-09-28 | 145 |
| [Ekaanth/OpenCut-AI](https://github.com/Ekaanth/OpenCut-AI) | [`eb8aef9`](https://github.com/Ekaanth/OpenCut-AI/tree/eb8aef9f971648980673b207fc28eb76955883b3) | 2026-09-23 | 2025-06-22 | 17 |
| [Ektie/react-video-timeline-editor](https://github.com/Ektie/react-video-timeline-editor) | [`2876697`](https://github.com/Ektie/react-video-timeline-editor/tree/2876697a975f7d074feafb57d43fdb42421755e4) | 2026-09-21 | 2026-09-21 | 4 |
| [elahlabs/elah](https://github.com/elahlabs/elah) | [`d4e8b23`](https://github.com/elahlabs/elah/tree/d4e8b237778128ac453bbd93fd6cb85c758c9b91) | 2026-10-30 | 2026-05-15 | 135 |
| [etro-js/etro](https://github.com/etro-js/etro) | [`7eb5a7a`](https://github.com/etro-js/etro/tree/7eb5a7ad25f78695ae70f34e919cdf1aaaffc85a) | 2026-10-24 | 2018-10-06 | 13 |
| [facebookresearch/audiocraft](https://github.com/facebookresearch/audiocraft) | [`896ec7c`](https://github.com/facebookresearch/audiocraft/tree/896ec7c47f5e5d1e5aa1e4b260c4405328bf009d) | 2025-03-13 | 2023-06-09 | 0 |
| [facebookresearch/demucs](https://github.com/facebookresearch/demucs) | [`e976d93`](https://github.com/facebookresearch/demucs/tree/e976d93ecc3865e5757426930257e200846a520a) | 2023-11-16 | 2019-11-25 | 0 |
| [facebookresearch/sam2](https://github.com/facebookresearch/sam2) | [`2b90b9f`](https://github.com/facebookresearch/sam2/tree/2b90b9f5ceec907a1c18123530e92e794ad901a4) | 2024-12-15 | 2024-07-29 | 0 |
| [facebookresearch/sam3](https://github.com/facebookresearch/sam3) | [`f1647e8`](https://github.com/facebookresearch/sam3/tree/f1647e8d0c1d280991f4d1b7d974c2704537fe66) | 2026-10-23 | 2025-11-18 | 11 |
| [feitangyuan/onetake](https://github.com/feitangyuan/onetake) | [`013a61a`](https://github.com/feitangyuan/onetake/tree/013a61ac8d98883c73733f59c06e49e9ba444f14) | 2026-10-21 | 2026-09-25 | 20 |
| [FerventOrange/cutpoint](https://github.com/FerventOrange/cutpoint) | [`ebd5c72`](https://github.com/FerventOrange/cutpoint/tree/ebd5c725595ac2c585a1e7d1aab733596564a3ff) | 2026-11-03 | 2026-10-21 | 409 |
| [fifteen42/otio.js](https://github.com/fifteen42/otio.js) | [`1a0120f`](https://github.com/fifteen42/otio.js/tree/1a0120f8b5506cd32093a1d7772886a7fbe8b45a) | 2026-04-12 | 2025-10-19 | 0 |
| [finnvoor/yap](https://github.com/finnvoor/yap) | [`7c19dd3`](https://github.com/finnvoor/yap/tree/7c19dd37b4e3689b5e78425548a43abaf5c0ab91) | 2026-07-20 | 2025-06-15 | 0 |
| [fluent-ffmpeg/node-fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) | [`7a701f5`](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/tree/7a701f560f6cd0f152cdef22c8a03132c56afc7b) | 2025-05-22 | 2011-04-12 | 0 |
| [FluidInference/FluidAudio](https://github.com/FluidInference/FluidAudio) | [`ee78635`](https://github.com/FluidInference/FluidAudio/tree/ee78635d23d52379117554ba72358b65a0612447) | 2026-11-02 | 2025-06-21 | 197 |
| [Francesco149/slopstudio](https://github.com/Francesco149/slopstudio) | [`674108f`](https://github.com/Francesco149/slopstudio/tree/674108fc88c1a8a8ffe51ef662f286a89da4b027) | 2026-07-21 | 2026-07-05 | 0 |
| [frankShan001/CutVoke](https://github.com/frankShan001/CutVoke) | [`e1d7649`](https://github.com/frankShan001/CutVoke/tree/e1d76491a4882742ce13de6d89514d64648deaee) | 2026-11-03 | 2026-09-22 | 156 |
| [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) | [`4da27c4`](https://github.com/ggml-org/whisper.cpp/tree/4da27c41cebadb3cbbcd2563e9c7cbc8d84bdcad) | 2026-11-03 | 2022-09-25 | 840 |
| [google-ai-edge/mediapipe](https://github.com/google-ai-edge/mediapipe) | [`4a2f1fb`](https://github.com/google-ai-edge/mediapipe/tree/4a2f1fbd6cb5ea09a5835d33c4fcf098b5347c5d) | 2026-11-03 | 2019-06-16 | 314 |
| [greensock/GSAP](https://github.com/greensock/GSAP) | [`13e2b79`](https://github.com/greensock/GSAP/tree/13e2b790546426a1a2e0e9b409f3f8dc6d6611f2) | 2026-04-13 | 2012-09-21 | 0 |
| [griffinwooldridge/talking-head-editor](https://github.com/griffinwooldridge/talking-head-editor) | [`9382aa3`](https://github.com/griffinwooldridge/talking-head-editor/tree/9382aa31bd66a5c6b6a06a761b748cc513149647) | 2026-10-27 | 2026-10-07 | 8 |
| [haidrrrry/claude-remotion-skill](https://github.com/haidrrrry/claude-remotion-skill) | [`1dcbe5e`](https://github.com/haidrrrry/claude-remotion-skill/tree/1dcbe5e3fc6cf970bd10d3cc05f0a8a5d19d0383) | 2026-08-12 | 2026-06-13 | 2 |
| [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) | [`faae601`](https://github.com/heygen-com/hyperframes/tree/faae6017dd6ab3ce2031489922e9a1750777e0e2) | 2026-11-03 | 2026-03-10 | 2985 |
| [hkchengrex/MMAudio](https://github.com/hkchengrex/MMAudio) | [`974010a`](https://github.com/hkchengrex/MMAudio/tree/974010a026c731054592d8f777218bd9d85a6c24) | 2026-02-23 | 2024-12-07 | 0 |
| [hormuz-labs/agentshot](https://github.com/hormuz-labs/agentshot) | [`e35c2e4`](https://github.com/hormuz-labs/agentshot/tree/e35c2e4c72a95dcfd2bc2f80073d16727362531f) | 2026-11-03 | 2026-10-06 | 317 |
| [jacobksamuelson/talking-head-video](https://github.com/jacobksamuelson/talking-head-video) | [`99aa6f2`](https://github.com/jacobksamuelson/talking-head-video/tree/99aa6f2eacefff435bc5ac498ce0ea87a54dd374) | 2026-10-14 | 2026-10-13 | 2 |
| [jianfch/stable-ts](https://github.com/jianfch/stable-ts) | [`e312072`](https://github.com/jianfch/stable-ts/tree/e312072cc024ae9fceb25b057d7d18524873a02b) | 2026-05-30 | 2022-09-29 | 0 |
| [JimLiu/baocut](https://github.com/JimLiu/baocut) | [`263aa69`](https://github.com/JimLiu/baocut/tree/263aa691ba9df2e6addc5c3be43e9f84bad3c360) | 2026-11-03 | 2026-10-07 | 1387 |
| [jub0t/Concat](https://github.com/jub0t/Concat) | [`eda5e0a`](https://github.com/jub0t/Concat/tree/eda5e0af75752cb479a018be85c798022c977070) | 2026-11-03 | 2026-08-25 | 1306 |
| [juliangarnier/anime](https://github.com/juliangarnier/anime) | [`01b81be`](https://github.com/juliangarnier/anime/tree/01b81be1df6843ccfe0a71c0699a746bf740dd77) | 2026-08-09 | 2016-06-27 | 1 |
| [jwulff/dictamac](https://github.com/jwulff/dictamac) | [`3400142`](https://github.com/jwulff/dictamac/tree/3400142d38ecbbd9bee275f2418736d9c35de3fb) | 2026-05-18 | 2026-05-13 | 0 |
| [kajisho5/ffmpeg-skill](https://github.com/kajisho5/ffmpeg-skill) | [`1ce2c18`](https://github.com/kajisho5/ffmpeg-skill/tree/1ce2c186bf1dba96132d87274eee46df4f537e0e) | 2026-11-01 | 2026-09-03 | 471 |
| [kevinbadi/open-edits](https://github.com/kevinbadi/open-edits) | [`7fbd746`](https://github.com/kevinbadi/open-edits/tree/7fbd74651ea945711792b207e8a9f0a167f78132) | 2026-10-02 | 2026-10-02 | 5 |
| [kurbaitaev/ghost-editor](https://github.com/kurbaitaev/ghost-editor) | [`ce17272`](https://github.com/kurbaitaev/ghost-editor/tree/ce172726c36293722b08eb57b5b307d4f06389e8) | 2026-10-30 | 2026-09-23 | 12 |
| [KyaniteLabs/mcp-video](https://github.com/KyaniteLabs/mcp-video) | [`a6f44fb`](https://github.com/KyaniteLabs/mcp-video/tree/a6f44fb55621462a4bb69352aea66d85e1d9dabf) | 2026-11-02 | 2026-03-20 | 652 |
| [LAION-AI/CLAP](https://github.com/LAION-AI/CLAP) | [`1fd4c37`](https://github.com/LAION-AI/CLAP/tree/1fd4c37df5ffbfcfbad5415c170bc66cf94c9994) | 2025-05-15 | 2022-03-06 | 0 |
| [lemomo-ai/lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) | [`bebbbe1`](https://github.com/lemomo-ai/lemo-opuscar/tree/bebbbe1aa92a3cb4bb6f83500e61b23a17d1aa00) | 2026-11-01 | 2026-09-26 | 80 |
| [leogaudin/opencaptions](https://github.com/leogaudin/opencaptions) | [`8ef9a7c`](https://github.com/leogaudin/opencaptions/tree/8ef9a7cd907ea02d46996200e204f06c72ce39cd) | 2026-10-23 | 2026-10-05 | 257 |
| [Leonxlnx/earshot](https://github.com/Leonxlnx/earshot) | [`591fa3e`](https://github.com/Leonxlnx/earshot/tree/591fa3e028032e6dce56620a20e932e35667e8d8) | 2026-10-22 | 2026-10-16 | 40 |
| [Lightricks/LTX-2](https://github.com/Lightricks/LTX-2) | [`e98f6d9`](https://github.com/Lightricks/LTX-2/tree/e98f6d927d83c92ef2be6aec76c8440b19306e39) | 2026-10-18 | 2026-01-05 | 13 |
| [Lightricks/LTX-Video](https://github.com/Lightricks/LTX-Video) | [`50f0aef`](https://github.com/Lightricks/LTX-Video/tree/50f0aef1297574a4b29acbdb874e3a363a6d5f2e) | 2026-11-02 | 2024-11-22 | 2 |
| [LottieFiles/dotlottie-web](https://github.com/LottieFiles/dotlottie-web) | [`2f3693a`](https://github.com/LottieFiles/dotlottie-web/tree/2f3693a1d5b9d6936027bc892fa4f9d1cd16d2bb) | 2026-11-02 | 2023-10-25 | 31 |
| [lx67621956-create/broll-finder](https://github.com/lx67621956-create/broll-finder) | [`f27bba2`](https://github.com/lx67621956-create/broll-finder/tree/f27bba227891fb7976d18b2539b1e3a0a8c34363) | 2026-11-04 | 2026-11-04 | 1 |
| [m-bain/whisperX](https://github.com/m-bain/whisperX) | [`5d3678b`](https://github.com/m-bain/whisperX/tree/5d3678b8535698a2826a5db9eb3e4105aef85dd9) | 2026-10-22 | 2022-12-13 | 9 |
| [MakeMyClip/editor](https://github.com/MakeMyClip/editor) | [`7820598`](https://github.com/MakeMyClip/editor/tree/782059842d3b2d3b15be55d5ec47035c1f4cbec5) | 2026-10-29 | 2026-05-27 | 21 |
| [ManimCommunity/manim](https://github.com/ManimCommunity/manim) | [`16ea443`](https://github.com/ManimCommunity/manim/tree/16ea443e2a5f1d79db0a721161411ce916d6e733) | 2026-10-27 | 2015-03-22 | 82 |
| [mariagorskikh/talking-head-reel](https://github.com/mariagorskikh/talking-head-reel) | [`c8472f3`](https://github.com/mariagorskikh/talking-head-reel/tree/c8472f33ef41d7039873701489b4e3ef5b46281f) | 2026-09-22 | 2026-09-22 | 1 |
| [MartinDelophy/ai-video-editor](https://github.com/MartinDelophy/ai-video-editor) | [`947285a`](https://github.com/MartinDelophy/ai-video-editor/tree/947285a56f3667cdf048a6a75bd4b840d51483f7) | 2026-11-03 | 2026-07-09 | 144 |
| [mazsola2k/ai-video-editor](https://github.com/mazsola2k/ai-video-editor) | [`cfb6d28`](https://github.com/mazsola2k/ai-video-editor/tree/cfb6d2872192dcd208fa6e2ee1617b57326c5c45) | 2026-04-11 | 2026-02-01 | 0 |
| [MegaTroll222/VOX-COLLAGE-BROLL](https://github.com/MegaTroll222/VOX-COLLAGE-BROLL) | [`2e9b8a9`](https://github.com/MegaTroll222/VOX-COLLAGE-BROLL/tree/2e9b8a93a2834e4d670700ab9e4827a8baf3b668) | 2026-07-17 | 2026-07-17 | 0 |
| [mermaid-js/mermaid](https://github.com/mermaid-js/mermaid) | [`ea53556`](https://github.com/mermaid-js/mermaid/tree/ea53556f130b397fb6f781818ee0f1e924b429eb) | 2026-11-03 | 2014-11-02 | 952 |
| [metiutek/editorvideo-ai](https://github.com/metiutek/editorvideo-ai) | [`6e94414`](https://github.com/metiutek/editorvideo-ai/tree/6e94414c85dde0b0aca53754adc4ecf792536533) | 2026-11-02 | 2026-08-03 | 93 |
| [MHughesDev/video-mcp](https://github.com/MHughesDev/video-mcp) | [`bf8c7b5`](https://github.com/MHughesDev/video-mcp/tree/bf8c7b5cbcdade6d140e385c3e7d056d5a7f8ee2) | 2026-10-17 | 2026-05-30 | 1 |
| [mifi/editly](https://github.com/mifi/editly) | [`dc46674`](https://github.com/mifi/editly/tree/dc46674052eacd15ef6e0f563a58eb378b3804ad) | 2025-02-20 | 2020-04-15 | 0 |
| [mikecann/tandem](https://github.com/mikecann/tandem) | [`b59a19f`](https://github.com/mikecann/tandem/tree/b59a19f69d71f69d427cab65045fa6e54b3e6eec) | 2026-11-03 | 2026-09-25 | 523 |
| [ml-explore/mlx](https://github.com/ml-explore/mlx) | [`c69303b`](https://github.com/ml-explore/mlx/tree/c69303b00f5f61860436e832f23fa8c34b96f93a) | 2026-11-02 | 2023-11-28 | 474 |
| [ml-explore/mlx-examples](https://github.com/ml-explore/mlx-examples) | [`796f5b5`](https://github.com/ml-explore/mlx-examples/tree/796f5b53cab69a3d48a44233ce21aae889e94a08) | 2026-04-06 | 2023-11-28 | 0 |
| [mlfoundations/open_clip](https://github.com/mlfoundations/open_clip) | [`4308ec8`](https://github.com/mlfoundations/open_clip/tree/4308ec82892b2d7d27aa4eb309973b5bd2c81a73) | 2026-10-29 | 2021-07-28 | 63 |
| [monet-ai-editor/monet](https://github.com/monet-ai-editor/monet) | [`74fcb16`](https://github.com/monet-ai-editor/monet/tree/74fcb1646a2329dfa35acfe7b3726491544fca18) | 2026-07-06 | 2026-04-21 | 0 |
| [motion-canvas/motion-canvas](https://github.com/motion-canvas/motion-canvas) | [`7b91435`](https://github.com/motion-canvas/motion-canvas/tree/7b91435c301d530351dcf5ebb91dd139c002e405) | 2026-07-02 | 2022-04-11 | 0 |
| [mrpaidsocial/mrpaidsocial-video-editor-agent](https://github.com/mrpaidsocial/mrpaidsocial-video-editor-agent) | [`bbbc1a4`](https://github.com/mrpaidsocial/mrpaidsocial-video-editor-agent/tree/bbbc1a4c55f70dfe37fe616f2f95c6586fa76cb4) | 2026-10-26 | 2026-08-29 | 28 |
| [mustafaaljadery/lightning-whisper-mlx](https://github.com/mustafaaljadery/lightning-whisper-mlx) | [`5a4d978`](https://github.com/mustafaaljadery/lightning-whisper-mlx/tree/5a4d978bcac88af22e612a3e58dfe07dbb3294ba) | 2024-05-08 | 2024-03-23 | 0 |
| [ncounterspecialist/twick](https://github.com/ncounterspecialist/twick) | [`3044c23`](https://github.com/ncounterspecialist/twick/tree/3044c23e282b87c639c3f0b3fd5fb3fd972aa04c) | 2026-05-07 | 2025-05-17 | 0 |
| [nomadkaraoke/python-audio-separator](https://github.com/nomadkaraoke/python-audio-separator) | [`4dd3477`](https://github.com/nomadkaraoke/python-audio-separator/tree/4dd3477c0a8f5bfb0fb053c6ed444bb935cb150e) | 2026-10-29 | 2023-06-30 | 15 |
| [nuzkyapp/nuzky](https://github.com/nuzkyapp/nuzky) | [`4500422`](https://github.com/nuzkyapp/nuzky/tree/45004221d7ad4d6448c159df849363ebcbc6c78c) | 2026-11-03 | 2026-10-06 | 1031 |
| [nyrahealth/CrisperWhisper](https://github.com/nyrahealth/CrisperWhisper) | [`5e5ce64`](https://github.com/nyrahealth/CrisperWhisper/tree/5e5ce6452762fe492a3cc5c9db56d00cba74d127) | 2026-09-22 | 2024-05-24 | 12 |
| [omni-media/omniclip](https://github.com/omni-media/omniclip) | [`cbe581a`](https://github.com/omni-media/omniclip/tree/cbe581a4a788d9982ffd4a10025c678f9e8707d6) | 2025-08-07 | 2023-11-05 | 0 |
| [OpenCut-app/OpenCut](https://github.com/OpenCut-app/OpenCut) | [`e668010`](https://github.com/OpenCut-app/OpenCut/tree/e668010778568641babef2cc40be4703ae6916d6) | 2026-09-24 | 2025-06-22 | 1 |
| [OpenCut-app/opencut-classic](https://github.com/OpenCut-app/opencut-classic) | [`cf5e79e`](https://github.com/OpenCut-app/opencut-classic/tree/cf5e79e919144200294fb9fed22a222592a0aeea) | 2026-05-17 | 2025-06-22 | 0 |
| [openfilm/openfilm](https://github.com/openfilm/openfilm) | [`4d52629`](https://github.com/openfilm/openfilm/tree/4d526294e0a7ad718cbf9bd27e2a562438819c73) | 2026-11-02 | 2026-10-10 | 216 |
| [openvideodev/react-video-editor](https://github.com/openvideodev/react-video-editor) | [`9a8c529`](https://github.com/openvideodev/react-video-editor/tree/9a8c5296da4b258f66dfb7ad73de96be62478bca) | 2026-06-29 | 2024-08-02 | 0 |
| [oxbshw/watch-skill](https://github.com/oxbshw/watch-skill) | [`f1317c8`](https://github.com/oxbshw/watch-skill/tree/f1317c8fe64744a606c31867b05fbbe3144268c6) | 2026-09-08 | 2026-07-03 | 481 |
| [palmier-io/palmier-pro](https://github.com/palmier-io/palmier-pro) | [`dfc810b`](https://github.com/palmier-io/palmier-pro/tree/dfc810b561f1692947eb81bbb689e078923ebb59) | 2026-11-02 | 2026-04-06 | 84 |
| [PeerReviewedShorts/karaoke-captions](https://github.com/PeerReviewedShorts/karaoke-captions) | [`db28736`](https://github.com/PeerReviewedShorts/karaoke-captions/tree/db287360eb7a6ae31d0c683356a02f4a1a0d000c) | 2026-10-22 | 2026-10-22 | 6 |
| [PeterL1n/BackgroundMattingV2](https://github.com/PeterL1n/BackgroundMattingV2) | [`a8e82df`](https://github.com/PeterL1n/BackgroundMattingV2/tree/a8e82df9f594578edf287dbb2b289ebcc50fbf00) | 2023-12-22 | 2020-12-14 | 0 |
| [PeterL1n/RobustVideoMatting](https://github.com/PeterL1n/RobustVideoMatting) | [`53d74c6`](https://github.com/PeterL1n/RobustVideoMatting/tree/53d74c6826735f01f4406b5ca9075eee27bec094) | 2023-03-13 | 2021-09-16 | 0 |
| [pq-yang/MatAnyone](https://github.com/pq-yang/MatAnyone) | [`e5ddc53`](https://github.com/pq-yang/MatAnyone/tree/e5ddc534c1fff9bb9e54cf476095d29071b7cb4f) | 2026-03-04 | 2025-02-03 | 0 |
| [pyang5166/gbro-collage-broll](https://github.com/pyang5166/gbro-collage-broll) | [`a1a4ee2`](https://github.com/pyang5166/gbro-collage-broll/tree/a1a4ee2e2abf7d44e460026b706d0c72c2cf8a91) | 2026-07-15 | 2026-07-15 | 0 |
| [pyang5166/gbro-collage-info](https://github.com/pyang5166/gbro-collage-info) | [`0b97a81`](https://github.com/pyang5166/gbro-collage-info/tree/0b97a817a6b65285d8aa90431079500a29092eab) | 2026-08-01 | 2026-08-01 | 0 |
| [pyannote/pyannote-audio](https://github.com/pyannote/pyannote-audio) | [`cc679dc`](https://github.com/pyannote/pyannote-audio/tree/cc679dc7d661f130369f99e5771dc79883d4fd79) | 2026-11-02 | 2016-03-07 | 6 |
| [qiuqiangkong/audioset_tagging_cnn](https://github.com/qiuqiangkong/audioset_tagging_cnn) | [`d2f4b8c`](https://github.com/qiuqiangkong/audioset_tagging_cnn/tree/d2f4b8c18eab44737fcc0de1248ae21eb43f6aa4) | 2021-07-13 | 2019-06-05 | 0 |
| [Quriosity-agent/qcut](https://github.com/Quriosity-agent/qcut) | [`15e2f42`](https://github.com/Quriosity-agent/qcut/tree/15e2f42f0c0424a5c24b44d13d1a3883590c8710) | 2026-11-02 | 2025-08-01 | 12517 |
| [redotvideo/revideo](https://github.com/redotvideo/revideo) | [`b5de67a`](https://github.com/redotvideo/revideo/tree/b5de67a009a55aa2768a1e178b0446b2479a0b4e) | 2026-07-15 | 2022-04-11 | 0 |
| [relo-video/synthcut](https://github.com/relo-video/synthcut) | [`96b1ca0`](https://github.com/relo-video/synthcut/tree/96b1ca0e8b9935cc0d9561a3bc020f29bf9e88a0) | 2026-07-21 | 2026-07-03 | 0 |
| [Remocn/remocn-studio](https://github.com/Remocn/remocn-studio) | [`fe21cf3`](https://github.com/Remocn/remocn-studio/tree/fe21cf3db88e0036afea80716abd12d4373a2dd7) | 2026-10-13 | 2026-06-24 | 458 |
| [remotion-dev/remotion](https://github.com/remotion-dev/remotion) | [`cd1bb77`](https://github.com/remotion-dev/remotion/tree/cd1bb77f35b839a6fdcd64765725749409c3f4e5) | 2026-11-03 | 2020-06-23 | 5529 |
| [resemble-ai/resemble-enhance](https://github.com/resemble-ai/resemble-enhance) | [`8e97814`](https://github.com/resemble-ai/resemble-enhance/tree/8e978149bfe8abab3eb77d965d579a111afdb0ff) | 2024-12-03 | 2023-12-13 | 0 |
| [riecodes/free247editor](https://github.com/riecodes/free247editor) | [`421f8b5`](https://github.com/riecodes/free247editor/tree/421f8b5a28da5d09fc2dbbc40fc2ded1afef7f73) | 2026-10-28 | 2026-10-16 | 7 |
| [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) | [`d375b2d`](https://github.com/Rikorose/DeepFilterNet/tree/d375b2d8309e0935d165700c91da9de862a99c31) | 2024-10-17 | 2021-10-10 | 0 |
| [rive-app/rive-wasm](https://github.com/rive-app/rive-wasm) | [`ef7cbdf`](https://github.com/rive-app/rive-wasm/tree/ef7cbdfe67b1f334e5acd4774fc86d701a92fc26) | 2026-11-03 | 2020-08-16 | 587 |
| [rk0neki/OpenKatana](https://github.com/rk0neki/OpenKatana) | [`f3b0910`](https://github.com/rk0neki/OpenKatana/tree/f3b09107a9828ef770f5bf63116cd418197c15c2) | 2026-11-03 | 2026-10-16 | 117 |
| [ronak-create/FableCut](https://github.com/ronak-create/FableCut) | [`579b08e`](https://github.com/ronak-create/FableCut/tree/579b08ec1a789baec5cbf06d7430373460508d09) | 2026-10-30 | 2026-07-06 | 267 |
| [senstella/parakeet-mlx](https://github.com/senstella/parakeet-mlx) | [`d4c3df0`](https://github.com/senstella/parakeet-mlx/tree/d4c3df0c8bb59ebb8925c545efa1598186bb7991) | 2026-11-03 | 2025-05-04 | 12 |
| [snakers4/silero-vad](https://github.com/snakers4/silero-vad) | [`066409f`](https://github.com/snakers4/silero-vad/tree/066409f3d9db45a30d21dfcbf9147826ffdd7052) | 2026-10-22 | 2020-11-23 | 24 |
| [social-media-skills/video-editing-skill](https://github.com/social-media-skills/video-editing-skill) | [`8b6fcf6`](https://github.com/social-media-skills/video-editing-skill/tree/8b6fcf6a73103a794bd4693af20f7a0c789b3aa4) | 2026-10-30 | 2026-10-30 | 1 |
| [soCzech/TransNetV2](https://github.com/soCzech/TransNetV2) | [`85cef72`](https://github.com/soCzech/TransNetV2/tree/85cef72af9a916bdfd7cc94a670c9cdfbf12d1ed) | 2021-07-28 | 2019-10-19 | 0 |
| [Stability-AI/stable-audio-tools](https://github.com/Stability-AI/stable-audio-tools) | [`3241adb`](https://github.com/Stability-AI/stable-audio-tools/tree/3241adba4fc2a85cf5b29d9eb68d42f40a28e820) | 2026-05-26 | 2023-05-23 | 0 |
| [storytold/filmcraft](https://github.com/storytold/filmcraft) | [`57dc82e`](https://github.com/storytold/filmcraft/tree/57dc82ea2046c2ec479ab4d4d8167d90e5500b49) | 2026-11-03 | 2026-09-30 | 3482 |
| [studiomeyer-io/mcp-video](https://github.com/studiomeyer-io/mcp-video) | [`c16fa34`](https://github.com/studiomeyer-io/mcp-video/tree/c16fa347a675f8d871ba4847fbe855e5388a0276) | 2026-11-01 | 2026-03-14 | 16 |
| [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) | [`2a3a857`](https://github.com/SYSTRAN/faster-whisper/tree/2a3a857737d17d974f30d818ebec69ce11929e5c) | 2026-11-02 | 2023-02-11 | 12 |
| [tenfoldmarc/video-edit-skill](https://github.com/tenfoldmarc/video-edit-skill) | [`3f01f2e`](https://github.com/tenfoldmarc/video-edit-skill/tree/3f01f2ebad12e1c6916eb66e32d6b816a3c7b41d) | 2026-10-15 | 2026-10-01 | 13 |
| [theatre-js/theatre](https://github.com/theatre-js/theatre) | [`6ea82b9`](https://github.com/theatre-js/theatre/tree/6ea82b938ea49609489f6377ded693ccc6ee8f5b) | 2024-04-11 | 2021-06-18 | 0 |
| [thehiggsfieldai/OpenHiggsfield](https://github.com/thehiggsfieldai/OpenHiggsfield) | [`a950796`](https://github.com/thehiggsfieldai/OpenHiggsfield/tree/a9507962df442b72c84f01d27565108b6724cc83) | 2026-09-26 | 2026-09-21 | 6 |
| [trykimu/videoeditor](https://github.com/trykimu/videoeditor) | [`6a30d43`](https://github.com/trykimu/videoeditor/tree/6a30d43c5d2c381940478d89e4c712f40fd85146) | 2026-09-10 | 2022-10-12 | 2 |
| [ultralytics/ultralytics](https://github.com/ultralytics/ultralytics) | [`8bd7c18`](https://github.com/ultralytics/ultralytics/tree/8bd7c184bb1683229ea9c50820040dae04ab4e2b) | 2026-11-03 | 2022-09-11 | 944 |
| [Vanilagy/mediabunny](https://github.com/Vanilagy/mediabunny) | [`303f4dd`](https://github.com/Vanilagy/mediabunny/tree/303f4dd05812d35be478820b9d551318b657ee37) | 2026-11-03 | 2024-09-01 | 229 |
| [veedstudio/open-edit](https://github.com/veedstudio/open-edit) | [`74b7240`](https://github.com/veedstudio/open-edit/tree/74b724014e4ca0f6e158afe72671f94fc02e5734) | 2026-11-03 | 2026-07-22 | 18 |
| [vercel-labs/json-render](https://github.com/vercel-labs/json-render) | [`1210a38`](https://github.com/vercel-labs/json-render/tree/1210a3825b7d3980e0978dfaa43d7b0c972ee11a) | 2026-11-02 | 2026-01-14 | 32 |
| [vincentventalon/claude-code-video-editing-skill](https://github.com/vincentventalon/claude-code-video-editing-skill) | [`49acf5b`](https://github.com/vincentventalon/claude-code-video-editing-skill/tree/49acf5b65c4660fe9772c063ba8aff50f5f23fe1) | 2026-11-02 | 2026-09-11 | 32 |
| [Vincentwei1021/video-talkcraft](https://github.com/Vincentwei1021/video-talkcraft) | [`a7c29ed`](https://github.com/Vincentwei1021/video-talkcraft/tree/a7c29edfb2404612dde6a5a1c8aa94232e85625b) | 2026-10-12 | 2026-08-28 | 84 |
| [walterlow/freecut](https://github.com/walterlow/freecut) | [`5ceeeb3`](https://github.com/walterlow/freecut/tree/5ceeeb388eef5423640b7db157706274bf1b8165) | 2026-10-29 | 2025-11-16 | 278 |
| [Wan-Video/Wan2.1](https://github.com/Wan-Video/Wan2.1) | [`9737cba`](https://github.com/Wan-Video/Wan2.1/tree/9737cba9c1c3c4d04b33fcad41c111989865d315) | 2026-03-05 | 2025-02-25 | 0 |
| [Wan-Video/Wan2.2](https://github.com/Wan-Video/Wan2.2) | [`1ea34ff`](https://github.com/Wan-Video/Wan2.2/tree/1ea34ff48f87168174e12956e200b1d908b1c5ff) | 2026-09-21 | 2025-07-28 | 2 |
| [WeftCut/WeftCut](https://github.com/WeftCut/WeftCut) | [`25aa8cd`](https://github.com/WeftCut/WeftCut/tree/25aa8cdb7ca456180915be79f8db8d6b6228ba41) | 2026-11-03 | 2026-05-07 | 1082 |
| [windpipe/claudeanimationbase](https://github.com/windpipe/claudeanimationbase) | [`0ac8bf2`](https://github.com/windpipe/claudeanimationbase/tree/0ac8bf2b31942376cb6b8c4074715595d512acd2) | 2026-09-24 | 2026-09-23 | 15 |
| [xzdarcy/react-timeline-editor](https://github.com/xzdarcy/react-timeline-editor) | [`4148f4a`](https://github.com/xzdarcy/react-timeline-editor/tree/4148f4a837dd767ea66807560d05bc7b65c7e578) | 2026-01-25 | 2022-02-19 | 0 |
| [YildizDikme/claude-video-edit](https://github.com/YildizDikme/claude-video-edit) | [`2db87cc`](https://github.com/YildizDikme/claude-video-edit/tree/2db87cc5e6e26f0c75f692badcaff3c898800bfe) | 2026-11-02 | 2026-11-02 | 2 |
| [yuchen-ya/reelterminal](https://github.com/yuchen-ya/reelterminal) | [`55aa352`](https://github.com/yuchen-ya/reelterminal/tree/55aa3528c304fecf306c6be1a0076c7317ea3023) | 2026-11-02 | 2026-01-19 | 654 |
| [ZhengPeng7/BiRefNet](https://github.com/ZhengPeng7/BiRefNet) | [`f707963`](https://github.com/ZhengPeng7/BiRefNet/tree/f7079632d681ecf12161fcea8905682934e59e51) | 2026-10-25 | 2022-08-17 | 4 |
