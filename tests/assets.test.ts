import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  AssetError,
  RETRY_WINDOW_MS,
  attachAssets,
  beginCreativeRun,
  endCreativeRun,
  ensureAssetsRecovered,
  prepareCarouselRun,
  prepareRetry,
  setAssetFaultHookForTests,
  simulateRestartForTests,
  stageImage,
  stagingDirectoryFor,
  sweepStaging,
  type AssetStep,
} from "@/lib/assets";
import {
  addReferenceImage,
  appendCarouselAssets,
  carouselAssets,
  createCarousel,
  duplicateCarousel,
  getCarousel,
  updateCarousel,
  addSlide,
} from "@/lib/carousels";
import { readCreativeRuns } from "@/lib/generation-status";
import { pickCarouselUpdate } from "@/lib/api-input";
import type { CarouselAsset } from "@/types/carousel";

// Real storage and real files in a throwaway working directory.
let workdir: string;
let originalCwd: string;

const uploads = () => path.join(workdir, "public", "uploads");
const staging = () => path.join(workdir, "data", "asset-staging");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const list = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).sort();
const fileSha = async (file: string) => sha(await readFile(file));

/** A solid-colour PNG at the exact size the image service returns for 1:1. */
async function png(seed: number) {
  const bytes = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: { r: seed % 256, g: (seed * 7) % 256, b: 90 } },
  })
    .png()
    .toBuffer();
  return { png: bytes, width: 1024, height: 1024 };
}

beforeEach(async () => {
  originalCwd = process.cwd();
  workdir = await mkdtemp(path.join(tmpdir(), "creatorbrio-assets-"));
  await mkdir(path.join(workdir, "data"), { recursive: true });
  await writeFile(
    path.join(workdir, "data", "brand.json"),
    JSON.stringify({
      name: "Synthetic",
      colors: { primary: "#111111", secondary: "#222222", accent: "#e94560", background: "#ffffff", surface: "#f4f4f4" },
      fonts: { heading: "Inter", body: "Inter" },
      customFonts: [],
      logoPath: null,
      styleKeywords: [],
      createdAt: "",
      updatedAt: "",
    })
  );
  process.chdir(workdir);
  simulateRestartForTests();
  setAssetFaultHookForTests(null);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  setAssetFaultHookForTests(null);
  simulateRestartForTests();
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  await rm(workdir, { recursive: true, force: true });
});

const TASKS = [
  { key: "a1", required: true, aspectRatio: "1:1" as const },
  { key: "a2", required: true, aspectRatio: "1:1" as const },
  { key: "a3", required: false, aspectRatio: "1:1" as const },
];

/**
 * A carousel with an uploaded reference image, an unrelated upload and an
 * asset committed by an earlier run: none of them may ever be touched.
 */
