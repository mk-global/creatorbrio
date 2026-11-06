/**
 * The real render pipeline (#144): what one attempt of a render job does with
 * the request snapshot, in order:
 *
 *   1. read the media records the snapshot can reference from the registry;
 *   2. `compile` the snapshot against them and the export profile; a snapshot
 *      that no longer compiles (a media record gone, a capability this build
 *      does not know) fails permanently as `snapshot_invalid`;
 *   3. `buildOverlay` for the export target with the bundled fonts;
 *   4. `executeRender` with the originals, in a sub-folder of the work folder
 *      (it starts the overlay browsers and FFmpeg, and stops them when the
 *      job's signal aborts);
 *   5. `verifyExport` against the plan, the profile and the production's
 *      `format.maxDurationMs`;
 *   6. the SRT and WebVTT sidecars from the plan's caption cues;
 *   7. `buildManifest` with the SHA-256 of every output.
 *
 * It leaves `PIPELINE_FILES` in the work folder and returns the manifest and
 * the verification report; render jobs decide whether the render succeeded
 * and publish it.
 */
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_CATALOG } from "../capabilities/catalog";
import type { CapabilityCatalog } from "../capabilities/types";
import { hashFile, type MediaRecord, type MediaRegistry } from "../media/registry";
import { compile, COMPILER_VERSION } from "./compile";
import { executeRender } from "./execute";
import { RenderFailure, type ExecuteOptions } from "./execute-types";
import { bundledFonts } from "./fonts";
import { buildManifest, type RenderOutput } from "./manifest";
import { buildOverlay } from "./overlay";
import { EXPORT_PROFILES } from "./profile";
import { PIPELINE_FILES, type RenderPipeline } from "./render-record";
import { toSrt, toVtt } from "./sidecars";
import { verifyExport } from "./verify";

/** Overlay browsers per render (ADR decision 3 default). */
export const OVERLAY_WORKERS = 4;

export interface PipelineOptions {
  media: MediaRegistry;
  catalog?: CapabilityCatalog;
  workers?: number;
  now?: () => string;
}

/** Every registered record by media id: what the snapshot is compiled against, as the request handler compiled it. */
async function registeredMedia(registry: MediaRegistry): Promise<Map<string, MediaRecord>> {
  return new Map((await registry.list()).map((record) => [record.mediaId, record]));
}

export function createRenderPipeline(options: PipelineOptions): RenderPipeline {
  const catalog = options.catalog ?? DEFAULT_CATALOG;
  const workers = options.workers ?? OVERLAY_WORKERS;
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async run({ request, workDir, signal, onProgress }) {
      const profile = EXPORT_PROFILES[request.profileId];
      const production = request.production;
      const records = await registeredMedia(options.media);
      const compiled = compile(production, records, { profile, catalog });
      if (!compiled.ok) {
        const codes = [...new Set(compiled.issues.map((issue) => issue.code))];
        const message = codes.includes("media_not_registered")
          ? "a media this production uses is no longer registered"
          : `the production snapshot no longer compiles (${codes.join(", ")})`;
        throw new RenderFailure("permanent", "snapshot_invalid", message);
      }
      const plan = compiled.plan;
      const fonts = await bundledFonts();
      const overlay = buildOverlay(plan, { catalog, fonts, target: "export" });
      const media: ExecuteOptions["media"] = new Map(
        plan.inputs.map((input) => {
          const record = records.get(input.mediaId);
          if (!record) throw new RenderFailure("permanent", "internal_error", "the plan reads a media the compiler was not given");
          return [input.mediaId, { record, originalPath: options.media.originalPath(record) }];
        })
      );

      // The executor's scratch files live apart from the outputs, and go as soon as the video is out.
      const executeDir = path.join(/*turbopackIgnore: true*/ workDir, "execute");
      await mkdir(executeDir);
      const execution = await executeRender({ plan, profile, overlay, fonts, media, workDir: executeDir, workers, signal, onProgress });
      const video = path.join(/*turbopackIgnore: true*/ workDir, "video.mp4");
      await rename(execution.videoFile, video);
      await rm(executeDir, { recursive: true, force: true });

      const verifyStarted = Date.now();
      const verification = await verifyExport(video, plan, profile, execution.loudness, { maxDurationMs: production.format.maxDurationMs, signal });
      const verifyMs = Date.now() - verifyStarted;

      await writeFile(path.join(/*turbopackIgnore: true*/ workDir, "captions.srt"), toSrt(plan.captions, plan.canvas.fps), { mode: 0o644 });
      await writeFile(path.join(/*turbopackIgnore: true*/ workDir, "captions.vtt"), toVtt(plan.captions, plan.canvas.fps), { mode: 0o644 });
      const outputs: RenderOutput[] = [];
      for (const name of PIPELINE_FILES) {
        const { sha256, size } = await hashFile(path.join(/*turbopackIgnore: true*/ workDir, name));
        outputs.push({ name, sha256, bytes: size });
      }
      const manifest = buildManifest({
        renderId: request.renderId,
        plan,
        profile,
        compilerVersion: COMPILER_VERSION,
        fonts,
        overlay,
        execution,
        verification,
        outputs,
        verifyMs,
        createdAt: now(),
      });
      return { manifest, verification };
    },
  };
}
