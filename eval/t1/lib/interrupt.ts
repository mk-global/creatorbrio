/**
 * An interrupted run must not leave a live, uncontained agent holding a token
 * (#225). Both runners register a stop function here at the moment the subject
 * can first run; SIGINT, SIGTERM and SIGHUP call it at once (stop the subject,
 * before anything else), tell the operator to revoke the token, and mark the
 * run interrupted so its main flow stops at the next checkpoint and goes
 * straight to teardown and the record. The spend reservation is never settled
 * by an interrupted run: it keeps counting in full. A second signal forces the
 * teardown and exits.
 */

export interface InterruptState {
  signal: string | null;
  at: number | null;
}

const state: InterruptState = { signal: null, at: null };
let stopSubject: (() => void) | null = null;
let teardown: (() => void) | null = null;
let notice: ((text: string) => void) | null = null;
let installed = false;

export class InterruptedError extends Error {
  constructor(signal: string) {
    super(`INTERRUPTED by ${signal}`);
  }
}

export const interrupted = (): InterruptState => ({ ...state });

let tokenSent = false;
/** Called at the token step of a run that carries a real token, before the token is sent: from then on, however the process ends, the operator is told to revoke it. */
export const markTokenSent = (): void => {
  tokenSent = true;
};
export const tokenWasSent = (): boolean => tokenSent;

/** Called from every wait in a runner: throws once a signal has arrived. */
export function checkpoint(): void {
  if (state.signal) throw new InterruptedError(state.signal);
}

/**
 * Lets the event loop run once. A signal's handler cannot run while the process
 * is inside a blocking command (a `spawnSync` of ssh, docker or lume), so a
 * signal that arrived during one is only recorded when the process next returns
 * to the loop: the gate yields first, then looks.
 */
const yieldToSignals = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/**
 * Runs one step only if no signal has arrived, as far as the process could have
 * noticed: it yields to the event loop (so a signal that came in during the
 * previous blocking command is recorded), then checks, then runs the step. Every
 * step of a runner that touches the subject's machine (the token above all, but
 * also each script run as the subject, each mark, snapshot and model phase) goes
 * through it, so an interrupted run reaches the token and the next phase never.
 * The longest a signal can wait is the one blocking command that was running
 * when it arrived.
 */
export async function gated<T>(step: () => T): Promise<T> {
  await yieldToSignals();
  checkpoint();
  return step();
}

export function revokeNotice(signal: string, hasToken: boolean): string {
  return `\n${signal}: the run was interrupted. The subject was stopped and the environment is being removed.\n${
    hasToken ? "REVOKE THE MODEL TOKEN NOW: it was inside the environment, and this run's spend reservation still counts in full until you settle it.\n" : "No model token was in use.\n"
  }`;
}

/** Registers what to do on a signal. `stop` must be quick and safe to call twice; `forceTeardown` removes everything and may take a while. */
export function installInterrupt(options: { stop: () => void; forceTeardown: () => void; say: (text: string) => void; hasToken: boolean }): void {
  stopSubject = options.stop;
  teardown = options.forceTeardown;
  notice = options.say;
  if (installed) return;
  installed = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      if (state.signal) {
        // A second signal: tear down now and leave.
        try {
          teardown?.();
        } finally {
          process.exit(130);
        }
      }
      state.signal = sig;
      state.at = Date.now();
      try {
        stopSubject?.();
      } catch {
        // The teardown below still runs.
      }
      notice?.(revokeNotice(sig, options.hasToken));
    });
  }
}

/** For tests: forgets a recorded signal. */
export function resetInterruptForTests(): void {
  state.signal = null;
  state.at = null;
}

/** For tests: records a signal as if it had arrived, without a process signal. */
export function simulateSignal(signal: string): void {
  state.signal = signal;
  state.at = Date.now();
}