async function world() {
  const carousel = await createCarousel("Synthetic", "1:1");
  await mkdir(uploads(), { recursive: true });
  const referenceId = randomUUID();
  const reference = await png(201);
  await writeFile(path.join(uploads(), `${referenceId}.png`), reference.png);
  await addReferenceImage(carousel.id, {
    id: referenceId,
    url: `/uploads/${referenceId}.png`,
    absPath: "",
    name: "reference",
    addedAt: new Date().toISOString(),
  });
  const unrelated = await png(202);
  await writeFile(path.join(uploads(), "unrelated.png"), unrelated.png);
  const earlierId = randomUUID();
  const earlier = await png(203);
  await writeFile(path.join(uploads(), `${earlierId}.png`), earlier.png);
  const earlierAsset: CarouselAsset = {
    id: earlierId,
    url: `/uploads/${earlierId}.png`,
    origin: "generated",
    sourceIds: [],
    width: 1024,
    height: 1024,
    sha256: sha(earlier.png),
    runId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await appendCarouselAssets(carousel.id, [earlierAsset]);
  const untouchable = {
    [`${referenceId}.png`]: sha(reference.png),
    "unrelated.png": sha(unrelated.png),
    [`${earlierId}.png`]: sha(earlier.png),
  };
  return { carouselId: carousel.id, earlierAsset, untouchable };
}

/** A run with every task staged. */
async function stagedRun(carouselId: string) {
  const runId = randomUUID();
  await beginCreativeRun(carouselId, runId, TASKS);
  const images: Record<string, Buffer> = {};
  for (const [i, task] of TASKS.entries()) {
    const image = await png(10 + i);
    images[task.key] = image.png;
    await stageImage(carouselId, runId, task.key, image);
  }
  return { runId, images };
}

/**
 * The invariants of SPEC section 6.4 that must hold after any crash followed
 * by recovery, for one run that staged `expected` files.
 */
async function assertInvariants(
  carouselId: string,
  runId: string,
  untouchable: Record<string, string>,
  expected: number
) {
  const carousel = (await getCarousel(carouselId))!;
  const assets = carouselAssets(carousel);

  // Every asset record points to an existing file whose content matches.
  for (const asset of assets) {
    expect(asset.url).toBe(`/uploads/${asset.id}.png`);
    expect(await fileSha(path.join(uploads(), `${asset.id}.png`))).toBe(asset.sha256);
  }
  // No record is duplicated.
  expect(new Set(assets.map((a) => a.id)).size).toBe(assets.length);

  // The attach is fully committed or fully absent.
  const mine = assets.filter((a) => a.runId === runId);
  expect([0, expected]).toContain(mine.length);

  // Nothing else in uploads was deleted or changed.
  for (const [name, digest] of Object.entries(untouchable)) {
    expect(await fileSha(path.join(uploads(), name))).toBe(digest);
  }
  // No partial or orphaned file sits under a final name: every uploads file is
  // a reference, the unrelated upload, or an asset some record names.
  const named = new Set([...Object.keys(untouchable), ...assets.map((a) => `${a.id}.png`)]);
  for (const name of await list(uploads())) expect(named.has(name)).toBe(true);

  // A blocked run's retryable tasks have valid staged or committed files.
  const record = (await readCreativeRuns())[carouselId];
  expect(record.ended).not.toBeNull();
  if (record.ended!.outcome === "blocked") {
    for (const task of record.tasks) {
      if (task.state === "staged") {
        expect(await fileSha(path.join(staging(), runId, `${task.key}.png`))).toBe(task.sha256);
      }
      if (task.state === "committed") {
        const asset = assets.find((a) => a.id === task.assetId);
        expect(asset).toBeDefined();
      }
    }
  }
  // No temporary file survives a sweep.
  for (const dir of await list(staging())) {
    for (const name of await list(path.join(staging(), dir))) expect(name.endsWith(".tmp")).toBe(false);
  }
  return { mine, record };
}

/** Fails or crashes at the nth occurrence of a step. */
function faultAt(step: AssetStep, mode: "fail" | "crash", occurrence = 1) {
  let seen = 0;
  setAssetFaultHookForTests((s) => {
    if (s !== step) return;
    seen += 1;
    if (seen === occurrence) return mode;
  });
}

/** What the chat route will do when a step throws: end the run as the spec says. */
async function endAfterError(carouselId: string, runId: string, err: unknown) {
  if (err instanceof AssetError && err.code === "commit_failed") {
    await endCreativeRun(carouselId, runId, "failed", { reason: err.code });
  } else {
    await endCreativeRun(carouselId, runId, "blocked", { reason: "storage_failed", retry: { plan: {}, message: "m" } });
  }
}

describe("assets: carousel records", () => {
  it("reads a carousel without assets as an empty list and rewrites nothing", async () => {
    const carousel = await createCarousel("Old", "4:5");
    const file = path.join(workdir, "data", "carousels.json");
    const stored = JSON.parse(await readFile(file, "utf-8"));
    delete stored.carousels[0].assets;
    await writeFile(file, JSON.stringify(stored));
    const before = await readFile(file, "utf-8");

    expect(carouselAssets((await getCarousel(carousel.id))!)).toEqual([]);
    await ensureAssetsRecovered();
    await sweepStaging();
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  it("copies assets when a carousel is duplicated", async () => {
    const { carouselId, earlierAsset } = await world();
    const copy = await duplicateCarousel(carouselId);
    expect(copy!.assets).toEqual([earlierAsset]);
  });

  it("never takes assets from an update body", async () => {
    const { carouselId, earlierAsset } = await world();
    const update = pickCarouselUpdate({ name: "Renamed", assets: [{ id: "x", url: "/etc/passwd" }] });
    expect(update).toEqual({ name: "Renamed" });
    await updateCarousel(carouselId, update);
    expect((await getCarousel(carouselId))!.assets).toEqual([earlierAsset]);
  });

  it("appends records idempotently", async () => {
    const { carouselId, earlierAsset } = await world();
    await appendCarouselAssets(carouselId, [earlierAsset]);
    expect((await getCarousel(carouselId))!.assets).toEqual([earlierAsset]);
  });
});

describe("assets: staging", () => {
  it("stages privately under data/, never under public/", async () => {
    const { carouselId } = await world();
    const { runId } = await stagedRun(carouselId);
    const dir = stagingDirectoryFor(runId);
    expect(dir.startsWith(path.join(process.cwd(), "data") + path.sep)).toBe(true);
    expect(dir.startsWith(path.join(process.cwd(), "public"))).toBe(false);
    expect(await list(dir)).toEqual(["a1.png", "a2.png", "a3.png"]);
  });

  it("refuses unsafe run IDs and task keys before touching the filesystem", async () => {
    const { carouselId } = await world();
    const runId = randomUUID();
    await expect(beginCreativeRun(carouselId, "../../escape", TASKS)).rejects.toBeInstanceOf(AssetError);
    await beginCreativeRun(carouselId, runId, TASKS);
    await expect(stageImage(carouselId, runId, "../a1", await png(1))).rejects.toMatchObject({ code: "plan_invalid" });
    expect(await list(staging())).toEqual([]);
  });

  it("refuses the image stage when staging and uploads are on different filesystems", async () => {
    // /dev is its own filesystem on macOS and Linux alike.
    await mkdir(path.join(workdir, "public"), { recursive: true });
    await symlink("/dev", uploads());
    expect((await stat("/dev")).dev).not.toBe((await stat(workdir)).dev);
    const carousel = await createCarousel("Synthetic", "1:1");
    const runId = randomUUID();
    await beginCreativeRun(carousel.id, runId, TASKS);
    await expect(stageImage(carousel.id, runId, "a1", await png(1))).rejects.toMatchObject({
      code: "storage_misconfigured",
    });
    await expect(attachAssets(carousel.id, runId)).rejects.toMatchObject({ code: "storage_misconfigured" });
  });
});

describe("assets: attach", () => {
  it("attaches every staged result with its hash and removes staging", async () => {
    const { carouselId, untouchable } = await world();
    const { runId, images } = await stagedRun(carouselId);
    const added = await attachAssets(carouselId, runId);
    await endCreativeRun(carouselId, runId, "completed");

    expect(added).toHaveLength(3);
    expect(new Set(added.map((a) => a.id)).size).toBe(3);
    for (const asset of added) {
      expect(asset).toMatchObject({ origin: "generated", sourceIds: [], width: 1024, height: 1024, runId });
      expect(asset.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(added.map((a) => a.sha256).sort()).toEqual(Object.values(images).map(sha).sort());
    expect(await list(stagingDirectoryFor(runId))).toEqual([]);
    const { mine } = await assertInvariants(carouselId, runId, untouchable, 3);
    expect(mine).toHaveLength(3);
  });

  it("is all or nothing: with a required task unfinished nothing moves and no record is added", async () => {
    const { carouselId, earlierAsset } = await world();
    const runId = randomUUID();
    await beginCreativeRun(carouselId, runId, TASKS);
    await stageImage(carouselId, runId, "a1", await png(1));
    await stageImage(carouselId, runId, "a3", await png(3));
    const before = await list(uploads());

    await expect(attachAssets(carouselId, runId)).rejects.toMatchObject({ code: "tasks_unfinished" });
    expect(await list(uploads())).toEqual(before);
    expect((await getCarousel(carouselId))!.assets).toEqual([earlierAsset]);
    expect(await list(stagingDirectoryFor(runId))).toEqual(["a1.png", "a3.png"]);
  });

  it("continues without a failed optional task", async () => {
    const { carouselId } = await world();
    const runId = randomUUID();
    await beginCreativeRun(carouselId, runId, TASKS);
    await stageImage(carouselId, runId, "a1", await png(1));
    await stageImage(carouselId, runId, "a2", await png(2));
    const added = await attachAssets(carouselId, runId);
    expect(added).toHaveLength(2);
  });

  it("returns files to staging and removes records when the carousel write fails", async () => {
    const { carouselId, earlierAsset, untouchable } = await world();
    const { runId, images } = await stagedRun(carouselId);
    // A directory where the storage layer writes its temporary file makes
    // the carousel write fail for real.
    await mkdir(path.join(workdir, "data", "carousels.json.tmp"));

    await expect(attachAssets(carouselId, runId)).rejects.toMatchObject({ code: "storage_failed" });
    await rm(path.join(workdir, "data", "carousels.json.tmp"), { recursive: true });

    expect((await getCarousel(carouselId))!.assets).toEqual([earlierAsset]);
    for (const [key, bytes] of Object.entries(images)) {
      expect(await fileSha(path.join(stagingDirectoryFor(runId), `${key}.png`))).toBe(sha(bytes));
    }
    expect((await readCreativeRuns())[carouselId].attach).toBeNull();
    await endAfterError(carouselId, runId, new AssetError("storage_failed", ""));
    await assertInvariants(carouselId, runId, untouchable, 3);
  });

  it("lets recovery finish when the roll-back fails too", async () => {
    const { carouselId, untouchable } = await world();
    const { runId } = await stagedRun(carouselId);
    let carouselWrites = 0;
    setAssetFaultHookForTests((step) => {
      if (step === "attach:unlinked" && ++carouselWrites === 3) return "fail"; // the records step fails
      if (step === "rollback:records") return "fail"; // and so does the roll-back
    });
    await expect(attachAssets(carouselId, runId)).rejects.toMatchObject({ code: "storage_failed" });
    await endAfterError(carouselId, runId, new AssetError("storage_failed", ""));
    expect((await readCreativeRuns())[carouselId].attach?.state).toBe("intent");

    setAssetFaultHookForTests(null);
    simulateRestartForTests();
    await ensureAssetsRecovered();
    const { mine, record } = await assertInvariants(carouselId, runId, untouchable, 3);
    expect(mine).toHaveLength(3);
    expect(record.attach?.state).toBe("committed");
  });

  it("keeps every change when attaches and other edits run concurrently", async () => {
    const { carouselId } = await world();
    const other = await createCarousel("Other", "1:1");
    const { runId } = await stagedRun(carouselId);
    await Promise.all([
      attachAssets(carouselId, runId),
      updateCarousel(carouselId, { name: "Renamed" }),
      addSlide(carouselId, "<p>one</p>"),
      addSlide(other.id, "<p>two</p>"),
      duplicateCarousel(other.id),
    ]);
    const carousel = (await getCarousel(carouselId))!;
    expect(carousel.name).toBe("Renamed");
    expect(carousel.slides).toHaveLength(1);
    expect(carouselAssets(carousel).filter((a) => a.runId === runId)).toHaveLength(3);
    expect((await getCarousel(other.id))!.slides).toHaveLength(1);
  });
});

describe("assets: fault injection with recovery", () => {
  const stagingSteps: AssetStep[] = ["stage:written", "stage:renamed", "stage:recorded"];
  const attachSteps: [AssetStep, number][] = [
    ["attach:intent", 1],
    ["attach:linked", 1],
    ["attach:unlinked", 1],
    ["attach:linked", 2],
    ["attach:unlinked", 2],
    ["attach:linked", 3],
    ["attach:unlinked", 3],
    ["attach:records", 1],
    ["attach:committed", 1],
    ["attach:cleaned", 1],
  ];

  it.each(stagingSteps.flatMap((s) => [[s, "fail"], [s, "crash"]] as const))(
    "staging: after %s, a %s leaves storage consistent",
    async (step, mode) => {
      const { carouselId, untouchable } = await world();
      const runId = randomUUID();
      await beginCreativeRun(carouselId, runId, TASKS);
      await stageImage(carouselId, runId, "a1", await png(1));
      faultAt(step, mode);
      const err = await stageImage(carouselId, runId, "a2", await png(2)).catch((e) => e);
      if (mode === "fail" && step !== "stage:recorded") {
        expect(err).toBeInstanceOf(Error);
        await endAfterError(carouselId, runId, err);
      }
      setAssetFaultHookForTests(null);
      simulateRestartForTests();
      await ensureAssetsRecovered();
      await assertInvariants(carouselId, runId, untouchable, 3);
      // Nothing was attached, and the first image is still there for a retry.
      const record = (await readCreativeRuns())[carouselId];
      expect(record.tasks.find((t) => t.key === "a1")!.state).toBe("staged");
    }
  );

  it.each(attachSteps.flatMap(([s, n]) => [[s, n, "fail"], [s, n, "crash"]] as const))(
    "attach: after %s (#%i), a %s leaves storage consistent after recovery",
    async (step, occurrence, mode) => {
      const { carouselId, untouchable } = await world();
      const { runId } = await stagedRun(carouselId);
      faultAt(step, mode, occurrence);
      const result = await attachAssets(carouselId, runId).catch((e) => e);
      if (result instanceof AssetError) await endAfterError(carouselId, runId, result);
      else if (!(result instanceof Error)) await endCreativeRun(carouselId, runId, "completed");

      setAssetFaultHookForTests(null);
      simulateRestartForTests();
      await ensureAssetsRecovered();
      const { mine, record } = await assertInvariants(carouselId, runId, untouchable, 3);
      // Recovery rolled forward or back; it never left an intent behind.
      expect(record.attach?.state ?? "none").not.toBe("intent");
      if (mine.length === 0) {
        expect(record.tasks.every((t) => t.state === "staged")).toBe(true);
      }
    }
  );

  it.each(
    (["recover:linked", "recover:records", "recover:committed", "rollback:records", "rollback:file"] as const).map(
      (s) => [s] as const
    )
  )("a crash during recovery (after %s) is repaired by the next recovery", async (recoveryStep) => {
    const { carouselId, untouchable } = await world();
    const { runId } = await stagedRun(carouselId);
    // Crash half-way through moving files, leaving an intent.
    faultAt("attach:linked", "crash", 2);
    await attachAssets(carouselId, runId).catch(() => {});
    simulateRestartForTests();

    // For a roll-back, one intended file must be lost first.
    if (recoveryStep.startsWith("rollback")) {
      const record = (await readCreativeRuns())[carouselId];
      const lostKey = record.attach!.items[2].taskKey;
      await rm(path.join(staging(), runId, `${lostKey}.png`));
    }
    faultAt(recoveryStep, "crash");
    await expect(ensureAssetsRecovered()).rejects.toBeInstanceOf(Error);

    setAssetFaultHookForTests(null);
    simulateRestartForTests();
    await ensureAssetsRecovered();
    const { mine } = await assertInvariants(carouselId, runId, untouchable, 3);
    expect(mine).toHaveLength(recoveryStep.startsWith("rollback") ? 0 : 3);
  });

  it("rolls back, keeping valid staged files, when an intended file is lost", async () => {
    const { carouselId, untouchable } = await world();
    const { runId } = await stagedRun(carouselId);
    faultAt("attach:unlinked", "crash", 1);
    await attachAssets(carouselId, runId).catch(() => {});
    simulateRestartForTests();
    const record = (await readCreativeRuns())[carouselId];
    const lost = record.attach!.items[2];
    await rm(path.join(staging(), runId, `${lost.taskKey}.png`));

    await ensureAssetsRecovered();
    const after = await assertInvariants(carouselId, runId, untouchable, 3);
    expect(after.mine).toEqual([]);
    expect(after.record.ended).toMatchObject({ outcome: "blocked", reason: "restart-before-design" });
    for (const task of after.record.tasks) {
      expect(task.state).toBe(task.key === lost.taskKey ? "failed" : "staged");
    }
  });

  it("never replaces another file found under an intended asset's name", async () => {
    const { carouselId, untouchable } = await world();
    const { runId } = await stagedRun(carouselId);
    faultAt("attach:intent", "crash");
    await attachAssets(carouselId, runId).catch(() => {});
    simulateRestartForTests();
    const record = (await readCreativeRuns())[carouselId];
    const squatter = await png(250);
    const squatterName = `${record.attach!.items[0].assetId}.png`;
    await writeFile(path.join(uploads(), squatterName), squatter.png);

    await ensureAssetsRecovered();
    expect(await fileSha(path.join(uploads(), squatterName))).toBe(sha(squatter.png));
    const after = await assertInvariants(carouselId, runId, { ...untouchable, [squatterName]: sha(squatter.png) }, 3);
    expect(after.mine).toEqual([]);
  });

  it("settles a run cut off before attach as blocked and in design as server-stopped", async () => {
    const { carouselId } = await world();
    const runId = randomUUID();
    await beginCreativeRun(carouselId, runId, TASKS);
    await stageImage(carouselId, runId, "a1", await png(1));
    simulateRestartForTests();
    await ensureAssetsRecovered();
    let record = (await readCreativeRuns())[carouselId];
    expect(record.ended).toMatchObject({ outcome: "blocked", reason: "restart-before-design" });
    expect(record.tasks.find((t) => t.key === "a1")!.state).toBe("staged");

    const designRun = randomUUID();
    await beginCreativeRun(carouselId, designRun, []);
    const { setCreativeStage } = await import("@/lib/assets");
    await setCreativeStage(carouselId, designRun, "designing");
    simulateRestartForTests();
    await ensureAssetsRecovered();
    record = (await readCreativeRuns())[carouselId];
    expect(record.ended).toMatchObject({ outcome: "server-stopped" });
  });
});

describe("assets: sweep", () => {
  it("removes temporary files, unrecorded and superseded staging, and leaves live runs and uploads alone", async () => {
    const { carouselId, untouchable } = await world();
    // A superseded blocked run.
    const old = await stagedRun(carouselId);
    await endCreativeRun(carouselId, old.runId, "blocked", { retry: { plan: {}, message: "m" } });
    // A live run on the same carousel replaces it.
    const live = randomUUID();
    await beginCreativeRun(carouselId, live, TASKS);
    await stageImage(carouselId, live, "a1", await png(1));
    await writeFile(path.join(staging(), live, ".a2.x.tmp"), "partial");
    // A directory no record knows.
    await mkdir(path.join(staging(), randomUUID()), { recursive: true });

    await sweepStaging();
    expect(await list(staging())).toEqual([live]);
    expect(await list(path.join(staging(), live))).toEqual([".a2.x.tmp", "a1.png"]);
    for (const [name, digest] of Object.entries(untouchable)) {
      expect(await fileSha(path.join(uploads(), name))).toBe(digest);
    }

    // Once it ends blocked, its temporary file and unclaimed files go.
    await writeFile(path.join(staging(), live, "a9.png"), "unclaimed");
    await endCreativeRun(carouselId, live, "blocked", { retry: { plan: {}, message: "m" } });
    await sweepStaging();
    expect(await list(path.join(staging(), live))).toEqual(["a1.png"]);
  });

  it("removes staged files whose hash no longer matches, and staging of runs that did not block", async () => {
    const { carouselId } = await world();
    const run = await stagedRun(carouselId);
    await endCreativeRun(carouselId, run.runId, "blocked", { retry: { plan: {}, message: "m" } });
    await writeFile(path.join(staging(), run.runId, "a2.png"), (await png(99)).png);
    await sweepStaging();
    expect(await list(path.join(staging(), run.runId))).toEqual(["a1.png", "a3.png"]);

    const other = await createCarousel("Other", "1:1");
    const failed = await stagedRun(other.id);
    await mkdir(path.join(staging(), failed.runId), { recursive: true });
    await endCreativeRun(other.id, failed.runId, "failed");
    await sweepStaging();
    expect(await list(staging())).toEqual([run.runId]);
  });
});

describe("assets: retry integrity and expiry", () => {
  async function blockedRun() {
    const fixture = await world();
    const run = await stagedRun(fixture.carouselId);
    await endCreativeRun(fixture.carouselId, run.runId, "blocked", {
      reason: "image_service_busy",
      retry: { plan: { status: "ready" }, message: "make a reel cover" },
    });
    return { ...fixture, ...run };
  }

  it("reuses intact staged results and regenerates a modified one", async () => {
    const { carouselId, runId } = await blockedRun();
    await writeFile(path.join(staging(), runId, "a2.png"), (await png(77)).png);
    const retry = await prepareRetry(carouselId, runId, () => true);
    expect(retry).toMatchObject({ plan: { status: "ready" }, message: "make a reel cover" });
    expect(retry.reused.sort()).toEqual(["a1", "a3"]);
    expect(retry.pending).toEqual(["a2"]);
    expect(await list(path.join(staging(), runId))).toEqual(["a1.png", "a3.png"]);
    const record = (await readCreativeRuns())[carouselId];
    expect(record.ended).toBeNull();
    expect(record.tasks.find((t) => t.key === "a2")!.state).toBe("pending");
  });

  it("regenerates a staged file that is not a PNG of the planned ratio", async () => {
    const { carouselId, runId } = await blockedRun();
    const wrong = await sharp({ create: { width: 864, height: 1536, channels: 3, background: "#000" } }).png().toBuffer();
    await writeFile(path.join(staging(), runId, "a1.png"), wrong);
    // Make the record claim the new bytes, so only the ratio check can catch it.
    const { mutateCreativeRuns } = await import("@/lib/generation-status");
    await mutateCreativeRuns((records) => {
      records[carouselId].tasks[0].sha256 = sha(wrong);
    });
    const retry = await prepareRetry(carouselId, runId, () => true);
    expect(retry.pending).toEqual(["a1"]);
  });

  it("does not reuse a committed asset whose file changed", async () => {
    const { carouselId, runId } = await blockedRun();
    const added = await attachAssets(carouselId, runId);
    await endCreativeRun(carouselId, runId, "blocked", { retry: { plan: {}, message: "m" } });
    await writeFile(path.join(uploads(), `${added[0].id}.png`), (await png(55)).png);
    const changedKey = (await readCreativeRuns())[carouselId].tasks.find((t) => t.assetId === added[0].id)!.key;
    const retry = await prepareRetry(carouselId, runId, () => true);
    expect(retry.pending).toEqual([changedKey]);
    expect(retry.reused).toHaveLength(2);
  });

  it("refuses a plan that no longer validates, another run, and a run that did not block", async () => {
    const { carouselId, runId } = await blockedRun();
    await expect(prepareRetry(carouselId, runId, () => false)).rejects.toMatchObject({ code: "plan_invalid" });
    await expect(prepareRetry(carouselId, randomUUID(), () => true)).rejects.toMatchObject({
      code: "retry_not_allowed",
    });
    const next = randomUUID();
    await beginCreativeRun(carouselId, next, []);
    await endCreativeRun(carouselId, next, "completed");
    await expect(prepareRetry(carouselId, runId, () => true)).rejects.toMatchObject({ code: "retry_not_allowed" });
    await expect(prepareRetry(carouselId, next, () => true)).rejects.toMatchObject({ code: "retry_not_allowed" });
  });

  it("refuses a retry after 24 hours before any sweep, then the sweep purges plan, message and files", async () => {
    const { carouselId, runId } = await blockedRun();
    const later = Date.now() + RETRY_WINDOW_MS + 60_000;
    await expect(prepareRetry(carouselId, runId, () => true, later)).rejects.toMatchObject({
      code: "retry_expired",
      message: "This attempt has expired; send the request again.",
    });
    // Refused on its own terms: nothing was purged yet.
    expect((await readCreativeRuns())[carouselId].retry).not.toBeNull();
    expect(await list(path.join(staging(), runId))).toHaveLength(3);

    await sweepStaging(later);
    const record = (await readCreativeRuns())[carouselId];
    expect(record.retry).toBeNull();
    expect(record.purgedAt).toBeDefined();
    expect(record).toMatchObject({ runId, ended: { outcome: "blocked" } });
    expect(await list(staging())).toEqual([]);
  });
});

describe("assets: preparing a carousel for a new run", () => {
  it("finishes an attach this process left unfinished before the next run on that carousel", async () => {
    await ensureAssetsRecovered();
    const { carouselId, untouchable } = await world();
    const { runId } = await stagedRun(carouselId);
    let n = 0;
    setAssetFaultHookForTests((step) => {
      if (step === "attach:unlinked" && ++n === 3) return "fail";
      if (step === "rollback:records") return "fail";
    });
    await attachAssets(carouselId, runId).catch(() => {});
    await endAfterError(carouselId, runId, new AssetError("storage_failed", ""));
    setAssetFaultHookForTests(null);

    // Same process: the once-per-process recovery already ran, so only
    // preparing the carousel can finish it.
    await ensureAssetsRecovered();
    expect((await readCreativeRuns())[carouselId].attach?.state).toBe("intent");
    await prepareCarouselRun(carouselId);
    const { mine } = await assertInvariants(carouselId, runId, untouchable, 3);
    expect(mine).toHaveLength(3);
  });
});
