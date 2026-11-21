/**
 * The contained Design Agent's folders (#227, #241).
 *
 * Each conversation has its own working folder,
 * `<root>/<carousel id>/<conversation id>`, outside the repository and the
 * data folder. The conversation identifier is a fresh random one, bound to the
 * stored session (`src/lib/agent-sessions.ts`), so a resumed session keeps
 * resolving (the CLI keys sessions by working folder) and a new conversation
 * never runs in a folder an earlier run could write. A new conversation moves
 * the carousel's previous conversation folders into quarantine whole and
 * starts in a new one; nothing is emptied in place. The carousel's folder,
 * with every conversation and staged image, is removed with the carousel.
 *
 * Each run also gets its own short temporary folder, which the CLI gives the
 * sandboxed shell instead of the shared per-user one (see
 * `MAX_AGENT_TEMP_PATH_BYTES`). Run folders live directly under one parent
 * per user (`serverTempRoot`), so the contained profile can read-deny the
 * parent and re-allow only the run's own folder. The path must fit the CLI's
 * limit for any user id, so a run folder's name is three characters and its
 * owner is recorded beside it: each server process has a folder in the parent
 * (`.s<process id>`) holding a marker per run it owns, written before the run
 * folder exists and removed after it is gone, so a later server can tell a
 * dead server's leftovers from a live one's. The Visual Director's image
 * copies for a contained design live in the server's folder, out of the
 * shell's reach.
 *
 * The images the agent is told to view are copied (never linked: a link would
 * be a writable second name for an upload) into a staging folder beside the
 * conversation's, because the uploads folder lives in the repository, which
 * the agent cannot read. The agent may read the staging folder but never
 * write it, so nothing it does can redirect the server's copies.
 *
 * A process the agent starts can outlive its run on macOS, and the agent can
 * write its own folders, so the server never deletes inside them in place: a
 * recursive delete walks paths, and a process that swaps a folder for a link
 * mid-delete would turn it into a delete of the link's target. Each such
 * folder is first renamed into a quarantine folder (`.removed`) that the agent
 * cannot write, and deleted there, restoring permissions and, on macOS,
 * clearing user immutable flags when a plain delete fails. On macOS the
 * sandbox's write rules follow paths, so the rename ends a surviving
 * process's access; on Linux nothing the agent started survives its run, and
 * a folder is never removed while its run is live (see the carousel delete
 * route). What could not be deleted stays in quarantine for the sweep at the
 * next server start (`sweepLeftoverFolders`).
 */
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentTempDirFits } from "@/lib/design-agent-profile";

export const AGENT_WORKSPACES_ENV = "CREATORBRIO_DESIGN_AGENT_WORKSPACES";

const SERVER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AgentWorkspaceError extends Error {}

/** A bound conversation whose folder no longer exists: the session cannot be resumed. */
export class ConversationGoneError extends AgentWorkspaceError {}

/** The folder that holds every carousel's folders; an operator may move it with an absolute path. */
export function agentWorkspaceRoot(env: Record<string, string | undefined> = process.env): string {
  const configured = env[AGENT_WORKSPACES_ENV]?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) throw new AgentWorkspaceError(`${AGENT_WORKSPACES_ENV} must be an absolute path.`);
    return path.resolve(configured);
  }
  return path.join(os.homedir(), ".creatorbrio", "design-agent");
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Whether a name is a server-generated identifier (a carousel's or a conversation's). */
export function isServerId(value: unknown): value is string {
  return typeof value === "string" && SERVER_ID.test(value);
}

/** Refuses a folder that is a link, not a folder, or resolves anywhere else. */
async function assertPlainDir(dir: string, what: string): Promise<void> {
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(dir)) !== dir) {
    throw new AgentWorkspaceError(`${what} is not a plain folder.`);
  }
}

/** Creates a folder owner-only if it is missing; an existing one is kept. */
async function mkdirPrivate(dir: string): Promise<void> {
  await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
}

