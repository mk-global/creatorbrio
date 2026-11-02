import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBrandForCarousel } from "@/lib/brand";
import type { Carousel } from "@/types/carousel";
import { AppClient, logEntries, logOffset, readRunRecord, serverCosts, type ChatOptions, type ChatResult } from "./app";
import { runDesignAgentOnly } from "./baseline";
import { health, imageServiceUrl, observeBusy, waitForAdmission, type BusyObservation } from "./image-service";
import { judgeOutcome, judgePairwise, type JudgeContext } from "./judge";
import {
  renderSummary,
  stageDurations,
  type Check,
  type ComparisonRecord,
  type ImageServiceEvidence,
  type RunResults,
  type ScenarioRecord,
} from "./report";
import { founderPhoto, SCENARIOS, type Scenario, type ScenarioId } from "./scenarios";
import { ROOT, runDir, startServer, type HarnessPort, type RunningServer } from "./server";
import {
  checkExportFiles,
  checkFileHashes,
  checkPlacement,
  checkPreview,
  checkTasks,
  plannedAssets,
  planSummary,
  runTasks,
  snapshotStaged,
  stagingDir,
  verifyReuse,
  type StagedSnapshot,
} from "./verify";

/**
 * The creative-run acceptance harness (#40). It drives real CreatorBrio
 * servers it starts itself, through the public API, with the real Claude CLI
 * and whatever local image service is running. It costs money and is not
 * deterministic, so it only runs when invoked explicitly:
 *
 *   npm run build
 *   EVAL_ONLY=S1,S2 npx vitest run --config vitest.eval.config.ts eval/acceptance/acceptance.eval.ts
 *
 * EVAL_MODE=dev uses `next dev` instead of a production build; EVAL_COMPARE=0
 * skips the Design-Agent-only comparison. A test fails only on a harness
 * error; quality misses are recorded in results.json and summary.md.
 *
 * Scenarios that need generated images first wait, for up to
 * EVAL_ADMISSION_WAIT_MS (10 minutes by default), for the image service's
 * read-only health check to say it admits work; one that is not admitted is
 * recorded as not run and costs nothing. EVAL_IMAGE_SERVICE_URL (loopback,
 * http://127.0.0.1:8791 by default) is the service the harness asks and the
 * address it gives every server it starts (but the unavailable-service one),
 * so `.env.local` cannot point the app elsewhere. EVAL_RESTART_SIGNAL (SIGKILL, the default, SIGINT or
 * SIGTERM) is how the restart scenario stops the server. SIGKILL is a crash,
 * which tests restart recovery in both modes. A graceful signal under
 * `next dev` closes open requests, so the run is cancelled rather than cut
 * off; a production build keeps the request open until the harness kills
 * the process 5 s later.
 */

const MODE = process.env.EVAL_MODE === "dev" ? "dev" : "prod";
const ONLY = process.env.EVAL_ONLY ? new Set(process.env.EVAL_ONLY.split(",").map((s) => s.trim())) : null;
const COMPARE = process.env.EVAL_COMPARE !== "0";
const RESTART_SIGNALS = ["SIGINT", "SIGTERM", "SIGKILL"] as const;
const RESTART_SIGNAL = restartSignal(process.env.EVAL_RESTART_SIGNAL);

function restartSignal(value: string | undefined): (typeof RESTART_SIGNALS)[number] {
  if (!value) return "SIGKILL";
  const signal = RESTART_SIGNALS.find((s) => s === value);
  if (!signal) throw new Error(`EVAL_RESTART_SIGNAL must be one of ${RESTART_SIGNALS.join(", ")}, not ${value}`);
  return signal;
}

const PORTS: Record<"main" | "no-images" | "own", HarnessPort> = { main: 3417, "no-images": 3418, own: 3419 };
/** The conformance message for an optional image replaced by the plan's alternative. */
const OPTIONAL_UNAVAILABLE = /^An optional image for slide \d+ could not be made/;
/** An unused loopback port, so the image client sees "not running". */
const NO_IMAGE_SERVICE_URL = "http://127.0.0.1:8799";

const selected = SCENARIOS.filter((s) => !ONLY || ONLY.has(s.id));
const started = Date.now();
const results: RunResults = {
  startedAt: new Date(started).toISOString(),
  mode: MODE,
  commit: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT }).toString().trim(),
  scenarios: [],
  comparisons: [],
  wallMs: 0,
};
/** Exported PNGs of each scenario's Director arm, for the comparison. */
const directorPngs = new Map<ScenarioId, string[]>();
const sessions = new Map<ScenarioId, { carouselId: string; sessionId: string | null }>();

