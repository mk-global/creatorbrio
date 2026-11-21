import { ServerStartRefused } from "./server";

/**
 * The gate every server start passes, and what the item tests make of a
 * refusal (#232), as pure code so each rule is tested without a server.
 *
 * A server must not start on a CLI or `.env` files that are no longer what
 * the run was checked against. The first refused start closes the gate for
 * good: no later item starts a server or a model call, and each is recorded
 * as not run before any stage, so settlement charges it nothing. What had
 * started is still charged in full, so the ledger never under-counts.
 */

/** The differences found at a server start, as the words the refusal names: the pinned CLI's first, then the `.env` files'. */
export function startChanges(pinChanges: readonly string[], envChanges: readonly string[]): string[] {
  return [...pinChanges.map((c) => `the pinned CLI: ${c}`), ...envChanges];
}

export class StartGate {
  private closedBy: string | null = null;

  /** The text of the first refusal, or null while the gate is open. */
  get refusal(): string | null {
    return this.closedBy;
  }

  /** Throws `ServerStartRefused` with the first refusal's text once one was made. */
  assertOpen(): void {
    if (this.closedBy) throw new ServerStartRefused(this.closedBy);
  }

  /** Closes the gate and throws when `changes` is not empty; does nothing otherwise. A later clean check never reopens it. */
  admit(changes: readonly string[]): void {
    this.assertOpen();
    if (changes.length === 0) return;
    this.closedBy = `The pinned CLI or the servers' .env files changed since the run began (${changes.join("; ")}), so no further model call is made`;
    throw new ServerStartRefused(this.closedBy);
  }
}

export type ItemFailure =
  /** A server start was refused before the item made any model call: not run, and charged nothing. */
  | { kind: "not-run"; reason: string }
  /** Anything else, including a refusal after the item's own chats, which is charged in full. */
  | { kind: "harness-error"; message: string };

/**
 * What an item's thrown error means. A refused server start before the item
 * made any chat is a "not run" with the refusal as its reason; every other
 * error, a refusal after the item's own chats included, is a harness error
 * (its stack, or its text when it has none). `scrub` removes paths from
 * whatever is stored.
 */
export function classifyItemFailure(err: unknown, chatsMade: number, scrub: (text: string) => string): ItemFailure {
  if (err instanceof ServerStartRefused && chatsMade === 0) return { kind: "not-run", reason: scrub(err.message) };
  return { kind: "harness-error", message: scrub((err as Error)?.stack ?? String(err)) };
}

/**
 * Why an item's comparison is skipped, or null when it can run: the item was
 * not run, in which case the reason is the refusal's text and not a missing
 * export, or the Director arm produced no export to compare.
 */
export function skippedComparisonReason(options: { notRun: string | null; directorExport: boolean }): string | null {
  if (options.notRun) return `the item was not run: ${options.notRun}`;
  if (!options.directorExport) return "the Director arm produced no export to compare";
  return null;
}
