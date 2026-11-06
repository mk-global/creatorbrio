/**
 * What the Export panel says about each render and what it offers (#150):
 * every state, progress, cancelling, verification, older revisions,
 * ordering, polling and the compiler's refusal in plain words.
 */
import { describe, expect, it } from "vitest";

import { activeSummary, describeCompileIssue, renderStatus, sentence, shouldPoll, sortRenders, withRender } from "@/lib/video/studio/render-status";
import type { RenderView } from "@/lib/video/studio/types";

function render(patch: Partial<RenderView> = {}): RenderView {
  return {
    renderId: "render-000000001-aaaaaaaa",
    productionId: "p1",
    revision: 3,
    profile: "instagram-reel",
    state: "queued",
    attempts: 0,
    requestedAt: "2026-11-06T10:00:00.000Z",
    updatedAt: "2026-11-06T10:00:00.000Z",
    files: [],
    ...patch,
  };
}

describe("render status", () => {
  it("queued: waiting, cancellable, not retryable, no files", () => {
    expect(renderStatus(render(), 3)).toMatchObject({ label: "Queued", tone: "progress", stage: "Waiting to start", progress: null, canCancel: true, canRetry: false, files: [], olderRevision: false, failure: null, verification: null });
  });

  it("running: the stage in words and its progress", () => {
    const status = renderStatus(render({ state: "running", progress: { stage: "overlay", done: 45, total: 90 } }), 3);
    expect(status).toMatchObject({ label: "Rendering", stage: "Drawing captions and graphics", progress: { done: 45, total: 90, percent: 50 }, canCancel: true, canRetry: false });
    expect(renderStatus(render({ state: "running", progress: { stage: "mux", done: 0, total: 0 } }), 3)).toMatchObject({ stage: "Packaging the MP4", progress: null });
  });

  it("running with a cancel requested: cancelling, and not cancellable again", () => {
    expect(renderStatus(render({ state: "running", cancelRequested: true }), 3)).toMatchObject({ label: "Cancelling", canCancel: false, canRetry: false });
  });

  it("succeeded: the files in download order and the verifier's pass", () => {
    const status = renderStatus(render({ state: "succeeded", files: ["manifest.json", "video.mp4", "captions.vtt", "captions.srt"], verification: { ok: true, failedChecks: [] } }), 3);
    expect(status).toMatchObject({ label: "Ready", tone: "success", canCancel: false, canRetry: false, verification: { ok: true } });
    expect(status.files).toEqual(["video.mp4", "captions.srt", "captions.vtt", "manifest.json"]);
  });

  it("failed: retryable, with the failure as a sentence, the failed checks and where it stopped", () => {
    const status = renderStatus(
      render({ state: "failed", progress: { stage: "video", done: 10, total: 40 }, failure: { failureClass: "permanent", code: "verification_failed", message: "the export did not pass verification" }, verification: { ok: false, failedChecks: ["faststart", "audio_codec"] } }),
      3
    );
    expect(status).toMatchObject({ label: "Failed", tone: "danger", canCancel: false, canRetry: true, failure: "The export did not pass verification.", stage: "Encoding video", progress: { percent: 25 } });
    expect(status.verification).toEqual({ ok: false, text: "Failed checks: faststart, audio_codec" });
  });

  it("cancelled: retryable, no files even if the list had some", () => {
    expect(renderStatus(render({ state: "cancelled", files: ["video.mp4"] }), 3)).toMatchObject({ label: "Cancelled", tone: "neutral", canRetry: true, canCancel: false, files: [] });
  });

  it("marks a render of an older revision", () => {
    expect(renderStatus(render({ revision: 2 }), 3).olderRevision).toBe(true);
    expect(renderStatus(render({ revision: 3 }), 3).olderRevision).toBe(false);
  });
});

describe("the render list", () => {
  const a = render({ renderId: "render-000000001-aaaaaaaa", requestedAt: "2026-11-06T10:00:00.000Z", state: "succeeded" });
  const b = render({ renderId: "render-000000002-bbbbbbbb", requestedAt: "2026-11-06T10:05:00.000Z", state: "running" });
  const c = render({ renderId: "render-000000003-cccccccc", requestedAt: "2026-11-06T10:05:00.000Z", state: "failed" });

  it("is newest first, by request time and then id", () => {
    expect(sortRenders([a, b, c]).map((r) => r.renderId)).toEqual([c.renderId, b.renderId, a.renderId]);
  });

  it("replaces a render by id or adds it", () => {
    expect(withRender([a, b], { ...b, state: "cancelled" }).map((r) => [r.renderId, r.state])).toEqual([[b.renderId, "cancelled"], [a.renderId, "succeeded"]]);
    expect(withRender([a], c).map((r) => r.renderId)).toEqual([c.renderId, a.renderId]);
  });

  it("is polled only while a render is queued or running", () => {
    expect(shouldPoll([a, c])).toBe(false);
    expect(shouldPoll([a, b])).toBe(true);
    expect(shouldPoll([render()])).toBe(true);
    expect(shouldPoll([])).toBe(false);
  });

  it("summarises the unfinished render for the header", () => {
    expect(activeSummary([a, c])).toBeNull();
    expect(activeSummary([render()])).toBe("Queued");
    expect(activeSummary([render(), { ...b, progress: { stage: "video", done: 21, total: 50 } }])).toBe("Rendering 42%");
  });
});

describe("refusals in plain words", () => {
  it("states the compiler's message as a sentence with its clip", () => {
    expect(describeCompileIssue({ code: "empty_timeline", path: "/timeline/tracks", message: "the timeline has no clips to export" })).toEqual({ text: "The timeline has no clips to export.", clipId: null });
    expect(describeCompileIssue({ code: "unsupported_feature", path: "/timeline/tracks/0/clips/0/speed", message: "speed changes cannot be exported yet", clipId: "v1" })).toEqual({ text: "Speed changes cannot be exported yet.", clipId: "v1" });
    expect(sentence("done!")).toBe("Done!");
    expect(sentence("  ")).toBe("");
  });
});
