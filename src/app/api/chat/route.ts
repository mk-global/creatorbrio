import { bindAgentSession, boundConversation } from "@/lib/agent-sessions";
import { ConversationGoneError } from "@/lib/agent-workspace";
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
  executionLimitMessage,
  isRunId,
  isSessionId,
  MAX_CHAT_MESSAGE_LENGTH,
  type ChatErrorCode,
  type ChatStreamEvent,
  type ExecutionLimit,
} from "@/lib/chat-stream";
import { finishCreativeRun, prepareCreativeRun, type CreativeRunInput } from "@/lib/creative-run";
import { checkConformance } from "@/lib/creative-handoff";
import { designAgentArgs, designAgentSettings } from "@/lib/design-agent";
import { designAgentProfileName } from "@/lib/design-agent-profile";
import { containedAvailability } from "@/lib/design-agent-availability";
import { agentListenerPort } from "@/lib/agent-listener";
import { prepareContainedLaunch, type ContainedLaunch } from "@/lib/contained-launch";
import { continuationOffer } from "@/lib/assets";
import {
  beginGeneration,
  CAROUSEL_BEING_DELETED_ERROR,
  classifyRunExit,
  GENERATION_ALREADY_RUNNING_ERROR,
  isBeingDeleted,
  type RunOutcome,
} from "@/lib/generation-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The longest creative run with default settings: linked pages (30 s),
// planning (120 s), images (12 min) and design (30 min), about 45 minutes. A
// self-hosted Next.js server does not enforce this value; the stage limits,
// including an operator's DESIGN_AGENT_TIMEOUT_SECONDS, are the real bound.
export const maxDuration = 2700;

type DesignRun = Extract<Awaited<ReturnType<typeof prepareCreativeRun>>, { kind: "design" }>;

/** The CLI's assistant-message errors that mean a usage or rate limit refused the request. */
const PROVIDER_LIMIT_ERRORS = new Set(["rate_limit", "billing_error"]);

