import { spawn } from "node:child_process";
import { resolveBrandForCarousel } from "@/lib/brand";
import { getCarousel } from "@/lib/carousels";
import { buildSystemPrompt } from "@/lib/chat-system-prompt";
import { designAgentArgs, type DesignAgentSettings } from "@/lib/design-agent";
import { resolveReferenceImages } from "@/lib/reference-images";
import { pinnedCliOrNull } from "./cli";
import { ROOT } from "./server";
import { modelsFromResult, usageFromCli, type TokenUsage } from "./usage";

/**
 * The comparison arm: the Design Agent alone, exactly as the product ran it
 * before the creative run existed. Same system prompt builder, same CLI
 * arguments, same working directory, the user's message as the whole task
 * and no visual plan. It writes slides through the running app's API, just
 * as the chat route's agent does.
 */


export interface BaselineResult {
  ok: boolean;
  durationMs: number;
  costUsd: number | null;
  /** Model token usage, turns and models from the CLI's result event. */
  usage: TokenUsage | null;
  turns: number | null;
  models: string[];
  subtype: string | null;
  resultText: string | null;
  /**
   * The CLI session this run was, from its result event or, when the run was
   * stopped before one, from the `system` init event that opens every
   * session: the session version reader finds its transcript by it (#232), so
   * a stopped run is version-checked too. Null when the CLI reported none.
   */
  sessionId: string | null;
  /** `timed out` (the deadline), `stalled` (the inactivity limit), an exit code or a start error; null for a clean exit. */
  error: string | null;
}

/**
 * The CLI the Design-Agent-only arm spawns: the harness's checked, pinned one
 * (cli.ts), the same real path the servers and the judge get (#232). Null
 * when none is pinned, which the pin check refuses.
 */
export function designAgentOnlyCliPath(): string | null {
  return pinnedCliOrNull();
}

/**
 * Why the Design-Agent-only arm's exported set is not judged, or null when it
 * is: the arm did not complete (it timed out, stalled or failed), so its set
 * is an unfinished design, and scoring it or comparing it with a finished one
 * would measure the stop. The arm ran, so it is still charged.
 */
export function notJudgedReason(baseline: Pick<BaselineResult, "ok" | "error" | "subtype">): string | null {
  if (baseline.ok) return null;
  return `the Design-Agent-only arm did not complete (${baseline.error ?? baseline.subtype ?? "no result"}), so its set is neither scored nor compared`;
}

/** The Design Agent's settings once the product accepted them. */
export type ValidDesignAgentSettings = Extract<DesignAgentSettings, { ok: true }>;

/** The product's force-kill grace after it stops a run that ignores the first stop. */
const FORCE_KILL_AFTER_MS = 5_000;

/**
 * Runs the Design Agent's CLI as the chat route does and reads its result
 * (#232): the absolute deadline and the inactivity limit are the chat route's,
 * from the same settings the servers see; output on the standard output resets
 * the inactivity limit and never moves the deadline; the first limit to fire is
 * the only one, stops the CLI and kills it outright if it ignores the stop.
 */
export function runArmProcess(options: {
  cliPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  settings: Pick<ValidDesignAgentSettings, "timeoutMs" | "inactivityMs">;
  /** How long a CLI that ignores the stop is left before it is killed outright. */
  forceKillAfterMs?: number;
}): Promise<BaselineResult> {
  const { settings } = options;
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(options.cliPath, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    let buffer = "";
    let final: Record<string, unknown> | null = null;
    let initSessionId: string | null = null;
    let limit: "deadline" | "inactivity" | null = null;
    let exited = false;
    let forceKill: NodeJS.Timeout | null = null;
    let quiet: NodeJS.Timeout | null = null;
    const clearLimits = () => {
      clearTimeout(deadline);
      if (quiet) clearTimeout(quiet);
      quiet = null;
    };
    const stopFor = (which: "deadline" | "inactivity") => {
      if (limit || exited) return;
      limit = which;
      clearLimits();
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), options.forceKillAfterMs ?? FORCE_KILL_AFTER_MS);
    };
    const deadline = setTimeout(() => stopFor("deadline"), settings.timeoutMs);
    const watchOutput = () => {
      if (settings.inactivityMs === null || limit || exited) return;
      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(() => stopFor("inactivity"), settings.inactivityMs);
    };
    watchOutput();
    child.stdout.on("data", (chunk: Buffer) => {
      if (!limit) watchOutput();
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type === "result") final = parsed;
          else if (parsed?.type === "system" && parsed.subtype === "init" && typeof parsed.session_id === "string") initSessionId = parsed.session_id;
        } catch {
          // Non-JSON output is ignored, as the route does.
        }
      }
    });
    child.stderr.on("data", () => {});
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      exited = true;
      clearLimits();
      if (forceKill) clearTimeout(forceKill);
      const f = final as Record<string, unknown> | null;
      resolve({
        ok: !error && !!f && !f.is_error,
        durationMs: Date.now() - started,
        costUsd: typeof f?.total_cost_usd === "number" ? f.total_cost_usd : null,
        usage: usageFromCli(f?.usage),
        turns: typeof f?.num_turns === "number" ? f.num_turns : null,
        models: modelsFromResult(f),
        subtype: typeof f?.subtype === "string" ? f.subtype : null,
        resultText: typeof f?.result === "string" ? f.result.slice(0, 4000) : null,
        sessionId: typeof f?.session_id === "string" ? f.session_id : initSessionId,
        error,
      });
    };
    child.on("error", (err) => finish(err.message));
    child.on("close", (code) => finish(limit === "deadline" ? "timed out" : limit === "inactivity" ? "stalled" : code === 0 ? null : `exit ${code}`));
  });
}

/**
 * The Design Agent alone on a fresh carousel. `cliPath`, `env` and `settings`
 * are the ones a server gives its Design Agent: the pinned CLI's real path,
 * the environment Next.js leaves in a server (the checkout's `.env` files
 * under the harness's), and the product's reading of it, so the two arms
 * differ only in what they are meant to differ in (#232).
 */
export async function runDesignAgentOnly(options: {
  origin: string;
  carouselId: string;
  message: string;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  settings: ValidDesignAgentSettings;
}): Promise<BaselineResult> {
  if (process.cwd() !== ROOT) throw new Error(`Run the harness from ${ROOT} so storage reads the server's data`);
  const carousel = await getCarousel(options.carouselId);
  if (!carousel) throw new Error(`Carousel ${options.carouselId} not found`);
  const brand = await resolveBrandForCarousel(carousel);
  const systemPrompt = buildSystemPrompt({
    baseUrl: options.origin,
    brand,
    carousel: { ...carousel, referenceImages: await resolveReferenceImages(carousel) },
    stylePreset: null,
  });
  const { settings } = options;
  // The paid-run preflight requires an explicit cap; never run this arm without one.
  if (settings.budgetUsd === null) throw new Error("DESIGN_AGENT_MAX_BUDGET_USD must be set for the Design-Agent-only arm");
  const args = designAgentArgs({
    taskMessage: options.message,
    systemPrompt,
    resumeSessionId: null,
    // The same cap the chat route reads, from the same setting.
    budgetUsd: settings.budgetUsd,
  });
  return runArmProcess({ cliPath: options.cliPath, args, env: options.env, cwd: ROOT, settings });
}