// ---------------------------------------------------------------------------
// One server at a time: they share this checkout's data files.

let current: { key: keyof typeof PORTS; server: RunningServer } | null = null;

async function serverFor(key: keyof typeof PORTS): Promise<RunningServer> {
  if (current?.key === key) return current.server;
  await stopServer();
  const server = await startServer({
    mode: MODE,
    port: PORTS[key],
    // The address the harness polls, so the app cannot be pointed elsewhere by `.env.local`.
    env: { IMAGE_SERVICE_URL: key === "no-images" ? NO_IMAGE_SERVICE_URL : imageServiceUrl() },
  });
  current = { key, server };
  return server;
}

async function stopServer(signal?: NodeJS.Signals) {
  if (!current) return;
  const { server } = current;
  current = null;
  await server.stop(signal);
}

async function save() {
  results.wallMs = Date.now() - started;
  await writeFile(path.join(runDir(), "results.json"), JSON.stringify(results, null, 2));
  await writeFile(path.join(runDir(), "summary.md"), renderSummary(results));
}

afterAll(async () => {
  await stopServer();
  await save();
  console.info(`[acceptance] results in ${runDir()}`);
}, 60_000);

// ---------------------------------------------------------------------------
// Evidence helpers.

const lastOf = <T extends ChatResult["events"][number]["event"]["type"]>(chat: ChatResult, type: T) =>
  chat.events.filter((e) => e.event.type === type).at(-1)?.event as Extract<ChatResult["events"][number]["event"], { type: T }> | undefined;

function runAssets(carousel: Carousel, runIds: string[]) {
  return (carousel.assets ?? []).filter((a) => runIds.includes(a.runId));
}

function placed(carousel: Carousel, url: string): boolean {
  return carousel.slides.some((slide) => slide.html.includes(url));
}

function imageEvidence(record: ScenarioRecord): ImageServiceEvidence {
  record.imageService ??= {};
  return record.imageService;
}

const sawStage = (chat: ChatResult, stage: string) => chat.events.some((e) => e.event.type === "stage" && e.event.stage === stage);
const endedOf = (runRecord: Record<string, unknown> | null) => (runRecord?.ended as { outcome?: string; reason?: string } | null | undefined) ?? null;

async function judgeContext(scenario: Scenario, carousel: Carousel): Promise<JudgeContext> {
  const brand = await resolveBrandForCarousel(carousel);
  return {
    scenarioId: scenario.id,
    message: scenario.message,
    aspectRatio: scenario.aspectRatio,
    objective: scenario.objective,
    audience: scenario.audience,
    constraints: scenario.constraints,
    brand: brand.name
      ? `${brand.name}; colours ${Object.values(brand.colors).join(", ")}; fonts ${brand.fonts.heading} and ${brand.fonts.body}`
      : "No brand configured; the studio's professional defaults apply, so judge internal consistency.",
    notes: scenario.notes,
  };
}

function newRecord(scenario: Scenario): ScenarioRecord {
  return {
    id: scenario.id,
    title: scenario.title,
    kind: scenario.kind,
    server: { port: 0, mode: MODE, readyMs: 0 },
    carouselId: null,
    chats: [],
    outcome: "not run",
    blocked: null,
    deviations: [],
    slides: null,
    generatedThisRun: null,
    runRecord: null,
    costs: null,
    logEntries: 0,
    export: null,
    judge: null,
    imageService: null,
    review: null,
    reuse: null,
    afterStop: null,
    checks: [],
    observations: [],
    wallMs: 0,
    harnessError: null,
  };
}

async function chat(
  record: ScenarioRecord,
  app: AppClient,
  label: string,
  body: { carouselId: string; message: string; sessionId?: string | null; retryRunId?: string },
  options: ChatOptions = {}
): Promise<ChatResult> {
  // The stored plan exists only while the run designs, so it is read as design begins.
  const atDesign: { run: Promise<Record<string, unknown> | null> | null } = { run: null };
  const result = await app.chat(body, {
    ...options,
    onEvent: (timed) => {
      if (!atDesign.run && timed.event.type === "stage" && timed.event.stage === "designing") atDesign.run = readRunRecord(body.carouselId);
      options.onEvent?.(timed);
    },
  });
  const run = atDesign.run ? await atDesign.run : null;
  record.chats.push({
    label,
    message: body.message,
    retryRunId: body.retryRunId,
    sessionId: body.sessionId ?? null,
    result,
    stages: stageDurations(result),
    planAtDesign: atDesign.run ? { assets: plannedAssets(run), summary: planSummary(run) } : null,
  });
  return result;
}

