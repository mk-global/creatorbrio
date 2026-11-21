import { IMAGE_STAGE_MS } from "@/lib/creative-run";
import {
  DESIGN_AGENT_INACTIVITY_ENV,
  DESIGN_AGENT_TIMEOUT_ENV,
  MAX_DESIGN_AGENT_TIMEOUT_SECONDS,
  designAgentSettings,
  type DesignAgentSettings,
} from "@/lib/design-agent";
import { DEFAULT_LIMITS as SOURCE_LIMITS } from "@/lib/source-retrieval";
import { DIRECTOR_TIMEOUT_MS } from "@/lib/visual-director";
import type { Calls } from "./budget";
import type { CliPin } from "./cli";
import type { DesignLimitsRecord } from "./environment";
import { OBSERVE_BUSY_MS } from "./image-service";
import { JUDGE_TIMEOUT_MS } from "./judge";
import type { Scenario } from "./scenarios";
import { READY_TIMEOUT_MS, STOP_GRACE_MS } from "./server";
import { printableMessage, serverSetting, type LoadedServerEnv, type ServerEnvFiles } from "./server-env";

/**
 * The time limits the harness derives from the product's and its own (#232),
 * so that only the product's limits stop a design: the Design Agent's
 * effective deadline and inactivity limit as the servers and the
 * Design-Agent-only arm see them, how long the chat request may stay quiet,
 * and how long each plan item's test may run.
 */

/** How much longer than the largest stage limit the chat stream may stay quiet: time for the server to stop the agent and finish the stream. */
export const CHAT_TIMEOUT_MARGIN_MS = 5 * 60 * 1000;

/** What a stop is allowed on top of its limit: the product's force-kill grace is 5 s. */
export const STOP_ALLOWANCE_MS = 10_000;

/**
 * Allowed per plan item for what has no limit of its own: the PNG export,
 * copying the slides for the judges, waiting for a run to go idle, and the
 * checks.
 */
export const ITEM_MARGIN_MS = 10 * 60 * 1000;

/** The longest a Node timer can wait. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** A setting's source as a label, naming an empty one: an empty value is a defined one in Next.js, and means the product's default. */
function sourceOf(name: string, setting: { value: string; source: string } | null): string {
  if (!setting) return "the product's default";
  return setting.value.trim() === "" ? `the product's default (${name} is empty in ${setting.source})` : `${name} from ${setting.source}`;
}

export interface DesignAgentLimits extends DesignLimitsRecord {
  /** The product accepts all the Design Agent's settings (cap, deadline, inactivity limit) as the servers see them. */
  ok: boolean;
  /** The product's code for what it refuses, when it does. */
  problem: string | null;
}

/**
 * The Design Agent's effective settings as a server the harness starts sees
 * them: the product's own reading (`designAgentSettings`) of the environment
 * Next.js's loader leaves it, the harness's environment with the checkout's
 * `.env` files under it (`loadServerEnv`). When the product refuses a setting,
 * every design would be refused too, so the limits fall back to the product's
 * maximum deadline and no inactivity limit, only to size what a refused plan
 * would have needed.
 */
export function designAgentLimits(loaded: Pick<LoadedServerEnv, "env" | "fileOf">): DesignAgentLimits {
  const settings = designAgentSettings(loaded.env);
  const timeoutSource = sourceOf(DESIGN_AGENT_TIMEOUT_ENV, serverSetting(loaded, DESIGN_AGENT_TIMEOUT_ENV));
  const inactivitySource = sourceOf(DESIGN_AGENT_INACTIVITY_ENV, serverSetting(loaded, DESIGN_AGENT_INACTIVITY_ENV));
  if (settings.ok) return { ok: true, problem: null, timeoutMs: settings.timeoutMs, timeoutSource, inactivityMs: settings.inactivityMs, inactivitySource };
  return {
    ok: false,
    problem: settings.code,
    timeoutMs: MAX_DESIGN_AGENT_TIMEOUT_SECONDS * 1000,
    timeoutSource: `${timeoutSource}; refused (${settings.code}), so the product's maximum is used`,
    inactivityMs: null,
    inactivitySource,
  };
}

/**
 * What the Design-Agent-only arm runs under (#232): the environment the loader
 * leaves a server, so the arm's CLI sees the harness's environment and the
 * `.env` files' variables as a server's Design Agent does, the product's
 * reading of it, and the limits it implies, which are the servers' own. It
 * does not see what Next.js itself adds to a running server
 * (`NEXT_ADDED_TO_SERVER`, server-env.ts: the names found in a started
 * `next start` server, and `__NEXT_PROCESSED_ENV`, which the loader sets).
 */
