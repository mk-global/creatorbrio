/**
 * How a pairing code is claimed (WS1 #122): exactly one winner across stores,
 * processes and restarts; a crash at any step leaves the code used and
 * creates no session; and cleanup of `claimed/` is bounded and never revives
 * a code.
 *
 * The original single-use race test lives in production-session.test.ts and
 * is kept unchanged. On macOS 27.2 it failed while redemption relied on
 * `unlink` succeeding for only one caller, which that filesystem does not
 * guarantee under concurrency.
 *
 * Crash tests reconstruct on disk the state a crash at each step leaves; they
 * do not kill a live process mid-claim.
 *
 * `STUDIO_PAIRING_STRESS_ROUNDS` raises the number of contended rounds (25 by
 * default) and prints a summary, for long runs on a target machine; run with
 * `--reporter=verbose` to see it.
 */
import { fork } from "node:child_process";
import { mkdir, mkdtemp, open, readdir, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CLAIM_CLEANUP_BATCH,
  CLAIM_CLEANUP_SCAN,
  CLAIM_RETENTION_MS,
  generateCode,
  PAIRING_TTL_MS,
  sha256,
  StudioSessions,
} from "@/lib/video/production/api/sessions";

const CHILD = path.resolve(__dirname, "helpers/redeem-child.mjs");
const ROUNDS = Number(process.env.STUDIO_PAIRING_STRESS_ROUNDS ?? 25);
const REPORT = process.env.STUDIO_PAIRING_STRESS_ROUNDS !== undefined;
/** Time between scheduled rounds; each round's redemptions finish well within it. */
const GAP_MS = 25;
/** A round whose attempts all started within this window was truly contended. */
const CONTENDED_WITHIN_MS = 5;

let auth: string;

beforeEach(async () => {
  auth = path.join(await realpath(await mkdtemp(path.join(tmpdir(), "creatorbrio-claims-"))), "video-auth");
});

afterEach(async () => {
  await rm(path.dirname(auth), { recursive: true, force: true });
});

const pairingDir = () => path.join(auth, "pairing");
const claimedDir = () => path.join(auth, "claimed");
const sessionDir = () => path.join(auth, "sessions");
const list = (dir: string) => readdir(dir).catch(() => [] as string[]);

/** Writes a pairing record in the format `scripts/studio-pair.mjs` writes, and returns its code. */
async function writeCode(expiresInMs = PAIRING_TTL_MS): Promise<string> {
  await mkdir(pairingDir(), { recursive: true, mode: 0o700 });
  const code = generateCode();
  const now = Date.now();
  const handle = await open(path.join(pairingDir(), `${sha256(code)}.json`), "wx", 0o600);
  await handle.writeFile(JSON.stringify({ v: 1, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + expiresInMs).toISOString() }));
  await handle.close();
  return code;
}

interface Attempt {
  round: number;
  ok: boolean;
  startedAt: number;
}

/** Redeems each round's code from `storesPerRound` fresh stores in each of `processes` child processes, all at the round's instant. */
async function redeemInProcesses(codes: string[], processes: number, storesPerRound: number): Promise<Attempt[]> {
  const children = Array.from({ length: processes }, () => fork(CHILD, [auth], { execArgv: [], stdio: ["ignore", "inherit", "inherit", "ipc"] }));
  try {
    await Promise.all(children.map((child) => new Promise<void>((resolve, reject) => {
      child.once("message", () => resolve());
      child.once("exit", (code) => reject(new Error(`redeem child exited early with ${code}`)));
    })));
    const start = Date.now() + 200;
    const rounds = codes.map((code, i) => ({ code, at: start + i * GAP_MS }));
    const replies = await Promise.all(children.map((child) => new Promise<Attempt[]>((resolve, reject) => {
      child.once("message", (message) => resolve((message as { attempts: Attempt[] }).attempts));
      child.once("exit", (code) => reject(new Error(`redeem child exited with ${code} before replying`)));
      child.send({ rounds, storesPerRound });
    })));
    return replies.flat();
  } finally {
    for (const child of children) child.kill();
  }
}

function summarise(attempts: Attempt[], rounds: number) {
  const byRound = Array.from({ length: rounds }, () => [] as Attempt[]);
  for (const a of attempts) byRound[a.round].push(a);
  const wins = byRound.map((round) => round.filter((a) => a.ok).length);
  const spread = byRound.map((round) => Math.max(...round.map((a) => a.startedAt)) - Math.min(...round.map((a) => a.startedAt)));
  return {
    rounds,
    attemptsPerRound: byRound[0]?.length ?? 0,
    exactlyOne: wins.filter((w) => w === 1).length,
    multipleWinners: wins.filter((w) => w > 1).length,
    noWinner: wins.filter((w) => w === 0).length,
    inconclusive: spread.filter((s) => s > CONTENDED_WITHIN_MS).length,
  };
}