/** The CLI's token counts, without anything else it reports. */
function usageCounts(usage: unknown): Record<string, number> | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const counts: Record<string, number> = {};
  for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    if (typeof u[key] === "number") counts[key] = u[key] as number;
  }
  return counts;
}

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
    continueRunId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { sessionId, carouselId, stylePresetId, retryRunId, continueRunId } = body;

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
  // A Continue likewise names one unfinished design of this carousel, and is never also a retry.
  const continuing = continueRunId !== undefined && continueRunId !== null;
  if (continuing && (!isRunId(continueRunId) || typeof carouselId !== "string" || !carouselId || (retryRunId ?? null) !== null)) {
    return NextResponse.json({ error: "Invalid continue" }, { status: 400 });
  }

  // Read per request, like the other settings; an unknown name is refused, never ignored.
  const profile = designAgentProfileName();
  const contained = profile.ok && profile.name === "contained";
  // The contained agent works in its carousel's own folder, so it needs one.
  if (contained && (typeof carouselId !== "string" || !carouselId)) {
    return NextResponse.json({ error: "A design needs a carousel" }, { status: 400 });
  }

  // The carousel's run begins before any work for this request, and a
  // carousel has one active run at a time. From here on, every way this
  // request ends must end the run exactly once.
  const run = typeof carouselId === "string" && carouselId ? beginGeneration(carouselId) : null;
  if (typeof carouselId === "string" && carouselId && !run) {
    // A contained carousel's deletion holds the same slot (#241).
    return NextResponse.json({ error: isBeingDeleted(carouselId) ? CAROUSEL_BEING_DELETED_ERROR : GENERATION_ALREADY_RUNNING_ERROR }, { status: 409 });
  }
  const endGeneration = (outcome: RunOutcome): Promise<void> =>
    run ? run.end(outcome) : Promise.resolve();

  // Build dynamic system prompt with the carousel's brand + carousel + style preset context
  let systemPrompt: string;
  let listenerPort: number | null = null;
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
        continueRunId: isRunId(continueRunId) ? continueRunId : null,
        resumingSession: resumeSessionId !== null,
        pageTextForAgent: contained,
      };
    }
    // The contained agent reaches only its run's listener; the legacy agent
    // curls this app's own API, at the origin the request arrived on.
    listenerPort = contained ? await agentListenerPort() : null;
    systemPrompt = buildSystemPrompt({
      baseUrl: listenerPort !== null ? `http://localhost:${listenerPort}` : resolveAppOrigin(request),
      contained,
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

  // Read per request, before any work, so a bad setting changes nothing.
  const settings = designAgentSettings();
  const budgetUsd = settings.ok ? settings.budgetUsd : null;
  const designArgs = (taskMessage: string) => designAgentArgs({ taskMessage, systemPrompt, resumeSessionId, budgetUsd });

  const encoder = new TextEncoder();
  // Set by the client going away (Stop, a reload, a closed tab).
  let cancelled = false;

  const stream = new ReadableStream({
    start(controller) {
      // The contained run's token is redacted from anything relayed, should the agent repeat it.
      let launch: ContainedLaunch | null = null;
      // The conversation a resumed contained session is bound to, and the one the run works in.
      let resumeConversationId: string | null = null;
      let conversationId: string | null = null;
      // Kept for the whole request: output and logs written after the run ends are still redacted.
      let redact = (text: string) => text;
      const finishLaunch = () => {
        const current = launch;
        launch = null;
        return current ? current.finish() : Promise.resolve();
      };
      const send = (event: ChatStreamEvent) => {
        if (event.type === "token" || event.type === "result") event = { ...event, text: redact(event.text) };
        try {
          controller.enqueue(encoder.encode(encodeChatEvent(event)));
        } catch {
          // stream already closed
        }
      };
      // Only the first failure is reported: it is the cause, and anything
      // after it (a non-zero exit following an error result) is a consequence.
      let errorCode: ChatErrorCode | null = null;
      const fail = (code: ChatErrorCode, message: string = CHAT_ERROR_MESSAGES[code]) => {
        if (errorCode || cancelled) return;
        errorCode = code;
        send({ type: "error", code, message });
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          // stream already closed
        }
      };

      void (async () => {
        if (!settings.ok) {
          console.warn("[chat] design agent setting invalid", { carouselId: carouselId ?? null, stage: "design", failureCategory: settings.code });
          fail(settings.code);
          await endGeneration("not-started");
          send({ type: "done", sessionId: null });
          close();
          return;
        }
        if (!profile.ok || contained) {
          // A contained run resumes only a session bound to its own carousel (#237),
          // in the conversation folder it is bound to (#241): the CLI would resume
          // any session it can find, including the person's own.
          const sessionRefusal = async () => {
            if (!resumeSessionId || !carouselId) return null;
            resumeConversationId = await boundConversation(carouselId, resumeSessionId).catch((error) => {
              // An unreadable binding is treated as no binding: the chat starts fresh.
              console.error("[chat] could not read the session bindings", { carouselId, failureCategory: "session_binding", error: String(error) });
              return null;
            });
            return resumeConversationId ? null : { code: "session_not_found" as const, message: CHAT_ERROR_MESSAGES.session_not_found };
          };
          const refusal = !profile.ok
            ? { code: "profile_setting_invalid" as const, message: CHAT_ERROR_MESSAGES.profile_setting_invalid }
            : ((await containedAvailability(claudePath).then((a) =>
                a.available ? null : { code: "agent_unavailable" as const, message: `${a.reason} ${a.guidance} Nothing was changed.` }
              )) ?? (await sessionRefusal()));
          if (refusal) {
            console.warn("[chat] design run refused before it started", { carouselId: carouselId ?? null, stage: "design", failureCategory: refusal.code });
            fail(refusal.code, refusal.message);
            await endGeneration("not-started");
            send({ type: "done", sessionId: null });
            close();
            return;
          }
        }
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
        if (contained) {
          try {
            launch = await prepareContainedLaunch({
              carouselId: carouselId!,
              taskMessage,
              systemPrompt,
              resumeSessionId,
              conversationId: resumeConversationId,
              budgetUsd,
              listenerPort: listenerPort!,
              appOrigin: resolveAppOrigin(request),
              tokenTtlMs: settings.timeoutMs + 60_000,
            });
            redact = launch.redact;
            conversationId = launch.conversationId;
          } catch (err) {
            // A bound conversation whose folder is gone cannot be resumed: the chat starts fresh.
            const gone = err instanceof ConversationGoneError;
            (gone ? console.warn : console.error)("[chat] contained design agent could not be prepared", { carouselId: carouselId ?? null, message: (err as Error)?.message });
            fail(gone ? "session_not_found" : "start_failed");
            if (creativeRun) await finishCreativeRun(carouselId!, creativeRun.runId, "failed");
            await endGeneration("not-started");
            send({ type: "done", sessionId: null });
            close();
            return;
          }
        }
        design(taskMessage, creativeRun);
      })();

      function design(taskMessage: string, creativeRun: DesignRun | null) {
      if (!settings.ok) return;
      const { timeoutMs, inactivityMs } = settings;
      let childProcess: ReturnType<typeof spawn>;
      const isWindowsShim =
        process.platform === "win32" && /\.(cmd|bat)$/i.test(claudePath);
      const spawner = isWindowsShim ? crossSpawn : spawn;

      // The contained CLI leads its own process group, so a terminal's Ctrl-C
      // never reaches it directly and every stop reaches the whole group and
      // what it started (#241); the legacy agent is started as before.
      const containedRun = launch;
      try {
        childProcess = spawner(claudePath, containedRun ? containedRun.args : designArgs(taskMessage), {
          cwd: containedRun ? containedRun.cwd : process.cwd(),
          // The contained profile's explicit allowlist; the legacy agent inherits everything.
          ...(containedRun ? { env: containedRun.env as NodeJS.ProcessEnv, detached: true } : { signal: abortController.signal }),
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
          .catch((error) => {
            // The token is still revoked and the run ended below.
            console.error("[chat] could not record the end of a creative run", { carouselId, message: (error as Error)?.message });
          })
          .then(finishLaunch)
          .then(() => endGeneration("not-started"))
          .finally(close);
        return;
      }

      // Stops the CLI: the contained CLI's whole process group and what it
      // started, the legacy CLI's own process as before.
      const kill = (signal: NodeJS.Signals = "SIGTERM") => {
        if (containedRun) containedRun.signal(signal);
        else childProcess.kill(signal);
      };
      if (containedRun && childProcess.pid !== undefined) {
        // A stop (the Stop button, a reload, a closed tab, the server shutting
        // down) ends the contained run as the abort signal ends the legacy one.
        let abortKill: ReturnType<typeof setTimeout> | null = null;
        const onAbort = () => {
          kill("SIGTERM");
          abortKill ??= setTimeout(() => kill("SIGKILL"), FORCE_KILL_AFTER_MS);
        };
        const cli = childProcess;
        containedRun.track(
          childProcess.pid,
          () => {
            cancelled = true;
            abortController.abort();
          },
          // Until Node reaps the CLI, its process id cannot belong to another process.
          () => cli.exitCode === null && cli.signalCode === null
        );
        if (abortController.signal.aborted) onAbort();
        else abortController.signal.addEventListener("abort", onAbort, { once: true });
        childProcess.once("exit", () => {
          if (abortKill) clearTimeout(abortKill);
          abortController.signal.removeEventListener("abort", onAbort);
        });
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
      // What the CLI reported, for the run log: its estimated cost (a list-price
      // estimate, not an invoiced charge), token usage and turns.
      let designCostUsd: number | null = null;
      let designUsage: Record<string, number> | null = null;
      let designTurns: number | null = null;
      // A usage, rate or spending limit outside CreatorBrio, as the CLI reports it.
      let providerError: string | null = null;
      let toolErrors = 0;
      let permissionDenials = 0;
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

        // The CLI reports a refused request for a usage or rate limit in two
        // ways: a rejected rate-limit event, and an error on the assistant
        // message it synthesizes instead of a reply.
        if (event.type === "rate_limit_event") {
          const info = event.rate_limit_info as Record<string, unknown> | undefined;
          if (info?.status === "rejected") providerError ??= "rate_limit_rejected";
          return;
        }
        if (event.type === "assistant" && typeof event.error === "string" && PROVIDER_LIMIT_ERRORS.has(event.error)) {
          providerError ??= event.error;
        }
        if (event.type === "user" && event.message) {
          const content = (event.message as Record<string, unknown>).content;
          if (Array.isArray(content)) {
            toolErrors += content.filter((b) => (b as Record<string, unknown>)?.type === "tool_result" && (b as Record<string, unknown>).is_error === true).length;
          }
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
          if (typeof event.num_turns === "number") designTurns = event.num_turns;
          designUsage = usageCounts(event.usage);
          if (Array.isArray(event.permission_denials)) permissionDenials = event.permission_denials.length;
          if (event.is_error === true) {
            // An error result is not a reply; it is reported as a failure.
            resultIsError = true;
            fail(
              resumeFailed()
                ? "session_not_found"
                : event.subtype === "error_max_budget_usd"
                  ? // Only a cap this app was told to pass is CreatorBrio's own.
                    budgetUsd !== null
                    ? "budget_exceeded"
                    : "usage_limited"
                  : providerError
                    ? "usage_limited"
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

      // The two execution limits (#187). The deadline is absolute. The
      // inactivity watchdog is reset by anything the CLI writes to its
      // standard output, and output can never move the deadline. The first
      // limit to fire is the only one: it clears both, stops the CLI, and
      // kills it outright if it ignores the stop, so the run always ends.
      let limitFired: ExecutionLimit | null = null;
      let exited = false;
      // The activity that tells a working agent from a stuck one, measured
      // until a limit fires: output after the stop does not count.
      let lastOutput: number | null = null;
      let longestQuiet = 0;
      let stoppedAt: number | null = null;
      let limitKill: ReturnType<typeof setTimeout> | null = null;
      let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
      const clearLimits = () => {
        clearTimeout(deadline);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = null;
      };
      const stopFor = (limit: ExecutionLimit) => {
        if (limitFired || exited || cancelled) return;
        limitFired = limit;
        timedOut = true;
        clearLimits();
        const now = Date.now();
        stoppedAt = now;
        // An expected outcome, not a fault: counts and times only.
        console.warn("[chat] design agent stopped by an execution limit", {
          carouselId: carouselId ?? null,
          runId: creativeRun?.runId ?? null,
          limit,
          timeoutMs,
          inactivityMs,
          elapsedMs: now - designStarted,
          quietMs: now - (lastOutput ?? designStarted),
        });
        kill();
        limitKill = setTimeout(() => kill("SIGKILL"), FORCE_KILL_AFTER_MS);
      };
      const deadline = setTimeout(() => stopFor("deadline"), timeoutMs);
      const watchOutput = () => {
        if (inactivityMs === null || limitFired || exited) return;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => stopFor("inactivity"), inactivityMs);
      };
      watchOutput();

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
        if (!limitFired) {
          const now = Date.now();
          longestQuiet = Math.max(longestQuiet, now - (lastOutput ?? designStarted));
          lastOutput = now;
          watchOutput();
        }
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });

      let stderrBuf = "";
      const STDERR_CAP = 8192;
      childProcess.stderr?.on("data", (chunk: Buffer) => {
        if (stderrBuf.length < STDERR_CAP) {
          // Redacted as a whole, so a token split across chunks is still caught.
          stderrBuf = redact(stderrBuf + chunk.toString()).slice(-STDERR_CAP);
        }
      });

      childProcess.on("error", async (err) => {
        clearLimits();
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
            kill("SIGKILL");
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
        kill();
        fail(childProcess.pid === undefined ? "start_failed" : "agent_failed");
        await released;
        // A process that is still running keeps its token until it exits.
        if (childProcess.pid === undefined || childProcess.exitCode !== null || childProcess.signalCode !== null) await finishLaunch();
        close();
      });

      childProcess.on("exit", async (code) => {
        exited = true;
        const endedAt = Date.now();
        const activityEnd = stoppedAt ?? endedAt;
        clearLimits();
        if (limitKill) clearTimeout(limitKill);
        handleLine(buffer);
        buffer = "";

        // Read once, for the stop message and the run log; the CLI has exited,
        // so nothing changes the slides any more.
        const after = carouselId ? await getCarousel(carouselId).catch(() => null) : null;
        if (limitFired) {
          fail(
            limitFired === "deadline" ? "timed_out" : "stalled",
            executionLimitMessage(limitFired, {
              limitMs: limitFired === "deadline" ? timeoutMs : (inactivityMs ?? timeoutMs),
              saved: after ? after.slides.length : null,
              expected: creativeRun?.plan.execution.slideCount ?? null,
            })
          );
        } else if (code !== 0 && !cancelled) {
          // Non-zero, or killed by a signal nobody here sent.
          fail(resumeFailed() ? "session_not_found" : providerError ? "usage_limited" : "agent_failed");
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

        // The agent has exited: its token stops working, whatever it left
        // running is stopped, and its temporary folder goes.
        await finishLaunch();
        // Saved before "done", so the editor's next status check sees it.
        const outcome = outcomeFor(code);
        if (creativeRun) await finishDesign(creativeRun, outcome);
        await endGeneration(outcome);

        // A session that could not be resumed is not offered again.
        const nextSessionId = errorCode === "session_not_found" ? null : resolvedSessionId;
        // Counts, codes, settings and times only: never the message, the plan or slide copy.
        const offer = carouselId && outcome !== "completed" ? await continuationOffer(carouselId).catch(() => null) : null;
        console.info("[chat] run finished", {
          carouselId: carouselId ?? null,
          runId: creativeRun?.runId ?? null,
          stage: "design",
          continued: creativeRun?.continued ?? false,
          resumedSessionId: resumeSessionId,
          sessionId: nextSessionId,
          outcome,
          exitCode: code,
          errorCode,
          failureCategory: errorCode ?? (outcome === "stopped" ? "cancelled" : null),
          providerError,
          budgetUsd,
          timeoutMs,
          inactivityMs,
          // Which execution limit stopped the run, if one did, and the
          // activity that tells a working agent from a stuck one (#187).
          limit: limitFired,
          designStartedAt: new Date(designStarted).toISOString(),
          lastOutputAt: lastOutput === null ? null : new Date(lastOutput).toISOString(),
          quietMs: activityEnd - (lastOutput ?? designStarted),
          // The longest the CLI went without output, the evidence for the inactivity limit.
          longestQuietMs: Math.max(longestQuiet, activityEnd - (lastOutput ?? designStarted)),
          lastCarouselWriteAt: after && Date.parse(after.updatedAt) >= designStarted ? after.updatedAt : null,
          designDurationMs: endedAt - designStarted,
          designCostUsd,
          designUsage,
          designTurns,
          toolErrors,
          permissionDenials,
          slidesSaved: after?.slides.length ?? null,
          slidesExpected: creativeRun?.plan.execution.slideCount ?? null,
          continuationAvailable: offer !== null,
        });
        // The session a contained run hands back is the one its carousel may resume.
        if (conversationId && carouselId && nextSessionId) {
          await bindAgentSession(carouselId, nextSessionId, conversationId).catch((error) =>
            console.error("[chat] could not bind the session to its carousel", { carouselId, failureCategory: "session_binding", error: String(error) })
          );
        }
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
