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
  encodeChatEvent,
  isSessionId,
  type ChatErrorCode,
  type ChatStreamEvent,
} from "@/lib/chat-stream";
import {
  beginGeneration,
  classifyRunExit,
  type RunOutcome,
} from "@/lib/generation-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
    message?: string;
    sessionId?: unknown;
    carouselId?: string;
    stylePresetId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { message, sessionId, carouselId, stylePresetId } = body;

  if (
    !message ||
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 10000
  ) {
    return NextResponse.json({ error: "Invalid message" }, { status: 400 });
  }

  // The session becomes a CLI argument, so only a Claude session ID is accepted;
  // anything else could be read by the CLI as an option.
  if (sessionId !== undefined && sessionId !== null && sessionId !== "" && !isSessionId(sessionId)) {
    return NextResponse.json({ error: "Invalid session" }, { status: 400 });
  }
  const resumeSessionId = isSessionId(sessionId) ? sessionId : null;

  // Build dynamic system prompt with the carousel's brand + carousel + style preset context
  let systemPrompt: string;
  // When the carousel last changed before this run, to tell afterwards whether
  // the run wrote anything.
  let baseline: string | null = null;
  try {
    const carousel = carouselId ? await getCarousel(carouselId) : null;
    baseline = carousel?.updatedAt ?? null;
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
    systemPrompt = buildSystemPrompt({
      // The agent curls this app's own API, so it must be told the origin the
      // request arrived on rather than a fixed port.
      baseUrl: resolveAppOrigin(request),
      brand,
      carousel: promptCarousel,
      stylePreset,
    });
  } catch (err) {
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

  const args = [
    "-p",
    message,
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--append-system-prompt",
    systemPrompt,
    "--allowedTools",
    "Bash",
    "--allowedTools",
    "WebFetch",
    "--allowedTools",
    "Read",
    "--max-budget-usd",
    "1.00",
    "--name",
    "creatorbrio-chat",
  ];

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  const encoder = new TextEncoder();
  // Set by the client going away (Stop, a reload, a closed tab).
  let cancelled = false;

  const stream = new ReadableStream({
    start(controller) {
      let childProcess: ReturnType<typeof spawn>;

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

      const isWindowsShim =
        process.platform === "win32" && /\.(cmd|bat)$/i.test(claudePath);
      const spawner = isWindowsShim ? crossSpawn : spawn;

      try {
        childProcess = spawner(claudePath, args, {
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
        close();
        return;
      }

      // The subprocess is what writes this carousel's slides, so export stays
      // unavailable until it has exited, however that happens, and how it
      // ended decides whether the slides count as finished.
      const endGeneration: (outcome: RunOutcome) => Promise<void> =
        typeof carouselId === "string" && carouselId
          ? beginGeneration(carouselId, baseline)
          : async () => {};
      let timedOut = false;
      let resultIsError = false;
      const outcomeFor = (code: number | null) =>
        classifyRunExit({ cancelled, timedOut, code, resultIsError });

      // A resumed session the CLI cannot find fails before the CLI reports
      // the session it started, which is how it is told apart from a failure
      // inside a running conversation.
      let sessionStarted = false;
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
        });
        send({ type: "done", sessionId: nextSessionId });
        close();
      });
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
