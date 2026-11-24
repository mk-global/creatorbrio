import type { ChildProcess } from "node:child_process";
import crossSpawn from "cross-spawn";
import { getClaudePath } from "./claude-path";

/**
 * One stateless Claude CLI call that returns structured output: the launch
 * the Visual Director has always used, shared with research synthesis (#252)
 * so both keep the same isolation instead of two copies of it.
 *
 * - its only tools are Read and the structured-output channel; Read is
 *   path-scoped to a per-call working directory outside the repository.
 *   Research's web search (#256) instead has Claude Code's built-in web
 *   search as its only tool, and no Read: it returns page addresses, which
 *   the server then reads itself;
 * - no setting sources, a strict empty MCP configuration and automatic memory
 *   off, so no user-level instruction file, connector or memory reaches it;
 * - no session persistence and never `--resume`;
 * - its input arrives on stdin, never in the process arguments;
 * - a mandatory timeout, and an optional spending cap.
 *
 * These are the CLI's permission rules, a policy boundary rather than
 * operating-system isolation: the CLI runs as the same account as the app.
 */

export const STRUCTURED_TOOLS = ["Read"] as const;
/** Claude Code's built-in web search tool, the only tool of research's web-search call (#256). */
export const WEB_SEARCH_TOOL = "WebSearch";
/** How long a cancelled or timed-out call gets to exit before it is killed. */
const KILL_GRACE_MS = 5_000;
/** The CLI's JSON result is small; anything past this is not a result. */
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

/** The CLI arguments for one structured call; callers pin them in tests. */
export function structuredClaudeArgs(
  workDir: string,
  options: { systemPrompt: string; schema: unknown; budgetUsd: number | null; tools?: "read" | "web-search" }
): string[] {
  const tools =
    options.tools === "web-search"
      ? // The web search tool takes no permission specifier: a bare name is its only rule form.
        ["--tools", WEB_SEARCH_TOOL, "--allowedTools", WEB_SEARCH_TOOL]
      : // The leading slash plus an absolute path is the CLI's absolute-path form.
        ["--tools", ...STRUCTURED_TOOLS, "--allowedTools", `Read(/${workDir}/**)`];
  return [
    "-p",
    "--output-format",
    "json",
    "--system-prompt",
    options.systemPrompt,
    ...tools,
    "--json-schema",
    JSON.stringify(options.schema),
    "--no-session-persistence",
    ...(options.budgetUsd === null ? [] : ["--max-budget-usd", String(options.budgetUsd)]),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--settings",
    JSON.stringify({ autoMemoryEnabled: false }),
  ];
}

export interface StructuredCliOutcome {
  exitCode: number | null;
  stdout: string;
  timedOut: boolean;
  cancelled: boolean;
  startError: boolean;
}

/** Runs the CLI once with `input` on stdin; never throws. Stderr is dropped: it can echo the input. */
export function runStructuredClaude(
  args: string[],
  cwd: string,
  input: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<StructuredCliOutcome> {
  return new Promise<StructuredCliOutcome>((resolve) => {
    let child: ChildProcess;
    try {
      child = crossSpawn(getClaudePath(), args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch {
      resolve({ exitCode: null, stdout: "", timedOut: false, cancelled: false, startError: true });
      return;
    }
    let stdout = "";
    let bytes = 0;
    let timedOut = false;
    let cancelled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= MAX_STDOUT_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", () => {});
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout: "", timedOut, cancelled, startError: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: code, stdout, timedOut, cancelled, startError: false });
    });
  });
}

export interface StructuredCliResult {
  subtype?: string;
  is_error?: boolean;
  structured_output?: unknown;
  total_cost_usd?: number;
  num_turns?: number;
  permission_denials?: unknown[];
  /** Usage per model; research's web search reads each model's `webSearchRequests` (#256). Untrusted shape. */
  modelUsage?: unknown;
}

export function parseStructuredResult(stdout: string): StructuredCliResult | null {
  try {
    const parsed = JSON.parse(stdout.trim());
    return parsed && typeof parsed === "object" ? (parsed as StructuredCliResult) : null;
  } catch {
    return null;
  }
}
