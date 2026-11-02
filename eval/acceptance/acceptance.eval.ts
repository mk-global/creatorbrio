import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBrandForCarousel } from "@/lib/brand";
import { stagingDirectoryFor } from "@/lib/assets";
import type { Carousel } from "@/types/carousel";
import { AppClient, logOffset, readRunRecord, serverCosts, type ChatOptions, type ChatResult } from "./app";
import { runDesignAgentOnly } from "./baseline";
import { judgeOutcome, judgePairwise, type JudgeContext } from "./judge";
import { renderSummary, stageDurations, type Check, type ComparisonRecord, type RunResults, type ScenarioRecord } from "./report";
import { founderPhoto, SCENARIOS, type Scenario, type ScenarioId } from "./scenarios";
import { ROOT, runDir, startServer, type HarnessPort, type RunningServer } from "./server";

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
 */

const MODE = process.env.EVAL_MODE === "dev" ? "dev" : "prod";
const ONLY = process.env.EVAL_ONLY ? new Set(process.env.EVAL_ONLY.split(",").map((s) => s.trim())) : null;
const COMPARE = process.env.EVAL_COMPARE !== "0";
/** After a cancelled or cut-off image the local service finishes it anyway; wait before the next image request. */
const IMAGE_COOLDOWN_MS = Number(process.env.EVAL_IMAGE_COOLDOWN_MS ?? 120_000);

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
    env: key === "no-images" ? { IMAGE_SERVICE_URL: NO_IMAGE_SERVICE_URL } : {},
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
  options?: ChatOptions
): Promise<ChatResult> {
  const result = await app.chat(body, options);
  record.chats.push({ label, message: body.message, retryRunId: body.retryRunId, sessionId: body.sessionId ?? null, result, stages: stageDurations(result) });
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
  options: { judge: boolean }
) {
  const blocked = lastOf(last, "blocked");
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

  if (ended === "completed" && carousel.slides.length > 0) {
    const exported = await app.exportPngs(carouselId, path.join(runDir(), `${scenario.id}-director`));
    record.export = exported.ok
      ? { ok: true, pngs: exported.files.length, durationMs: exported.durationMs }
      : { ok: false, pngs: 0, error: `${exported.status} ${exported.error}`, durationMs: exported.durationMs };
    if (exported.ok) {
      directorPngs.set(scenario.id, exported.files);
      if (options.judge) record.judge = await judgeOutcome(await judgeContext(scenario, carousel), exported.files);
    }
  }
  return carousel;
}

function check(record: ScenarioRecord, name: string, pass: boolean, evidence: string) {
  record.checks.push({ name, pass, evidence } satisfies Check);
}