/** The resolved root, created owner-only on first use, refused inside the repository or around it. */
async function resolvedRoot(root: string, repoDir: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  const realRepo = await realpath(repoDir);
  if (isInside(realRoot, realRepo) || isInside(realRepo, realRoot)) {
    throw new AgentWorkspaceError("The Design Agent's folders must be outside the repository.");
  }
  return realRoot;
}

const QUARANTINE = ".removed";
const STAGING = ".staged";

/**
 * Starts a new conversation for a carousel: every earlier conversation folder
 * is moved into quarantine whole (and deleted there), the earlier staged
 * images are removed, and a fresh, owner-only folder with a new identifier is
 * created. A folder that cannot be moved is reported and left, and the new
 * conversation still starts, in a folder no earlier run could write. The
 * identifier is random; the qualification names one in advance.
 */
export async function startConversation(carouselId: string, repoDir: string, root = agentWorkspaceRoot(), conversationId: string = randomUUID()): Promise<string> {
  if (!isServerId(carouselId) || !isServerId(conversationId)) throw new AgentWorkspaceError("Not a conversation identifier.");
  const realRoot = await resolvedRoot(root, repoDir);
  const carouselDir = path.join(realRoot, carouselId);
  await mkdirPrivate(carouselDir);
  await assertPlainDir(carouselDir, "The carousel's folder");
  const earlier = await readdir(carouselDir);
  // A conversation's path is never used twice.
  if (earlier.includes(conversationId)) throw new AgentWorkspaceError("That conversation folder was used before.");
  for (const name of earlier) {
    if (name === STAGING) continue;
    await removeAgentWritable(path.join(carouselDir, name), realRoot).catch(logLeftBehind(name, "a previous conversation's folder"));
  }
  // Only the server writes the staging folder, so it is deleted directly.
  await rm(path.join(carouselDir, STAGING), { recursive: true, force: true });
  const dir = path.join(carouselDir, conversationId);
  // Never an existing folder: a name collision is an error, not a reuse.
  await mkdir(dir, { mode: 0o700 });
  await assertPlainDir(dir, "The conversation's folder");
  return dir;
}

/**
 * The folder of a conversation bound to a resumed session. It is never
 * created: a folder that is gone was quarantined, and recreating it would
 * give a process an earlier run left behind its old path again.
 */
export async function openConversation(carouselId: string, conversationId: string, repoDir: string, root = agentWorkspaceRoot()): Promise<string> {
  if (!isServerId(carouselId) || !isServerId(conversationId)) throw new AgentWorkspaceError("Not a conversation identifier.");
  const realRoot = await resolvedRoot(root, repoDir);
  const carouselDir = path.join(realRoot, carouselId);
  const dir = path.join(carouselDir, conversationId);
  try {
    await lstat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ConversationGoneError("The conversation's folder no longer exists.");
    throw err;
  }
  await assertPlainDir(carouselDir, "The carousel's folder");
  await assertPlainDir(dir, "The conversation's folder");
  return dir;
}

/** The server-only folder of the images a conversation's agent may view, beside its working folder. */
export function stagingDirFor(workDir: string): string {
  return path.join(path.dirname(workDir), STAGING, path.basename(workDir));
}

/**
 * Removes a folder or file the agent could write, without ever deleting in
 * place: it is renamed into the quarantine folder under `root` and deleted
 * there. Where it cannot be renamed (another file system), it is deleted in
 * place only on Linux, where nothing the agent started outlives its run, and
 * otherwise left behind and reported. What cannot be deleted in quarantine
 * stays there for the next sweep and is reported, never thrown. Nothing is
 * created when there is nothing to remove, so the legacy profile, which has
 * no such folders, never gets one.
 */
export async function removeAgentWritable(target: string, root: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const moved = await quarantine(target, root, platform);
  if (moved) await purgeQuarantined(moved, platform);
}

