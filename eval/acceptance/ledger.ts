import { execFileSync } from "node:child_process";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The M1 evaluation spending ledger (#224): one JSON line per paid evaluation
 * run, kept outside the repository in a private folder, so every run can be
 * checked against the founder's cumulative cap before it starts.
 *
 * A harness run appends a `reservation` of its worst-case cost before it
 * spends anything and a `spend` entry with what it measured when it ends.
 * A reservation counts in full until a spend entry with the same run id
 * settles it, so a run that was killed before it could record its cost is
 * never under-counted. Earlier or manual spend is recorded with the CLI:
 *
 *   node eval/acceptance/ledger.ts show
 *   node eval/acceptance/ledger.ts add --usd 3.42 --note "pilot run"
 *   node eval/acceptance/ledger.ts add --usd 4.10 --run <run id> --note "settles a killed run"
 *
 * Reading, checking and appending is one step under an exclusive lock file
 * next to the ledger, so two evaluation processes cannot both pass the
 * preflight against the same remaining allowance.
 *
 * Node builtins only, so it runs without the app's build tooling (Node 22.18 or
 * later strips the types itself; older versions need --experimental-strip-types).
 */

/** The checkout this harness lives in: `eval/acceptance/` is two folders below it. */
export const CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_LEDGER_LABEL = "~/.local/share/creatorbrio-m1-eval/ledger.jsonl";
export const DEFAULT_M1_CAP_USD = 50;
export const DEFAULT_TICKET = "#221";

export type LedgerKind = "reservation" | "spend";

export interface LedgerEntry {
  /** ISO timestamp. */
  at: string;
  kind: LedgerKind;
  ticket: string;
  runId: string;
  /** The harness commit the run used. */
  commit: string;
  costUsd: number;
  note: string;
}

export interface LedgerTotals {
  /** Sum of spend entries. */
  settledUsd: number;
  /** Sum of reservations no spend entry has settled. */
  outstandingUsd: number;
  totalUsd: number;
  /** Run ids with an unsettled reservation. */
  unsettled: string[];
}

/** Expands a leading `~/` against `home`. */
export function expandHome(p: string, home = os.homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? path.join(home, p.slice(2)) : p;
}

/** `p` with symbolic links resolved as far as it exists, so a link cannot hide where a path really is. */
export function resolveReal(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(realpathSync(existing), ...rest);
}

/** Whether `child` is `parent` or lies below it, links resolved. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(resolveReal(parent), resolveReal(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Spend and evidence must never enter Git, so neither the ledger nor the archive may live in the checkout. */
export function assertOutsideCheckout(p: string, what: string, root = CHECKOUT_ROOT): void {
  if (isInside(p, root)) throw new Error(`${what} must be outside the repository checkout, so evaluation spend and evidence never enter Git`);
}

/** The ledger file: `EVAL_LEDGER`, or the default under the home folder; always absolute and outside the checkout. */
export function ledgerPath(env: Record<string, string | undefined> = process.env, home = os.homedir(), root = CHECKOUT_ROOT): string {
  const file = expandHome(env.EVAL_LEDGER?.trim() || DEFAULT_LEDGER_LABEL, home);
  if (!path.isAbsolute(file)) throw new Error("EVAL_LEDGER must be an absolute path (or start with ~/)");
  assertOutsideCheckout(file, "EVAL_LEDGER", root);
  return file;
}

/** A USD amount of 0 or more, or `fallback` when unset. Throws for anything else. */
export function parseNonNegativeUsd(raw: string | undefined, name: string, fallback: number): number {
  const value = raw?.trim() ?? "";
  if (value === "") return fallback;
  if (!/^\d+(\.\d+)?$/.test(value) || !Number.isFinite(Number(value))) throw new Error(`${name} must be a USD amount of 0 or more such as 15`);
  return Number(value);
}

/** A positive USD amount, or `fallback` when unset. Throws for anything else. */
export function parseUsd(raw: string | undefined, name: string, fallback?: number): number {
  const value = raw?.trim() ?? "";
  if (value === "" && fallback !== undefined) return fallback;
  if (!/^\d+(\.\d+)?$/.test(value) || !(Number(value) > 0)) throw new Error(`${name} must be a positive USD amount such as 2.50`);
  return Number(value);
}

