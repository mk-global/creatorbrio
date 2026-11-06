/**
 * What the Studio's pairing card, media bin and history buttons show
 * (#150): the pairing code as typed, the plain-words message for each error
 * code the API answers, each media's preview state and thumbnail, and the
 * Undo and Redo titles.
 */
import { describe, expect, it } from "vitest";

import { generateCode, normaliseCode } from "@/lib/video/production/api/sessions";
import { historyActions } from "@/lib/video/studio/history-labels";
import { mediaDetail, previewState, thumbnailFile } from "@/lib/video/studio/media-library";
import { readPairingInput } from "@/lib/video/studio/pairing-code";
import { createErrorMessage, importErrorMessage, pairingErrorMessage, retryErrorMessage, waitPhrase } from "@/lib/video/studio/studio-messages";
import type { MediaView, ProductionView } from "@/lib/video/studio/types";

const err = (code: string, details: Record<string, unknown> = {}, message = `server says ${code}`) => ({ code, message, details });

describe("the pairing code as typed", () => {
  it("groups up to 20 letters and digits in fives, in upper case, ignoring separators", () => {
    expect(readPairingInput("")).toEqual({ code: "", display: "", complete: false });
    expect(readPairingInput("abcde")).toEqual({ code: "ABCDE", display: "ABCDE", complete: false });
    expect(readPairingInput("abcde-")).toMatchObject({ display: "ABCDE" });
    expect(readPairingInput("abcdef")).toMatchObject({ display: "ABCDE-F" });
    expect(readPairingInput(" 0123 4567-89ab cdef ghjk ")).toEqual({ code: "0123456789ABCDEFGHJK", display: "01234-56789-ABCDE-FGHJK", complete: true });
    expect(readPairingInput("0123456789ABCDEFGHJKMNPQ")).toMatchObject({ code: "0123456789ABCDEFGHJK", complete: true });
    expect(readPairingInput("ab_cd.é!")).toMatchObject({ code: "ABCD" });
  });

  it("sends a form the server reads as the same code, however it was typed", () => {
    for (let i = 0; i < 50; i++) {
      const code = generateCode();
      const printed = code.match(/.{5}/g)!.join("-");
      for (const typed of [printed, code, code.toLowerCase(), printed.replace(/-/g, " "), ` ${printed.toLowerCase()} `]) {
        const input = readPairingInput(typed);
        expect(input.complete).toBe(true);
        expect(normaliseCode(input.display)).toBe(code);
      }
    }
  });

  it("leaves letters the server reads loosely for the server to judge", () => {
    expect(normaliseCode(readPairingInput("O1234-I6789-LBCDE-FGHJK").display)).toBe("01234-16789-1BCDE-FGHJK".replace(/-/g, ""));
  });
});

describe("error messages", () => {
  it("says what to do for each pairing refusal", () => {
    expect(pairingErrorMessage(err("invalid_pairing_code"))).toMatch(/mistyped, already used, or older than five minutes.*npm run studio:pair/);
    expect(pairingErrorMessage(err("rate_limited"))).toContain("Wait a minute");
    expect(pairingErrorMessage(err("rate_limited", { retryAfterSeconds: 42 }))).toContain("Wait 42 seconds");
    for (const code of ["request_refused", "session_request_refused"]) expect(pairingErrorMessage(err(code))).toContain("CreatorBrio app's own address");
    expect(pairingErrorMessage(err("network_error"))).toContain("did not answer");
    expect(pairingErrorMessage(err("internal_error"))).toBe("The browser was not paired: server says internal_error");
  });

  it("words the wait from Retry-After", () => {
    expect(waitPhrase({})).toBe("a minute");
    expect(waitPhrase({ retryAfterSeconds: "30" })).toBe("30 seconds");
    expect(waitPhrase({ retryAfterSeconds: "soon" })).toBe("a minute");
    expect(waitPhrase({ retryAfterSeconds: -5 })).toBe("a minute");
    expect(waitPhrase({ retryAfterSeconds: 1 })).toBe("1 second");
    expect(waitPhrase({ retryAfterSeconds: 59 })).toBe("59 seconds");
    expect(waitPhrase({ retryAfterSeconds: 59.2 })).toBe("a minute");
    expect(waitPhrase({ retryAfterSeconds: 60 })).toBe("a minute");
    expect(waitPhrase({ retryAfterSeconds: 61 })).toBe("2 minutes");
  });

  it("explains every import refusal without echoing the path", () => {
    const codes = ["invalid_path", "not_found", "not_a_file", "inside_data_directory", "too_large", "unsupported_media", "tool_missing", "network_error"];
    const messages = codes.map((code) => importErrorMessage(err(code)));
    expect(new Set(messages).size).toBe(codes.length);
    for (const m of messages) expect(m).not.toMatch(/server says/);
    expect(importErrorMessage(err("contended"))).toBe("The file was not imported: server says contended");
  });

  it("explains retry and create refusals", () => {
    expect(retryErrorMessage(err("job_not_failed"))).toContain("already being made");
    expect(retryErrorMessage(err("media_not_found"))).toContain("no longer");
    expect(createErrorMessage(err("already_exists"))).toContain("already exists");
    expect(createErrorMessage(err("rejected", { issues: [{ path: "name", message: "expected non-empty text" }] }))).toBe("The production was not created: expected non-empty text");
    expect(createErrorMessage(err("rejected"))).toBe("The production was not created: server says rejected");
  });
});