/** The rename half of `removeAgentWritable`: the quarantined path, or null when nothing is left to delete. */
async function quarantine(target: string, root: string, platform: NodeJS.Platform): Promise<string | null> {
  try {
    await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const bin = path.join(root, QUARANTINE);
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const moved = path.join(bin, randomUUID());
  try {
    await rename(target, moved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code === "EXDEV" && platform === "linux") {
      await rm(target, { recursive: true, force: true });
      return null;
    }
    throw err;
  }
  return moved;
}

/**
 * Deletes one entry already in quarantine, which the agent cannot write. A
 * plain delete comes first; if it fails, permissions are restored (owner
 * read, write and search on every real folder, never following a link) and,
 * on macOS, the user immutable and append-only flags are cleared, then it is
 * deleted again. What still cannot be deleted is logged by name only.
 */
export async function purgeQuarantined(entry: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  try {
    await rm(entry, { recursive: true, force: true });
    return true;
  } catch {
    // Restored below, then tried once more.
  }
  await restoreForRemoval(entry, platform);
  try {
    await rm(entry, { recursive: true, force: true });
    return true;
  } catch (err) {
    logLeftBehind(path.basename(entry), "a quarantined folder")(err);
    return false;
  }
}

async function clearUserFlags(paths: string[]): Promise<void> {
  // In batches, to stay within the argument list limit; `-h` changes a link itself, never what it points to.
  for (let i = 0; i < paths.length; i += 256) {
    const batch = paths.slice(i, i + 256);
    await new Promise<void>((resolve) => execFile("chflags", ["-h", "nouchg,nouappnd", "--", ...batch], { timeout: 10_000 }, () => resolve()));
  }
}

async function restoreForRemoval(entry: string, platform: NodeJS.Platform): Promise<void> {
  let info;
  try {
    info = await lstat(entry);
  } catch {
    return;
  }
  if (platform === "darwin") await clearUserFlags([entry]);
  if (!info.isDirectory() || info.isSymbolicLink()) return;
  await chmod(entry, (info.mode & 0o7777) | 0o700).catch(() => {});
  let names: string[];
  try {
    names = await readdir(entry);
  } catch {
    return;
  }
  const children = names.map((name) => path.join(entry, name));
  // One call per folder for its entries' flags; folders are then restored one by one.
  if (platform === "darwin" && children.length > 0) await clearUserFlags(children);
  for (const child of children) {
    const childInfo = await lstat(child).catch(() => null);
    if (childInfo?.isDirectory() && !childInfo.isSymbolicLink()) await restoreForRemoval(child, platform);
  }
}

/** Removes a carousel's folder, with every conversation and staged image, if it has one; called when the carousel is deleted. */
export async function removeCarouselWorkDir(carouselId: string, root = agentWorkspaceRoot()): Promise<void> {
  if (!isServerId(carouselId)) return;
  await removeAgentWritable(path.join(root, carouselId), root);
}

/**
 * The test seam for the parent: tests set it to a folder of their own, so
 * no test touches the real one. Never set outside tests.
 */
export const SERVER_TEMP_ROOT_OVERRIDE = Symbol.for("creatorbrio.server-temp-root");

/**
 * The real per-user parent, whatever a test has set: `cb` and the user id in
 * base 36 under `/tmp` (on macOS its real path, `/private/tmp`). Base 36 keeps
 * any 32-bit user id to seven characters, so a run's temporary folder fits the
 * CLI's limit with the longest user id (see `RUN_DIR_NAME`).
 */
export function systemServerTempRoot(platform: NodeJS.Platform = process.platform, uid: number = currentUid()): string {
  return `${platform === "darwin" ? "/private/tmp" : "/tmp"}/cb${uid.toString(36)}`;
}

/**
 * The parent of every run's temporary folder and of the Visual Director's
 * image copies for a contained design: one per user, private to them, which
 * the contained profile read-denies.
 */
export function serverTempRoot(platform: NodeJS.Platform = process.platform, uid: number = currentUid()): string {
  const override = (globalThis as Record<symbol, unknown>)[SERVER_TEMP_ROOT_OVERRIDE];
  return typeof override === "string" ? override : systemServerTempRoot(platform, uid);
}

function currentUid(): number {
  return process.getuid?.() ?? 0;
}

/** This server process's folder in the parent, named by its process id. */
export function serverTempDirName(pid: number = process.pid): string {
  return `.s${pid.toString(36)}`;
}

const SERVER_DIR_NAME = /^\.s([0-9a-z]{1,8})$/;
/** A run's temporary folder: three characters, so the longest user id still fits the CLI's limit. */
const RUN_DIR_NAME = /^[0-9a-z]{3}$/;
const RUN_MARKER = /^run-([0-9a-z]{3})$/;
const runMarker = (name: string) => `run-${name}`;

/**
 * Creates (or verifies) a folder that must belong to this user alone: a real
 * folder, never a link, owned by `uid`, with no group or other access. One
 * that exists with another owner or wider access is refused, never adopted.
 */
async function ensurePrivateDir(dir: string, uid: number): Promise<void> {
  await mkdirPrivate(dir);
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0 || (await realpath(dir)) !== dir) {
    throw new AgentWorkspaceError("A server temporary folder is not a private folder of this user.");
  }
}