/** The cumulative M1 cap: `EVAL_M1_CAP_USD`, 50 by default. */
export const m1CapUsd = (env: Record<string, string | undefined> = process.env) => parseUsd(env.EVAL_M1_CAP_USD, "EVAL_M1_CAP_USD", DEFAULT_M1_CAP_USD);

const SHORT = /^[^\n\r]{1,200}$/;

export function validEntry(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.at === "string" &&
    !Number.isNaN(Date.parse(e.at)) &&
    (e.kind === "reservation" || e.kind === "spend") &&
    typeof e.ticket === "string" &&
    SHORT.test(e.ticket) &&
    typeof e.runId === "string" &&
    SHORT.test(e.runId) &&
    typeof e.commit === "string" &&
    SHORT.test(e.commit) &&
    typeof e.costUsd === "number" &&
    Number.isFinite(e.costUsd) &&
    e.costUsd >= 0 &&
    typeof e.note === "string" &&
    e.note.length <= 500 &&
    !/[\n\r]/.test(e.note)
  );
}

/**
 * Every entry, oldest first; an absent ledger is empty. A line that is not a
 * valid entry stops the read: a damaged ledger must never under-count spend.
 */
export function readLedger(file: string): LedgerEntry[] {
  if (!existsSync(file)) return [];
  const entries: LedgerEntry[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Ledger line ${i + 1} is not JSON; fix the ledger before any paid run`);
      }
      if (!validEntry(parsed)) throw new Error(`Ledger line ${i + 1} is not a valid entry; fix the ledger before any paid run`);
      entries.push(parsed);
    });
  return entries;
}

export function ledgerTotals(entries: LedgerEntry[]): LedgerTotals {
  const settledRuns = new Set(entries.filter((e) => e.kind === "spend").map((e) => e.runId));
  const settledUsd = entries.filter((e) => e.kind === "spend").reduce((a, e) => a + e.costUsd, 0);
  const open = entries.filter((e) => e.kind === "reservation" && !settledRuns.has(e.runId));
  const outstandingUsd = open.reduce((a, e) => a + e.costUsd, 0);
  return { settledUsd, outstandingUsd, totalUsd: settledUsd + outstandingUsd, unsettled: open.map((e) => e.runId) };
}

/**
 * Makes sure `dir` is a private folder. A folder this call creates (with any
 * missing parents) is made mode 700. A folder that already exists is never
 * changed: it is accepted only when it is owned by this user and owner-only,
 * and refused otherwise, so this code never alters the permissions of a
 * folder someone else made.
 */
export function ensurePrivateDir(dir: string): void {
  const created = mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error("Refusing to use a symbolic link as a private evaluation folder");
  if (created !== undefined) return;
  if (!st.isDirectory()) throw new Error("Refusing to use a file where a private evaluation folder is needed");
  const foreign = typeof process.getuid === "function" && st.uid !== process.getuid();
  if (foreign || (st.mode & 0o077) !== 0) {
    throw new Error(
      `Refusing to use an existing folder that is not private to this user (mode ${(st.mode & 0o777).toString(8)}${foreign ? ", owned by someone else" : ""}); this code never changes the permissions of a folder it did not create. Make it owner-only (mode 700) or choose another location`
    );
  }
}

/** Appends one entry, creating the ledger mode 600 in a private folder. Callers that read first hold the lock (`withLedgerLock`). */
export function appendLedger(file: string, entry: LedgerEntry): void {
  if (!validEntry(entry)) throw new Error("Refusing to append an invalid ledger entry");
  ensurePrivateDir(path.dirname(file));
  if (existsSync(file) && (statSync(file).mode & 0o077) !== 0) throw new Error("Refusing to append to a ledger that is not owner-only; make it mode 600");
  const fd = openSync(file, "a", 0o600);
  try {
    writeSync(fd, JSON.stringify(entry) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** A lock older than this was left by a process that died, and is removed. */
export const LOCK_STALE_MS = 2 * 60_000;
/** How long to wait for a lock another process holds before refusing. */
export const LOCK_WAIT_MS = 10_000;

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn` while holding the ledger's exclusive lock, a file created with
 * O_EXCL next to the ledger (`<ledger>.lock`), so a read-check-append
 * sequence is one step across processes. A lock older than `staleMs` is taken
 * to be left by a dead process and is removed; a younger one is waited for up
 * to `waitMs`, then refused with a clear error. The lock is always released.
 */
export function withLedgerLock<T>(file: string, fn: () => T, options: { staleMs?: number; waitMs?: number } = {}): T {
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  ensurePrivateDir(path.dirname(file));
  const lock = `${file}.lock`;
  const deadline = Date.now() + waitMs;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lock, "wx", 0o600);
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let held: { ageMs: number; ino: number };
    try {
      const st = statSync(lock);
      held = { ageMs: Date.now() - st.mtimeMs, ino: st.ino };
    } catch {
      continue; // released between the attempt and the look: try again at once
    }
    if (held.ageMs > staleMs) {
      // Moved aside rather than deleted in place, and only if it is still the lock that was seen.
      try {
        if (statSync(lock).ino === held.ino) {
          const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
          renameSync(lock, aside);
          unlinkSync(aside);
        }
      } catch {
        // Another process removed it first.
      }
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `The spending ledger is locked by another evaluation process (lock ${Math.round(held.ageMs / 1000)} s old). Wait for it to finish; if no run is active, delete ${path.basename(lock)} next to the ledger. A lock older than ${Math.round(staleMs / 1000)} s is removed automatically.`
      );
    }
    sleep(100);
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      // Already removed.
    }
  }
}

