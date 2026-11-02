/**
 * A read-only view of the local image service's health, so the harness can
 * wait for the service to admit work before it pays for planning. It only
 * ever sends `GET /health`: it never asks for an image, never reads the
 * service's token, and refuses any address that is not this machine.
 *
 * The service's refusal reason is a short code. It is kept in results.json
 * for diagnosis and never written to summary.md.
 */

export const DEFAULT_IMAGE_SERVICE_URL = "http://127.0.0.1:8791";
const HEALTH_TIMEOUT_MS = 5_000;
/** The same bound the app applies to a refusal reason: a short lowercase code, never free text. */
const REASON_PATTERN = /^[a-z_]{1,64}$/;

export interface HealthSample {
  /** The service answered at all. */
  reachable: boolean;
  busy: boolean;
  canGenerate: boolean;
  /** The service's own reason code, or null when it gave none (or not a code). */
  reason: string | null;
  /** When the sample was taken, as an ISO timestamp. */
  at: string;
}

export interface AdmissionResult {
  admitted: boolean;
  waitedMs: number;
  /** The last sample taken; it decided the result. */
  last: HealthSample;
  /** Every distinct reason seen while waiting, in order. */
  reasons: string[];
  samples: HealthSample[];
}

/**
 * The image service's address: the app's default, or `EVAL_IMAGE_SERVICE_URL`
 * when set; loopback only. The harness also gives it to the servers it starts
 * as `IMAGE_SERVICE_URL`, so the app and the health poll always agree.
 */
export function imageServiceUrl(env: Record<string, string | undefined> = process.env): string {
  const url = new URL(env.EVAL_IMAGE_SERVICE_URL || DEFAULT_IMAGE_SERVICE_URL);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error(`EVAL_IMAGE_SERVICE_URL must be a loopback http address, not ${url.origin}`);
  }
  return url.origin;
}

/** Whether the service would accept an image request now. */
export const admits = (sample: HealthSample) => sample.reachable && sample.canGenerate && !sample.busy;

/** One `GET /health`, with a 5-second limit. Never throws. */
export async function health(baseUrl = imageServiceUrl(), timeoutMs = HEALTH_TIMEOUT_MS): Promise<HealthSample> {
  const at = new Date().toISOString();
  try {
    const res = await fetch(new URL("/health", baseUrl), { method: "GET", signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await res.text());
      if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
    } catch {
      // An unreadable body reads as "cannot generate".
    }
    const reason = typeof body.reason === "string" && REASON_PATTERN.test(body.reason) ? body.reason : null;
    return { reachable: true, busy: body.busy === true, canGenerate: res.ok && body.canGenerate === true, reason, at };
  } catch {
    return { reachable: false, busy: false, canGenerate: false, reason: null, at };
  }
}

export interface WaitOptions {
  /** How long to wait in total; `EVAL_ADMISSION_WAIT_MS`, 10 minutes by default. */
  timeoutMs?: number;
  /** How often to ask; 15 seconds by default. */
  intervalMs?: number;
  baseUrl?: string;
  healthTimeoutMs?: number;
}

export function admissionWaitMs(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.EVAL_ADMISSION_WAIT_MS ?? 600_000);
  return Number.isFinite(value) && value >= 0 ? value : 600_000;
}

/**
 * Polls the service's health until it admits work or `timeoutMs` passes.
 * Always samples at least once, and never waits past the bound.
 */
export async function waitForAdmission(options: WaitOptions = {}): Promise<AdmissionResult> {
  const timeoutMs = options.timeoutMs ?? admissionWaitMs();
  const intervalMs = options.intervalMs ?? 15_000;
  const baseUrl = options.baseUrl ?? imageServiceUrl();
  const started = Date.now();
  const samples: HealthSample[] = [];
  while (true) {
    const sample = await health(baseUrl, options.healthTimeoutMs);
    samples.push(sample);
    const waitedMs = Date.now() - started;
    const remaining = timeoutMs - waitedMs;
    if (admits(sample) || remaining <= 0) {
      const reasons = [...new Set(samples.map((s) => s.reason).filter((r): r is string => r !== null))];
      return { admitted: admits(sample), waitedMs, last: sample, reasons, samples };
    }
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
}

export interface BusyObservation {
  /** Whether any sample reported the service busy. */
  busySeen: boolean;
  /** From the first to the last busy sample, in ms; null when never busy. */
  busyForMs: number | null;
  /** The service was no longer busy by the end of the observation. */
  settled: boolean;
  samples: HealthSample[];
}

/**
 * Samples health every `intervalMs` for up to `durationMs`, stopping early
 * once the service was busy and is no longer: evidence of whether it finishes
 * a job a cancelled request had already started.
 */
export async function observeBusy(options: { durationMs?: number; intervalMs?: number; baseUrl?: string; healthTimeoutMs?: number } = {}): Promise<BusyObservation> {
  const durationMs = options.durationMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const baseUrl = options.baseUrl ?? imageServiceUrl();
  const started = Date.now();
  const samples: HealthSample[] = [];
  while (true) {
    const sample = await health(baseUrl, options.healthTimeoutMs);
    samples.push(sample);
    const busy = samples.filter((s) => s.busy);
    if (busy.length > 0 && !sample.busy) break;
    const remaining = durationMs - (Date.now() - started);
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
  }
  const busy = samples.filter((s) => s.busy);
  return {
    busySeen: busy.length > 0,
    busyForMs: busy.length > 0 ? Date.parse(busy.at(-1)!.at) - Date.parse(busy[0].at) : null,
    settled: !samples.at(-1)!.busy,
    samples,
  };
}
