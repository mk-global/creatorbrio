/**
 * What the run can and cannot say about its own spend (#225). The subject holds
 * the model token, so it could start model calls of its own; the egress proxy
 * counts every model API connection per phase and refuses beyond a budget, and
 * this module turns what the proxy, the app's request capture and the process
 * sweeps saw into flags. A flag does not change the charge (every started
 * message is already charged at its full limit); it marks the settlement as
 * possibly incomplete, for the founder to review.
 */
import type { Window } from "./judge";
import type { Observation, ProxyLine } from "./observations";
import type { AppRequest } from "./pcap";
import { judgeCliRuns, type AppServer, type CliRun, type ProcRecord } from "./procs";
import { sweepReasons, type SweepRecord } from "./sweep";

/** The model API connections the preflight makes on purpose: one `CONNECT api.anthropic.com:443`. */
export const PREFLIGHT_MODEL_CONNECTIONS = 1;

/** How far above the plan a phase may go before the proxy stops it: the plan only flags a settlement, the ceiling cuts a session off, so it sits far above anything a long legitimate Design Agent session does. */
export const CEILING_MULTIPLE = 10;
/** Bytes through the tunnels of one planned call, and of headroom, in each direction together: a stated plan, calibrated by the first paid run. */
export const BYTES_PER_CALL = 64 * 1024 * 1024;
export const BYTES_HEADROOM = 64 * 1024 * 1024;
/** The byte ceiling is this multiple of the byte plan. */
export const BYTES_CEILING_MULTIPLE = 8;

/**
 * The conversion from dollars to bytes the byte plan is derived with. Both numbers are named, overridable (`T1_INPUT_USD_PER_MTOK`, `T1_BYTES_PER_TOKEN`) and recorded in `results.json`; nothing here is a
 * quoted price. The defaults are an assumption, chosen to flag too much rather than too little: the price is a high uncached input price per million tokens (so the caps buy few tokens, hence few bytes),
 * and four bytes carry a token of text.
 */
export interface BytePricing {
  inputUsdPerMTok: number;
  bytesPerToken: number;
}
export const DEFAULT_PRICING: BytePricing = { inputUsdPerMTok: 15, bytesPerToken: 4 };

