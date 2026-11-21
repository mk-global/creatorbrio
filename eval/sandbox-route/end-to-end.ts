/**
 * One contained Design Agent turn end to end, at no cost (#237): the real
 * Claude CLI, launched exactly as the chat route launches it
 * (`prepareContainedLaunch`), with the real agent-only listener and run token,
 * runs the contained prompt's own "Create a slide" command, unchanged but for
 * the slide's HTML, against the app's real carousel routes. The stand-in model
 * issues that one command; the check is host-side: the slide is saved in the
 * carousel, the token stops working when the run ends, and the run's
 * temporary folder is gone.
 *
 * Run it only on a disposable host (the Linux container or the macOS VM).
 *
 *   node --import ./eval/t1/register.mjs eval/sandbox-route/end-to-end.ts [--claude path]
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { agentListenerPort, stopAgentListener } from "../../src/lib/agent-listener";
import { AGENT_WORKSPACES_ENV } from "../../src/lib/agent-workspace";
import { createCarousel, getCarousel } from "../../src/lib/carousels";
import { buildSystemPrompt } from "../../src/lib/chat-system-prompt";
import { prepareContainedLaunch } from "../../src/lib/contained-launch";
import { startAppRoutesServer } from "../../tests/helpers/app-routes-server";
import { PROMPT_BASELINE_CASES } from "../../tests/fixtures/prompt-baseline/cases";
import { standInEnv, startStandIn } from "./stand-in";

const SLIDE_MARKER = "CREATORBRIO_END_TO_END_SLIDE";

/** The contained prompt's own "Create a slide" command, with the slide's HTML filled in. */
export function createSlideCommand(systemPrompt: string, html: string): string {
  const block = /### Create a slide:\n([\s\S]*?)\n\n/.exec(systemPrompt)?.[1];
  if (!block || !block.includes("YOUR_HTML_HERE")) throw new Error("The prompt has no Create a slide command");
  return block.replace("YOUR_HTML_HERE", html);
}

async function main() {
  const claude = process.argv.includes("--claude") ? process.argv[process.argv.indexOf("--claude") + 1] : "claude";
  const root = realpathSync(mkdtempSync(path.join(homedir(), ".creatorbrio-e2e-")));
  const repo = path.join(root, "repo");
  for (const d of [path.join(repo, "data"), path.join(repo, "public", "uploads")]) mkdirSync(d, { recursive: true });
  process.chdir(repo);
  process.env[AGENT_WORKSPACES_ENV] = path.join(root, "agents");
  const stand = await startStandIn();
  const app = await startAppRoutesServer();
  const checks: Record<string, boolean> = {};
  try {
    const carousel = await createCarousel("End to end", "4:5", "default");
    const listenerPort = await agentListenerPort();
    const systemPrompt = buildSystemPrompt({
      baseUrl: `http://localhost:${listenerPort}`,
      brand: PROMPT_BASELINE_CASES["2-configured-brand-portrait-slides"].brand,
      carousel: { ...carousel, referenceImages: [] },
      contained: true,
    });
    const command = createSlideCommand(systemPrompt, `<div style=\\"width:1080px;height:1350px\\">${SLIDE_MARKER}</div>`);
    stand.setScript([{ name: "Bash", input: { command, description: "Create a slide" } }]);
    const launch = await prepareContainedLaunch({
      carouselId: carousel.id,
      taskMessage: "Create one slide.",
      systemPrompt,
      resumeSessionId: null,
      budgetUsd: null,
      listenerPort,
      appOrigin: app.origin,
      tokenTtlMs: 120_000,
      repoDir: repo,
      env: standInEnv({ PATH: process.env.PATH, HOME: homedir(), LANG: process.env.LANG ?? "C.UTF-8" } as unknown as NodeJS.ProcessEnv, stand.port),
    });
    const tempDir = launch.env.CLAUDE_CODE_TMPDIR;
    const token = launch.env.CREATORBRIO_AGENT_GRANT;
    const exit = await new Promise<number>((resolve) => {
      const child = execFile(claude, launch.args, { cwd: launch.cwd, env: launch.env as NodeJS.ProcessEnv, timeout: 120_000 }, (error) =>
        resolve(error ? Number((error as { code?: unknown }).code ?? 1) || 1 : 0)
      );
      child.stdin?.end();
    });
    const toolResult = stand.requests.filter((r) => r.mainLoop).at(-1)?.toolResults.at(-1) ?? "";
    await launch.finish();
    const saved = await getCarousel(carousel.id);
    checks.cliExitedCleanly = exit === 0;
    checks.slideSavedThroughListener = Boolean(saved?.slides.some((s) => s.html.includes(SLIDE_MARKER)));
    checks.appReceivedTheForwardedCreate = app.received.some((r) => r.method === "POST" && r.path === `/api/carousels/${carousel.id}/slides`);
    checks.tokenNeverInToolOutput = !toolResult.includes(token);
    checks.tempDirRemoved = !existsSync(tempDir);
    // After the run the token is refused. A plain request, as curl sends one:
    // fetch adds browser headers, which the listener refuses before the token.
    const statusAfter = await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: "127.0.0.1", port: listenerPort, path: `/api/carousels/${carousel.id}`, headers: { authorization: `Bearer ${token}` } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
    });
    checks.tokenRevokedAtRunEnd = statusAfter === 401;
    process.stdout.write(`${JSON.stringify({ checks, toolResult: toolResult.slice(0, 200) }, null, 2)}\n`);
  } finally {
    await stopAgentListener();
    await app.close();
    await stand.close();
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(Object.values(checks).length > 0 && Object.values(checks).every(Boolean) ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  });
}
