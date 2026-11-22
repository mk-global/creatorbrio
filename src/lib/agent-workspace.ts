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
 * limit, so a run folder's random name fills what the budget leaves for this
 * parent and user id (`runDirNameLength`): at about ten characters or more a
 * name is not drawn twice in practice, which matters because on macOS a
 * surviving process keeps its sandbox's access to the path it was given. With
 * the shorter names that larger user ids leave (five characters or fewer from
 * about 100 million on macOS, and a floor of three, all that fits for the
 * longest user ids) a later run can draw a name an earlier run held. Each
 * run's owner is recorded beside it: each server process has a folder in the
 * parent (`.s<process id>`) holding the server's start time and a marker per
 * run it owns, written before the run folder exists and removed after it is
 * gone, so a later server can tell a dead server's leftovers from a live
 * one's. The Visual Director's image copies for a contained design live in
 * the server's folder, out of the shell's reach.
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
 * route). That exclusion is the run slot, which lives in one server process's
 * memory, so it holds within one server process, and only one contained
 * server at a time owns the data and agent folders (`claimContainedServer`,
 * src/lib/contained-server.ts, #246). What could not be deleted stays in quarantine for
 * the sweep at the next server start (`sweepLeftoverFolders`), which first
 * stops the processes earlier servers' runs left working in these folders.
 */
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stopStrayProcesses, defaultProbe, type ProcessProbe } from "@/lib/agent-processes";
import { agentTempDirFits, MAX_AGENT_TEMP_PATH_BYTES } from "@/lib/design-agent-profile";

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
export async function resolvedRoot(root: string, repoDir: string): Promise<string> {
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
    await removeAgentWritable(path.join(carouselDir, name), realRoot).catch(logLeftBehind(name, "a previous conversation's folder", { carouselId }));
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

/**
 * Whether a conversation's folder still exists, for a resume to be refused
 * before anything is planned when it does not. Only a folder known to be gone
 * counts as missing: when this cannot tell (an unusable setting, a folder it
 * may not look at) it says yes, and the launch reports the cause.
 */
export async function conversationFolderExists(carouselId: string, conversationId: string, root?: string): Promise<boolean> {
  if (!isServerId(carouselId) || !isServerId(conversationId)) return false;
  try {
    await lstat(path.join(root ?? agentWorkspaceRoot(), carouselId, conversationId));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
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
  // Never into a folder another user, or the group, could reach.
  if (!isPrivateDir(await lstat(bin).catch(() => null), currentUid())) throw new AgentWorkspaceError("The quarantine folder is not a private folder of this user.");
  const moved = path.join(bin, randomUUID());
  try {
    try {
      await rename(target, moved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM" || platform !== "darwin") throw err;
      // The agent can make its own folder user-immutable, which cannot be renamed. The
      // folder's parent is the server's, so the flags are cleared (`-h`: never through a
      // link) and the move is tried once more.
      await clearUserFlags([target]);
      await rename(target, moved);
    }
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

/**
 * Linux's O_PATH (the same on x86-64, arm64 and the other common architectures):
 * a handle on a folder that needs no permission on it, which Node does not name.
 */
const O_PATH = 0o10000000;

/**
 * Adds owner read, write and search to a real folder without ever following a
 * link, keeping every other bit it has.
 *
 * The folder is opened with O_NOFOLLOW and changed through the handle. A
 * folder without read permission cannot be opened that way, so then: on macOS
 * `chmod -h` changes it by path without following a link; on Linux it is opened
 * with O_PATH (which needs no permission on it) and changed through that
 * handle's own entry in `/proc/self/fd`, so a link swapped in meanwhile is not
 * followed either. Where neither is available it is changed by path only after
 * it has been seen to be a real folder, and nothing is changed when it cannot
 * be looked at. Never throws: a folder that cannot be restored is deleted, or
 * reported, by the caller. `skipOpen` goes straight to the second way, for tests.
 */
export async function allowOwner(entry: string, platform: NodeJS.Platform = process.platform, options: { skipOpen?: boolean } = {}): Promise<void> {
  try {
    if (!options.skipOpen) {
      const handle = await open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        await handle.chmod(((await handle.stat()).mode & 0o7777) | 0o700);
      } finally {
        await handle.close().catch(() => {});
      }
      return;
    }
  } catch (err) {
    // Gone, replaced by a link or no longer a folder: nothing to restore. Only a folder without read permission takes the other way.
    if ((err as NodeJS.ErrnoException).code !== "EACCES") return;
  }
  try {
    if (platform === "darwin") {
      await new Promise<void>((resolve) => execFile("chmod", ["-h", "u+rwx", entry], { timeout: 10_000 }, () => resolve()));
      return;
    }
    if (platform === "linux" && ["x64", "arm64", "riscv64"].includes(process.arch)) {
      try {
        const handle = await open(entry, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          await chmod(`/proc/self/fd/${handle.fd}`, ((await handle.stat()).mode & 0o7777) | 0o700);
        } finally {
          await handle.close().catch(() => {});
        }
        return;
      } catch (err) {
        // A link or something gone is not a folder to restore; anything else (no O_PATH here) is left to the check below.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") return;
      }
    }
    const info = await lstat(entry);
    if (!info.isDirectory() || info.isSymbolicLink()) return;
    await chmod(entry, (info.mode & 0o7777) | 0o700);
  } catch {
    // Cannot be looked at or changed: left as it is.
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
  await allowOwner(entry, platform);
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

/** The server-owned home folder's name in the agent folders' root: a dot-name, which no carousel's identifier can be. */
const AGENT_HOME = ".home";

/** The contained CLI's server-owned home folder under the agent folders' root (#242). */
export function agentHomeDir(root: string): string {
  return path.join(root, AGENT_HOME);
}

/**
 * The shell startup files a shell reads from its home folder: the
 * server-owned home must hold none, or the CLI's shell preparation would run
 * them before each command (#242).
 */
export const HOME_STARTUP_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout", ".profile", ".bash_profile", ".bash_login", ".bashrc", ".bash_logout", ".bash_aliases"] as const;

/**
 * The contained CLI's home folder (#242): one per person, under the agent
 * folders' root, so it is outside the repository and the data folder, kept
 * across server restarts (the CLI keeps its sessions under it, which a
 * resumed conversation needs), and read-denied to the agent's shell with the
 * rest of that root.
 *
 * It is created owner-only and never followed through a link; one that exists
 * with another owner, wider access or as a link is refused, never adopted. It
 * holds no shell startup file, so the CLI's shell preparation runs nothing of
 * the person's: one found there is refused, never deleted, because the server
 * never writes one. The empty files the CLI's sandbox leaves in their place
 * on Linux define nothing and are kept.
 *
 * It holds nothing of the person's (#246): the contained CLI signs in with a
 * token of its own (`src/lib/agent-sign-in.ts`), never through the person's
 * keychain or credentials file. A home made under #242 holds, on macOS,
 * `Library/Keychains`, a link to the person's keychain folder, which the server
 * made; that link is removed (the link itself, never what it points to), and
 * anything else in its place is refused.
 */
export async function prepareAgentHome(input: {
  repoDir: string;
  /** The person's own home folder, resolved. */
  personHome: string;
  root?: string;
  uid?: number;
}): Promise<string> {
  const uid = input.uid ?? currentUid();
  const realRoot = await resolvedRoot(input.root ?? agentWorkspaceRoot(), input.repoDir);
  const dir = agentHomeDir(realRoot);
  await ensurePrivateDir(dir, uid, "The Design Agent's home folder");
  for (const name of HOME_STARTUP_FILES) {
    const info = await lstat(path.join(dir, name)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    // On Linux the CLI's sandbox leaves an empty file in place of each startup
    // file it keeps the shell from writing (measured on 2.1.328); an empty
    // regular file defines nothing. Anything else is refused.
    if (info !== null && !(info.isFile() && info.size === 0)) {
      throw new AgentWorkspaceError(`The Design Agent's home folder holds a shell startup file (${name}), which the server never writes. Remove it and try again.`);
    }
  }
  await removeKeychainLink(dir, input.personHome, uid);
  return dir;
}

/**
 * Removes the link to the person's keychain folder that a home made under
 * #242 holds on macOS (`Library/Keychains`), and the then empty `Library`
 * the server made for it. Only the exact link the server made is removed, by
 * unlinking it, so its target is never followed or touched; any other entry
 * there is refused, never removed. Checked on every platform, since the home
 * may have been made on another.
 */
async function removeKeychainLink(home: string, personHome: string, uid: number): Promise<void> {
  const library = path.join(home, "Library");
  const libraryInfo = await lstat(library).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (libraryInfo === null) return;
  if (!isPrivateDir(libraryInfo, uid)) {
    throw new AgentWorkspaceError("The Design Agent's home folder's Library is not a folder the server made. Remove it and try again.");
  }
  const link = path.join(library, "Keychains");
  const info = await lstat(link).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (info !== null) {
    if (!info.isSymbolicLink() || (await readlink(link)) !== path.join(personHome, "Library", "Keychains")) {
      throw new AgentWorkspaceError("The Design Agent's home folder's Library/Keychains is not the link the server made. Remove it and try again.");
    }
    await unlink(link);
  }
  // Empty unless the CLI keeps something there; then it stays.
  await rmdir(library).catch(() => {});
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
/** The shortest a run folder's name is: all that fits for the longest user ids on macOS (ten digits). */
const RUN_NAME_MIN = 3;
/** The longest: all that fits for user id 0 under Linux's `/tmp/cb0`, the shortest parent there is. */
const RUN_NAME_MAX = 26;
const RUN_DIR_NAME = /^[0-9a-z]{3,26}$/;
const RUN_MARKER = /^run-([0-9a-z]{3,26})$/;
const runMarker = (name: string) => `run-${name}`;
/** The file in a server's folder that holds the server's start time, which tells it from a later process that reuses its id. */
const SERVER_START_FILE = ".start";

/**
 * How many characters a run folder's name has under `root` for this user id:
 * what is left of the CLI's temporary path budget once the parent, the
 * separators and `claude-<user id>` are counted, never fewer than three. Every
 * 32-bit user id keeps at least three on both platforms.
 */
export function runDirNameLength(root: string, uid: number): number {
  const fixed = Buffer.byteLength(path.join(root, "x", `claude-${uid}`)) - 1;
  return Math.min(RUN_NAME_MAX, Math.max(RUN_NAME_MIN, MAX_AGENT_TEMP_PATH_BYTES - fixed));
}

/**
 * Creates (or verifies) a folder that must belong to this user alone: a real
 * folder, never a link, owned by `uid`, with no group or other access. One
 * that exists with another owner or wider access is refused, never adopted.
 */
async function ensurePrivateDir(dir: string, uid: number, what = "The server temporary folder"): Promise<void> {
  await mkdirPrivate(dir);
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077) !== 0 || (await realpath(dir)) !== dir) {
    throw new AgentWorkspaceError(
      `${what} "${path.basename(dir)}" is not a private folder of this user (a real folder, owned by this user, with no group or other access). Remove it, or fix its owner and permissions, and try again.`
    );
  }
}

const LIVE_KEY = Symbol.for("creatorbrio.server-temp-live");

/** Every server temporary folder this process created and has not removed, which the sweep never touches. */
function liveTemp(): Set<string> {
  const store = globalThis as typeof globalThis & { [LIVE_KEY]?: Set<string> };
  store[LIVE_KEY] ??= new Set();
  return store[LIVE_KEY];
}

const START_KEY = Symbol.for("creatorbrio.server-temp-start");

interface StartRecord {
  /** This process's own start time, as the process table prints it, read once; null when it cannot be read. */
  start: Promise<string | null>;
  /** The folders it has written that time into. */
  written: Set<string>;
}

function startRecord(): StartRecord {
  const store = globalThis as typeof globalThis & { [START_KEY]?: StartRecord };
  store[START_KEY] ??= {
    start: defaultProbe()
      .list()
      .then((table) => table.find((p) => p.pid === process.pid)?.start ?? null)
      .catch(() => null),
    written: new Set(),
  };
  return store[START_KEY];
}

/**
 * This process's start time as the process table prints it, read once, or
 * null when it cannot be read: what a server folder records (below), and what
 * a contained server's ownership record holds (`src/lib/contained-server.ts`).
 */
export function ownServerStart(): Promise<string | null> {
  return startRecord().start;
}

/**
 * Whether the server process recorded as `pid`, with the start time
 * `recorded` (null when it was not recorded), is still running: its id is
 * alive and, when both the recorded start and its current one (`starts`, from
 * one read of the process table) are known, they are the same, so an id a
 * later process has reused is a dead server's. When either is unknown, an
 * alive id counts as running.
 */
export function serverStillRunning(pid: number, recorded: string | null, starts: ReadonlyMap<number, string>, alive: (pid: number) => boolean = isAlive): boolean {
  if (!alive(pid)) return false;
  const current = starts.get(pid);
  return !(recorded !== null && current !== undefined && recorded.trim() !== current);
}

/** Records this process's start time in its folder, once, so a later server can tell it from a process that reuses its id. */
async function recordServerStart(own: string): Promise<void> {
  const record = startRecord();
  const file = path.join(own, SERVER_START_FILE);
  if (record.written.has(own) && (await lstat(file).then(() => true, () => false))) return;
  const start = await record.start;
  if (start === null) return;
  // Never through a link: the folder is verified private, and the name is never followed.
  await writeFile(file, start, { mode: 0o600, flag: constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW });
  record.written.add(own);
}

/** The verified parent and this server's verified folder in it. */
async function serverDirs(uid: number, platform: NodeJS.Platform, parent?: string): Promise<{ root: string; own: string }> {
  const root = parent ?? serverTempRoot(platform, uid);
  await ensurePrivateDir(root, uid);
  const own = path.join(root, serverTempDirName());
  await ensurePrivateDir(own, uid);
  // Best effort: without it a later server treats this one as running while its process id is alive, as before.
  await recordServerStart(own).catch(() => {});
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
    const name = randomRunName(runDirNameLength(root, uid));
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

function randomRunName(length: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  return Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
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
 * Whether a working folder is one the contained profile's server makes: under
 * the agent folders, `<carousel id>/<conversation id>`, `<carousel id>/.staged`
 * or the removal folder; under the temporary parent, a run folder, a server
 * folder or its removal folder. Anything else under a configured folder, such
 * as a person's own files, is never taken for a run's.
 */
function isContainedWorkingFolder(cwd: string, roots: { workspace: string | null; temp: string | null }): boolean {
  const below = (root: string | null): string[] | null => {
    if (root === null) return null;
    const rel = path.relative(root, cwd);
    return rel === "" || rel.startsWith("..") || path.isAbsolute(rel) ? null : rel.split(path.sep);
  };
  const work = below(roots.workspace);
  if (work) {
    const [first, second] = work;
    if (first === QUARANTINE) return true;
    if (SERVER_ID.test(first) && (second === undefined || second === STAGING || SERVER_ID.test(second))) return true;
  }
  const temp = below(roots.temp);
  if (temp) {
    const [first] = temp;
    if (first === QUARANTINE || RUN_DIR_NAME.test(first) || SERVER_DIR_NAME.test(first)) return true;
  }
  return false;
}

/**
 * The agent folders' root as the sweep may use it: absolute and outside the
 * repository, as `resolvedRoot` requires, and real. Null (with a log) for a
 * setting it refuses, or one that does not exist yet.
 */
async function sweepableWorkspaceRoot(configured: string | undefined, repoDir: string): Promise<string | null> {
  let root: string;
  try {
    root = configured ?? agentWorkspaceRoot();
  } catch {
    // No usable agent folder setting: the chat reports it when a design starts.
    return null;
  }
  const real = await realpath(root).catch(() => null);
  if (real === null) return null;
  const realRepo = await realpath(repoDir).catch(() => path.resolve(repoDir));
  if (isInside(real, realRepo) || isInside(realRepo, real)) {
    console.error("[design-agent] the agent folders' setting is inside or around the repository; it was not swept", { folder: path.basename(real) });
    return null;
  }
  return real;
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
 * First, with no other contained server running, it stops this user's
 * leftover processes with no controlling terminal that work in those folders
 * (`stopStrayProcesses`), which is what stops a process the last server's
 * shutdown window missed. While another server of this user is running it
 * cannot tell that server's background processes from leftovers, so it
 * stops none. A server counts as running while its process id is alive and,
 * when the start time it recorded is known, still has that start time: an id a
 * later process has reused is a dead server's.
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
  /** The repository, which the agent folders must be outside of; the current directory by default. */
  repoDir?: string;
  probe?: ProcessProbe;
  /** Whether to stop leftover processes first; on unless a test has no use for it. */
  stopProcesses?: boolean;
} = {}): Promise<{ purged: Promise<void> }> {
  const platform = options.platform ?? process.platform;
  const uid = options.uid ?? currentUid();
  const tempRoot = options.tempRoot ?? serverTempRoot(platform, uid);
  const ownPid = options.pid ?? process.pid;
  const alive = options.alive ?? isAlive;
  const probe = options.probe ?? defaultProbe();
  const live = liveTemp();
  const bins: string[] = [];
  const workspaceRoot = options.workspaceRoot === null ? null : await sweepableWorkspaceRoot(options.workspaceRoot, options.repoDir ?? process.cwd());

  const tempInfo = await lstat(tempRoot).catch(() => null);
  if (tempInfo) {
    if (!isPrivateDir(tempInfo, uid)) {
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
      // Which servers are running: the id is alive and is still the process that recorded its start.
      const startsIn = async () => new Map((await probe.list().catch(() => [])).map((p) => [p.pid, p.start]));
      const running = async (server: string, pid: number, starts: Map<number, string>): Promise<boolean> => {
        if (!alive(pid)) return false;
        const recorded = await readFile(path.join(/*turbopackIgnore: true*/ tempRoot, server, SERVER_START_FILE), "utf8").catch(() => null);
        return serverStillRunning(pid, recorded, starts, alive);
      };
      const serverPid = (server: string) => parseInt(SERVER_DIR_NAME.exec(server)![1], 36);
      const starts = await startsIn();
      const state = new Map<string, boolean>();
      for (const server of servers) state.set(server, serverPid(server) === ownPid ? true : await running(server, serverPid(server), starts));
      const others = servers.filter((server) => serverPid(server) !== ownPid && state.get(server) === true);
      /** Other servers running now, from the folders as they are now: one whose first run starts during this sweep has its folder before its CLI exists. */
      const othersNow = async (): Promise<number> => {
        const now = (await readdir(/*turbopackIgnore: true*/ tempRoot).catch(() => [] as string[])).filter((name) => SERVER_DIR_NAME.test(name) && serverPid(name) !== ownPid);
        const fresh = await startsIn();
        let live = 0;
        for (const server of now) if (await running(server, serverPid(server), fresh)) live++;
        return live;
      };
      if (options.stopProcesses !== false) {
        if (others.length > 0) {
          console.info("[design-agent] another server is running its own design runs; leftover processes were not looked for", { servers: others.length });
        } else {
          const realTemp = await realpath(tempRoot).catch(() => tempRoot);
          await stopLeftoverProcesses({ roots: { workspace: workspaceRoot, temp: realTemp }, probe, uid, proceed: async () => (await othersNow()) === 0 });
        }
      }
      for (const server of servers) {
        const pid = serverPid(server);
        const serverDir = at(server);
        if (pid === ownPid) {
          // This process's own folder can hold leftovers only from an earlier
          // server that had the same process id; what it now runs is kept. Its
          // start time is this process's from now on, so another server never
          // takes the folder for a dead server's.
          await recordServerStart(serverDir).catch(() => {});
          for (const child of await readdir(/*turbopackIgnore: true*/ serverDir).catch(() => [] as string[])) {
            if (child === SERVER_START_FILE) continue;
            const run = RUN_MARKER.exec(child)?.[1];
            if (run !== undefined) {
              if (live.has(at(run))) continue;
              await move(at(run), run);
              await rm(path.join(/*turbopackIgnore: true*/ serverDir, child), { force: true }).catch(logLeftBehind(child, "a leftover run marker"));
            } else if (!live.has(path.join(/*turbopackIgnore: true*/ serverDir, child))) {
              await move(path.join(/*turbopackIgnore: true*/ serverDir, child), child);
            }
          }
        } else if (state.get(server) === false) {
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

  if (workspaceRoot !== null) bins.push(path.join(workspaceRoot, QUARANTINE));
  const purged = (async () => {
    for (const bin of bins) await purgeChildren(bin, uid, platform);
  })().catch((err) => logLeftBehind(QUARANTINE, "the quarantine")(err));
  return { purged };
}

/** Stops what earlier servers' runs left working in the contained profile's folders, and says what it did. */
async function stopLeftoverProcesses(input: {
  roots: { workspace: string | null; temp: string | null };
  probe: ProcessProbe;
  uid: number;
  proceed: () => Promise<boolean>;
}): Promise<void> {
  const report = await stopStrayProcesses({ belongs: (cwd) => isContainedWorkingFolder(cwd, input.roots), probe: input.probe, uid: input.uid, proceed: input.proceed });
  if (report.probeFailures.length > 0) console.error("[design-agent] a look at the system failed while looking for leftover processes", { failures: report.probeFailures });
  if (report.abandoned) {
    console.info(
      report.sigtermSent
        ? "[design-agent] another server started while leftover processes were being looked for; SIGTERM had already been sent to them, and none was sent SIGKILL"
        : "[design-agent] another server started while leftover processes were being looked for; none was signalled"
    );
  }
  else if (report.left > 0) console.error("[design-agent] leftover processes of earlier design runs could not be stopped", { remaining: report.left });
  else if (report.found > 0) console.warn("[design-agent] stopped processes earlier design runs left running", { stopped: report.found });
}

/** A real folder (never a link) owned by `uid` with no group or other access. */
function isPrivateDir(info: Awaited<ReturnType<typeof lstat>> | null, uid: number): boolean {
  return info !== null && info.isDirectory() && !info.isSymbolicLink() && info.uid === uid && (Number(info.mode) & 0o077) === 0;
}

/**
 * Deletes everything in one quarantine folder, only if it is this user's own
 * private folder: one that is a link, another user's, or open to the group or
 * others is reported by name and left alone.
 */
async function purgeChildren(bin: string, uid: number, platform: NodeJS.Platform): Promise<void> {
  const info = await lstat(bin).catch(() => null);
  if (!info) return;
  if (!isPrivateDir(info, uid)) {
    console.error("[design-agent] a quarantine folder is not a private folder of this user; it was not purged", { folder: path.basename(bin), parent: path.basename(path.dirname(bin)) });
    return;
  }
  for (const name of await readdir(bin).catch(() => [] as string[])) {
    // Only what `quarantine` itself names: anything else was put there by something else, and is reported, never deleted.
    if (!SERVER_ID.test(name)) {
      console.warn("[design-agent] an unexpected entry in a quarantine folder was left alone", { folder: name, parent: path.basename(path.dirname(bin)) });
      continue;
    }
    await purgeQuarantined(path.join(bin, name), platform);
  }
}

/** A folder that could not be removed stays on disk; it is reported by name, never silently left. */
function logLeftBehind(name: string, what: string, extra: Record<string, string> = {}) {
  return (err: unknown) => {
    console.error(`[design-agent] could not remove ${what}`, { ...extra, folder: name, code: (err as NodeJS.ErrnoException)?.code ?? null });
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