describe("exactly one redeemer wins each code", () => {
  it(
    "across separate processes, each with several stores, under repeated contention",
    async () => {
      const codes = await Promise.all(Array.from({ length: ROUNDS }, () => writeCode()));
      const summary = summarise(await redeemInProcesses(codes, 4, 2), ROUNDS);
      if (REPORT) console.log(`cross-process claim stress: ${JSON.stringify(summary)}`);
      expect(summary).toMatchObject({ attemptsPerRound: 8, exactlyOne: ROUNDS, multipleWinners: 0, noWinner: 0 });
      expect(summary.inconclusive, "no round was actually contended").toBeLessThan(ROUNDS);
      expect(await list(pairingDir())).toEqual([]);
      expect((await list(claimedDir())).filter((n) => n.endsWith(".won"))).toHaveLength(ROUNDS);
    },
    ROUNDS * GAP_MS * 2 + 60_000,
  );

  it(
    "among many stores in one process, round after round",
    async () => {
      const summary = { rounds: ROUNDS, attemptsPerRound: 16, exactlyOne: 0, multipleWinners: 0, noWinner: 0 };
      for (let round = 0; round < ROUNDS; round++) {
        const code = await writeCode();
        const results = await Promise.all(Array.from({ length: 16 }, () => new StudioSessions(auth).redeem(code)));
        const wins = results.filter((r) => r.ok).length;
        if (wins === 1) summary.exactlyOne++;
        else if (wins > 1) summary.multipleWinners++;
        else summary.noWinner++;
      }
      if (REPORT) console.log(`in-process claim stress: ${JSON.stringify(summary)}`);
      expect(summary).toMatchObject({ exactlyOne: ROUNDS, multipleWinners: 0, noWinner: 0 });
    },
    ROUNDS * 200 + 30_000,
  );
});

describe("a code stays used after a crash, a restart or cleanup", () => {
  it("refuses a code whose record a crashed redeemer had already moved, after a restart", async () => {
    const code = await writeCode();
    const hash = sha256(code);
    await mkdir(claimedDir(), { recursive: true });
    // State left by a crash straight after step 1 (the rename): no marker, no session.
    await rename(path.join(pairingDir(), `${hash}.json`), path.join(claimedDir(), `${hash}.0123456789abcdef.json`));

    const restarted = new StudioSessions(auth);
    expect((await restarted.redeem(code)).ok).toBe(false);
    expect(await list(sessionDir())).toEqual([]);
  });

  it("refuses a code whose winner crashed after taking the marker", async () => {
    const code = await writeCode();
    const hash = sha256(code);
    await mkdir(claimedDir(), { recursive: true });
    // State left by a crash after step 2 (the marker), before a session was written.
    await rename(path.join(pairingDir(), `${hash}.json`), path.join(claimedDir(), `${hash}.0123456789abcdef.json`));
    await writeFile(path.join(claimedDir(), `${hash}.won`), "");

    expect((await new StudioSessions(auth).redeem(code)).ok).toBe(false);
    expect(await list(sessionDir())).toEqual([]);
  });

  it("refuses a second redeemer through the marker alone, even if its rename had succeeded", async () => {
    const code = await writeCode();
    await mkdir(claimedDir(), { recursive: true });
    // The record is still in pairing/, as a second, non-exclusive rename would leave it; the marker must decide.
    await writeFile(path.join(claimedDir(), `${sha256(code)}.won`), "");

    expect((await new StudioSessions(auth).redeem(code)).ok).toBe(false);
    expect(await list(pairingDir())).toEqual([]);
    expect(await list(sessionDir())).toEqual([]);
  });

  it("refuses a replay from another store, another process, and after cleanup has removed the marker", async () => {
    const code = await writeCode();
    expect((await new StudioSessions(auth).redeem(code)).ok).toBe(true);

    expect((await new StudioSessions(auth).redeem(code)).ok).toBe(false);
    const fromChildren = await redeemInProcesses([code], 2, 2);
    expect(fromChildren.filter((a) => a.ok)).toEqual([]);

    // A later successful pairing runs cleanup, which removes the first code's marker.
    const later = new StudioSessions(auth, { now: () => Date.now() + CLAIM_RETENTION_MS + 60_000 });
    expect((await later.redeem(await writeCode(CLAIM_RETENTION_MS + 5 * 60_000))).ok).toBe(true);
    expect(await list(claimedDir())).not.toContain(`${sha256(code)}.won`);
    expect((await later.redeem(code)).ok).toBe(false);
    expect((await new StudioSessions(auth).redeem(code)).ok).toBe(false);
    expect(await list(sessionDir())).toHaveLength(2);
  });
});

