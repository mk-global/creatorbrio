/**
 * The Studio page's view of one production (#150): the stored document, its
 * history and its compiled preview, and the only way the page changes it.
 *
 * The page never owns timeline state. Every edit is one change set against
 * the revision the page last read; the stored production is read back after
 * every outcome, so what the page shows is always what the store holds. A
 * refused edit leaves the stored state as it was and records the refusal for
 * the page to show at its path. One command runs at a time: an edit computed
 * on a state that is about to change would be refused as stale anyway, so a
 * second command while one is in flight is declined rather than queued.
 *
 * Framework-free, so its rules are unit-tested; React reads it through
 * `useSyncExternalStore`.
 */
import { StudioApiError, type StudioApi } from "./api";
import type { PreviewView, ProductionOp, ProductionView, RefusalIssue } from "./types";

export interface Refusal {
  /** What the person tried, e.g. "Trim clip". */
  summary: string;
  code: string;
  message: string;
  /** Engine or admission issues, each with its path into the production. */
  issues: RefusalIssue[];
}

export interface ProductionSessionState {
  status: "loading" | "ready" | "error";
  view: ProductionView | null;
  preview: PreviewView | null;
  /** A command is in flight; the page should not start another. */
  busy: boolean;
  /** The last command the store refused; cleared by the next one that applies. */
  refusal: Refusal | null;
  /** A failure to read the production at all. */
  error: StudioApiError | null;
}

export type CommandOutcome = "applied" | "refused" | "busy" | "failed";

type Listener = () => void;

export class ProductionSession {
  private state: ProductionSessionState = { status: "loading", view: null, preview: null, busy: false, refusal: null, error: null };
  private readonly listeners = new Set<Listener>();
  private disposed = false;

  constructor(
    private readonly api: StudioApi,
    readonly productionId: string
  ) {}

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ProductionSessionState => this.state;

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private set(patch: Partial<ProductionSessionState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Reads the stored production and its preview. */
  async load(): Promise<void> {
    try {
      const [view, preview] = await Promise.all([this.api.production(this.productionId), this.api.preview(this.productionId)]);
      this.set({ status: "ready", view, preview, error: null });
    } catch (error) {
      this.set({ status: this.state.view ? "ready" : "error", error: asApiError(error) });
    }
  }

  /** Commits `ops` as one change set against the revision last read. */
  apply(summary: string, ops: ProductionOp[]): Promise<CommandOutcome> {
    return this.command(summary, (view) => this.api.change(this.productionId, { baseRevision: view.revision, summary, ops }));
  }

  undo(): Promise<CommandOutcome> {
    return this.command("Undo", (view) => this.api.undo(this.productionId, view.generation));
  }

  redo(): Promise<CommandOutcome> {
    return this.command("Redo", (view) => this.api.redo(this.productionId, view.generation));
  }

  /** Forgets the last refusal, e.g. once the person dismissed it. */
  dismissRefusal(): void {
    this.set({ refusal: null });
  }

  private async command(summary: string, send: (view: ProductionView) => Promise<unknown>): Promise<CommandOutcome> {
    const view = this.state.view;
    if (this.state.busy || !view) return "busy";
    this.set({ busy: true });
    let outcome: CommandOutcome;
    try {
      await send(view);
      this.set({ refusal: null });
      outcome = "applied";
    } catch (error) {
      const e = asApiError(error);
      // A refusal is the store's answer; anything else (network, server) is a failure to reach it.
      outcome = e.status >= 400 && e.status < 500 ? "refused" : "failed";
      this.set({ refusal: { summary, code: e.code, message: e.message, issues: Array.isArray(e.details.issues) ? (e.details.issues as RefusalIssue[]) : [] } });
    }
    // Whatever happened, show what the store now holds: the edit, or the state it refused to change.
    await this.load();
    this.set({ busy: false });
    return outcome;
  }
}

function asApiError(error: unknown): StudioApiError {
  return error instanceof StudioApiError ? error : new StudioApiError(0, "unexpected_error", "Something went wrong in the page.");
}