export function designAgentOnlyRun(loaded: Pick<LoadedServerEnv, "env" | "fileOf">): {
  env: NodeJS.ProcessEnv;
  settings: DesignAgentSettings;
  limits: DesignLimitsRecord;
} {
  const { timeoutMs, timeoutSource, inactivityMs, inactivitySource } = designAgentLimits(loaded);
  return { env: loaded.env, settings: designAgentSettings(loaded.env), limits: { timeoutMs, timeoutSource, inactivityMs, inactivitySource } };
}

/**
 * Why a paid dev-mode run is refused: `next dev` reloads the checkout's `.env`
 * files into a server that is already running, so an edit made mid-run would
 * reach later model calls before the next re-check, while `next start` reads
 * them once, at start. A dry run in dev mode still prints the plan.
 */
export const DEV_MODE_REFUSAL =
  "Refusing a paid run before any spend: EVAL_MODE=dev runs the servers under `next dev`, which reloads the checkout's .env files into a server that is already running, so an edit made during the run would reach later model calls before the next check. Build the checkout and run without EVAL_MODE, so each server reads its .env files once, when it starts. A dry run in dev mode prints the plan.";

/**
 * Why a paid run is refused before the ledger reservation, so before any
 * spend (#232), or null: the servers would run under `next dev`, the CLI is not
 * pinned (servers, arm and judge on one explicitly named CLI), the servers'
 * `.env` files add a variable that is not allowed, the harness's own
 * environment sets one of the four refused token or effort names, the product
 * does not accept the Design Agent's settings, or the checkout is not a
 * worktree the servers may use (`worktree`, from `worktreeRefusal`). A dry run
 * prints the same reasons instead, the worktree's included.
 */
export function refusalBeforeSpend(checks: {
  mode: "prod" | "dev";
  pin: CliPin;
  envFiles: ServerEnvFiles;
  /** The refusal for a token or effort limit in the harness's own environment (harness-env.ts), or null. */
  harnessRefusal: string | null;
  limits: DesignAgentLimits;
  armSettings: DesignAgentSettings;
  /** Why the checkout is refused as the place to run servers (environment.ts `worktreeRefusal`), or null. */
  worktree?: string | null;
}, options: { printable?: boolean } = {}): string | null {
  if (checks.mode === "dev") return DEV_MODE_REFUSAL;
  if (!checks.pin.ok) return checks.pin.message;
  // `printable`: the text of a dry run, which names no `.env` variable that is not on the allowlist (a paid run's refusal, for the operator's own terminal, names them).
  if (!checks.envFiles.ok) return options.printable ? printableMessage(checks.envFiles) : checks.envFiles.message;
  if (checks.harnessRefusal) return checks.harnessRefusal;
  if (!checks.limits.ok || !checks.armSettings.ok) {
    const problem = checks.limits.problem ?? (checks.armSettings.ok ? "unknown" : checks.armSettings.code);
    return `Refusing a paid run before any spend: the product does not accept the Design Agent settings the servers would load (${problem}), so every design would be refused. Correct DESIGN_AGENT_MAX_BUDGET_USD, DESIGN_AGENT_TIMEOUT_SECONDS or DESIGN_AGENT_INACTIVITY_SECONDS in the harness's environment or the .env files.`;
  }
  // The servers share this checkout's data/ folder: never run against a primary worktree's live data.
  return checks.worktree ?? null;
}

/** The time limit of each stage a plan item can pass through, from the product's constants and the effective settings. */
export interface StageLimits {
  serverReadyMs: number;
  /** One wait for the image service to admit work (`EVAL_ADMISSION_WAIT_MS`). */
  admissionWaitMs: number;
  /** One observation of whether the service finishes a job a stop left behind. */
  observeMs: number;
  directorMs: number;
  /** Reading linked pages, before the Director plans. */
  sourcesMs: number;
  /** The whole image stage of one run. */
  imageStageMs: number;
  /** The Design Agent's deadline as the servers see it. */
  designMs: number;
  /** The Design-Agent-only arm's deadline: the same. */
  designArmMs: number;
  judgeMs: number;
  /** What a stop is allowed on top of its limit. */
  stopMs: number;
  /** What has no limit of its own, per item. */
  marginMs: number;
}

export function stageLimits(options: { designMs: number; designArmMs: number; admissionWaitMs: number }): StageLimits {
  return {
    serverReadyMs: READY_TIMEOUT_MS + 2 * STOP_GRACE_MS,
    admissionWaitMs: options.admissionWaitMs,
    observeMs: OBSERVE_BUSY_MS,
    directorMs: DIRECTOR_TIMEOUT_MS,
    sourcesMs: SOURCE_LIMITS.stageMs,
    imageStageMs: IMAGE_STAGE_MS,
    designMs: options.designMs,
    designArmMs: options.designArmMs,
    judgeMs: JUDGE_TIMEOUT_MS,
    stopMs: STOP_ALLOWANCE_MS,
    marginMs: ITEM_MARGIN_MS,
  };
}

