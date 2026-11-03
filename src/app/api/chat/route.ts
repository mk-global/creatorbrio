import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import crossSpawn from "cross-spawn";
import { getClaudePath, isClaudeAvailable } from "@/lib/claude-path";
import { buildSystemPrompt } from "@/lib/chat-system-prompt";
import { resolveBrandForCarousel, BrandNotFoundError } from "@/lib/brand";
import { getCarousel } from "@/lib/carousels";
import { getPreset } from "@/lib/style-presets";
import { resolveReferenceImages } from "@/lib/reference-images";
import { dataErrorResponse } from "@/lib/api-errors";
import { resolveAppOrigin } from "@/lib/request-origin";
import {
  CHAT_ERROR_MESSAGES,
  checkChatMessage,
  encodeChatEvent,
  isRunId,
  isSessionId,
  MAX_CHAT_MESSAGE_LENGTH,
  type ChatErrorCode,
  type ChatStreamEvent,
} from "@/lib/chat-stream";
import { finishCreativeRun, prepareCreativeRun, type CreativeRunInput } from "@/lib/creative-run";
import { checkConformance } from "@/lib/creative-handoff";
import { designAgentArgs } from "@/lib/design-agent";
import {
  beginGeneration,
  classifyRunExit,
  GENERATION_ALREADY_RUNNING_ERROR,
  type RunOutcome,
} from "@/lib/generation-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The longest creative run: linked pages (30 s), planning (120 s), images
// (12 min) and design (8 min), about 23 minutes. A self-hosted Next.js server
// does not enforce this value; the stage limits above are the real bound.
export const maxDuration = 1500;

type DesignRun = Extract<Awaited<ReturnType<typeof prepareCreativeRun>>, { kind: "design" }>;

/** How long a cancelled Claude CLI gets to exit before it is killed. */
const FORCE_KILL_AFTER_MS = 5_000;