const money = (v: number) => `$${v.toFixed(2)}`;

export function renderLedger(entries: LedgerEntry[], capUsd: number): string {
  const t = ledgerTotals(entries);
  const lines = entries.map((e) => `${e.at}  ${e.kind.padEnd(11)} ${money(e.costUsd).padStart(9)}  ${e.ticket}  ${e.runId}  ${e.commit}  ${e.note}`);
  lines.push("");
  lines.push(`Spent ${money(t.settledUsd)}; unsettled reservations ${money(t.outstandingUsd)}${t.unsettled.length ? ` (${t.unsettled.join(", ")})` : ""}.`);
  lines.push(`Counted against the cap ${money(t.totalUsd)} of ${money(capUsd)}; remaining ${money(Math.max(0, capUsd - t.totalUsd))}.`);
  return lines.join("\n");
}

function flags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--(\w+)$/);
    if (!m || i + 1 >= argv.length) throw new Error(`Unexpected argument ${argv[i]}`);
    out[m[1]] = argv[++i];
  }
  return out;
}

function currentCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: path.dirname(new URL(import.meta.url).pathname) }).toString().trim();
  } catch {
    return "unknown";
  }
}

export function main(argv: string[], env: Record<string, string | undefined> = process.env): string {
  const file = ledgerPath(env);
  const [command, ...rest] = argv;
  if (command === "show") return renderLedger(readLedger(file), m1CapUsd(env));
  if (command === "add") {
    const f = flags(rest);
    const costUsd = Number(f.usd);
    if (!/^\d+(\.\d+)?$/.test(f.usd ?? "") || !Number.isFinite(costUsd)) throw new Error("--usd must be a USD amount such as 3.42");
    if (!f.note?.trim()) throw new Error("--note is required");
    const at = new Date().toISOString();
    const entry: LedgerEntry = {
      at,
      kind: "spend",
      ticket: f.ticket ?? env.EVAL_TICKET ?? DEFAULT_TICKET,
      runId: f.run ?? `manual-${at.replace(/[:.]/g, "-")}`,
      commit: f.commit ?? currentCommit(),
      costUsd,
      note: f.note.trim(),
    };
    withLedgerLock(file, () => {
      readLedger(file); // never append to a damaged ledger
      appendLedger(file, entry);
    });
    return `Recorded ${money(costUsd)} as ${entry.runId}.\n\n${renderLedger(readLedger(file), m1CapUsd(env))}`;
  }
  throw new Error("Usage: ledger.ts show | add --usd <amount> --note <text> [--ticket <t>] [--run <run id>] [--commit <sha>]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
