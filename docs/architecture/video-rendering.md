# Video Studio Rendering and Export

[← Architecture](README.md) · API: [video-production-api.md](video-production-api.md) · Store: [video-production-store.md](video-production-store.md) · Media: [video-media-registry.md](video-media-registry.md) · ADR: [decision 3](adr-creatorbrio-video-studio.md)

Rendering turns one admitted production revision into a verified Instagram MP4 with SRT and WebVTT captions and a manifest (#144, WS4 #81 and WS17 #94, with parts of WS3 #80 and WS5 #82).
It lives in `src/lib/video/render/` and `src/lib/video/capabilities/`, and owns `data/video-renders/`.
It is the single renderer of ADR decision 3: the Studio preview follows the same compiled plan and the same overlay document, so nothing here depends on where it is played.

## From production to file

1. A person requests a render of a production's current revision (`POST /api/video/productions/:id/renders`).
2. The revision is compiled against the media registry and the export profile.
   If it cannot be exported, the request is refused with every reason at once and nothing is queued.
3. The exact document that compiled is written to the render's `request.json` as its snapshot, and the render is queued.
   Later edits to the production never change what a queued render produces.
4. A worker compiles the snapshot again, builds the overlay document, captures its frames in hardened Chromium, cuts, composites and mixes the originals in FFmpeg, and masters the loudness.
5. The file is verified against the profile with ffprobe and a loudness measurement.
6. The video, captions, manifest and verification report are published together, and only then is the render `succeeded` and its files served.

## The render plan

`compile()` (`compile.ts`) is a pure function from a production, the registered media and a profile to a `RenderPlan` (`plan.ts`) or a list of issues.
The plan is the one description of picture, sound and graphics that export and preview both follow.
Timeline positions are integer frames at the canvas frame rate, source positions integer microseconds, and sizes integer pixels.

**Issues.** Each issue has a code, a JSON pointer into the stored document such as `/timeline/tracks/2/clips/0/capability/params/cues/1/text`, a message and, where it applies, the clip id.

| Code | When |
|---|---|
| `empty_timeline` | Nothing to render |
| `profile_mismatch` | The canvas (`/format`) or frame rate (`/format/fps`) is not one the profile accepts |
| `duration_exceeds_profile` | The output is longer than `format.maxDurationMs`; exactly at the limit is accepted |
| `unsupported_feature` | A feature this renderer does not draw yet (below) |
| `capability_unavailable` | A graphics clip names a capability or version this server does not have, or a captions capability without cues |
| `invalid_capability_params` | The capability refused the clip's parameters; the pointer continues into `params` |
| `media_not_registered` | A clip names media the registry does not have |
| `media_kind_mismatch` | A video clip on media without a picture, a still on media that is not an image, or picture facts missing |
| `no_audio_stream` | An audio clip on media without sound |

**Not drawn yet, and refused rather than ignored:** transitions, clips on overlay tracks, non-empty `framing`, `speed` other than 1, `behind-subject` graphics, non-empty `effects` and audio `processing`.
An empty `framing` or `effects`, `speed: 1` and `processing: {}` are accepted.
`sceneId`, `provenance`, `renderCacheKey`, `markers` and `Timeline.captions.presetId` do not affect the output.

**Visibility.**
- The output lasts until the end of the last clip on any track, hidden and muted tracks included.
- A hidden video track draws nothing, but its clips' sound still plays and still ducks music.
- A hidden graphics track, a muted audio track and, when `Timeline.captions.hidden` is true, every captions clip are skipped without being checked.

**Picture.** Video tracks draw bottom to top; where nothing covers a frame the output is black.
Each layer is placed cover-fit in upright pixels: the source is turned upright, scaled to cover the canvas, and the canvas-sized window at the placement's offset is shown; when the crop is odd by one pixel, the extra pixel is cut from the right or bottom.
The export expresses the placement as scale and crop in FFmpeg, and the preview sizes and offsets the proxy element by the same numbers (`layerBox()`).
`tests/render-preview-parity.test.ts` checks that both put the same source features on the same canvas pixels.

**Sound.** Every sound is an `AudioSource` with its whole gain automation as a piecewise-linear envelope in timeline time, so the mix is plan data rather than a filter's hidden behaviour.
- An a-roll video clip's own sound and unmuted voice tracks are `voice`; a b-roll clip's sound is `b-roll` and is never ducked.
- Gain is the keyframes (in dB) times the fades times ducking.
  A keyframe's `ease` shapes the segment arriving at it from the previous keyframe; before the first keyframe and after the last the gain is constant.
- Ducking lowers music, sfx and ambience under merged voice intervals by `Timeline.audio.ducking`: a linear ramp in dB over the attack, and a release from whatever depth was reached.
  Where a release overlaps the next attack, the deeper reduction applies.
- The envelope is within 0.1 dB of the exact curve wherever the gain is at least -60 dB.
- A video clip's own sound can only be silenced today by gain keyframes at -96 dB; a proper mute is tracked in [#146](https://github.com/mk-global/creatorbrio/issues/146).

**Captions.** Caption cues are clipped to their clip, sorted, and written as `captions.srt` and `captions.vtt` (`sidecars.ts`) as well as drawn.
WebVTT escapes `&`, `<` and `>`; SRT has no escapes, so a run of dashes before `>` is shortened so it cannot read as a timing line.

## Capabilities

Captions and graphics are capabilities: first-party code named by a graphics clip's `CapabilityCall`, never user markup.
A capability validates its parameters strictly and emits the CSS and markup of one clip of the overlay document.

| Capability | Parameters | Drawing |
|---|---|---|
| `captions.timed@1.0.0` | `preset` (`kinetic` or `sentence`), `position` (`lower` or `center`), `accent?` (`#rrggbb`), `cues`: up to 500, each `{ start, end, text }` in whole clip frames, sorted, not overlapping, text 1 to 120 characters, at most 1,500 words per clip | Kinetic pops each word in over about 0.2 s, or until the next word if that is sooner, growing from its left edge so it never covers the word before it, and highlights the newest; sentence fades each cue in. Text is sized per clip so the longest cue fits three lines |
| `graphics.lower-third@1.0.0` | `title` (1 to 60), `subtitle?` (up to 80), `accent?` | Slides in over 10 frames and out over the last 8, bottom left, above the caption band |
| `graphics.title-card@1.0.0` | `title` (1 to 80), `subtitle?` (up to 120), `align` (`center` or `top`), `scrim` | Fades and scales in over 12 frames and out over the last 8; the scrim is a dark card inside the safe zone |

- Text is counted and drawn in code points after trimming its ends; the stored parameters keep what was sent. Control characters and line and paragraph separators are refused.
- Everything is drawn inside the safe zone: on 9:16, 60 px from the left, 14% from the top, 120 px from the right and 35% from the bottom, scaled to the canvas; on other canvases 60 px at the sides and top and 120 px at the bottom, scaled by the shorter side.
  This is a creator convention, not a Meta specification.
- Capability parameters are admitted when a change is committed, through the store's catalog (`StoreOptions.capabilities`).
  A capability the catalog does not know stays admissible so that drafts and future capabilities can be stored; the compiler refuses it at export.

## The overlay document

`buildOverlay()` (`overlay.ts`) compiles the plan's graphics into one HTML document with one `<style>` and no script.
Every animation is delayed by `calc(<seconds>s - var(--t, 0s))`, so the export seeks it with `document.getAnimations()` and the preview with the `--t` variable alone.
A graphic is shown on exactly its frames `[start, start + duration)`, sampled at frame centres, `(f + 0.5) / fps`.
`tests/overlay-preview-parity.test.ts` checks that the preview document in an `<iframe sandbox="">` and the export capture agree at 20 frames across every capability, apart from anti-aliasing at glyph edges.

**Security boundary.** The compiler and the capabilities are what stands between production text and a browser, so the document is checked after it is built, not only trusted:
- every user string is HTML-escaped, and CSS carries only values validated against strict patterns;
- each capability's CSS may hold only single-class selectors and keyframes named by that clip's prefix, with no `url(`, `@import`, `@font-face`, `<`, `>`, backslash, `!important`, quotes other than the font name, or `animation-play-state`;
- each capability's markup may hold only balanced `div` and `span` elements whose only attribute is such a class;
- output that breaks any rule fails the render as `internal_error`, and so do unknown capabilities, refused parameters and fonts that are not the six bundled faces.

**Fonts.** Text uses Inter from `@fontsource/inter` 5.3.0 (OFL 1.1), family `CreatorBrio Inter`, weights 400, 700 and 800 for latin and latin-ext, with `font-display: block` and no fallback family.
The faces are read from `node_modules/@fontsource/inter` at run time and checked against the pinned version and unicode ranges; a missing or different package fails as `font_bundle_missing` or `font_bundle_mismatch`.
Characters outside latin and latin-ext, such as emoji, fall back to system fonts and can differ between computers.
The export document loads the fonts from its own origin; the preview document embeds them as `data:` URLs under a meta CSP.

## The executor

`executeRender()` (`execute.ts`) produces the MP4 from a plan and its overlay document in a scratch folder.

**Overlay capture.** Up to `workers` (1 to 16, default 4) Chromium browsers capture the overlay's frames as transparent PNGs.
Each browser:
- starts with its sandbox on, and is refused as `browser_sandbox_disabled` if anything disabled it;
- is driven over a pipe rather than a WebSocket, so it exits when the server process dies, even by SIGKILL;
- runs with page JavaScript off and the pinned G1 software-raster flags plus background networking, component updates, domain reliability and extensions disabled (`chrome.ts`); `chromeArgsSha256` in the manifest records them;
- loads the document at the synthetic origin `https://overlay.creatorbrio.invalid` under `default-src 'none'; style-src 'unsafe-inline'; font-src 'self'`;
- intercepts every request at the browser target and answers only the document and the six font files from memory: any other request fails the render as `overlay_request_blocked`, and any navigation, frame or new page as `overlay_navigation`;
- has a 30 s deadline to start and load and a 10 s deadline per frame, after which it is killed and the render fails as `timeout`.

Frames outside the plan's active graphics ranges are known to be transparent and are not captured.
Frames are captured in chunks of 15, each on a freshly loaded document with the page's animation timeline paused, and written in order; the output is byte-identical at any worker count and across runs.
The pause was needed because Chromium otherwise advanced animations while a document sat loaded, and it is measured behaviour rather than a documented Chromium guarantee, so it must be checked again whenever Chromium is upgraded.

**Picture and sound.** One FFmpeg graph cuts, rotates, scales and crops the originals, converts HLG and PQ to BT.709, composites at 4:4:4 with the overlay converted explicitly to BT.709, and subsamples once to 4:2:0.
It encodes with libx264 at the profile's settings, bitexact flags and fixed threads, so the same plan encodes identically.
A track made of several clips, or with gaps, is put back on the frame grid after its pieces are joined, because joining them leaves microsecond timestamps that made the track end a frame early.
The final pass must deliver exactly the plan's frame count.

**Mix.** Each sound follows its stream's timestamps, as its picture does: a stream that starts after its file does is preceded by silence, measured from the seek point, and a gap of 10 ms or more inside it becomes silence (an overlap that large is dropped).
It is then trimmed, delayed and padded in samples, and its gain envelope is written as a gain signal, one 32-bit float gain per sample of the render equal to the envelope at that sample, which FFmpeg multiplies into the sound.
An envelope's complexity therefore never changes the graph or the cost per sample; an earlier design that wrote the envelope as one FFmpeg expression failed to parse at a few hundred points, which a fade over a ducked music bed reaches.

**Loudness.** The mix is normalised with two-pass `loudnorm` to `Timeline.audio.masterLufs`, aiming its true peak 0.5 dB under the profile's limit, then encoded with the profile's AAC settings and measured again.
If the encoded result is more than 0.2 LU from the target, or its true peak is less than 0.1 dB under the profile's limit, a static gain and an oversampled limiter correct it, in at most four passes.
Verification then checks the profile's limit itself.
A mix below the profile's silence floor is left as it is (`skipped-silence`), and a plan without sound gets a silent track (`no-audio`).

**Deadlines.** The video pass may take the larger of 300 s and 30 s per output second, the mix the larger of 120 s and 10 s per second, and each loudness run the larger of 60 s and 5 s per second.
Cancelling kills every browser and FFmpeg process of the render.

## Verification and the manifest

`verifyExport()` (`verify.ts`) reads the file with ffprobe and checks, in order:
- the container;
- one video stream: H.264 High, yuv420p, the canvas size, frame rate (`r_frame_rate` and `avg_frame_rate`), frame count, BT.709 primaries, transfer and matrix, limited range, and duration;
- one audio stream: AAC-LC, 48 kHz stereo, and duration;
- all three durations within one frame of the plan, the production's `format.maxDurationMs` and faststart;
- integrated loudness within the profile's tolerance of the target and the true peak under the ceiling, measured from the file, unless the mix was silent or absent.

Each check records what was expected and what was found.
A file that fails any check fails the render permanently as `verification_failed`; its files and `verification.json` stay for inspection but are never served.

`manifest.json` (`manifest.ts`, schema version 1) records the render and production ids, revision, profile and its version, plan and compiler versions, canvas, frame count, the input media hashes, fonts with their hashes, the overlay document's hash and captured-frame digest, the tool versions, the Chromium flags hash, worker count, loudness measurements, the verification outcome and the size and SHA-256 of the video and both caption files.
It never holds a path, a media file name or any text from the production.

## Render jobs

```text
data/video-renders/
  .staging/<uuid>/          a render folder being created
  <productionId>/<renderId>/
    request.json            the snapshot: the admitted document and the profile, written once
    job.json                the job record, replaced by atomic rename
    job.lock                present only while a process runs the render
    work/                   the running attempt's scratch folder
    video.mp4, captions.srt, captions.vtt, manifest.json, verification.json
```

```text
queued ──▶ running ──▶ succeeded
  │           │  ▲
  │           │  └── transient failure, attempt < 3 (after 2 s, then 4 s)
  │           ├────▶ failed: transient after the last attempt, permanent, or configuration
  └───────────┴────▶ cancelled (a person)
failed, cancelled ──retry──▶ queued
```

- A render folder appears whole: its snapshot and job record are written under `.staging/` and renamed into place together.
- One render runs at a time in a process, in its own lane, so preview jobs keep flowing during an export.
  `job.lock` keeps two processes from running the same render: it is written whole to a temporary file and hard-linked into place, so it is never seen half written, and it stays held through the pauses between attempts.
  A lock that cannot be read counts as held for 30 s after it was last changed.
  A lock whose owner has stopped is taken over by moving it aside and checking it is the one that was read; a process otherwise removes only its own lock.
- An owner is recorded as its process id, host and start time (read with `ps`), so a process id reused after a reboot is not mistaken for the owner; without `ps` only the id is compared.
- An attempt builds into `work/`, which the next attempt clears.
  The outputs are renamed into the render folder only when all of them exist, and `job.json` saying `succeeded` is the commit point for serving them.
- When the API starts, renders still queued are run, and renders left `running` by an owner confirmed stopped are `interrupted`: the attempt counts, and the render is queued again, or fails as transient `interrupted` if that was its third attempt.
- If a render's record cannot be written after it started, it is failed as transient `io_error` on a best-effort basis and not retried automatically; a person retries it.
- Requesting a render while one is queued or running for the same document (the snapshot's SHA-256, not the revision number, which recovery can reuse) and profile returns that render (200, `existing`).
- Cancelling a queued render, or one waiting between attempts, cancels it at once.
  Cancelling a running render stops its processes, and it ends `cancelled`, never `failed`.
  A render that another live process is running, or waiting to retry, cannot be cancelled from this one (409 `not_cancellable`).
  A render whose owner is neither this process nor confirmed alive, for example one recorded under another host name, can be cancelled by a person, which also removes that owner's lock, and then retried.
- Progress is `{ stage, done, total }` for the stages `overlay`, `video`, `audio` and `mux`, written whenever the stage changes and otherwise at most once a second.
  While the file is verified, the last mux progress is still shown.

| Failure class | Codes | What happens |
|---|---|---|
| Transient | `timeout`, `interrupted`, `io_error` (disk full or busy) | Retried up to three attempts in all, then `failed`; an `io_error` writing the job record fails at once |
| Permanent | `tool_failed`, `overlay_navigation`, `overlay_request_blocked`, `overlay_font_failed`, `verification_failed`, `snapshot_invalid` (the snapshot is missing or damaged, its media is no longer registered, or it no longer compiles), `internal_error` | `failed` at once |
| Configuration | `tool_missing`, `ffmpeg_too_old`, `encoder_missing`, `browser_missing`, `browser_sandbox_disabled`, `hdr_conversion_unavailable`, `font_bundle_missing`, `font_bundle_mismatch` | `failed` at once; fix the installation, then retry |

Failure messages never contain paths, tool output or production text.

**Recovery.** A person retries a failed or cancelled render with `POST …/renders/:renderId/retry`, which queues it again from its snapshot with its attempts reset.
`job.json` keeps the last 20 events for investigation.
Log events are `[video render] render_requested`, `render_refused`, `render_started`, `render_retrying`, `render_failed`, `render_succeeded`, `render_cancelled`, `render_interrupted`, `render_retried`, `render_unreadable` and `render_error`, with ids, attempt and codes only.

## HTTP

The render endpoints, who may call them and their errors are in [video-production-api.md](video-production-api.md#renders).
Only a person can request, cancel, retry or download renders; agents cannot.
Files are downloads (`Content-Disposition: attachment`) with `no-store`, `nosniff` and a sandbox CSP; only `video.mp4` supports Range requests and may be loaded by a paired browser's media element.

## Tools

Rendering needs FFmpeg 6.0 or newer with libx264 and the native AAC encoder (tested with 9.0.2), found as described in [the media registry](video-media-registry.md#ffmpeg), and the Chromium that Puppeteer installs, or `PUPPETEER_EXECUTABLE_PATH` when it is an absolute path to an existing file.
The render tests that need them skip, saying why, where they are missing; CI does not install FFmpeg yet ([#142](https://github.com/mk-global/creatorbrio/issues/142)).

## Not built yet

- Deleting renders, a bound on their disk use, and sweeping `.staging/` after a crash: [#147](https://github.com/mk-global/creatorbrio/issues/147).
- Transitions, reframing, speed changes, effects, overlay tracks and behind-subject graphics.
- Export profiles other than Instagram.
- FFmpeg 6.x paths are written but tested only on 9.0.2.
