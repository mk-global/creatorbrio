# Video Studio Media Registry

[← Architecture](README.md) · API: [video-production-api.md](video-production-api.md) · Store: [video-production-store.md](video-production-store.md)

The media registry keeps the footage, audio and images a production uses (#140, the first slice of WS2 #79, with parts of WS3 #80 and WS5 #82).
It lives in `src/lib/video/media/` and owns `data/video-media/`.
It is also the asset ledger the [production store](video-production-store.md) admits every new state against.

## What a media is

A media is an imported file's exact bytes, named by their SHA-256, which is the `mediaId` productions refer to.
Its record holds what ffprobe found (kind, container, duration, streams, frame rate, rotation, colour tags and dynamic range), the original file name without its folder, the import time and a provenance claim of `user-supplied` rights.
HLG and PQ video is recorded as HDR.

Originals are never rewritten, moved or served over HTTP.
Export renders from them (see the [ADR](adr-creatorbrio-video-studio.md), decision 3); the browser only ever sees derived preview files.

## Layout

```text
data/video-media/
  objects/<sha256>/
    original.<ext>   the imported bytes, mode 0444
    record.json      the record
    job.json         the derived-files job
    job.lock         present only while a process runs the job
    proxy.mp4 | proxy.m4a | proxy.png, poster.jpg, peaks.json
  tmp/               imports and job attempts being built
```

## Importing by path

A person sends the absolute path of a local file (`POST /api/video/media`).
Browser upload is not offered yet: Next.js keeps only the first 10 MB of a body that passes `src/proxy.ts`.

1. The path must be absolute and name a regular file: folders, symbolic links, devices and anything inside CreatorBrio's data folder are refused.
2. Files over 32 GiB are refused before anything is read.
3. ffprobe reads the file in place; a file that is not video, audio or a still image is refused and never copied.
   For a still image ffprobe also decodes the first frame, whose orientation (EXIF in JPEG, `eXIf` in PNG) becomes the record's rotation, so the image is placed and previewed upright.
   An image that does not decode, or whose orientation is mirrored (EXIF 2, 4, 5 or 7) or not a quarter turn, is refused as `unsupported_media`.
4. The file is cloned into its own folder under `tmp/` (copy-on-write on APFS, a full copy elsewhere), made read-only, hashed while streaming, and probed again: the copy is what the record describes.
5. The record is written next to it, and the folder is renamed onto `objects/<sha256>`.
   That rename publishes the media in one step.
   If the same bytes were already registered, the rename fails and the existing record is returned (`200`, `status: "existing"`); concurrent imports of the same file publish exactly once.

A crash before the rename leaves only files under `tmp/`.

## Derived files

Each media has one job that makes its preview files.
They are previews only.

| Media | Files |
|---|---|
| Video | `proxy.mp4`: H.264 yuv420p, BT.709 tagged, within 540×960 (or 960×540), upright with no rotation flag, a keyframe every 15 frames, source timestamps kept, AAC 48 kHz stereo, faststart. `poster.jpg`: a frame of the proxy. `peaks.json` when the video has sound. |
| Audio | `proxy.m4a`: AAC 48 kHz stereo. `peaks.json`. |
| Image | `proxy.png`: within 1080×1920 (or 1920×1080), transparency kept. |

`peaks.json` is `{ version, peaksPerSecond, peaks }`: the loudest sample in each bucket, from 0 to 255, at 100 per second, fewer for media longer than about 17 minutes so that a file never holds more than 100,000 values.
Peak i is at file time i / peaksPerSecond: a sound stream that starts after its file does is preceded by silence and gaps of 10 ms or more become silence, as in the export, so the waveform lines up with the exported sound.

**HDR.** HLG and PQ video is converted on VideoToolbox: the hardware decodes and converts the colour to BT.709 with `scale_vt` (the G2 record, #98), and the frames are then turned upright in software, because FFmpeg drops the rotation on that hardware path.
This FFmpeg build has no software tone-mapping, so on a computer without `scale_vt` the job fails with the configuration code `hdr_conversion_unavailable` rather than producing a washed-out preview.
The conversion was checked on synthetic HLG and PQ signals only; real iPhone footage and Dolby Vision are still to be qualified.

### The job

```text
queued ──▶ running ──▶ succeeded
              │  ▲
              │  └── transient failure, attempt < 3 (after 2 s, then 4 s)
              └────▶ failed: transient after the last attempt, permanent, or configuration
```

- An import queues its job; when the API starts, any media with a missing, queued or interrupted job is queued too.
- One job runs at a time in a process.
  `job.lock`, created exclusively, keeps a second process from running the same media; a lock whose process has stopped is taken over.
- A job found `running` whose owner has stopped was interrupted, for example by a server restart, and is queued again.
- Stopping the job runner also ends this startup recovery: it writes and queues nothing more, and waiting for the runner to be idle includes it.
- Each attempt builds its files in a scratch folder under `tmp/`, and they are renamed into the media's folder only when all of them exist.
  A derived file is served only after its job succeeded.
- Tool deadlines scale with the media's length: four times its duration for a video proxy, with a two-minute minimum.

| Failure class | Codes | What happens |
|---|---|---|
| Transient | `timeout`, `interrupted`, `io_error` (disk full or busy) | Retried up to three attempts in all, then `failed` |
| Permanent | `tool_failed` (FFmpeg could not read or convert the file), `internal_error` | `failed` at once |
| Configuration | `tool_missing`, `ffmpeg_too_old`, `encoder_missing`, `hdr_conversion_unavailable` | `failed` at once; fix the installation, then retry |

**Recovery.** A person retries a failed job with `POST /api/video/media/:mediaId/proxy`, which resets its attempts.
`job.json` keeps the last 20 events (queued, started, failed with its code, succeeded, interrupted, retried) for investigation.
Log events are `[video media] job_started`, `job_retrying`, `job_failed`, `job_succeeded`, `job_interrupted`, `job_retried`, `imported` and `import refused`, with the media id, attempt and code, and never a path.

## The ledger

`MediaRegistry.ledger()` maps every registered media id to its kind and, for video and audio, its duration.
`apiContext()` gives it to the `ProductionStore`, which reads it fresh for every attempt to commit.
An unreadable registry fails the request as a storage error and writes nothing.

## FFmpeg

CreatorBrio needs FFmpeg 6.0 or newer, the first release with every option it uses; it has been tested with 9.0.2 on macOS.
With an older numbered release, jobs fail with the configuration code `ffmpeg_too_old`.
The media tests skip, saying why, where FFmpeg is missing or too old; CI does not install it yet ([#142](https://github.com/mk-global/creatorbrio/issues/142)), so there they skip.
FFmpeg and ffprobe are found through `CREATORBRIO_FFMPEG` and `CREATORBRIO_FFPROBE`, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, then `PATH`.
They run as child processes without a shell, with a deadline, a bound on captured output and an abort signal, and every file is passed with the `file:` protocol so a name cannot be read as an option or another protocol.

## Not built yet

- Deleting media and collecting unused originals.
- Browser upload, and moving imports of very large files out of the request: [#141](https://github.com/mk-global/creatorbrio/issues/141).
- Transcription, and rights beyond the `user-supplied` claim.
