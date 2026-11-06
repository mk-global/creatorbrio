/**
 * What the Studio's Undo and Redo buttons offer (#150): the step each would
 * apply, named by the change set's summary, and whether it can run now. The
 * top of each stack is its last element, as the history keeps them.
 */
import type { ProductionView } from "./types";

export interface HistoryAction {
  /** The step's label, e.g. "Add title"; null when the stack is empty. */
  label: string | null;
  enabled: boolean;
  /** "Undo Add title", "Nothing to undo", or the same while another command runs. */
  title: string;
}

function action(verb: "Undo" | "Redo", steps: ProductionView["history"]["undo"], busy: boolean): HistoryAction {
  const top = steps.length > 0 ? steps[steps.length - 1] : null;
  if (!top) return { label: null, enabled: false, title: `Nothing to ${verb.toLowerCase()}` };
  const title = `${verb} ${top.label}`;
  return { label: top.label, enabled: !busy, title: busy ? `${title} (wait for the current change to finish)` : title };
}

export function historyActions(view: ProductionView, busy: boolean): { undo: HistoryAction; redo: HistoryAction } {
  return { undo: action("Undo", view.history.undo, busy), redo: action("Redo", view.history.redo, busy) };
}
