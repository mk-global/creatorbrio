/**
 * The contained Design Agent's folders (#227).
 *
 * Each carousel conversation has one working folder, outside the repository
 * and the data folder, named by the carousel's server-generated identifier. It
 * is created on first use and reused by that carousel's runs, so the CLI's
 * stored session keeps resolving (the CLI keys sessions by working folder). A
 * run that starts a new conversation empties it first, which is the server's
 * side of the person clearing the chat, and it is removed with the carousel.
 *
 * Each run also gets its own short temporary folder, which the CLI gives the
 * sandboxed shell instead of the shared per-user one (see
 * `MAX_AGENT_TEMP_PATH_BYTES`), removed when the run ends.
 *
 * The images the agent is told to view are copied (never linked: a link would
 * be a writable second name for an upload) into a staging folder beside the
 * carousel's, because the uploads folder lives in the repository, which the
 * agent cannot read. The agent may read the staging folder but never write it,
 * so nothing it does can redirect the server's copies.
 *
 * A process the agent starts can outlive its run (measured on macOS), and the
 * agent can write its own folders, so the server never deletes inside them in
 * place: a recursive delete walks paths, and a process that swaps a folder for
 * a link mid-delete would turn it into a delete of the link's target. Each
 * such folder is first renamed into a quarantine folder beside the carousels'
 * folders, which the agent cannot write, and deleted there. On macOS the
 * sandbox's write rules follow paths, so the rename ends a surviving process's
 * access; on Linux nothing the agent started survives its run, and a folder
 * is never removed while its run is live (see the carousel delete route).
 */
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { agentTempDirFits } from "@/lib/design-agent-profile";

export const AGENT_WORKSPACES_ENV = "CREATORBRIO_DESIGN_AGENT_WORKSPACES";

const CAROUSEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class AgentWorkspaceError extends Error {}

/** The folder that holds every carousel's working folder; an operator may move it with an absolute path. */
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

/**
 * The carousel's working folder, created owner-only on first use. Refuses an
 * identifier that is not a server-generated one, a root inside the repository,
 * and a folder that is a link or resolves anywhere else.
 */
export async function ensureCarouselWorkDir(carouselId: string, repoDir: string, root = agentWorkspaceRoot()): Promise<string> {
  if (!CAROUSEL_ID.test(carouselId)) throw new AgentWorkspaceError("Not a carousel identifier.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  const realRepo = await realpath(repoDir);
  if (isInside(realRoot, realRepo) || isInside(realRepo, realRoot)) {
    throw new AgentWorkspaceError("The Design Agent's folders must be outside the repository.");
  }
  const dir = path.join(realRoot, carouselId);
  await mkdir(dir, { mode: 0o700 }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(dir)) !== dir) {
    throw new AgentWorkspaceError("The carousel's folder is not a plain folder.");
  }
  return dir;
}

const QUARANTINE = ".removed";
const STAGING = ".staged";

/** The server-only folder of the images a carousel's agent may view, beside its working folder. */
export function stagingDirFor(workDir: string): string {
  return path.join(path.dirname(workDir), STAGING, path.basename(workDir));
}

/**
 * Removes a folder or file the agent could write, without ever deleting in
 * place: it is renamed into the quarantine folder under `root` and deleted
 * there. Where it cannot be renamed (another file system), it is deleted in
 * place only on Linux, where nothing the agent started outlives its run, and
 * otherwise left behind and reported.
 */
export async function removeAgentWritable(target: string, root: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  const bin = path.join(root, QUARANTINE);
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const moved = path.join(bin, randomUUID());
  try {
    await rename(target, moved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    if (code === "EXDEV" && platform === "linux") {
      await rm(target, { recursive: true, force: true });
      return;
    }
    throw err;
  }
  await rm(moved, { recursive: true, force: true });
}

/** Empties the carousel's folder without removing it; a new conversation starts from nothing. */
export async function emptyCarouselWorkDir(dir: string): Promise<void> {
  for (const name of await readdir(dir)) {
    await removeAgentWritable(path.join(dir, name), path.dirname(dir));
  }
}

/** Removes a carousel's folder and its staged images, if it has them; called when the carousel is deleted. */
export async function removeCarouselWorkDir(carouselId: string, root = agentWorkspaceRoot()): Promise<void> {
  if (!CAROUSEL_ID.test(carouselId)) return;
  await removeAgentWritable(path.join(root, carouselId), root);
  // The agent never writes the staging folder, so it is deleted directly.
  await rm(stagingDirFor(path.join(root, carouselId)), { recursive: true, force: true });
}

/**
 * A fresh, owner-only temporary folder for one run, short enough that the CLI
 * gives it to the sandboxed shell. `/tmp` is used rather than the platform's
 * per-user temporary folder, whose path on macOS is far longer than the limit.
 */
export async function createRunTempDir(uid: number, platform: NodeJS.Platform = process.platform): Promise<string> {
  const base = platform === "darwin" ? "/private/tmp" : "/tmp";
  const dir = await mkdtemp(path.join(base, "cb-"));
  if (!agentTempDirFits(dir, uid)) {
    await rm(dir, { recursive: true, force: true });
    throw new AgentWorkspaceError("The run's temporary folder path is too long for the CLI to use.");
  }
  return dir;
}

/** Removes the run's temporary folder, which the agent could write, through the quarantine under `root`. */
export async function removeRunTempDir(dir: string, root = agentWorkspaceRoot()): Promise<void> {
  await removeAgentWritable(dir, root);
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
  // conversation staged, and is emptied when a new conversation starts.
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
