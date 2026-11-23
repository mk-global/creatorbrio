/**
 * One contained server at a time per data folder and per agent folders' root
 * (#246).
 *
 * A carousel's run slot, which keeps a live run and its carousel's deletion
 * or a new conversation apart (#241), lives in one server process's memory,
 * so two contained servers over the same data folder or agent folders could
 * each delete what the other's live run is using. When a server starts with
 * the contained profile (`src/instrumentation.ts`), it therefore takes an
 * ownership record in each of the two folders, the data folder first and the
 * agent folders' root second, and gives back the first if it cannot take the
 * second. A server that does not own both refuses contained designs and
 * carousel deletions, with an explanation naming the folder and the process
 * that holds it (`containedServerStatus`), runs no start sweep and stops no
 * leftover processes. The records are released at shutdown, through the
 * shutdown hook (`onServerShutdown`); a crashed server leaves its records,
 * which the next server takes over.
 *
 * A record (`.contained-server`) names its server by process id and start
 * time, as the server's own folder in the temporary parent records them
 * (`ownServerStart`, `serverStillRunning`), so a reused process id is never
 * taken for a live server. It is created whole, by linking a complete private
 * file into place, which fails when a record is already there: two servers
 * can never both create it. A record whose process is gone, or has another
 * start time, is stale and is taken over by renaming it to a name of the
 * taker's own, which only one taker can do, then creating a new record the
 * same way. A taker that finds it moved a live server's fresh record instead
 * (another taker got there first) puts it back. With three or more servers
 * racing over one stale record a moved record cannot always be put back, so a
 * server that took both records checks them once more a moment later and, if
 * one is no longer its own, gives back the other and tries again; and each
 * server checks, whenever it is asked, that its records are still the ones in
 * place: at the start of every design, again immediately before the launch
 * (planning can take minutes, and a record or the folders setting can change
 * meanwhile), and on every contained deletion. Exclusive creation guarantees one owner of a record that is created
 * where none was; the takeover of a stale record, with three or more servers
 * starting at once after a crash, is made safe by those checks and not fully
 * excluded (accepted).
 *
 * The folders are bound to the ones claimed: the data folder's and the agent
 * folders' real paths are kept, and a server whose settings now name other
 * folders is refused, as one that never claimed them is, until it is restarted
 * (`containedServerStatus`), so what it owns is what it deletes in.
 *
 * Both events are logged without a path: a stale record taken over (the folder
 * and the previous process id), and this server's own record found replaced.
 *
 * This is no distributed lock: both folders are local, and the records only
 * keep a second server on the same computer out. A legacy-profile server takes
 * no record and is not excluded.
 */
