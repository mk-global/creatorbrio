/**
 * Assembles one contained Design Agent run (#156, #186, #226, #227, #228):
 * the carousel's folder, the run's temporary folder, the images it may view,
 * its listener token, and the exact CLI arguments and environment from the
 * profile. `finish` always revokes the token and removes the temporary folder,
 * however the run ends.
 */
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { issueAgentToken } from "@/lib/agent-listener";
import { getCarousel } from "@/lib/carousels";
import {
  createRunTempDir,
  emptyCarouselWorkDir,
  ensureCarouselWorkDir,
  removeRunTempDir,
  stageUploadsForAgent,
} from "@/lib/agent-workspace";
import { containedArgs, containedEnv, privateReadDirs, type ContainedLayout } from "@/lib/design-agent-profile";

export interface ContainedLaunch {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** Removes the run's token from text the app relays or logs. */
  redact: (text: string) => string;
  finish: () => Promise<void>;
}

export async function prepareContainedLaunch(options: {
  carouselId: string;
  taskMessage: string;
  systemPrompt: string;
  resumeSessionId: string | null;
  budgetUsd: number | null;
  listenerPort: number;
  appOrigin: string;
  /** How long the token stays valid if the run is never ended: its deadline plus a margin. */
  tokenTtlMs: number;
  repoDir?: string;
  env?: Record<string, string | undefined>;
}): Promise<ContainedLaunch> {
  const repoDir = await realpath(options.repoDir ?? process.cwd());
  const dataDir = path.join(repoDir, "data");
  const uploadsDir = path.join(repoDir, "public", "uploads");
  const uid = process.getuid?.() ?? 0;
  // A folder only for a carousel that exists, so no request leaves one behind.
  if (!(await getCarousel(options.carouselId))) throw new Error("The carousel does not exist.");
  const workDir = await ensureCarouselWorkDir(options.carouselId, repoDir);
  // A new conversation starts from an empty folder: the server's side of the
  // person clearing the chat. A resumed one keeps its folder.
  if (!options.resumeSessionId) await emptyCarouselWorkDir(workDir);
  const tempDir = await createRunTempDir(uid);
  let revoke: (() => void) | null = null;
  try {
    // The prompt and the task name uploads by absolute path; the agent may read
    // only its own folder, so both name the copies staged there instead.
    const spellings = [uploadsDir, await realpath(uploadsDir).catch(() => uploadsDir)];
    const [systemPrompt, taskMessage] = await stageUploadsForAgent([options.systemPrompt, options.taskMessage], spellings, workDir);
    const issued = issueAgentToken({ carouselId: options.carouselId, appOrigin: options.appOrigin, ttlMs: options.tokenTtlMs });
    revoke = issued.revoke;
    const privateDirs = privateReadDirs({
      env: options.env ?? process.env,
      platform: process.platform,
      workspaceRoot: path.dirname(workDir),
      userTempDir: await realpath(os.tmpdir()),
    });
    // The run's own temporary folder must stay readable by the shell.
    if (privateDirs.some((dir) => tempDir === dir || tempDir.startsWith(dir + path.sep))) {
      throw new Error("The run's temporary folder is inside a folder the agent must not read.");
    }
    const layout: ContainedLayout = {
      workDir,
      tempDir,
      homeDir: await realpath(os.homedir()),
      repoDir,
      dataDir,
      listenerPort: options.listenerPort,
      platform: process.platform,
      uid,
      privateDirs,
    };
    const token = issued.token;
    return {
      args: containedArgs({ taskMessage, systemPrompt, resumeSessionId: options.resumeSessionId, budgetUsd: options.budgetUsd, layout }),
      env: containedEnv(options.env ?? process.env, { tempDir, token }),
      cwd: workDir,
      redact: (text) => (text.includes(token) ? text.split(token).join("[redacted]") : text),
      finish: async () => {
        revoke?.();
        revoke = null;
        await removeRunTempDir(tempDir).catch(() => {});
      },
    };
  } catch (err) {
    revoke?.();
    await removeRunTempDir(tempDir).catch(() => {});
    throw err;
  }
}
