/**
 * The Production v2 change-set engine (WS1 #114): typed operations, one
 * atomic admission funnel, revision checks, in-memory history and agent runs.
 * Pure: no file system, network or model access.
 */

export { applyChangeSet, commit } from "./engine";
export type { ApplyOptions, OpenRun } from "./engine";
export { applyToHistory, beginRun, createHistory, endRun, labelRevision, MAX_HISTORY_STEPS, redo, restoreLabel, undo } from "./history";
export type { ActiveRun, HistoryOutcome, HistoryResult, HistoryStep, ProductionHistory } from "./history";
export { MAX_OPS_PER_CHANGE_SET, OP_NAMES, SCENE_PATCH_FIELDS, validateChangeSet } from "./validate";
export { SCENE_TRANSITIONS } from "./apply";
export type * from "./types";
