/**
 * Small-sample statistics for repeated scenarios: the sample size, the
 * median and the range. With a handful of runs per scenario an
 * interquartile range says little, so the spread is reported as min and max.
 */

export interface Spread {
  /** How many runs had a value. */
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

export function spread(values: (number | null | undefined)[]): Spread {
  const v = values.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0, median: null, min: null, max: null };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { n: v.length, median, min: v[0], max: v[v.length - 1] };
}

/** Groups items by a key, keeping first-seen key order. */
export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/**
 * A run's request latency: the sum of its chat requests' own durations, which
 * is what a user waits. Unlike the harness's wall time it leaves out judging,
 * export, waits for the image service and the checks. Null when no chat was sent.
 */
export const requestMs = (r: { chats: { result: { durationMs: number } }[] }): number | null =>
  r.chats.length ? r.chats.reduce((a, c) => a + c.result.durationMs, 0) : null;