const LIVE_KEY = Symbol.for("creatorbrio.server-temp-live");

/** Every server temporary folder this process created and has not removed, which the sweep never touches. */
function liveTemp(): Set<string> {
  const store = globalThis as typeof globalThis & { [LIVE_KEY]?: Set<string> };
  store[LIVE_KEY] ??= new Set();
  return store[LIVE_KEY];
}

/** The verified parent and this server's verified folder in it. */
async function serverDirs(uid: number, platform: NodeJS.Platform, parent?: string): Promise<{ root: string; own: string }> {
  const root = parent ?? serverTempRoot(platform, uid);
  await ensurePrivateDir(root, uid);
  const own = path.join(root, serverTempDirName());
  await ensurePrivateDir(own, uid);
  return { root, own };
}

/**
 * A fresh, owner-only folder for server-only files (the Visual Director's
 * image copies) in this server's own folder, which the agent can never reach.
 */
export async function createServerTempDir(prefix: string, uid: number, platform: NodeJS.Platform = process.platform, parent?: string): Promise<string> {
  const { own } = await serverDirs(uid, platform, parent);
  const dir = await mkdtemp(path.join(own, prefix));
  liveTemp().add(dir);
  return dir;
}

/** Removes a server-only temporary folder (one the agent can never write) and forgets it. */
export async function removeServerTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  liveTemp().delete(dir);
}

/**
 * A fresh, owner-only temporary folder for one run, directly in the parent,
 * short enough that the CLI gives it to the sandboxed shell. Its marker in
 * this server's folder is written first, so the folder never exists without
 * a recorded owner.
 */
