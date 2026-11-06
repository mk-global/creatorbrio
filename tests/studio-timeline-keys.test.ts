/**
 * The Studio timeline's keyboard (#150, G7): which key does what to the
 * focused clip, that the workspace's Space and Cmd/Ctrl shortcuts are left
 * alone, and that each key press is at most one change set.
 */
import { describe, expect, it } from "vitest";

import { newEditProduction, STUDIO_TRACKS } from "@/lib/video/production/new-production";
import { commandEdit, KEYBOARD_HELP, keyCommand, type KeyInput } from "@/lib/video/studio/timeline-keys";
import type { GraphicsClip, Production } from "@/types/production";

const press = (key: string, code: string, mods: Partial<KeyInput> = {}): KeyInput => ({ key, code, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods });

const title = (id: string, start: number, duration: number): GraphicsClip => ({
  id,
  kind: "graphics",
  start,
  duration,
  layer: "front",
  capability: { id: "graphics.title-card", version: "1.0.0", params: { title: id, align: "center", scrim: true } },
  provenance: { by: "user", changeSetId: "cs-0" },
});

function production(): Production {
  const p = newEditProduction({ id: "p1", name: "Keys", at: "2026-01-01T00:00:00.000Z" });
  const titles = p.timeline.tracks.find((t) => t.id === STUDIO_TRACKS.titles)!;
  (titles.clips as GraphicsClip[]) = [title("a", 0, 60), title("b", 90, 30)];
  return p;
}

describe("the timeline's keys", () => {
  it("moves by a frame, or a second with Shift", () => {
    expect(keyCommand(press("ArrowLeft", "ArrowLeft"))).toEqual({ kind: "move", direction: -1, by: "frame" });
    expect(keyCommand(press("ArrowRight", "ArrowRight", { shiftKey: true }))).toEqual({ kind: "move", direction: 1, by: "second" });
  });

  it("trims the start with [ and ] and the end with , and ., by physical key", () => {
    expect(keyCommand(press("[", "BracketLeft"))).toEqual({ kind: "trim", edge: "in", direction: -1, by: "frame" });
    expect(keyCommand(press("}", "BracketRight", { shiftKey: true }))).toEqual({ kind: "trim", edge: "in", direction: 1, by: "second" });
    expect(keyCommand(press("<", "Comma", { shiftKey: true }))).toEqual({ kind: "trim", edge: "out", direction: -1, by: "second" });
    expect(keyCommand(press(".", "Period"))).toEqual({ kind: "trim", edge: "out", direction: 1, by: "frame" });
  });

  it("reorders with Alt and the arrows, splits with S, deletes, selects and deselects", () => {
    expect(keyCommand(press("ArrowLeft", "ArrowLeft", { altKey: true }))).toEqual({ kind: "reorder", direction: "earlier" });
    expect(keyCommand(press("ArrowRight", "ArrowRight", { altKey: true }))).toEqual({ kind: "reorder", direction: "later" });
    expect(keyCommand(press("s", "KeyS"))).toEqual({ kind: "split" });
    expect(keyCommand(press("Delete", "Delete"))).toEqual({ kind: "delete" });
    expect(keyCommand(press("Backspace", "Backspace"))).toEqual({ kind: "delete" });
    expect(keyCommand(press("Enter", "Enter"))).toEqual({ kind: "select" });
    expect(keyCommand(press("Escape", "Escape"))).toEqual({ kind: "deselect" });
  });

  it("leaves Space, Tab and every Cmd or Ctrl shortcut to the workspace and the browser", () => {
    expect(keyCommand(press(" ", "Space"))).toBeNull();
    expect(keyCommand(press("Tab", "Tab"))).toBeNull();
    expect(keyCommand(press("z", "KeyZ", { metaKey: true }))).toBeNull();
    expect(keyCommand(press("z", "KeyZ", { ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(keyCommand(press("y", "KeyY", { ctrlKey: true }))).toBeNull();
    expect(keyCommand(press("ArrowLeft", "ArrowLeft", { metaKey: true }))).toBeNull();
    expect(keyCommand(press("s", "KeyS", { metaKey: true }))).toBeNull();
    expect(keyCommand(press("S", "KeyS", { shiftKey: true }))).toBeNull();
    expect(keyCommand(press("[", "BracketLeft", { altKey: true }))).toBeNull();
  });

  it("turns each key into one edit, in frames, or nothing", () => {
    const p = production();
    const at = { playheadFrame: 30 };
    expect(commandEdit(p, "b", { kind: "move", direction: -1, by: "frame" }, at)!.ops).toEqual([{ op: "moveClip", clipId: "b", start: 89 }]);
    expect(commandEdit(p, "b", { kind: "move", direction: -1, by: "second" }, at)!.ops).toEqual([{ op: "moveClip", clipId: "b", start: 60 }]);
    // Against the neighbour and at the timeline start, nothing moves.
    expect(commandEdit(p, "a", { kind: "move", direction: -1, by: "frame" }, at)).toBeNull();
    expect(commandEdit(p, "a", { kind: "move", direction: 1, by: "second" }, at)!.ops).toEqual([{ op: "moveClip", clipId: "a", start: 30 }]);
    expect(commandEdit(p, "b", { kind: "trim", edge: "out", direction: 1, by: "second" }, at)!.ops).toEqual([{ op: "trimClip", clipId: "b", edge: "out", toFrame: 150 }]);
    expect(commandEdit(p, "b", { kind: "trim", edge: "in", direction: -1, by: "second" }, at)!.ops).toEqual([{ op: "trimClip", clipId: "b", edge: "in", toFrame: 60 }]);
    expect(commandEdit(p, "a", { kind: "split" }, at)!.ops).toEqual([{ op: "splitClip", clipId: "a", atFrame: 30, newClipId: "a-2" }]);
    expect(commandEdit(p, "b", { kind: "split" }, at)).toBeNull(); // the playhead is not inside it
    expect(commandEdit(p, "a", { kind: "reorder", direction: "later" }, at)!.ops).toHaveLength(2);
    expect(commandEdit(p, "a", { kind: "delete" }, at)!.ops).toEqual([{ op: "removeClip", clipId: "a", ripple: false }]);
    expect(commandEdit(p, "a", { kind: "select" }, at)).toBeNull();
    expect(commandEdit(p, "missing", { kind: "delete" }, at)).toBeNull();
  });

  it("lists every key it answers to in the help", () => {
    const listed = KEYBOARD_HELP.flatMap((row) => row.keys).join(" ");
    for (const k of ["←", "→", "[", "]", ",", ".", "S", "Delete", "Enter", "Esc", "Alt", "Shift", "Space"]) expect(listed).toContain(k);
  });
});
