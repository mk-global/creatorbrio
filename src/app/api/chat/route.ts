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
    sessionId?: string;
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

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  const encoder = new TextEncoder();
  // Set by the client going away (Stop, a reload, a closed tab).
  let cancelled = false;

  const stream = new ReadableStream({
    start(controller) {
      let childProcess: ReturnType<typeof spawn>;

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
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({
              error: "Failed to start Claude CLI",
              code: e?.code,
              path: claudePath,
              message: e?.message,
            })}\n\n`
          )
        );
        controller.close();
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
      const noteResult = (event: Record<string, unknown>) => {
        if (event.type === "result" && event.is_error === true) resultIsError = true;
      };

      let buffer = "";
      let resolvedSessionId = sessionId ?? "";

      childProcess.stdout?.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            noteResult(event);
            handleEvent(event, controller, encoder, (id) => {
              resolvedSessionId = id;
            });
          } catch {
            // skip unparseable lines
          }
        }
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

      childProcess.on("error", (err) => {
        clearTimeout(timeout);
        // A cancelled chat reports an AbortError as soon as the kill is sent,
        // while the subprocess may still be finishing a write. Release here
        // only if it never started or has already gone; otherwise "exit" will.
        if (childProcess.pid === undefined) {
          endGeneration("not-started");
        } else if (
          childProcess.exitCode !== null ||
          childProcess.signalCode !== null
        ) {
          endGeneration(outcomeFor(childProcess.exitCode));
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
        try {
          childProcess.kill();
          controller.enqueue(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({
                error: err.message,
                code: e?.code,
                syscall: e?.syscall,
                path: e?.path,
                stderr: stderrBuf || undefined,
              })}\n\n`
            )
          );
          controller.close();
        } catch {
          // stream already closed
        }
      });

      childProcess.on("exit", async (code) => {
        clearTimeout(timeout);
        // process remaining buffer
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            noteResult(event);
            handleEvent(event, controller, encoder, (id) => {
              resolvedSessionId = id;
            });
          } catch {
            // skip
          }
        }

        if (code && code !== 0) {
          console.error("[chat] Claude subprocess exited non-zero", {
            claudePath,
            platform: process.platform,
            exitCode: code,
            stderr: stderrBuf,
          });
          try {
            controller.enqueue(
              encoder.encode(
                `event: error\ndata: ${JSON.stringify({
                  error: `Claude CLI exited with code ${code}`,
                  exitCode: code,
                  stderr: stderrBuf || undefined,
                })}\n\n`
              )
            );
          } catch {
            // stream already closed
          }
        }

        // Saved before "done", so the editor's next status check sees it.
        await endGeneration(outcomeFor(code));

        try {
          controller.enqueue(
            encoder.encode(
              `event: done\ndata: ${JSON.stringify({
                sessionId: resolvedSessionId,
                exitCode: code,
              })}\n\n`
            )
          );
          controller.close();
        } catch {
          // stream already closed
        }
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

function handleEvent(
  event: Record<string, unknown>,
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  onSessionId: (id: string) => void
) {
  // Extract session ID from init event
  if (
    event.type === "system" &&
    event.subtype === "init" &&
    event.session_id
  ) {
    onSessionId(event.session_id as string);
    return;
  }

  // Extract streaming text tokens
  if (event.type === "assistant" && event.message) {
    const msg = event.message as Record<string, unknown>;
    if (msg.type === "message" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "token", text: b.text })}\n\n`
            )
          );
        }
      }
    }
    return;
  }

  // Extract result with session ID
  if (event.type === "result") {
    if (event.session_id) {
      onSessionId(event.session_id as string);
    }
    if (typeof event.result === "string" && event.result) {
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ type: "result", text: event.result })}\n\n`
        )
      );
    }
    return;
  }
}