/**
 * The largest limit of any stage in which the chat stream may be quiet: the
 * Director (with the page reading before it), the image stage and the Design
 * Agent. The chat request waits that long, and a margin, for the next byte.
 */
export const largestStageMs = (l: Pick<StageLimits, "directorMs" | "sourcesMs" | "imageStageMs" | "designMs">): number =>
  Math.max(l.directorMs + l.sourcesMs, l.imageStageMs, l.designMs);

/** How long the chat request may wait for its headers or between two chunks of the stream. */
export function chatTimeoutMs(longestStageMs: number): number {
  return longestStageMs + CHAT_TIMEOUT_MARGIN_MS;
}

/** The longest any stage can be under the product's own bounds: the default for a client that is not told the settings. */
export const LONGEST_POSSIBLE_STAGE_MS = largestStageMs({
  directorMs: DIRECTOR_TIMEOUT_MS,
  sourcesMs: SOURCE_LIMITS.stageMs,
  imageStageMs: IMAGE_STAGE_MS,
  designMs: MAX_DESIGN_AGENT_TIMEOUT_SECONDS * 1000,
});

/**
 * What a scenario's driver does, counted for its worst case: server starts
 * (a restart starts twice), waits for the image service (one for its retry,
 * or for the cooldown after a stop), image stages (the run and its retry),
 * and observations of the service after a stop.
 */
const PROFILES: Record<Scenario["kind"], { starts: number; admissions: number; imageStages: number; observations: number }> = {
  integration: { starts: 1, admissions: 1, imageStages: 2, observations: 0 },
  revision: { starts: 1, admissions: 1, imageStages: 2, observations: 0 },
  "image-service-unavailable": { starts: 1, admissions: 0, imageStages: 0, observations: 0 },
  cancel: { starts: 1, admissions: 1, imageStages: 1, observations: 1 },
  "restart-retry": { starts: 2, admissions: 1, imageStages: 2, observations: 1 },
};

export interface ItemShape {
  kind: Scenario["kind"];
  needsImages: boolean;
  /** The run's model calls. */
  calls: Calls;
  /** The Design-Agent-only arm and its judges, when compared. */
  comparison: Calls | null;
}

export interface ItemDuration {
  /** The sum of every part: the item's test timeout. */
  ms: number;
  parts: { name: string; ms: number }[];
}

/**
 * The longest a plan item can take if every stage runs to its limit: the sum
 * of its stage limits plus a margin. It is the item's Vitest timeout, so the
 * test never ends before the product's own limits would have stopped each
 * stage (#232). An item that needs more than a Node timer can wait is refused.
 */
export function itemWorstCase(item: ItemShape, limits: StageLimits): ItemDuration {
  const profile = PROFILES[item.kind];
  const admissions = profile.admissions + (item.needsImages ? 1 : 0);
  const starts = profile.starts + (item.comparison ? 1 : 0);
  const parts = [
    { name: "server start", ms: starts * limits.serverReadyMs },
    { name: "waits for the image service", ms: admissions * limits.admissionWaitMs },
    { name: "observing the image service", ms: profile.observations * limits.observeMs },
    { name: "Director", ms: item.calls.director * (limits.directorMs + limits.sourcesMs + limits.stopMs) },
    { name: "image stage", ms: profile.imageStages * limits.imageStageMs },
    { name: "Design Agent", ms: item.calls.design * (limits.designMs + limits.stopMs) },
    { name: "judges", ms: item.calls.judge * limits.judgeMs },
    { name: "Design-Agent-only arm", ms: (item.comparison?.design ?? 0) * (limits.designArmMs + limits.stopMs) },
    { name: "comparison judges", ms: (item.comparison?.judge ?? 0) * limits.judgeMs },
    { name: "export, checks and waits without a limit of their own", ms: limits.marginMs },
  ].filter((p) => p.ms > 0);
  const ms = parts.reduce((a, p) => a + p.ms, 0);
  if (ms > MAX_TIMER_MS) throw new Error(`An item that could take ${formatDuration(ms)} cannot be given a test timeout: Node timers wait at most ${formatDuration(MAX_TIMER_MS)}`);
  return { ms, parts };
}

/** `2 h 10 min`, rounded up to the minute. */
export function formatDuration(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  const h = Math.floor(minutes / 60);
  return h > 0 ? `${h} h ${minutes % 60} min` : `${minutes} min`;
}