/** The pricing assumption from the environment, validated; the defaults when unset. */
export function pricingFrom(env: Record<string, string | undefined> = process.env): BytePricing {
  const num = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number, not ${JSON.stringify(raw)}`);
    return v;
  };
  return { inputUsdPerMTok: num("T1_INPUT_USD_PER_MTOK", DEFAULT_PRICING.inputUsdPerMTok), bytesPerToken: num("T1_BYTES_PER_TOKEN", DEFAULT_PRICING.bytesPerToken) };
}

/** The bytes a dollar amount could buy at the assumed price: dollars over the price per token, times bytes per token. */
export const bytesForUsd = (usd: number, p: BytePricing): number => Math.ceil((usd / p.inputUsdPerMTok) * 1_000_000 * p.bytesPerToken);

export interface ModelConnectionBudget {
  /** The plan: allowed model API connections by phase. More than this flags the settlement as possibly incomplete (founder review); a phase not listed has none. */
  perPhase: Record<string, number>;
  /** The ceiling: the proxy refuses a model connection once a phase has this many (`budget_exhausted`). Absent: the plan itself. */
  ceilingPerPhase?: Record<string, number>;
  /** The byte plan by model phase (up and down, all tunnels); more flags the settlement. */
  bytesPerPhase?: Record<string, number>;
  /** The byte ceiling by model phase: the proxy cuts the phase's tunnels and refuses new ones (`bytes_exhausted`). */
  bytesCeilingPerPhase?: Record<string, number>;
}

/**
 * The default budget. For each model phase the plan is ten connections for
 * every planned model call (the CLI opens a few over a session, and
 * reconnects) plus ten of headroom, and 64 MiB per call plus 64 MiB of bytes;
 * the ceilings are 10 times and 8 times that, so a long legitimate session is
 * never cut off and a runaway one still is. The preflight needs one connection
 * and keeps a ceiling equal to its plan.
 */
export function defaultBudget(callsPerPhase: number, modelPhases: string[], perCall = 10, headroom = 10, bytesPlan?: number): ModelConnectionBudget {
  const plan = callsPerPhase * perCall + headroom;
  const bytes = callsPerPhase * BYTES_PER_CALL + BYTES_HEADROOM;
  const only = <T>(v: (p: string) => T) => Object.fromEntries(modelPhases.map((p) => [p, v(p)]));
  return {
    perPhase: { preflight: PREFLIGHT_MODEL_CONNECTIONS + 1, ...only(() => plan) },
    ceilingPerPhase: { preflight: PREFLIGHT_MODEL_CONNECTIONS + 1, ...only(() => plan * CEILING_MULTIPLE) },
    // With the run's dollar caps the plan is what they could buy (`bytesForUsd`); the ceiling stays where it was, far above it, so a legitimate session is flagged for review but never cut off.
    bytesPerPhase: only(() => bytesPlan ?? bytes),
    bytesCeilingPerPhase: only(() => bytes * BYTES_CEILING_MULTIPLE),
  };
}

/** Sets a phase's connection plan for every model phase, keeping the ceiling at its multiple. */
export function withConnections(b: ModelConnectionBudget, modelPhases: string[], connections: number): ModelConnectionBudget {
  return {
    ...b,
    perPhase: { ...b.perPhase, ...Object.fromEntries(modelPhases.map((p) => [p, connections])) },
    ceilingPerPhase: { ...(b.ceilingPerPhase ?? {}), ...Object.fromEntries(modelPhases.map((p) => [p, connections * CEILING_MULTIPLE])) },
  };
}

/** The plan: more connections than this in a phase flags the settlement. */
export const budgetFor = (b: ModelConnectionBudget, phase: string) => b.perPhase[phase] ?? 0;
/** The most connections the proxy lets a phase have. */
export const ceilingFor = (b: ModelConnectionBudget, phase: string) => Math.max(budgetFor(b, phase), b.ceilingPerPhase?.[phase] ?? 0);
export const bytesFor = (b: ModelConnectionBudget, phase: string) => b.bytesPerPhase?.[phase] ?? 0;
export const bytesCeilingFor = (b: ModelConnectionBudget, phase: string) => Math.max(bytesFor(b, phase), b.bytesCeilingPerPhase?.[phase] ?? 0);

/**
 * The proxy's per-phase accounting: model connections allowed, bytes carried,
 * and whether a new model connection may open. Pure, with no clock, so the
 * service and the tests use the same rules.
 */
export class PhaseLedger {
  private readonly connections = new Map<string, number>();
  private readonly bytes = new Map<string, number>();
  private readonly budget: ModelConnectionBudget;

  constructor(budget: ModelConnectionBudget) {
    this.budget = budget;
  }

  /** Decides one new model connection in a phase, and counts it when allowed. */
  admit(phase: string): "allow" | "budget_exhausted" | "bytes_exhausted" {
    if ((this.bytes.get(phase) ?? 0) >= bytesCeilingFor(this.budget, phase) && bytesCeilingFor(this.budget, phase) > 0) return "bytes_exhausted";
    const used = this.connections.get(phase) ?? 0;
    if (used >= ceilingFor(this.budget, phase)) return "budget_exhausted";
    this.connections.set(phase, used + 1);
    return "allow";
  }

  /** Adds bytes carried by a tunnel opened in a phase; true once the phase is at its byte ceiling and its tunnels must be cut. */
  carried(phase: string, n: number): boolean {
    const total = (this.bytes.get(phase) ?? 0) + n;
    this.bytes.set(phase, total);
    const ceiling = bytesCeilingFor(this.budget, phase);
    return ceiling > 0 && total >= ceiling;
  }

  counts(phase: string) {
    return { connections: this.connections.get(phase) ?? 0, bytes: this.bytes.get(phase) ?? 0 };
  }
}

const windowAt = (at: number, windows: Window[]) => windows.find((w) => at >= w.start && at < w.end) ?? null;

const isAllowedModel = (l: ProxyLine) => l.decision === "allowed" && l.model;

/**
 * Allowed model connections in a window that is not a model window are the
 * subject's own activity, as observations (the preflight's one deliberate
 * connection is not). They fall in harness windows (stray) or in the control.
 */
export function modelWindowObservations(proxy: ProxyLine[], windows: Window[]): Observation[] {
  const out: Observation[] = [];
  const inPreflight: ProxyLine[] = [];
  for (const l of proxy) {
    if (!isAllowedModel(l)) continue;
    const w = windowAt(l.at, windows);
    if (w?.kind === "model") continue;
    if (w?.kind === "preflight") {
      inPreflight.push(l);
      continue;
    }
    out.push({ at: l.at, observer: "proxy", channel: "egress", actor: "subject", detail: `model API connection outside a model window (${w ? w.phase : "no window"})` });
  }
  for (const l of inPreflight.slice(PREFLIGHT_MODEL_CONNECTIONS)) out.push({ at: l.at, observer: "proxy", channel: "egress", actor: "subject", detail: "model API connection beyond the preflight's own" });
  return out;
}

export interface SpendIntegrity {
  /** True when anything below says spend may have gone beyond what the settlement charges. */
  possiblyIncomplete: boolean;
  flags: string[];
  /** Per model phase: the proxy's counts against the plan and ceiling, recorded so the first paid run can calibrate them. */
  modelConnections: { phase: string; allowed: number; refusedOverBudget: number; budget: number; ceiling: number; bytes: number; byteBudget: number; byteCeiling: number; longestTunnelMs: number; cutByCap: number }[];
  /** Every window's CONNECT counts (all targets), allowed and refused, as the proxy logged them. */
  connectsByWindow: { phase: string; kind: string; allowed: number; refused: number }[];
  /** Runs of the CLI binary (by path, signature or size, copies included): how many were the app's own planned ones, how many the control's, how many were flagged, and every run with its chain of parents. */
  cliProcesses: { expected: number; inControl: number; flagged: number; runs: CliRun[] };
}

/** A tunnel's closing line from the proxy: when it opened, what it carried, how long it lived and whether a cap closed it. */
export interface ProxyEnd {
  at: number;
  model: boolean;
  bytesUp?: number;
  bytesDown?: number;
  durationMs?: number;
  /** Set when the proxy closed the tunnel itself: `lifetime`, `bytes` or `phase_ended`. */
  cap?: string;
}

/** Bytes a tunnel carried, by the window it was opened in. */
const tunnelBytes = (l: ProxyEnd) => (l.bytesUp ?? 0) + (l.bytesDown ?? 0);

export function spendIntegrity(i: {
  proxy: ProxyLine[];
  windows: Window[];
  appRequests: AppRequest[];
  sweeps: SweepRecord[];
  budget: ModelConnectionBudget;
  modelPhases: string[];
  loadProblems?: { file: string; problem: string }[];
  /** Every tunnel's closing line. */
  ends?: ProxyEnd[];
  /** Every process the observer saw start, with its ancestry. */
  procs?: ProcRecord[];
  /** The app server as root recorded it before any model phase; without it nothing is expected. */
  app?: AppServer | null;
  /** Distinct CLI runs the app plans per model window (one Visual Director, one Design Agent). */
  plannedCliPerWindow?: number;
  /** The CLI runs the control starts itself; more than this in a control window are flagged. */
  controlCliRuns?: number;
}): SpendIntegrity {
  const flags: string[] = [];
  const outside = modelWindowObservations(i.proxy, i.windows);
  if (outside.length > 0) flags.push(`${outside.length} model API connection(s) outside the model windows (${[...new Set(outside.map((o) => o.detail.replace(/^.*\((.*)\)$/, "$1")))].slice(0, 4).join(", ")})`);
  const ends = i.ends ?? [];
  const modelConnections = i.modelPhases.map((phase) => {
    const w = i.windows.find((x) => x.phase === phase);
    const mine = i.proxy.filter((l) => l.model && w && l.at >= w.start && l.at < w.end);
    const allowed = mine.filter((l) => l.decision === "allowed").length;
    const refusedOverBudget = mine.filter((l) => l.decision === "refused" && (l.reason === "budget_exhausted" || l.reason === "bytes_exhausted")).length;
    const tunnels = ends.filter((l) => l.model && w && l.at >= w.start && l.at < w.end);
    return {
      phase,
      allowed,
      refusedOverBudget,
      budget: budgetFor(i.budget, phase),
      ceiling: ceilingFor(i.budget, phase),
      bytes: tunnels.reduce((n, l) => n + tunnelBytes(l), 0),
      byteBudget: bytesFor(i.budget, phase),
      byteCeiling: bytesCeilingFor(i.budget, phase),
      longestTunnelMs: tunnels.reduce((n, l) => Math.max(n, l.durationMs ?? 0), 0),
      cutByCap: tunnels.filter((l) => l.cap).length,
    };
  });
  for (const m of modelConnections) {
    if (m.refusedOverBudget > 0) flags.push(`${m.refusedOverBudget} model API connection(s) in ${m.phase} were refused at the ceiling of ${m.ceiling} connections or ${m.byteCeiling} bytes: the subject made calls the plan does not`);
    if (m.allowed > m.budget) flags.push(`${m.allowed} model API connections in ${m.phase}, over the plan of ${m.budget}`);
    if (m.byteBudget > 0 && m.bytes > m.byteBudget) flags.push(`${m.bytes} bytes through model API tunnels in ${m.phase}, over the plan of ${m.byteBudget}`);
    if (m.cutByCap > 0) flags.push(`${m.cutByCap} model API tunnel(s) in ${m.phase} were cut by a lifetime or byte cap`);
  }
  const connectsByWindow = i.windows.map((w) => {
    const mine = i.proxy.filter((l) => l.at >= w.start && l.at < w.end);
    return { phase: w.phase, kind: w.kind, allowed: mine.filter((l) => l.decision === "allowed").length, refused: mine.filter((l) => l.decision === "refused").length };
  });
  const chat = i.appRequests.filter((r) => !r.driver && r.method === "POST" && /^\/api\/chat(\/|$)/.test(r.path));
  if (chat.length > 0) flags.push(`${chat.length} subject-initiated POST /api/chat request(s) (any carousel): the subject started design runs of its own`);
  // Any process the subject left running past its phase, whatever it is called: it could be a model session of its own, or a tunnel to one.
  // Counts and categories only: the names of what the subject ran stay in `sweeps` in the results, never in a flag (a flag reaches the ledger's note).
  const strays = i.sweeps.flatMap((s) => s.survivors.filter((x) => !x.expected));
  if (strays.length > 0) flags.push(`${strays.length} subject-started process(es) outlived their phase: any of them may have been a model session of its own`);
  const cli = judgeCliRuns(i.procs ?? [], { app: i.app ?? null, windows: i.windows, plannedPerWindow: i.plannedCliPerWindow ?? 2, controlRuns: i.controlCliRuns });
  if (cli.flagged.length > 0) {
    const count = (label: string) => cli.flagged.filter((r) => (r.labels as string[]).includes(label)).length;
    flags.push(`${cli.flagged.length} run(s) of the CLI binary (by path, signature or size, copies included) beyond the app's own planned ones: ${count("not_app_server_child")} not started by the app server, ${count("cli_ancestor")} with a CLI above them, ${count("outside_model_window")} outside a model window, ${count("beyond_planned_count")} beyond the planned count`);
  }
  for (const r of sweepReasons(i.sweeps).filter((x) => /could not be listed/.test(x))) flags.push(r);
  for (const p of i.loadProblems ?? []) flags.push(`the record ${p.file} ${p.problem}: the spend evidence from it is missing`);
  return { possiblyIncomplete: flags.length > 0, flags, modelConnections, connectsByWindow, cliProcesses: { expected: cli.expected.length, inControl: cli.inControl.length, flagged: cli.flagged.length, runs: cli.all } };
}

/**
 * Flags for what the host knows and the records may not show: the last
 * collection of the records failed or was refused (so what the subject did after
 * the last good copy is missing), or messages were started whose model windows
 * are missing from the evidence (the marks that bracket them never arrived).
 * Either way the spend may be more than the evidence says, so the settlement is
 * flagged for founder review. Counts only.
 */
export function staleSpendFlags(i: { startedMessages: number; windows: Window[]; finalCollectOk: boolean }): string[] {
  const out: string[] = [];
  if (!i.finalCollectOk) out.push("the final records could not be taken from the subject's machine: whatever happened after the last good copy is missing from the evidence");
  const modelWindows = i.windows.filter((w) => w.kind === "model").length;
  if (i.startedMessages > modelWindows) out.push(`${i.startedMessages} message(s) were started but only ${modelWindows} model window(s) are in the evidence`);
  return out;
}

/** The note a flagged settlement carries in the ledger. */
export const NEEDS_REVIEW = "needs founder review";