export async function createRunTempDir(uid: number, platform: NodeJS.Platform = process.platform, parent?: string): Promise<string> {
  const { root, own } = await serverDirs(uid, platform, parent);
  for (let attempt = 0; attempt < 64; attempt++) {
    const name = randomRunName();
    const marker = path.join(own, runMarker(name));
    try {
      await (await open(marker, "wx", 0o600)).close();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    const dir = path.join(root, name);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (err) {
      await rm(marker, { force: true });
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw err;
    }
    liveTemp().add(dir);
    if (!agentTempDirFits(dir, uid)) {
      await removeRunTempDir(dir, platform);
      throw new AgentWorkspaceError("The run's temporary folder path is too long for the CLI to use.");
    }
    return dir;
  }
  throw new AgentWorkspaceError("No free name for the run's temporary folder.");
}

function randomRunName(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  return Array.from({ length: 3 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

/**
 * Removes the run's temporary folder, which the agent could write, through
 * the quarantine in the parent, then its marker.
 */
export async function removeRunTempDir(dir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const root = path.dirname(dir);
  await removeAgentWritable(dir, root, platform);
  await rm(path.join(root, serverTempDirName(), runMarker(path.basename(dir))), { force: true });
  liveTemp().delete(dir);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Which server folder holds each run's marker, read afresh. */
async function runOwners(root: string, serverNames: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const server of serverNames) {
    for (const child of await readdir(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ root, server)).catch(() => [] as string[])) {
      const m = RUN_MARKER.exec(child);
      if (m) owners.set(m[1], server);
    }
  }
  return owners;
}

/**
 * Removes what earlier servers and runs left behind: in the parent, the run
 * folders and server folder of every server process that is no longer
 * running, the entries of this process's own folder that no live run or plan
 * owns, run folders no server owns, and everything in its quarantine; and
 * everything in the agent folders' quarantine. A server process still running
 * keeps its folder and runs. Nothing is created, a parent that is not this
 * user's private folder is left alone, and what cannot be removed is logged by
 * name and retried at the next start.
 *
 * It resolves once every leftover is moved into quarantine, which is quick,
 * with `purged` settling when the quarantines are deleted; the server awaits
 * only the first, so no run can start while its folders are being judged.
 */
export async function sweepLeftoverFolders(options: {
  tempRoot?: string;
  workspaceRoot?: string | null;
  uid?: number;
  pid?: number;
  alive?: (pid: number) => boolean;
  platform?: NodeJS.Platform;
} = {}): Promise<{ purged: Promise<void> }> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? currentUid();
  const tempRoot = options.tempRoot ?? serverTempRoot(platform, uid);
  const ownPid = options.pid ?? process.pid;
  const alive = options.alive ?? isAlive;
  const live = liveTemp();
  const bins: string[] = [];

  const tempInfo = await lstat(tempRoot).catch(() => null);
  if (tempInfo) {
    if (!tempInfo.isDirectory() || tempInfo.isSymbolicLink() || tempInfo.uid !== uid || (tempInfo.mode & 0o077) !== 0) {
      console.error("[design-agent] the server temporary folder is not a private folder of this user; it was not swept", { folder: path.basename(tempRoot) });
    } else {
      bins.push(path.join(tempRoot, QUARANTINE));
      const at = (name: string) => path.join(/*turbopackIgnore: true*/ tempRoot, name);
      const move = (target: string, name: string) => quarantine(target, tempRoot, platform).catch(logLeftBehind(name, "a leftover temporary folder"));
      // The parent is listed before the server folders: a run folder is made
      // only after its marker, so every run listed here that a server owns
      // has its marker in place when the markers are read.
      const entries = await readdir(/*turbopackIgnore: true*/ tempRoot).catch(() => [] as string[]);
      const servers = entries.filter((name) => SERVER_DIR_NAME.test(name));
      const runs = entries.filter((name) => RUN_DIR_NAME.test(name));
      const owners = await runOwners(tempRoot, servers);
      for (const server of servers) {
        const pid = parseInt(SERVER_DIR_NAME.exec(server)![1], 36);
        const serverDir = at(server);
        if (pid === ownPid) {
          // This process's own folder can hold leftovers only from an earlier
          // server that had the same process id; what it now runs is kept.
          for (const child of await readdir(/*turbopackIgnore: true*/ serverDir).catch(() => [] as string[])) {
            const run = RUN_MARKER.exec(child)?.[1];
            if (run !== undefined) {
              if (live.has(at(run))) continue;
              await move(at(run), run);
              await rm(path.join(/*turbopackIgnore: true*/ serverDir, child), { force: true }).catch(logLeftBehind(child, "a leftover run marker"));
            } else if (!live.has(path.join(/*turbopackIgnore: true*/ serverDir, child))) {
              await move(path.join(/*turbopackIgnore: true*/ serverDir, child), child);
            }
          }
        } else if (!alive(pid)) {
          for (const [run, owner] of owners) if (owner === server) await move(at(run), run);
          await move(serverDir, server);
        }
      }
      // A run folder with no marker anywhere was left by a server whose
      // folder is gone. The markers are read again first, so a run another
      // server started meanwhile is never taken.
      const unowned = runs.filter((run) => !owners.has(run));
      if (unowned.length > 0) {
        const again = await runOwners(tempRoot, (await readdir(/*turbopackIgnore: true*/ tempRoot).catch(() => [] as string[])).filter((name) => SERVER_DIR_NAME.test(name)));
        for (const run of unowned) if (!again.has(run) && !live.has(at(run))) await move(at(run), run);
      }
    }
  }

  if (options.workspaceRoot !== null) {
    try {
      bins.push(path.join(options.workspaceRoot ?? agentWorkspaceRoot(), QUARANTINE));
    } catch {
      // No usable agent folder setting: the chat reports it when a design starts.
    }
  }
  const purged = (async () => {
    for (const bin of bins) await purgeChildren(bin, platform);
  })().catch((err) => logLeftBehind(QUARANTINE, "the quarantine")(err));
  return { purged };
}

async function purgeChildren(bin: string, platform: NodeJS.Platform): Promise<void> {
  const info = await lstat(bin).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) return;
  for (const name of await readdir(bin).catch(() => [] as string[])) await purgeQuarantined(path.join(bin, name), platform);
}

/** A folder that could not be removed stays on disk; it is reported by name, never silently left. */
function logLeftBehind(name: string, what: string) {
  return (err: unknown) => {
    console.error(`[design-agent] could not remove ${what}`, { folder: name, code: (err as NodeJS.ErrnoException)?.code ?? null });
  };
}

const UPLOAD_NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,127}\\.(?:png|jpe?g|webp)";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites every path into the uploads folder named in the agent's
 * instructions to its copy in the staging folder, and copies exactly those
 * files there. A name that is not a plain upload file, or a source that is not
 * a regular file, is not copied, and its path is left unchanged, so the agent
 * is refused it rather than shown something else.
 */