/** Fills in the outcome, assets, costs and export for a finished scenario; judges it when it completed. */
async function finish(
  record: ScenarioRecord,
  scenario: Scenario,
  app: AppClient,
  server: RunningServer,
  carouselId: string,
  last: ChatResult,
  logFrom: number,
  /** `chatFrom`: where the last chat's own log lines start, when `logFrom` also covers an earlier attempt. */
  options: { judge: boolean; sampleHealth?: boolean; chatFrom?: number }
) {
  const blocked = lastOf(last, "blocked");
  // A refusal is diagnosed best by what the service says right after it.
  const sampleHealth = options.sampleHealth !== false;
  if (sampleHealth && blocked?.code === "image_failed") (imageEvidence(record).afterFailure ??= []).push(await health());
  const deviations = lastOf(last, "deviations");
  const error = lastOf(last, "error");
  record.blocked = blocked ? { code: blocked.code, message: blocked.message, retryRunId: blocked.retryRunId } : null;
  record.deviations = deviations?.items ?? [];
  record.runRecord = await readRunRecord(carouselId);
  const ended = (record.runRecord?.ended as { outcome?: string } | null | undefined)?.outcome ?? "not ended";
  record.outcome = blocked ? `blocked: ${blocked.code}` : error ? `error: ${error.code}` : last.aborted ? `cancelled (${ended})` : ended;

  const carousel = await app.getCarousel(carouselId);
  record.slides = carousel.slides.length;
  record.generatedThisRun = runAssets(carousel, [String(record.runRecord?.runId ?? "")]).length;
  const costs = await serverCosts(server.logPath, carouselId, logFrom);
  const { entries, ...rest } = costs;
  record.costs = rest;
  record.logEntries = entries.length;
  if (rest.imageFailures.length > 0) {
    const evidence = imageEvidence(record);
    // Only a failure in this chat calls for a sample now; an earlier attempt's was sampled when it happened.
    const failedNow = options.chatFrom === undefined ? true : (await serverCosts(server.logPath, carouselId, options.chatFrom)).imageFailures.length > 0;
    if (sampleHealth && failedNow && blocked?.code !== "image_failed") (evidence.afterFailure ??= []).push(await health());
    evidence.failureReasons = rest.imageFailures.map((f) => ({
      key: typeof f.key === "string" ? f.key : null,
      code: typeof f.code === "string" ? f.code : null,
      reason: typeof f.reason === "string" ? f.reason : null,
    }));
  }

  if (ended === "completed" && carousel.slides.length > 0) {
    const exported = await app.exportPngs(carouselId, path.join(runDir(), `${scenario.id}-director`));
    record.export = exported.ok
      ? { ok: true, pngs: exported.files.length, files: exported.files, durationMs: exported.durationMs }
      : { ok: false, pngs: 0, error: `${exported.status} ${exported.error}`, durationMs: exported.durationMs };
    if (exported.ok) {
      directorPngs.set(scenario.id, exported.files);
      if (options.judge) record.judge = await judgeOutcome(await judgeContext(scenario, carousel), exported.files);
    }
  }
  if (ended === "completed") {
    const plan = record.chats.at(-1)?.planAtDesign?.summary ?? null;
    record.review = {
      creativeBrief: carousel.creativeBrief ?? null,
      plan,
      planNote: plan ? null : "no stored plan: only a plan with generated images is stored, and only while its run lasts",
      directorPlan: record.costs?.directorPlan ?? null,
    };
  }
  return carousel;
}

function check(record: ScenarioRecord, name: string, pass: boolean, evidence: string) {
  record.checks.push({ name, pass, evidence: `${evidence} [server ${MODE}]` } satisfies Check);
}