import { constants, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { link, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { defaultProbe, onServerShutdown, type ProcessProbe } from "@/lib/agent-processes";
import { AgentWorkspaceError, agentWorkspaceRoot, ownServerStart, resolvedRoot, serverStillRunning } from "@/lib/agent-workspace";

/** The ownership record's name in each folder: a dot-name, which no carousel's identifier or data file has. */
export const SERVER_RECORD = ".contained-server";

/**
 * A claim of both records settles this long before it is checked once more,
 * so a record another server's stale takeover moved meanwhile is noticed
 * before this server starts acting as the owner.
 */
const SETTLE_MS = 200;
/** How many times a claim is tried while other servers' starts keep the records changing. */
const CLAIM_ATTEMPTS = 6;
const BACKOFF_MS = 25;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A server process, by id and start time as the process table prints it. */
export interface ServerIdentity {
  pid: number;
  start: string;
}

/** Which of the two folders, as messages name it. */
export type OwnedFolder = "data" | "agents";

const FOLDER_WORDS: Record<OwnedFolder, string> = { data: "data folder", agents: "Design Agent's folders" };

/** One record this process created: which file, and which file it is (its device and inode), with what it says. */
interface HeldRecord {
  file: string;
  dev: number;
  ino: number;
  body: string;
  /** Which folder's record it is, once a claim of both folders names it. */
  folder?: OwnedFolder;
}

export type RecordClaim =
  /** `tookOver` is the server whose stale record this claim replaced, when it replaced one. */
  | { owned: true; record: HeldRecord; tookOver?: ServerIdentity }
  | { owned: false; holder: ServerIdentity | null; problem: "held" | "not-a-record" | "contended" };

const recordBody = (self: ServerIdentity) => `${JSON.stringify({ pid: self.pid, start: self.start })}\n`;

/** A record's server, or null when the text is not a record the server writes. */
export function parseRecord(text: string): ServerIdentity | null {
  try {
    const value = JSON.parse(text) as { pid?: unknown; start?: unknown };
    if (Number.isInteger(value.pid) && (value.pid as number) > 1 && typeof value.start === "string" && value.start.trim() !== "") {
      return { pid: value.pid as number, start: value.start };
    }
  } catch {
    // Not a record.
  }
  return null;
}

/**
 * Reads the record at `file` without following a link: what it says and
 * which file it is, `null` when there is none, or "not-a-record" for a link,
 * anything but a regular file, another user's file or text that is not a
 * record.
 */
async function readRecord(file: string, uid: number): Promise<{ text: string; holder: ServerIdentity | null; dev: number; ino: number } | null | "not-a-record"> {
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    return "not-a-record";
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== uid || info.size > 4096) return "not-a-record";
    const text = await handle.readFile("utf8");
    return { text, holder: parseRecord(text), dev: info.dev, ino: info.ino };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Takes the ownership record in `dir` for `self`, or says who holds it.
 * `running` says whether a recorded server is still that process. Nothing is
 * ever deleted that this call did not judge stale or create itself.
 */
export async function claimRecord(
  dir: string,
  self: ServerIdentity,
  running: (holder: ServerIdentity) => Promise<boolean>,
  options: { uid?: number; attempts?: number } = {}
): Promise<RecordClaim> {
  const uid = options.uid ?? process.getuid?.() ?? 0;
  const file = path.join(dir, SERVER_RECORD);
  const body = recordBody(self);
  // The server whose stale record this call removed, which it says if the record it then creates is its own.
  let tookOver: ServerIdentity | undefined;
  for (let attempt = 0; attempt < (options.attempts ?? 8); attempt++) {
    // Created whole: a complete private file, linked into place only if no record is there.
    const draft = path.join(dir, `${SERVER_RECORD}.${self.pid}.${randomUUID()}`);
    const handle = await open(draft, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let created: { dev: number; ino: number };
    try {
      await handle.writeFile(body);
      await handle.sync();
      const info = await handle.stat();
      created = { dev: info.dev, ino: info.ino };
    } finally {
      await handle.close();
    }
    let linked = false;
    try {
      await link(draft, file);
      linked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        await unlink(draft).catch(() => {});
        throw err;
      }
    }
    await unlink(draft).catch(() => {});
    if (linked) {
      // Verified after creating: the file in place is the one this call made.
      const now = await readRecord(file, uid);
      if (now !== null && now !== "not-a-record" && now.dev === created.dev && now.ino === created.ino && now.text === body) {
        return { owned: true, record: { file, dev: created.dev, ino: created.ino, body }, ...(tookOver ? { tookOver } : {}) };
      }
      continue;
    }
    const held = await readRecord(file, uid);
    if (held === null) continue;
    if (held === "not-a-record" || held.holder === null) return { owned: false, holder: null, problem: "not-a-record" };
    // This process's own record, from an earlier claim in the same process.
    if (held.text === body) return { owned: true, record: { file, dev: held.dev, ino: held.ino, body } };
    if (await running(held.holder)) return { owned: false, holder: held.holder, problem: "held" };
    // Stale: moved to a name of this taker's own, which only one taker can do.
    const aside = path.join(dir, `${SERVER_RECORD}.stale.${self.pid}.${randomUUID()}`);
    try {
      await rename(file, aside);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    const moved = await readRecord(aside, uid);
    if (moved !== null && moved !== "not-a-record" && moved.text === held.text) {
      await unlink(aside).catch(() => {});
      tookOver = held.holder;
      continue;
    }
    // Another taker replaced the stale record first: its record goes back, unless a record is in place again.
    await link(aside, file).catch(() => {});
    await unlink(aside).catch(() => {});
  }
  return { owned: false, holder: null, problem: "contended" };
}

/** Whether `record` is still the file in place, unchanged. */
function stillHeld(record: HeldRecord): boolean {
  try {
    const info = lstatSync(record.file);
    return info.isFile() && info.dev === record.dev && info.ino === record.ino && readFileSync(record.file, "utf8") === record.body;
  } catch {
    return false;
  }
}

/** Removes `record` if it is still this process's own, synchronously, so it completes at shutdown. */
function releaseRecord(record: HeldRecord): void {
  if (!stillHeld(record)) return;
  try {
    unlinkSync(record.file);
  } catch {
    // Left for the next server, which takes it over as stale.
  }
}

/** What a server that does not own its folders tells Home, Settings and the chat. */
export interface ServerRefusal {
  ok: false;
  reason: string;
  guidance: string;
}

/** The real paths of the two folders a server took charge of. */
interface ClaimedFolders {
  dataDir: string;
  agentsRoot: string;
}

type Ownership =
  | {
      owned: true;
      records: HeldRecord[];
      /** The folders the records are in, which this server owns and deletes in. */
      folders: ClaimedFolders;
      /** Where the settings name the two folders now, as the claim read them, or null when either cannot be resolved. */
      resolve: () => Promise<ClaimedFolders | null>;
      /** Whether the replaced record was already logged, so a request-by-request check logs it once. */
      replacedLogged: boolean;
    }
  | ({ owned: false; log: Record<string, unknown> } & Omit<ServerRefusal, "ok">);

const STATE_KEY = Symbol.for("creatorbrio.contained-server");

function state(): { current?: Ownership } {
  const g = globalThis as typeof globalThis & { [STATE_KEY]?: { current?: Ownership } };
  g[STATE_KEY] ??= {};
  return g[STATE_KEY];
}

function refusalFor(folder: OwnedFolder, claim: Extract<RecordClaim, { owned: false }>, dir: string): Ownership {
  const words = FOLDER_WORDS[folder];
  const separate = "To run two servers, give each its own CreatorBrio folder (its own data folder) and its own CREATORBRIO_DESIGN_AGENT_WORKSPACES folder.";
  const log = { folder, name: path.basename(dir), problem: claim.problem, holder: claim.holder?.pid ?? null };
  if (claim.problem === "held") {
    return {
      owned: false,
      log,
      reason: `Another CreatorBrio server (process ${claim.holder!.pid}) is running the contained Design Agent with the same ${words}, so this one does not run designs or delete projects.`,
      guidance: `Stop that server (\`/stop\` in its folder, or end process ${claim.holder!.pid}), then restart this one. ${separate}`,
    };
  }
  if (claim.problem === "not-a-record") {
    return {
      owned: false,
      log,
      reason: `The ${words} hold a file named ${SERVER_RECORD} that is not a record this app writes, so this server does not run the contained Design Agent.`,
      guidance: `Stop any other CreatorBrio server, remove ${SERVER_RECORD} from the ${words}, then restart this one.`,
    };
  }
  return {
    owned: false,
    log,
    reason: `Other CreatorBrio servers kept changing the ${words}' ownership record, so this server does not run the contained Design Agent.`,
    guidance: `Run one server at a time, then restart this one. ${separate}`,
  };
}

/**
 * Takes the ownership records for this server: in the data folder, then in
 * the agent folders' root, giving back the first if the second cannot be
 * taken. Records the outcome for `containedServerStatus`, registers the
 * release with the shutdown hook, and never throws: a failure to take either
 * is an outcome, logged without paths.
 */
export async function claimContainedServer(options: {
  dataDir?: string;
  agentsRoot?: string;
  repoDir?: string;
  self?: ServerIdentity | null;
  probe?: ProcessProbe;
  alive?: (pid: number) => boolean;
  /** How long a claim settles before it is checked once more; for tests. */
  settleMs?: number;
} = {}): Promise<{ owned: boolean }> {
  const store = state();
  const fail = (reason: string, guidance: string, log: Record<string, unknown>) => {
    store.current = { owned: false, reason, guidance, log };
    return { owned: false };
  };
  const records: HeldRecord[] = [];
  try {
    const start = options.self === undefined ? await ownServerStart() : options.self?.start ?? null;
    if (start === null) {
      return fail("This server could not read its own start time, so it does not run the contained Design Agent.", "Check that `ps` works for this account, then restart CreatorBrio.", { problem: "no-start-time" });
    }
    const self = { pid: options.self?.pid ?? process.pid, start };
    const repoDir = options.repoDir ?? process.cwd();
    const dataDir = options.dataDir ?? path.resolve(repoDir, "data");
    await mkdir(dataDir, { recursive: true });
    const agentsRoot = await resolvedRoot(options.agentsRoot ?? agentWorkspaceRoot(), repoDir);
    // The same reading of the settings, kept to compare with later: a server whose settings were changed since it started owns other folders than the ones it would use.
    const resolve = async (): Promise<ClaimedFolders | null> => {
      try {
        return {
          dataDir: await realpath(options.dataDir ?? path.resolve(options.repoDir ?? process.cwd(), "data")),
          agentsRoot: await realpath(options.agentsRoot ?? agentWorkspaceRoot()),
        };
      } catch {
        return null;
      }
    };
    const folders: ClaimedFolders = { dataDir: await realpath(dataDir), agentsRoot };
    const probe = options.probe ?? defaultProbe();
    const running = async (holder: ServerIdentity) => {
      const starts = new Map((await probe.list().catch(() => [])).map((p) => [p.pid, p.start]));
      return serverStillRunning(holder.pid, holder.start, starts, options.alive);
    };
    const settleMs = options.settleMs ?? SETTLE_MS;
    let last: Ownership | null = null;
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_MS + Math.floor(Math.random() * BACKOFF_MS * 4));
      records.length = 0;
      let final = false;
      for (const [folder, dir] of [["data", dataDir], ["agents", agentsRoot]] as const) {
        const claim = await claimRecord(dir, self, running);
        if (!claim.owned) {
          for (const record of records) releaseRecord(record);
          records.length = 0;
          last = refusalFor(folder, claim, dir);
          // The data folder's live holder, or a file that is not a record, is the answer; anything else may be a moment of another server's start.
          final = claim.problem === "not-a-record" || (folder === "data" && claim.problem === "held");
          break;
        }
        if (claim.tookOver) console.info("[design-agent] took over a stale ownership record", { folder, previousPid: claim.tookOver.pid });
        records.push({ ...claim.record, folder });
      }
      if (final) break;
      if (records.length === 0) continue;
      // Settled: only a server whose records are still both its own a moment later owns the folders.
      await sleep(settleMs);
      if (records.every(stillHeld)) {
        store.current = { owned: true, records: [...records], folders, resolve, replacedLogged: false };
        onServerShutdown(releaseContainedServer);
        return { owned: true };
      }
      for (const record of records) releaseRecord(record);
      records.length = 0;
      last = refusalFor("data", { owned: false, holder: null, problem: "contended" }, dataDir);
    }
    store.current = last ?? refusalFor("data", { owned: false, holder: null, problem: "contended" }, dataDir);
    return { owned: false };
  } catch (err) {
    for (const record of records) releaseRecord(record);
    return fail(
      "This server could not take charge of the contained Design Agent's folders.",
      "Check that the data folder and the Design Agent's folders (CREATORBRIO_DESIGN_AGENT_WORKSPACES) are usable, then restart CreatorBrio.",
      { problem: "claim-failed", code: (err as NodeJS.ErrnoException)?.code ?? null, detail: err instanceof AgentWorkspaceError ? err.message : null }
    );
  }
}

/** What the last claim found, for the server log at start: never a path. */
export function containedServerClaimLog(): Record<string, unknown> | null {
  const current = state().current;
  return current && !current.owned ? current.log : null;
}

/**
 * Whether this server may run contained designs and delete projects: it took
 * both records when it started, and both are still its own. Read on every
 * request; a server that never claimed (it started with another profile) or
 * whose record was replaced is refused, never assumed the owner.
 */
export async function containedServerStatus(): Promise<{ ok: true } | ServerRefusal> {
  const current = state().current;
  if (!current) {
    return {
      ok: false,
      reason: "This server did not take charge of the contained Design Agent's folders when it started.",
      guidance: "Restart CreatorBrio with CREATORBRIO_DESIGN_AGENT_PROFILE set to contained.",
    };
  }
  if (!current.owned) return { ok: false, reason: current.reason, guidance: current.guidance };
  const replaced = current.records.filter((record) => !stillHeld(record));
  if (replaced.length > 0) {
    // Read on every request, so it is said once.
    if (!current.replacedLogged) {
      current.replacedLogged = true;
      console.warn("[design-agent] this server's ownership record was replaced, so it no longer runs contained designs or deletes projects", { folders: replaced.map((record) => record.folder ?? "unknown") });
    }
    return {
      ok: false,
      reason: "This server's ownership record for the contained Design Agent's folders was replaced, so it no longer runs designs or deletes projects.",
      guidance: "Stop every CreatorBrio server using these folders, then start one.",
    };
  }
  // The records are in the folders claimed at start; a design or a deletion works in the folders the settings name now.
  const now = await current.resolve();
  if (now === null || now.dataDir !== current.folders.dataDir || now.agentsRoot !== current.folders.agentsRoot) {
    return {
      ok: false,
      reason: "The data folder or the Design Agent's folders are no longer the ones this server took charge of when it started, so it no longer runs designs or deletes projects.",
      guidance: "Restart CreatorBrio after changing CREATORBRIO_DESIGN_AGENT_WORKSPACES, or change the setting back.",
    };
  }
  return { ok: true };
}

/** Gives back this server's records if they are still its own; called once at shutdown. */
export function releaseContainedServer(): void {
  const current = state().current;
  if (!current?.owned) return;
  for (const record of current.records) releaseRecord(record);
  state().current = undefined;
}

/** Forgets this process's ownership without touching any file: for tests that claim in temporary folders. */
export function resetContainedServerForTests(): void {
  state().current = undefined;
}
