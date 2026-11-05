import { spawn } from "node:child_process";
import { resolveBrandForCarousel } from "@/lib/brand";
import { getCarousel } from "@/lib/carousels";
import { buildSystemPrompt } from "@/lib/chat-system-prompt";
import { getClaudePath } from "@/lib/claude-path";
import { designAgentArgs, designAgentSettings } from "@/lib/design-agent";
import { resolveReferenceImages } from "@/lib/reference-images";
import { cleanEnv, ROOT } from "./server";

/**
 * The comparison arm: the Design Agent alone, exactly as the product ran it
 * before the creative run existed. Same system prompt builder, same CLI
 * arguments, same working directory, the user's message as the whole task
 * and no visual plan. It writes slides through the running app's API, just
 * as the chat route's agent does.
 */


export interface BaselineResult {
  ok: boolean;
  durationMs: number;
  costUsd: number | null;
  subtype: string | null;
  resultText: string | null;
  error: string | null;
}

export async function runDesignAgentOnly(options: { origin: string; carouselId: string; message: string }): Promise<BaselineResult> {
  if (process.cwd() !== ROOT) throw new Error(`Run the harness from ${ROOT} so storage reads the server's data`);
  const carousel = await getCarousel(options.carouselId);
  if (!carousel) throw new Error(`Carousel ${options.carouselId} not found`);
  const brand = await resolveBrandForCarousel(carousel);
  const systemPrompt = buildSystemPrompt({
    baseUrl: options.origin,
    brand,
    carousel: { ...carousel, referenceImages: await resolveReferenceImages(carousel) },
    stylePreset: null,
  });
  const settings = designAgentSettings();
  if (!settings.ok) throw new Error(`Design Agent setting invalid: ${settings.code}`);
  const args = designAgentArgs({
    taskMessage: options.message,
    systemPrompt,
    resumeSessionId: null,
    // The same optional cap the chat route reads; none unless the operator sets one.
    budgetUsd: settings.budgetUsd,
  });

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(getClaudePath(), args, { cwd: ROOT, env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    let buffer = "";
    let final: Record<string, unknown> | null = null;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, settings.timeoutMs); // the chat route's own deadline
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type === "result") final = parsed;
        } catch {
          // Non-JSON output is ignored, as the route does.
        }
      }
    });
    child.stderr.on("data", () => {});
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const f = final as Record<string, unknown> | null;
      resolve({
        ok: !error && !!f && !f.is_error,
        durationMs: Date.now() - started,
        costUsd: typeof f?.total_cost_usd === "number" ? f.total_cost_usd : null,
        subtype: typeof f?.subtype === "string" ? f.subtype : null,
        resultText: typeof f?.result === "string" ? f.result.slice(0, 4000) : null,
        error,
      });
    };
    child.on("error", (err) => finish(err.message));
    child.on("close", (code) => finish(timedOut ? "timed out" : code === 0 ? null : `exit ${code}`));
  });
}