export async function POST(request: NextRequest) {
  if (!isClaudeAvailable()) {
    return NextResponse.json(
      {
        error:
          "Claude CLI not found. Install from https://docs.anthropic.com/en/docs/claude-code or set CLAUDE_CLI_PATH in .env.local",
      },
      { status: 503 }
    );
  }

  let body: {
    message?: unknown;
    sessionId?: unknown;
    carouselId?: string;
    stylePresetId?: string;
    retryRunId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { sessionId, carouselId, stylePresetId, retryRunId } = body;

  const messageCheck = checkChatMessage(body.message);
  if (!messageCheck.ok) {
    // An expected refusal, logged so it can be traced; never the content.
    console.info("[chat] message refused", {
      carouselId: typeof carouselId === "string" ? carouselId.slice(0, 64) : null,
      reason: messageCheck.reason,
      length: messageCheck.length,
      limit: MAX_CHAT_MESSAGE_LENGTH,
    });
    return NextResponse.json({ error: messageCheck.error }, { status: 400 });
  }
  const { message } = messageCheck;

  // The session becomes a CLI argument, so only a Claude session ID is accepted;
  // anything else could be read by the CLI as an option.
  if (sessionId !== undefined && sessionId !== null && sessionId !== "" && !isSessionId(sessionId)) {
    return NextResponse.json({ error: "Invalid session" }, { status: 400 });
  }
  const resumeSessionId = isSessionId(sessionId) ? sessionId : null;

  // A retry names one earlier run of this carousel; anything else is refused
  // before any lookup.
  if (retryRunId !== undefined && retryRunId !== null && (!isRunId(retryRunId) || typeof carouselId !== "string" || !carouselId)) {
    return NextResponse.json({ error: "Invalid retry" }, { status: 400 });
  }

  // The carousel's run begins before any work for this request, and a
  // carousel has one active run at a time. From here on, every way this
  // request ends must end the run exactly once.
  const run = typeof carouselId === "string" && carouselId ? beginGeneration(carouselId) : null;
  if (typeof carouselId === "string" && carouselId && !run) {
    return NextResponse.json({ error: GENERATION_ALREADY_RUNNING_ERROR }, { status: 409 });
  }
  const endGeneration = (outcome: RunOutcome): Promise<void> =>
    run ? run.end(outcome) : Promise.resolve();

  // Build dynamic system prompt with the carousel's brand + carousel + style preset context
  let systemPrompt: string;
  // Everything the creative run needs; null for a chat without a carousel.
  let creative: CreativeRunInput | null = null;
  try {
    const carousel = carouselId ? await getCarousel(carouselId) : null;
    // The brand the carousel was created in; the default brand for carousels
    // made before brands existed.
    const brand = await resolveBrandForCarousel(carousel);
    const stylePreset = stylePresetId ? await getPreset(stylePresetId) : null;
    // Only references that still resolve to confined PNG uploads reach the
    // prompt, each with a path derived now; the stored path is never used.
    // buildSystemPrompt itself stays a pure function of what it is given.
    const promptCarousel = carousel
      ? { ...carousel, referenceImages: await resolveReferenceImages(carousel) }
      : null;
    if (carousel && promptCarousel) {
      creative = {
        carousel,
        brand,
        stylePreset,
        message,
        references: promptCarousel.referenceImages,
        retryRunId: isRunId(retryRunId) ? retryRunId : null,
      };
    }
    systemPrompt = buildSystemPrompt({
      // The agent curls this app's own API, so it must be told the origin the
      // request arrived on rather than a fixed port.
      baseUrl: resolveAppOrigin(request),
      brand,
      carousel: promptCarousel,
      stylePreset,
    });
    // The run's baseline is saved before anything can change the slides.
    await run?.ready;
  } catch (err) {
    await endGeneration("not-started");
    if (err instanceof BrandNotFoundError) {
      // Never generate with a different brand than the carousel's own.
      return NextResponse.json(
        { error: "This carousel's brand no longer exists." },
        { status: 409 }
      );
    }
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    throw err;
  }

  const claudePath = getClaudePath();
  const abortController = new AbortController();

  const designArgs = (taskMessage: string) => designAgentArgs({ taskMessage, systemPrompt, resumeSessionId });

  const encoder = new TextEncoder();
  // Set by the client going away (Stop, a reload, a closed tab).
  let cancelled = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: ChatStreamEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeChatEvent(event)));
        } catch {
          // stream already closed
        }
      };
      // Only the first failure is reported: it is the cause, and anything
      // after it (a non-zero exit following an error result) is a consequence.
      let errorCode: ChatErrorCode | null = null;
      const fail = (code: ChatErrorCode) => {
        if (errorCode || cancelled) return;
        errorCode = code;
        send({ type: "error", code, message: CHAT_ERROR_MESSAGES[code] });
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // stream already closed
        }
      };

      void (async () => {
        // The creative run comes first: linked pages, the plan and its images.
        // It either hands the Design Agent its task message or ends the run
        // here, before anything can change the slides.
        let taskMessage = message;
        let creativeRun: DesignRun | null = null;
        if (creative) {
          let prepared;
          try {
            prepared = await prepareCreativeRun(
              creative,
              { stage: (stage, detail) => send(detail ? { type: "stage", stage, detail } : { type: "stage", stage }) },
              abortController.signal
            );
          } catch (err) {
            console.error("[chat] creative run failed before design", {
              carouselId: carouselId ?? null,
              message: (err as Error)?.message,
            });
            fail("run_failed");
            await endGeneration("not-started");
            send({ type: "done", sessionId: null });
            close();
            return;
          }
          if (prepared.kind !== "design") {
            if (prepared.kind === "blocked") {
              send({ type: "blocked", code: prepared.code, message: prepared.message, retryRunId: prepared.retryRunId });
            }
            // Nothing changed the slides; the Design Agent's session is kept as it was.
            await endGeneration(prepared.kind === "blocked" ? "blocked" : "stopped");
            console.info("[chat] run finished", {
              carouselId: carouselId ?? null,
              outcome: prepared.kind === "blocked" ? "blocked" : "stopped",
              ...(prepared.kind === "blocked" ? { blockedCode: prepared.code } : {}),
            });
            send({ type: "done", sessionId: null });
            close();
            return;
          }
          creativeRun = prepared;
          taskMessage = prepared.designMessage;
        }
        if (cancelled) {
          if (creativeRun) await finishCreativeRun(carouselId!, creativeRun.runId, "stopped");
          await endGeneration("stopped");
          send({ type: "done", sessionId: null });
          close();
          return;
        }
        design(taskMessage, creativeRun);
      })();

      function design(taskMessage: string, creativeRun: DesignRun | null) {
      let childProcess: ReturnType<typeof spawn>;
      const isWindowsShim =
        process.platform === "win32" && /\.(cmd|bat)$/i.test(claudePath);
      const spawner = isWindowsShim ? crossSpawn : spawn;

      try {
        childProcess = spawner(claudePath, designArgs(taskMessage), {
          cwd: process.cwd(),
          signal: abortController.signal,
          stdio: ["pipe", "pipe", "pipe"],
        });
        // Close stdin — we don't send input to the subprocess
        childProcess.stdin?.end();
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        console.error("[chat] failed to spawn Claude CLI", {
          claudePath,
          platform: process.platform,
          code: e?.code,
          message: e?.message,
        });
        fail("start_failed");
        void (creativeRun ? finishCreativeRun(carouselId!, creativeRun.runId, "failed") : Promise.resolve())
          .then(() => endGeneration("not-started"))
          .finally(close);
        return;
      }

      // The subprocess is what writes this carousel's slides, so export stays
      // unavailable until it has exited, however that happens, and how it
      // ended decides whether the slides count as finished.
      let timedOut = false;
      let resultIsError = false;
      const outcomeFor = (code: number | null) =>
        classifyRunExit({ cancelled, timedOut, code, resultIsError });

      // A resumed session the CLI cannot find fails before the CLI reports
      // the session it started, which is how it is told apart from a failure
      // inside a running conversation.
      let sessionStarted = false;
      // The Design Agent's reported cost, for the run log.
      let designCostUsd: number | null = null;
      const designStarted = Date.now();
      let resolvedSessionId: string | null = null;
      const noteSession = (id: unknown) => {
        if (isSessionId(id)) resolvedSessionId = id;
      };
      const resumeFailed = () => resumeSessionId !== null && !sessionStarted;

      const handleEvent = (event: Record<string, unknown>) => {
        if (event.type === "system" && event.subtype === "init") {
          sessionStarted = true;
          noteSession(event.session_id);
          return;
        }

        // Streaming text tokens
        if (event.type === "assistant" && event.message) {
          const msg = event.message as Record<string, unknown>;
          if (msg.type === "message" && Array.isArray(msg.content)) {
            for (const block of msg.content) {
              const b = block as Record<string, unknown>;
              if (b.type === "text" && typeof b.text === "string") {
                send({ type: "token", text: b.text });
              }
            }
          }
          return;
        }

        if (event.type === "result") {
          if (typeof event.total_cost_usd === "number") designCostUsd = event.total_cost_usd;
          if (event.is_error === true) {
            // An error result is not a reply; it is reported as a failure.
            resultIsError = true;
            fail(
              resumeFailed()
                ? "session_not_found"
                : event.subtype === "error_max_budget_usd"
                  ? "budget_exceeded"
                  : "agent_failed"
            );
            return;
          }
          if (sessionStarted) noteSession(event.session_id);
          if (typeof event.result === "string" && event.result) {
            send({ type: "result", text: event.result });
          }
        }
      };

      let buffer = "";
      const handleLine = (line: string) => {
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return; // skip unparseable lines
        }
        if (typeof event === "object" && event !== null) {
          handleEvent(event as Record<string, unknown>);
        }
      };

      childProcess.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });

      let stderrBuf = "";
      const STDERR_CAP = 8192;
      childProcess.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBuf.length < STDERR_CAP) {
          stderrBuf = (stderrBuf + chunk.toString()).slice(-STDERR_CAP);
        }
      });

      // Timeout: kill subprocess after 8 minutes (autonomous mode creates many slides)
      const timeout = setTimeout(() => {
        timedOut = true;
        childProcess.kill();
      }, 480_000);

      childProcess.on("error", async (err) => {
        clearTimeout(timeout);
        // A cancelled chat reports an AbortError as soon as the kill is sent,
        // while the subprocess may still be finishing a write. Release here
        // only if it never started or has already gone; otherwise "exit" will.
        // A release made here is saved before the stream closes, as on exit.
        let released: Promise<void> = Promise.resolve();
        if (childProcess.pid === undefined) {
          released = endGeneration("not-started");
        } else if (
          childProcess.exitCode !== null ||
          childProcess.signalCode !== null
        ) {
          released = endGeneration(outcomeFor(childProcess.exitCode));
        } else {
          // Export stays unavailable until the subprocess exits, so one that
          // ignores the termination request is killed outright.
          const forceKill = setTimeout(() => {
            childProcess.kill("SIGKILL");
          }, FORCE_KILL_AFTER_MS);
          childProcess.once("exit", () => clearTimeout(forceKill));
        }
        const e = err as NodeJS.ErrnoException;
        console.error("[chat] Claude subprocess error", {
          claudePath,
          platform: process.platform,
          code: e?.code,
          syscall: e?.syscall,
          path: e?.path,
          message: e?.message,
          stderr: stderrBuf,
        });
        childProcess.kill();
        fail(childProcess.pid === undefined ? "start_failed" : "agent_failed");
        await released;
        close();
      });

      childProcess.on("exit", async (code) => {
        clearTimeout(timeout);
        handleLine(buffer);
        buffer = "";

        if (timedOut) {
          fail("timed_out");
        } else if (code !== 0 && !cancelled) {
          // Non-zero, or killed by a signal nobody here sent.
          fail(resumeFailed() ? "session_not_found" : "agent_failed");
        }
        if (code && code !== 0) {
          const log = errorCode === "session_not_found" ? console.warn : console.error;
          log("[chat] Claude subprocess exited non-zero", {
            claudePath,
            platform: process.platform,
            exitCode: code,
            errorCode,
            stderr: stderrBuf,
          });
        }

        // Saved before "done", so the editor's next status check sees it.
        const outcome = outcomeFor(code);
        if (creativeRun) await finishDesign(creativeRun, outcome);
        await endGeneration(outcome);

        // A session that could not be resumed is not offered again.
        const nextSessionId = errorCode === "session_not_found" ? null : resolvedSessionId;
        console.info("[chat] run finished", {
          carouselId: carouselId ?? null,
          resumedSessionId: resumeSessionId,
          sessionId: nextSessionId,
          outcome,
          exitCode: code,
          errorCode,
          designDurationMs: Date.now() - designStarted,
          designCostUsd,
        });
        send({ type: "done", sessionId: nextSessionId });
        close();
      });
      }

      /**
       * After design: compare the slides with the plan, show and record any
       * differences, and end the creative run. Never corrects the design.
       */
      async function finishDesign(creativeRun: DesignRun, outcome: RunOutcome) {
        let deviations: string[] = [];
        if (outcome === "completed") {
          const after = await getCarousel(carouselId!).catch(() => null);
          const result = checkConformance(creativeRun.plan, after?.slides ?? [], creativeRun.assets, creative?.references ?? []);
          for (const deviation of result.deviations) {
            console.info("[chat] plan_deviation", { carouselId, runId: creativeRun.runId, kind: deviation.kind });
          }
          deviations = [...result.deviations.map((d) => d.message), ...result.notes];
          if (result.deviations.length > 0) send({ type: "deviations", items: deviations });
        }
        const recorded = outcome === "completed" || outcome === "stopped" || outcome === "failed" || outcome === "timed-out"
          ? outcome
          : "failed";
        await finishCreativeRun(carouselId!, creativeRun.runId, recorded, deviations).catch((err) => {
          console.error("[chat] could not record the end of a creative run", { carouselId, message: (err as Error)?.message });
        });
      }
    },

    cancel() {
      cancelled = true;
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
