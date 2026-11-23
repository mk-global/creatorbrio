/**
 * Assembles one contained Design Agent run (#156, #186, #226, #227, #228,
 * #241, #242, #246): its own sign-in token, the conversation's folder, the
 * run's temporary folder, the CLI's server-owned home folder, the images it
 * may view, its listener token, and the exact CLI arguments and environment
 * from the profile. The CLI is
 * started as the leader of its own process group (`src/lib/agent-processes.ts`). `finish` always revokes the token, stops
 * every process the run left, and removes the temporary folder, however the
 * run ends.
 */
import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { issueAgentToken } from "@/lib/agent-listener";
import { forgetAgentSessions } from "@/lib/agent-sessions";
import { getCarousel } from "@/lib/carousels";
import { AgentSignInError, agentSignIn } from "@/lib/agent-sign-in";
import {
  agentWorkspaceRoot,
  createRunTempDir,
  openConversation,
  prepareAgentHome,
  removeRunTempDir,
  serverTempRoot,
  stageUploadsForAgent,
  stagingDirFor,
  startConversation,
} from "@/lib/agent-workspace";
import { trackRun, type TrackedRun } from "@/lib/agent-processes";
import { containedArgs, containedEnv, containedModelApiAddress, ModelApiAddressError, privateReadDirs, type ContainedLayout } from "@/lib/design-agent-profile";

export interface ContainedLaunch {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  /** The conversation this run works in, which the session it hands back is bound to. */
  conversationId: string;
  /** Removes the run's token, and its sign-in token, from text the app relays or logs. */
  redact: (text: string) => string;
  /** The length of the longest secret `redact` removes: text cut anywhere inside that length from its end may hold the start of one. */
  secretLength: number;
  /**
   * Starts tracking the spawned CLI's processes; `abort` ends the run as a
   * stop does, and `unreaped` says the server has not yet reaped the CLI.
   */
  track: (pid: number, abort: () => void, unreaped: () => boolean) => void;
  /** Signals the CLI's process group and every group among its descendants. */
  signal: (signal: NodeJS.Signals) => void;
  finish: () => Promise<void>;
}

export async function prepareContainedLaunch(options: {
  carouselId: string;
  taskMessage: string;
  systemPrompt: string;
  resumeSessionId: string | null;
  /** The conversation bound to `resumeSessionId`; a new conversation has none. */
  conversationId: string | null;
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
  // The chat holds the carousel's run slot, so it cannot be deleted meanwhile.
  if (!(await getCarousel(options.carouselId))) throw new Error("The carousel does not exist.");
  if ((options.resumeSessionId === null) !== (options.conversationId === null)) throw new Error("A resumed session needs its conversation.");
  const env = options.env ?? process.env;
  // Its own sign-in first (#246), so a launch without one changes nothing.
  const signIn = await agentSignIn({ env, repoDir, dataDir, workspaceRoot: agentWorkspaceRoot(env), tempRoot: serverTempRoot(process.platform, uid) });
  if (!signIn.ok) throw new AgentSignInError(signIn);
  // And its model API setting, which must be valid before anything is made, since that is where its token is sent.
  const modelApi = containedModelApiAddress(env);
  if (!modelApi.ok) throw new ModelApiAddressError(modelApi);
  // A resumed conversation keeps its folder. A new one starts in a new folder,
  // and the earlier conversations' folders and sessions go: the server's side
  // of the person clearing the chat.
  const workDir = options.conversationId
    ? await openConversation(options.carouselId, options.conversationId, repoDir)
    : await startConversation(options.carouselId, repoDir);
  if (!options.conversationId) await forgetAgentSessions(options.carouselId);
  const stagingDir = stagingDirFor(workDir);
  const tempDir = await createRunTempDir(uid);
  let revoke: (() => void) | null = null;
  let tracked: TrackedRun | null = null;
  // What every log line about this run carries: the carousel and the run's folder name, never a path.
  const ids = { carouselId: options.carouselId, run: path.basename(tempDir) };
  const removeTemp = () => removeRunTempDir(tempDir).catch(logLeftBehind(ids));
  try {
    // The prompt and the task name uploads by absolute path; the agent cannot
    // read the repository, so both name the copies staged for it instead.
    const spellings = [uploadsDir, await realpath(uploadsDir).catch(() => uploadsDir)];
    const [systemPrompt, taskMessage] = await stageUploadsForAgent([options.systemPrompt, options.taskMessage], spellings, stagingDir);
    const issued = issueAgentToken({ carouselId: options.carouselId, appOrigin: options.appOrigin, ttlMs: options.tokenTtlMs });
    revoke = issued.revoke;
    const workspaceRoot = path.dirname(path.dirname(workDir));
    const homeDir = await realpath(os.homedir());
    const agentHome = await prepareAgentHome({ repoDir, personHome: homeDir, root: workspaceRoot, uid });
    const privateDirs = privateReadDirs({
      env,
      platform: process.platform,
      workspaceRoot,
      userTempDir: await realpath(os.tmpdir()),
    });
    // The run's own temporary folder must stay readable by the shell.
    if (privateDirs.some((dir) => tempDir === dir || tempDir.startsWith(dir + path.sep))) {
      throw new Error("The run's temporary folder is inside a folder the agent must not read.");
    }
    const layout: ContainedLayout = {
      workDir,
      stagingDir,
      tempDir,
      tempRoot: serverTempRoot(process.platform, uid),
      homeDir,
      agentHome,
      signInTokenFile: signIn.file,
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
      env: containedEnv(env, { tempDir, token, home: agentHome, signInToken: signIn.token }),
      cwd: workDir,
      conversationId: path.basename(workDir),
      // The sign-in token never reaches the agent; it is redacted too, should the CLI ever print it.
      redact: (text) => [token, signIn.token].reduce((t, secret) => (t.includes(secret) ? t.split(secret).join("[redacted]") : t), text),
      secretLength: Math.max(token.length, signIn.token.length),
      track: (pid, abort, unreaped) => {
        tracked ??= trackRun({ leaderPid: pid, folders: [workDir, stagingDir, tempDir], abort, leaderUnreaped: unreaped });
      },
      signal: (signal) => tracked?.signal(signal),
      finish: async () => {
        revoke?.();
        revoke = null;
        // Before the folders go, so nothing the run started can still use them.
        const report = await tracked?.stop().catch((err) => {
          console.error("[design-agent] could not stop the processes a run started", { ...ids, code: (err as NodeJS.ErrnoException)?.code ?? null });
          return null;
        });
        // A look at the system that failed finds nothing, so it is reported rather than taken for a clean stop.
        if (report && report.probeFailures.length > 0) console.error("[design-agent] a look at the system failed while stopping a run's processes", { ...ids, failures: report.probeFailures });
        if (report && report.left > 0) console.error("[design-agent] processes a run started could not be stopped", { ...ids, remaining: report.left });
        else if (report && report.found > 0) console.info("[design-agent] stopped processes a run left running", { ...ids, stopped: report.found });
        await removeTemp();
      },
    };
  } catch (err) {
    revoke?.();
    await removeTemp();
    throw err;
  }
}

/** A run's temporary folder that could not be removed stays on disk; it is reported, never silently left. */
function logLeftBehind(ids: { carouselId: string; run: string }) {
  return (err: unknown) => {
    console.error("[design-agent] could not remove a run's temporary folder", { ...ids, code: (err as NodeJS.ErrnoException)?.code ?? null });
  };
}