/** The deterministic checks shared by every scenario that should design. */
function designChecks(record: ScenarioRecord, scenario: Scenario, carousel: Carousel, last: ChatResult) {
  const runId = String(record.runRecord?.runId ?? "");
  const assets = runAssets(carousel, [runId]);
  check(record, "run completed", record.outcome === "completed", `outcome ${record.outcome}; stream error ${last.streamError ?? "none"}`);
  if (scenario.expect.slides !== undefined)
    check(record, "slide count", carousel.slides.length === scenario.expect.slides, `${carousel.slides.length} slides, expected ${scenario.expect.slides}`);
  const g = scenario.expect.generated;
  if (g !== undefined) {
    const ok = g === "none" ? assets.length === 0 : g === "some" ? assets.length > 0 : assets.length === g;
    check(record, "generated images attached", ok, `${assets.length} attached by this run, expected ${g}`);
  }
  if (scenario.expect.generatedPlaced && assets.length) {
    const missing = assets.filter((a) => !placed(carousel, a.url));
    check(record, "every generated image placed", missing.length === 0, missing.length ? `not placed: ${missing.map((a) => a.url).join(", ")}` : `${assets.length} of ${assets.length} placed`);
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
  // An optional image the service could not make, replaced by the plan's own
  // alternative and reported to the user, is the designed outcome, not a miss.
  const disclosed = record.deviations.filter((d) => OPTIONAL_UNAVAILABLE.test(d));
  const unexpected = record.deviations.filter((d) => !OPTIONAL_UNAVAILABLE.test(d));
  if (disclosed.length) record.observations.push(`disclosed optional-image fallbacks: ${disclosed.join(" ")}`);
  check(record, "matches the plan", unexpected.length === 0, unexpected.length ? unexpected.join(" ") : disclosed.length ? "only disclosed optional-image fallbacks" : "no deviations reported");
}

// ---------------------------------------------------------------------------
// Scenario drivers.

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
  const last = await chat(record, app, "request", { carouselId, message: scenario.message, sessionId });
  const carousel = await finish(record, scenario, app, server, carouselId, last, logFrom, { judge: true });
  if (record.outcome === "completed") sessions.set(scenario.id, { carouselId, sessionId: last.sessionId });
  designChecks(record, scenario, carousel, last);

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
  const carousel = await finish(record, scenario, app, server, carouselId, last, logFrom, { judge: false });
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

async function runCancel(scenario: Scenario, record: ScenarioRecord) {
  const server = await serverFor("main");
  const app = new AppClient(server.origin);
  const carouselId = (await app.createCarousel(`Acceptance ${scenario.id}`, scenario.aspectRatio)).id;
  record.carouselId = carouselId;
  const logFrom = await logOffset(server.logPath);
  const last = await chat(
    record,
    app,
    "request, stopped during images",
    { carouselId, message: scenario.message },
    {
      abortWhen: ({ event }) => event.type === "stage" && event.stage === "preparing-images" && /^1 of /.test(event.detail ?? ""),
      // Long enough for the first image to be in flight.
      abortDelayMs: 5_000,
    }
  );
  const idle = await app.waitUntilIdle(carouselId);
  const carousel = await finish(record, scenario, app, server, carouselId, last, logFrom, { judge: false });
  const ended = (record.runRecord?.ended as { outcome?: string } | undefined)?.outcome;
  check(record, "stopped during images", last.aborted && last.events.some((e) => e.event.type === "stage" && e.event.stage === "preparing-images"), `aborted ${last.aborted}; stages ${last.events.filter((e) => e.event.type === "stage").map((e) => (e.event as { stage: string }).stage).join(" > ")}`);
  check(record, "run recorded as stopped", ended === "stopped", `ended ${ended ?? "-"}; idle ${idle}`);
  check(record, "nothing attached or changed", carousel.slides.length === 0 && (carousel.assets ?? []).length === 0, `${carousel.slides.length} slides, ${(carousel.assets ?? []).length} assets`);
  const runId = String(record.runRecord?.runId ?? "");
  if (runId) record.observations.push(`staging folder after cancel: ${existsSync(stagingDirectoryFor(runId)) ? "still present" : "removed"}`);
  await new Promise((r) => setTimeout(r, IMAGE_COOLDOWN_MS));
}

async function runRestartRetry(scenario: Scenario, record: ScenarioRecord) {
  let server = await serverFor("own");
  let app = new AppClient(server.origin);
  const carouselId = (await app.createCarousel(`Acceptance ${scenario.id}`, scenario.aspectRatio)).id;
  record.carouselId = carouselId;
  const logFrom = await logOffset(server.logPath);
  const stop: { promise: Promise<void> | null } = { promise: null };
  const first = await chat(record, app, "request, server stopped during images", { carouselId, message: scenario.message }, {
    onEvent: ({ event }) => {
      if (stop.promise || event.type !== "stage" || event.stage !== "preparing-images") return;
      const m = (event.detail ?? "").match(/^(\d+) of (\d+)$/);
      // Stop as the third image (or the last, for fewer) starts, like Ctrl+C on the server.
      if (m && Number(m[1]) === Math.min(3, Number(m[2])) && Number(m[2]) > 0) stop.promise = stopServer("SIGINT");
    },
  });
  if (stop.promise) await stop.promise;
  else {
    record.observations.push("the server was never stopped: the run did not reach the image stage");
    await finish(record, scenario, app, server, carouselId, first, logFrom, { judge: false });
    check(record, "reached the image stage", false, `outcome ${record.outcome}`);
    return;
  }
  const afterStop = await readRunRecord(carouselId);
  const runId = String(afterStop?.runId ?? "");
  const tasks = (afterStop?.tasks as { key: string; state: string }[] | undefined) ?? [];
  record.observations.push(`after the stop: tasks ${tasks.map((t) => `${t.key}=${t.state}`).join(", ")}`);

  await new Promise((r) => setTimeout(r, IMAGE_COOLDOWN_MS));
  server = await serverFor("own");
  app = new AppClient(server.origin);
  record.server.readyMs = server.readyMs;
  const status = await app.generation(carouselId);
  record.observations.push(`after the restart: generating ${status.generating}, interrupted ${status.interrupted}`);
  const retryFrom = await logOffset(server.logPath);
  const retry = await chat(record, app, "retry after restart", { carouselId, message: "Retry", retryRunId: runId });
  const carousel = await finish(record, scenario, app, server, carouselId, retry, logFrom, { judge: true });
  const retryCosts = await serverCosts(server.logPath, carouselId, retryFrom);
  const retryLine = retryCosts.retries[0];
  const total = tasks.length;
  const reused = typeof retryLine?.reused === "number" ? retryLine.reused : null;
  const pending = typeof retryLine?.pending === "number" ? retryLine.pending : null;
  check(
    record,
    "retry remade only missing images",
    reused !== null && pending !== null && reused + pending === total && retryCosts.imagesStaged === pending && reused === tasks.filter((t) => t.state === "staged").length,
    `tasks ${total}; staged before stop ${tasks.filter((t) => t.state === "staged").length}; retry reused ${reused ?? "?"}, pending ${pending ?? "?"}; images made on retry ${retryCosts.imagesStaged}`
  );
  designChecks(record, scenario, carousel, retry);
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
        if (scenario.kind === "integration" || scenario.kind === "revision") await runIntegration(scenario, record);
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