export async function stageUploadsForAgent(
  texts: string[],
  uploadsDirs: string | string[],
  stagingDir: string
): Promise<string[]> {
  // Every spelling of the uploads folder (a path and its resolved form) in one
  // pass, so the staging folder is rebuilt once per run.
  const spellings = [...new Set(typeof uploadsDirs === "string" ? [uploadsDirs] : uploadsDirs)];
  const uploadsDir = spellings[0];
  const pattern = new RegExp(
    `(?:${spellings.map((d) => escapeRegExp(d.endsWith(path.sep) ? d : d + path.sep)).join("|")})(${UPLOAD_NAME})`,
    "g"
  );
  const names = new Set<string>();
  for (const text of texts) for (const match of text.matchAll(pattern)) names.add(match[1]);
  if (names.size === 0) return texts;
  const target = stagingDir;
  // Only the server writes it. It keeps what earlier turns of the
  // conversation staged, and is removed when a new conversation starts.
  await mkdir(target, { recursive: true, mode: 0o700 });
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(target)) !== target) {
    throw new AgentWorkspaceError("The staging folder is not a plain folder.");
  }
  const staged = new Set<string>();
  for (const name of names) {
    const source = path.join(uploadsDir, name);
    try {
      const info = await lstat(source);
      if (!info.isFile()) continue;
      // COPYFILE_FICLONE may share blocks on copy-on-write file systems, but
      // the copy is a separate file: writing it never changes the upload.
      // COPYFILE_EXCL refuses an existing name, a link included, instead of following it.
      await copyFile(source, path.join(target, name), constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE).catch((err: NodeJS.ErrnoException) => {
        // Staged by an earlier turn: an upload's name never changes its content.
        if (err.code !== "EEXIST") throw err;
      });
      staged.add(name);
    } catch {
      // Missing or unreadable: left unstaged, and the agent cannot read it.
    }
  }
  return texts.map((text) => text.replace(pattern, (whole, name: string) => (staged.has(name) ? path.join(target, name) : whole)));
}