/** The deterministic checks shared by every scenario that should design. */
async function designChecks(record: ScenarioRecord, scenario: Scenario, carousel: Carousel, last: ChatResult, server: RunningServer) {
  const runId = String(record.runRecord?.runId ?? "");
  const assets = runAssets(carousel, [runId]);
  const tasks = runTasks(record.runRecord);
  const planned = record.chats.at(-1)?.planAtDesign?.assets ?? null;
  check(record, "run completed", record.outcome === "completed", `outcome ${record.outcome}; stream error ${last.streamError ?? "none"}`);
  if (scenario.expect.slides !== undefined)
    check(record, "slide count", carousel.slides.length === scenario.expect.slides, `${carousel.slides.length} slides, expected ${scenario.expect.slides}`);
  const g = scenario.expect.generated;
  if (g !== undefined) {
    const ok = g === "none" ? assets.length === 0 : g === "some" ? assets.length > 0 : assets.length === g;
    check(record, "generated images attached", ok, `${assets.length} attached by this run, expected ${g}`);
  }
  if (scenario.expect.generatedPlaced && assets.length && !planned) {
    // Without the plan's assignments only "somewhere in the carousel" can be checked.
    const missing = assets.filter((a) => !placed(carousel, a.url));
    check(record, "every generated image placed", missing.length === 0, missing.length ? `not placed: ${missing.map((a) => a.url).join(", ")}` : `${assets.length} of ${assets.length} placed somewhere; the plan was not captured`);
  }
  if (record.outcome === "completed" && tasks.length > 0) {
    const t = checkTasks(tasks);
    check(record, "image tasks committed", t.pass, t.evidence);
    const h = await checkFileHashes(ROOT, tasks, assets);
    check(record, "attached files match their hashes", h.pass, h.evidence);
    if (planned) {
      const p = checkPlacement(planned, tasks, carousel.slides);
      check(record, "each generated image on its planned slides", p.pass, p.evidence);
    } else {
      check(record, "each generated image on its planned slides", false, "the stored plan was not captured when design began");
    }
    const v = await checkPreview(server.origin, assets);
    check(record, "preview serves each image", v.pass, v.evidence);
  }
  if (scenario.expect.referencePlaced) {
    const refs = carousel.referenceImages ?? [];
    check(record, "uploaded photo placed", refs.some((r) => placed(carousel, r.url)), refs.map((r) => `${r.url}: ${placed(carousel, r.url) ? "placed" : "not placed"}`).join("; ") || "no reference");
  }
  if (scenario.expect.typographyOnly) {
    const withImages = carousel.slides.filter((sl) => /<img\b|\/uploads\//i.test(sl.html));
    check(record, "typography only", withImages.length === 0, withImages.length ? `${withImages.length} slide(s) contain an image` : "no slide contains an image");
  }
  if (scenario.expect.readsSources) {
    const read = record.chats.some((c) => c.result.events.some((e) => e.event.type === "stage" && e.event.stage === "reading-sources"));
    check(record, "linked page read", read, read ? "reading-sources stage shown" : "no reading-sources stage");
  }
  check(record, "export", !!record.export?.ok && record.export.pngs === carousel.slides.length, record.export ? `${record.export.pngs} PNG(s)${record.export.error ? `; ${record.export.error}` : ""}` : "not exported");
  if (record.export?.ok && record.export.files) {
    const e = await checkExportFiles(record.export.files, carousel.aspectRatio);
    check(record, "exported PNGs decode at the carousel's size", e.pass, e.evidence);
  }
  // An optional image the service could not make, replaced by the plan's own
  // alternative and reported to the user, is the designed outcome, not a miss.
  const disclosed = record.deviations.filter((d) => OPTIONAL_UNAVAILABLE.test(d));
  const unexpected = record.deviations.filter((d) => !OPTIONAL_UNAVAILABLE.test(d));
  if (disclosed.length) record.observations.push(`disclosed optional-image fallbacks: ${disclosed.join(" ")}`);
  check(record, "matches the plan", unexpected.length === 0, unexpected.length ? unexpected.join(" ") : disclosed.length ? "only disclosed optional-image fallbacks" : "no deviations reported");
}

// ---------------------------------------------------------------------------
// Scenario drivers.

/**
 * Sends an explicit retry of a blocked run and proves each image staged
 * before it was reused: no new image for its key, and the same hash and the
 * same file once attached. Waits for the image service to admit work first,
 * within the bound; returns the retry's result, or null when it was not sent.
 */
async function retryAndVerify(
  record: ScenarioRecord,
  scenario: Scenario,
  server: RunningServer,
  carouselId: string,
  runId: string,
  snapshot: StagedSnapshot,
  logFrom: number
): Promise<{ chat: ChatResult; carousel: Carousel } | null> {
  record.reuse = { snapshot, attempted: false };
  const admission = await waitForAdmission();
  imageEvidence(record).retryAdmission = admission;
  if (!admission.admitted) {
    record.observations.push("retry not attempted: the image service was not admitting");
    return null;
  }
  const app = new AppClient(server.origin);
  const retryFrom = await logOffset(server.logPath);
  const retry = await chat(record, app, "explicit retry", { carouselId, message: "Retry", retryRunId: runId });
  record.reuse.attempted = true;
  const carousel = await finish(record, scenario, app, server, carouselId, retry, logFrom, { judge: true, chatFrom: retryFrom });
  const entries = await logEntries(server.logPath, carouselId, retryFrom);
  const line = entries.find((e) => e.tag === "[creative-run] retry")?.fields;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  const checks = await verifyReuse(ROOT, snapshot, {
    runRecord: record.runRecord,
    assets: carousel.assets ?? [],
    stagedAfterRetry: entries.filter((e) => e.tag === "[creative-run] image staged").map((e) => String(e.fields.key)),
    retryLine: line ? { reused: num(line.reused), pending: num(line.pending) } : null,
  });
  for (const { name, verdict } of checks) check(record, name, verdict.pass, verdict.evidence);
  await designChecks(record, scenario, carousel, retry, server);
  return { chat: retry, carousel };
}

/**
 * For a run that blocked because an image could not be made after at least
 * one other was staged: retries it and verifies the reuse. Null when the run
 * is not such a partial run, or the retry was not sent.
 */
async function retryPartialRun(record: ScenarioRecord, scenario: Scenario, server: RunningServer, carouselId: string, logFrom: number) {
  const blocked = record.blocked;
  if (blocked?.code !== "image_failed" || !blocked.retryRunId) return null;
  const snapshot = await snapshotStaged(ROOT, await readRunRecord(carouselId));
  if (snapshot.items.length === 0) return null;
  record.observations.push(`partial run: ${snapshot.items.length} image(s) staged before it blocked (${record.outcome}); retrying it`);
  return retryAndVerify(record, scenario, server, carouselId, blocked.retryRunId, snapshot, logFrom);
}

async function runIntegration(scenario: Scenario, record: ScenarioRecord) {
  const server = await serverFor("main");
  const app = new AppClient(server.origin);
  let carouselId: string;
  let sessionId: string | null = null;
  if (scenario.revisionOf) {
    const prior = sessions.get(scenario.revisionOf);
    if (!prior) {
      // A revision of a carousel whose first run did not complete tests something else.
      record.outcome = "skipped";
      record.observations.push(`needs ${scenario.revisionOf} to complete in the same run`);
      return;
    }
    carouselId = prior.carouselId;
    sessionId = prior.sessionId;
  } else {
    carouselId = (await app.createCarousel(`Acceptance ${scenario.id}`, scenario.aspectRatio)).id;
    if (scenario.reference) await app.addReference(carouselId, await founderPhoto(), "founder-photo.png");
  }
  record.carouselId = carouselId;
  const before = await app.getCarousel(carouselId);
  const logFrom = await logOffset(server.logPath);
  let last = await chat(record, app, "request", { carouselId, message: scenario.message, sessionId });
  let carousel = await finish(record, scenario, app, server, carouselId, last, logFrom, { judge: true });
  const retried = await retryPartialRun(record, scenario, server, carouselId, logFrom);
  if (retried) ({ chat: last, carousel } = retried);
  else await designChecks(record, scenario, carousel, last, server);
  if (record.outcome === "completed") sessions.set(scenario.id, { carouselId, sessionId: last.sessionId });

  if (scenario.kind === "revision") {
    check(record, "session resumed", !!sessionId && !lastOf(last, "error"), `resumed ${sessionId ? "the earlier session" : "nothing"}; error ${lastOf(last, "error")?.code ?? "none"}`);
    const b = before.creativeBrief;
    const a = carousel.creativeBrief;
    check(record, "brief kept", !!b && !!a && !!a.objective && !!a.audience, `before: ${b?.objective?.value ?? "-"} / ${b?.audience?.value ?? "-"}; after: ${a?.objective?.value ?? "-"} / ${a?.audience?.value ?? "-"}`);
    record.observations.push(`central message before "${b?.centralMessage?.value ?? "-"}", after "${a?.centralMessage?.value ?? "-"}"`);
    const plan = record.costs?.directorPlan;
    if (plan) record.observations.push(`revision plan: requestType ${plan.requestType}, generate ${plan.generate}, reuse ${plan.reuse}`);
  }
}

async function runImageServiceUnavailable(scenario: Scenario, record: ScenarioRecord) {
  const server = await serverFor("no-images");
  const app = new AppClient(server.origin);
  const carouselId = (await app.createCarousel(`Acceptance ${scenario.id}`, scenario.aspectRatio)).id;
  record.carouselId = carouselId;
  const logFrom = await logOffset(server.logPath);
  const last = await chat(record, app, "request", { carouselId, message: scenario.message });
  // This server talks to an unused port, so the real service's health says nothing about it.
  const carousel = await finish(record, scenario, app, server, carouselId, last, logFrom, { judge: false, sampleHealth: false });
  const plan = record.costs?.directorPlan;
  const required = typeof plan?.required === "number" ? plan.required : null;
  const generate = typeof plan?.generate === "number" ? plan.generate : null;
  if (record.blocked) {
    check(record, "stopped with a reason", record.blocked.code === "image_failed", `${record.blocked.code}: ${record.blocked.message}`);
    check(record, "nothing changed", carousel.slides.length === 0 && (carousel.assets ?? []).length === 0, `${carousel.slides.length} slides, ${(carousel.assets ?? []).length} assets`);
    record.observations.push(`behaviour: blocked before design (plan asked for ${generate ?? "?"} image(s), ${required ?? "?"} required)`);
  } else {
    // Designing without the requested photo is only acceptable if no required image was planned.
    check(record, "no silent fallback", record.outcome === "completed" && required === 0, `outcome ${record.outcome}; plan generate ${generate ?? "?"}, required ${required ?? "?"}`);
    record.observations.push(`behaviour: designed without images (plan generate ${generate ?? "?"}, required ${required ?? "?"})`);
  }
}

/** Waits for the image service to admit work again, so the next scenario does not meet a job a stopped run left behind. */
async function cooldown(record: ScenarioRecord) {
  const admission = await waitForAdmission();
  imageEvidence(record).cooldown = admission;
  if (!admission.admitted) record.observations.push("the image service was still not admitting at the end of the scenario");
}

/** Whether the image service went on with an image after `after`, in plain words. */
function busyLine(after: string, busy: BusyObservation): string {
  return busy.busySeen
    ? `after ${after} the image service stayed busy for about ${((busy.busyForMs ?? 0) / 1000).toFixed(0)} s${busy.settled ? "" : " and was still busy when observation ended"}`
    : `after ${after} the image service was never seen busy`;
}

async function runCancel(scenario: Scenario, record: ScenarioRecord) {
  const server = await serverFor("main");
  const app = new AppClient(server.origin);
  const carouselId = (await app.createCarousel(`Acceptance ${scenario.id}`, scenario.aspectRatio)).id;
  record.carouselId = carouselId;
  const logFrom = await logOffset(server.logPath);
  const stop: { logAt: Promise<number> | null } = { logAt: null };
  const last = await chat(
    record,
    app,
    "request, stopped during images",
    { carouselId, message: scenario.message },
    {
      abortWhen: ({ event }) => event.type === "stage" && event.stage === "preparing-images" && /^1 of /.test(event.detail ?? ""),
      // Long enough for the first image to be in flight.
      abortDelayMs: 5_000,
      onAbort: () => {
        stop.logAt = logOffset(server.logPath);
      },
    }
  );
  // Whether the service goes on with the image the cancelled request started.
  if (last.aborted) imageEvidence(record).afterCancel = await observeBusy();
  const idle = await app.waitUntilIdle(carouselId);
  const carousel = await finish(record, scenario, app, server, carouselId, last, logFrom, { judge: false });
  const nothingChanged = carousel.slides.length === 0 && (carousel.assets ?? []).length === 0;
  const changes = `${carousel.slides.length} slides, ${(carousel.assets ?? []).length} assets`;

  if (!last.aborted || !stop.logAt) {
    // For example, the first image was refused before the stop could happen.
    record.observations.push(`cancellation not exercised: the run ended (${record.outcome}) before the stop`);
    check(record, "nothing attached or changed", nothingChanged, changes);
    await cooldown(record);
    return;
  }
  const ended = endedOf(record.runRecord);
  const tasks = runTasks(record.runRecord);
  const runId = String(record.runRecord?.runId ?? "");
  check(record, "stopped during images", sawStage(last, "preparing-images"), `stages ${last.events.filter((e) => e.event.type === "stage").map((e) => (e.event as { stage: string }).stage).join(" > ")}`);
  check(record, "run recorded as stopped", ended?.outcome === "stopped" && ended.reason === "cancelled", `ended ${ended?.outcome ?? "-"} (${ended?.reason ?? "-"}); idle ${idle}`);
  check(
    record,
    "image in flight abandoned",
    tasks.some((t) => t.state === "abandoned") && !tasks.some((t) => t.state === "running"),
    tasks.map((t) => `${t.key}=${t.state}`).join(", ") || "no tasks"
  );
  check(record, "staging removed", !!runId && !existsSync(stagingDir(ROOT, runId)), runId ? `staging folder ${existsSync(stagingDir(ROOT, runId)) ? "still present" : "removed"}` : "no run");
  const after = (await logEntries(server.logPath, carouselId, await stop.logAt)).filter((e) => e.tag === "[creative-run] image staged");
  check(record, "no image staged after the stop", after.length === 0, after.length ? `staged after the stop: ${after.map((e) => e.fields.key).join(", ")}` : "none");
  check(record, "nothing attached or changed", nothingChanged, changes);
  const busy = imageEvidence(record).afterCancel;
  if (busy) record.observations.push(busyLine("the stop", busy));
  await cooldown(record);
}

async function runRestartRetry(scenario: Scenario, record: ScenarioRecord) {
  let server = await serverFor("own");
  const app = new AppClient(server.origin);
  const carouselId = (await app.createCarousel(`Acceptance ${scenario.id}`, scenario.aspectRatio)).id;
  record.carouselId = carouselId;
  const logFrom = await logOffset(server.logPath);
  const stop: { promise: Promise<void> | null } = { promise: null };
  const first = await chat(record, app, `request, server stopped during images (${RESTART_SIGNAL})`, { carouselId, message: scenario.message }, {
    onEvent: ({ event }) => {
      if (stop.promise || event.type !== "stage" || event.stage !== "preparing-images") return;
      const m = (event.detail ?? "").match(/^(\d+) of (\d+)$/);
      // Stop as the third image (or the last, for fewer) starts.
      if (m && Number(m[1]) === Math.min(3, Number(m[2])) && Number(m[2]) > 0) stop.promise = stopServer(RESTART_SIGNAL);
    },
  });
  if (stop.promise) await stop.promise;
  else {
    await finish(record, scenario, app, server, carouselId, first, logFrom, { judge: false });
    if (sawStage(first, "preparing-images") && record.blocked) {
      record.observations.push(`blocked before the stop point: ${record.blocked.code}`);
      if (await retryPartialRun(record, scenario, server, carouselId, logFrom)) return;
    } else {
      record.observations.push(sawStage(first, "preparing-images") ? `the run ended (${record.outcome}) before the stop point` : "the server was never stopped: the run did not reach the image stage");
    }
    check(record, "reached the stop point", false, `outcome ${record.outcome}`);
    return;
  }

  // The state the stop left, before any recovery runs.
  const afterStop = await readRunRecord(carouselId);
  const runId = String(afterStop?.runId ?? "");
  const snapshot = await snapshotStaged(ROOT, afterStop);
  const ended = endedOf(afterStop);
  const tasks = runTasks(afterStop);
  record.afterStop = {
    signal: RESTART_SIGNAL,
    ended: afterStop?.ended ?? null,
    tasks: tasks.map((t) => ({ key: t.key, state: t.state, sha256: t.sha256 ?? null })),
    staging: snapshot,
  };
  record.observations.push(
    `after the stop (${RESTART_SIGNAL}): run ${ended?.outcome ?? "not settled"}; tasks ${tasks.map((t) => `${t.key}=${t.state}`).join(", ")}; staging folder ${snapshot.stagingDirExists ? "present" : "absent"}`
  );
  // Whether the service goes on with the image the stopped server had started.
  const busy = await observeBusy();
  imageEvidence(record).afterServerStop = busy;
  record.observations.push(busyLine("the server stopped", busy));
  if (ended?.outcome === "stopped" && RESTART_SIGNAL !== "SIGKILL") {
    // The route's cancellation ran before the process exited: staging is gone and the run cannot be retried.
    record.outcome = "not exercised: the graceful stop cancelled the run";
    record.observations.push(`${RESTART_SIGNAL} let the server cancel the run, so this exercised cancellation, not restart recovery; SIGKILL, the default, tests a crash`);
    return;
  }
  if (snapshot.items.length === 0) record.observations.push("nothing was staged before the stop, so reuse cannot be shown");

  server = await serverFor("own");
  record.server.readyMs = server.readyMs;
  const status = await new AppClient(server.origin).generation(carouselId);
  record.observations.push(`after the restart: generating ${status.generating}, interrupted ${status.interrupted}`);
  const retried = await retryAndVerify(record, scenario, server, carouselId, runId, snapshot, logFrom);
  if (!retried) check(record, "retry after restart", false, "not attempted: the image service was not admitting");
}

// ---------------------------------------------------------------------------
// Comparison: the Design Agent alone on a fresh carousel, then a blind pairwise judgment.

async function runComparison(scenario: Scenario): Promise<ComparisonRecord> {
  const record: ComparisonRecord = { id: scenario.id, baselineCarouselId: null, baseline: null, baselineExport: null, baselineJudge: null, pairwise: null, skipped: null, harnessError: null };
  const director = directorPngs.get(scenario.id);
  if (!director) {
    // For example, the Director arm was blocked because an image could not be made.
    record.skipped = "the Director arm produced no export to compare";
    return record;
  }
  const server = await serverFor("main");
  const app = new AppClient(server.origin);
  const carousel = await app.createCarousel(`Acceptance ${scenario.id} baseline`, scenario.aspectRatio);
  record.baselineCarouselId = carousel.id;
  if (scenario.reference) await app.addReference(carousel.id, await founderPhoto(), "founder-photo.png");
  record.baseline = await runDesignAgentOnly({ origin: server.origin, carouselId: carousel.id, message: scenario.message });
  const after = await app.getCarousel(carousel.id);
  if (after.slides.length === 0) {
    record.baselineExport = { ok: false, pngs: 0, error: "no slides" };
    return record;
  }
  const exported = await app.exportPngs(carousel.id, path.join(runDir(), `${scenario.id}-baseline`));
  record.baselineExport = exported.ok ? { ok: true, pngs: exported.files.length } : { ok: false, pngs: 0, error: `${exported.status} ${exported.error}` };
  if (!exported.ok) return record;
  const context = await judgeContext(scenario, after);
  record.baselineJudge = await judgeOutcome(context, exported.files);
  record.pairwise = await judgePairwise(context, { director, baseline: exported.files });
  return record;
}

// ---------------------------------------------------------------------------

describe.sequential(`creative run acceptance (${MODE})`, () => {
  for (const scenario of selected) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const t0 = Date.now();
      const record = newRecord(scenario);
      results.scenarios.push(record);
      try {
        // A revision whose first run did not complete is skipped by its driver, without waiting.
        const priorMissing = !!scenario.revisionOf && !sessions.has(scenario.revisionOf);
        let admitted = true;
        if (scenario.needsImages && !priorMissing) {
          const admission = await waitForAdmission();
          imageEvidence(record).admission = admission;
          admitted = admission.admitted;
        }
        // Not run, and nothing spent on planning; the service's reasons stay in results.json.
        if (!admitted) record.outcome = "skipped: image service not admitting";
        else if (scenario.kind === "integration" || scenario.kind === "revision") await runIntegration(scenario, record);
        else if (scenario.kind === "image-service-unavailable") await runImageServiceUnavailable(scenario, record);
        else if (scenario.kind === "cancel") await runCancel(scenario, record);
        else await runRestartRetry(scenario, record);
        if (current) record.server = { port: current.server.port, mode: current.server.mode, readyMs: record.server.readyMs || current.server.readyMs };
      } catch (err) {
        record.harnessError = (err as Error).stack ?? String(err);
      } finally {
        record.wallMs = Date.now() - t0;
        await save();
      }
      expect(record.harnessError).toBeNull();

      if (COMPARE && scenario.compare) {
        let comparison: ComparisonRecord;
        try {
          comparison = await runComparison(scenario);
        } catch (err) {
          comparison = { id: scenario.id, baselineCarouselId: null, baseline: null, baselineExport: null, baselineJudge: null, pairwise: null, skipped: null, harnessError: (err as Error).stack ?? String(err) };
        }
        results.comparisons.push(comparison);
        await save();
        expect(comparison.harnessError).toBeNull();
      }
    }, 60 * 60 * 1000);
  }
});