function media(kind: MediaView["kind"], derived: Partial<MediaView["derived"]>, facts: Partial<MediaView["facts"]> = {}): MediaView {
  return {
    mediaId: "a".repeat(64),
    kind,
    originalName: "x",
    sizeBytes: 1,
    importedAt: "2026-11-06T00:00:00.000Z",
    facts: { kind, container: "synthetic", ...facts },
    provenance: { source: "local-file", rights: "user-supplied" },
    derived: { state: "queued", attempts: 0, files: [], ...derived },
  };
}

describe("a library media's state", () => {
  it("is preparing until the job succeeds or fails", () => {
    expect(previewState(media("video", { state: "queued" }))).toBe("preparing");
    expect(previewState(media("video", { state: "running" }))).toBe("preparing");
    expect(previewState(media("video", { state: "succeeded" }))).toBe("ready");
    expect(previewState(media("video", { state: "failed" }))).toBe("failed");
  });

  it("shows the poster or image proxy only once the job made it, and nothing for audio", () => {
    expect(thumbnailFile(media("video", { state: "running" }))).toBeNull();
    expect(thumbnailFile(media("video", { state: "succeeded", files: ["proxy.mp4", "peaks.json"] }))).toBeNull();
    expect(thumbnailFile(media("video", { state: "succeeded", files: ["proxy.mp4", "poster.jpg"] }))).toBe("poster.jpg");
    expect(thumbnailFile(media("image", { state: "succeeded", files: ["proxy.png"] }))).toBe("proxy.png");
    expect(thumbnailFile(media("audio", { state: "succeeded", files: ["proxy.m4a", "peaks.json"] }))).toBeNull();
  });

  it("gives the length in whole frames at the production's rate, or an image's upright size", () => {
    expect(mediaDetail(media("video", {}, { durationUs: 62_533_333 }), 30)).toBe("00:01:02:15");
    expect(mediaDetail(media("audio", {}), 30)).toBe("");
    const picture = { codec: "png", width: 1920, height: 1080, frameRate: null, variableFrameRate: false, pixelFormat: null, bitDepth: null, color: { primaries: null, transfer: null, matrix: null, range: null }, dynamicRange: "sdr" as const };
    expect(mediaDetail(media("image", {}, { video: { ...picture, rotation: 0 } }), 30)).toBe("1920 × 1080");
    expect(mediaDetail(media("image", {}, { video: { ...picture, rotation: 90 } }), 30)).toBe("1080 × 1920");
  });
});

describe("Undo and Redo", () => {
  const step = (label: string) => ({ label, changeSetIds: ["cs"], runId: null, fromRevision: 0, toRevision: 1 });
  const view = (undo: string[], redo: string[]) => ({ history: { undo: undo.map(step), redo: redo.map(step), labels: [] } }) as unknown as ProductionView;

  it("names the top step of each stack and is off when a stack is empty", () => {
    expect(historyActions(view([], []), false)).toEqual({
      undo: { label: null, enabled: false, title: "Nothing to undo" },
      redo: { label: null, enabled: false, title: "Nothing to redo" },
    });
    expect(historyActions(view(["Add footage.mov", "Add title"], ["Trim clip"]), false)).toEqual({
      undo: { label: "Add title", enabled: true, title: "Undo Add title" },
      redo: { label: "Trim clip", enabled: true, title: "Redo Trim clip" },
    });
  });

  it("is off while a command is in flight", () => {
    const { undo, redo } = historyActions(view(["Add title"], ["Trim clip"]), true);
    expect(undo).toMatchObject({ enabled: false, title: expect.stringMatching(/^Undo Add title \(wait/) });
    expect(redo.enabled).toBe(false);
  });
});