describe("cleanup of claimed/ is bounded and never revives a code", () => {
  it("runs only after a successful pairing, never after failed attempts", async () => {
    await mkdir(claimedDir(), { recursive: true });
    const old = (Date.now() - CLAIM_RETENTION_MS - 60_000) / 1000;
    const stale = path.join(claimedDir(), `${sha256("stale")}.won`);
    await writeFile(stale, "");
    await utimes(stale, old, old);

    const store = new StudioSessions(auth);
    for (let i = 0; i < 3; i++) expect((await store.redeem("AAAAA-AAAAA-AAAAA-AAAAA")).ok).toBe(false);
    expect(await list(claimedDir())).toContain(path.basename(stale));
    const code = await writeCode();
    expect((await store.redeem(code)).ok).toBe(true);
    expect(await list(claimedDir())).toEqual([`${sha256(code)}.won`]);
  });

  it("removes at most a batch of old files per pairing, keeps recent ones, and ignores other files", async () => {
    await mkdir(claimedDir(), { recursive: true });
    const old = (Date.now() - CLAIM_RETENTION_MS - 60_000) / 1000;
    const stale = CLAIM_CLEANUP_BATCH + 8;
    for (let i = 0; i < stale; i++) {
      const file = path.join(claimedDir(), `${sha256(`stale-${i}`)}.${i % 2 ? "won" : "0123456789abcdef.json"}`);
      await writeFile(file, "");
      await utimes(file, old, old);
    }
    const recent = path.join(claimedDir(), `${sha256("recent")}.won`);
    await writeFile(recent, "");
    const foreign = path.join(claimedDir(), "notes.txt");
    await writeFile(foreign, "");
    await utimes(foreign, old, old);

    const store = new StudioSessions(auth);
    const first = await writeCode();
    expect((await store.redeem(first)).ok).toBe(true);
    // Each pairing leaves its own recent marker.
    expect(await list(claimedDir())).toHaveLength(stale - CLAIM_CLEANUP_BATCH + 3);
    const second = await writeCode();
    expect((await store.redeem(second)).ok).toBe(true);
    expect((await list(claimedDir())).sort()).toEqual([path.basename(recent), "notes.txt", `${sha256(first)}.won`, `${sha256(second)}.won`].sort());
  });

  it("inspects at most a bounded number of files per pairing, and reaches every file over time", async () => {
    await mkdir(claimedDir(), { recursive: true });
    const old = (Date.now() - CLAIM_RETENTION_MS - 60_000) / 1000;
    // More recent files than one run inspects, and a few old ones among them.
    for (let i = 0; i < CLAIM_CLEANUP_SCAN * 2; i++) await writeFile(path.join(claimedDir(), `${sha256(`recent-${i}`)}.won`), "");
    const oldFiles = Array.from({ length: 4 }, (_, i) => `${sha256(`old-${i}`)}.won`);
    for (const name of oldFiles) {
      await writeFile(path.join(claimedDir(), name), "");
      await utimes(path.join(claimedDir(), name), old, old);
    }

    const store = new StudioSessions(auth);
    let pairings = 0;
    while ((await list(claimedDir())).some((n) => oldFiles.includes(n))) {
      expect((await store.redeem(await writeCode())).ok).toBe(true);
      expect(++pairings, "old files were never reached").toBeLessThan(200);
    }
    expect(await list(claimedDir())).toHaveLength(CLAIM_CLEANUP_SCAN * 2 + pairings);
  });

  it("leaves a code that a crash had claimed unredeemable once its files are cleaned up", async () => {
    const code = await writeCode();
    const hash = sha256(code);
    await mkdir(claimedDir(), { recursive: true });
    await rename(path.join(pairingDir(), `${hash}.json`), path.join(claimedDir(), `${hash}.0123456789abcdef.json`));
    await writeFile(path.join(claimedDir(), `${hash}.won`), "");

    const later = new StudioSessions(auth, { now: () => Date.now() + CLAIM_RETENTION_MS + 60_000 });
    const other = await writeCode(CLAIM_RETENTION_MS + 5 * 60_000);
    expect((await later.redeem(other)).ok).toBe(true);
    expect(await list(claimedDir())).toEqual([`${sha256(other)}.won`]);
    expect((await new StudioSessions(auth).redeem(code)).ok).toBe(false);
    expect(await list(sessionDir())).toHaveLength(1);
  });
});
