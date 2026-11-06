/**
 * The Studio timeline's keyboard (#150, G7): what each key does to the
 * focused clip, and the edit it commits. Every key press is at most one
 * change set.
 *
 * Keys leave the workspace's own shortcuts alone: Space (play and pause) is
 * never handled here, and nothing with Cmd or Ctrl held is, so Cmd/Ctrl+Z,
 * Shift+Cmd/Ctrl+Z and Cmd/Ctrl+Y still reach undo and redo. Trim keys are
 * matched by physical key (`code`) so Shift, which turns `[` into `{` and
 * `,` into `<` on a US layout, only changes the step.
 */
import type { Production } from "@/types/production";
import { findClip, planNudge, planRemove, planReorder, planSplit, planTrimNudge, type Edge, type Edit } from "./edits";

export type TimelineCommand =
  | { kind: "move"; direction: -1 | 1; by: "frame" | "second" }
  | { kind: "trim"; edge: Edge; direction: -1 | 1; by: "frame" | "second" }
  | { kind: "reorder"; direction: "earlier" | "later" }
  | { kind: "split" }
  | { kind: "delete" }
  | { kind: "select" }
  | { kind: "deselect" };

export interface KeyInput {
  key: string;
  code: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/** The command a key press on a focused clip means, or null to let it through. */
export function keyCommand(e: KeyInput): TimelineCommand | null {
  if (e.metaKey || e.ctrlKey) return null;
  const by = e.shiftKey ? "second" : "frame";
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const direction = e.key === "ArrowLeft" ? -1 : 1;
    if (e.altKey) return e.shiftKey ? null : { kind: "reorder", direction: direction < 0 ? "earlier" : "later" };
    return { kind: "move", direction, by };
  }
  if (e.altKey) return null;
  switch (e.code) {
    case "BracketLeft":
      return { kind: "trim", edge: "in", direction: -1, by };
    case "BracketRight":
      return { kind: "trim", edge: "in", direction: 1, by };
    case "Comma":
      return { kind: "trim", edge: "out", direction: -1, by };
    case "Period":
      return { kind: "trim", edge: "out", direction: 1, by };
    case "KeyS":
      return e.shiftKey ? null : { kind: "split" };
  }
  if (e.shiftKey) return null;
  if (e.key === "Delete" || e.key === "Backspace") return { kind: "delete" };
  if (e.key === "Enter") return { kind: "select" };
  if (e.key === "Escape") return { kind: "deselect" };
  return null;
}

/** The edit a command commits on `clipId`, or null when it changes nothing (or only the selection). */
export function commandEdit(
  production: Production,
  clipId: string,
  command: TimelineCommand,
  context: { playheadFrame: number; mediaDurationUs?: number }
): Edit | null {
  if (!findClip(production, clipId)) return null;
  const step = (by: "frame" | "second") => (by === "second" ? production.format.fps : 1);
  switch (command.kind) {
    case "move":
      return planNudge(production, clipId, command.direction * step(command.by));
    case "trim":
      return planTrimNudge(production, clipId, command.edge, command.direction * step(command.by), context.mediaDurationUs);
    case "reorder":
      return planReorder(production, clipId, command.direction);
    case "split":
      return planSplit(production, clipId, context.playheadFrame);
    case "delete":
      return planRemove(production, clipId);
    default:
      return null;
  }
}

/** The keys, as the Keyboard help lists them. */
export const KEYBOARD_HELP: { keys: string[]; action: string }[] = [
  { keys: ["Tab"], action: "Go to the next clip" },
  { keys: ["Enter"], action: "Select the focused clip" },
  { keys: ["Esc"], action: "Clear the selection" },
  { keys: ["←", "→"], action: "Move one frame" },
  { keys: ["Shift", "←/→"], action: "Move one second" },
  { keys: ["[", "]"], action: "Trim the start one frame earlier or later" },
  { keys: [",", "."], action: "Trim the end one frame earlier or later" },
  { keys: ["Shift", "[ ] , ."], action: "Trim by one second" },
  { keys: ["Alt", "←/→"], action: "Swap with the clip before or after" },
  { keys: ["S"], action: "Split at the playhead" },
  { keys: ["Delete"], action: "Delete the clip" },
  { keys: ["Space"], action: "Play or pause" },
];
