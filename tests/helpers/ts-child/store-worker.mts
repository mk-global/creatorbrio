// A real OS process that uses the production store, for the cross-process
// tests in tests/production-store-processes.test.ts. Input is one JSON
// argument; output is one JSON line per outcome on stdout.
import { ProductionStore } from "../../../src/lib/video/production/store";

interface Job {
  mode: "race" | "same-base" | "open-run-and-exit" | "edit-forever";
  root: string;
  productionId: string;
  worker: number;
  rounds?: number;
  startAt?: number;
  baseRevision?: number;
}

const job = JSON.parse(process.argv[2]) as Job;
const store = new ProductionStore({ root: job.root });
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const at = (n: number) => new Date(Date.UTC(2026, 10, 4, 12, 0, 0, n)).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function currentRevision(): Promise<number> {
  const loaded = await store.load(job.productionId);
  if (loaded.status !== "ok") throw new Error(JSON.stringify(loaded));
  return loaded.state.history.current.revision;
}

function rename(id: string, baseRevision: number, name: string, extra: Record<string, unknown> = {}) {
  return { id, baseRevision, at: at(job.worker), by: "user", summary: "rename", ops: [{ op: "renameProduction", name }], ...extra };
}

if (job.startAt) await sleep(Math.max(0, job.startAt - Date.now()));

if (job.mode === "race") {
  // Read the current revision, then try to change it, many times, as fast as possible.
  for (let i = 0; i < (job.rounds ?? 10); i++) {
    const base = await currentRevision();
    const result = await store.apply(job.productionId, rename(`w${job.worker}-${i}`, base, `Worker ${job.worker} round ${i}`));
    emit({ status: result.status, reason: "reason" in result ? result.reason : undefined, base, revision: "revision" in result ? result.revision : undefined, generation: "generation" in result ? result.generation : undefined });
  }
} else if (job.mode === "same-base") {
  const result = await store.apply(job.productionId, rename(`w${job.worker}`, job.baseRevision!, `Worker ${job.worker}`));
  emit({ status: result.status, reason: "reason" in result ? result.reason : undefined, revision: "revision" in result ? result.revision : undefined });
} else if (job.mode === "open-run-and-exit") {
  // Begin an agent run, make one agent change, and stop without keeping or discarding it.
  const begun = await store.beginRun(job.productionId, { runId: "run-crashed" });
  const base = await currentRevision();
  const change = await store.apply(job.productionId, rename("cs-agent", base, "Agent rename", { by: "agent", runId: "run-crashed" }));
  emit({ begun: begun.status, change: change.status });
  process.exit(0);
} else if (job.mode === "edit-forever") {
  // Edit until killed; the parent sends SIGKILL at an arbitrary moment.
  emit({ ready: true });
  for (let i = 0; ; i++) {
    const base = await currentRevision();
    await store.apply(job.productionId, rename(`k${job.worker}-${i}`, base, `Kill test ${i}`));
  }
}
