/**
 * The Creative Brief: the small, persistent record of what a carousel is for,
 * so a revision such as "make it more dramatic" keeps the original objective,
 * subject, tone and constraints.
 *
 * It is stored on the carousel (one brief per carousel, so it never crosses to
 * another carousel or brand), server-owned and copied when the carousel is
 * duplicated. The Visual Director reads it and proposes an update; this module
 * validates the proposal and merges it under two rules:
 *
 * - a value the user stated (`explicit`) is never replaced or retired by one
 *   the Director inferred;
 * - a newer explicit instruction replaces or retires an older value it is
 *   incompatible with, and the Director must say why.
 *
 * Everything here is pure; persistence goes through `carousels.ts`.
 */

import type { AssetRelationship, BriefItem, BriefValue, CreativeBrief, Provenance } from "@/types/creative-brief";
import { BRIEF_FIELDS, type BriefField } from "@/types/creative-brief";

export type { AssetRelationship, BriefItem, BriefValue, CreativeBrief, Provenance, BriefField };
export { BRIEF_FIELDS };

/** What the Director proposes after reading the request and the stored brief. */
export interface BriefUpdate {
  fields: Partial<Record<BriefField, { value: string; source: Provenance }>>;
  addConstraints: { text: string; source: Provenance }[];
  /** Earlier constraints the current message replaces, quoted exactly, with the reason. */
  retireConstraints: { text: string; because: string; source: Provenance }[];
  addVisualDecisions: { text: string; source: Provenance }[];
  retireVisualDecisions: { text: string; because: string; source: Provenance }[];
  assetRelationships: { id: string; role: string; source: Provenance }[];
}

export const BRIEF_LIMITS = {
  value: 300,
  item: 200,
  reason: 200,
  constraints: 12,
  visualDecisions: 12,
  assetRelationships: 10,
} as const;

export const EMPTY_BRIEF_UPDATE: BriefUpdate = {
  fields: {},
  addConstraints: [],
  retireConstraints: [],
  addVisualDecisions: [],
  retireVisualDecisions: [],
  assetRelationships: [],
};

export function emptyBrief(at = ""): CreativeBrief {
  return { constraints: [], visualDecisions: [], assetRelationships: [], updatedAt: at };
}

// Newline and tab are allowed; every other control character is refused.
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/;

/** A bounded, single-purpose text: non-empty after trimming, no control characters. */
export function isBoundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL_CHARS.test(value);
}

const isProvenance = (v: unknown): v is Provenance => v === "explicit" || v === "inferred";
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], at: string, errors: string[]): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${at}: unknown field "${key}"`);
}

/**
 * Validates an untrusted brief update. Returns the typed update, or the list
 * of rule violations; unknown fields are violations.
 */
export function validateBriefUpdate(
  input: unknown,
  knownIds: ReadonlySet<string>
): { ok: true; update: BriefUpdate } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["briefUpdate: must be an object"] };
  onlyKeys(input, Object.keys(EMPTY_BRIEF_UPDATE), "briefUpdate", errors);

  const fields: BriefUpdate["fields"] = {};
  if (input.fields !== undefined) {
    if (!isRecord(input.fields)) errors.push("briefUpdate.fields: must be an object");
    else {
      onlyKeys(input.fields, BRIEF_FIELDS, "briefUpdate.fields", errors);
      for (const name of BRIEF_FIELDS) {
        const field = input.fields[name];
        if (field === undefined) continue;
        if (!isRecord(field)) {
          errors.push(`briefUpdate.fields.${name}: must be an object`);
          continue;
        }
        onlyKeys(field, ["value", "source"], `briefUpdate.fields.${name}`, errors);
        if (!isBoundedText(field.value, BRIEF_LIMITS.value) || !isProvenance(field.source)) {
          errors.push(`briefUpdate.fields.${name}: needs a value of 1 to ${BRIEF_LIMITS.value} characters and a source`);
        } else fields[name] = { value: field.value, source: field.source };
      }
    }
  }

  const items = (key: "addConstraints" | "addVisualDecisions", max: number) => {
    const raw = input[key] ?? [];
    if (!Array.isArray(raw) || raw.length > max) {
      errors.push(`briefUpdate.${key}: must be a list of at most ${max}`);
      return [];
    }
    return raw.flatMap((item, i) => {
      if (!isRecord(item)) return errors.push(`briefUpdate.${key}[${i}]: must be an object`), [];
      onlyKeys(item, ["text", "source"], `briefUpdate.${key}[${i}]`, errors);
      if (!isBoundedText(item.text, BRIEF_LIMITS.item) || !isProvenance(item.source)) {
        return errors.push(`briefUpdate.${key}[${i}]: needs text of 1 to ${BRIEF_LIMITS.item} characters and a source`), [];
      }
      return [{ text: item.text, source: item.source }];
    });
  };

  const retirements = (key: "retireConstraints" | "retireVisualDecisions", max: number) => {
    const raw = input[key] ?? [];
    if (!Array.isArray(raw) || raw.length > max) {
      errors.push(`briefUpdate.${key}: must be a list of at most ${max}`);
      return [];
    }
    return raw.flatMap((item, i) => {
      if (!isRecord(item)) return errors.push(`briefUpdate.${key}[${i}]: must be an object`), [];
      onlyKeys(item, ["text", "because", "source"], `briefUpdate.${key}[${i}]`, errors);
      if (
        !isBoundedText(item.text, BRIEF_LIMITS.item) ||
        !isBoundedText(item.because, BRIEF_LIMITS.reason) ||
        !isProvenance(item.source)
      ) {
        return errors.push(`briefUpdate.${key}[${i}]: needs the exact text, a reason and a source`), [];
      }
      return [{ text: item.text, because: item.because, source: item.source }];
    });
  };

  const relationships = (() => {
    const raw = input.assetRelationships ?? [];
    if (!Array.isArray(raw) || raw.length > BRIEF_LIMITS.assetRelationships) {
      errors.push(`briefUpdate.assetRelationships: must be a list of at most ${BRIEF_LIMITS.assetRelationships}`);
      return [];
    }
    return raw.flatMap((item, i) => {
      if (!isRecord(item)) return errors.push(`briefUpdate.assetRelationships[${i}]: must be an object`), [];
      onlyKeys(item, ["id", "role", "source"], `briefUpdate.assetRelationships[${i}]`, errors);
      if (typeof item.id !== "string" || !knownIds.has(item.id)) {
        return errors.push(`briefUpdate.assetRelationships[${i}]: not a reference image or asset of this carousel`), [];
      }
      if (!isBoundedText(item.role, BRIEF_LIMITS.item) || !isProvenance(item.source)) {
        return errors.push(`briefUpdate.assetRelationships[${i}]: needs a role and a source`), [];
      }
      return [{ id: item.id, role: item.role, source: item.source }];
    });
  })();

  const update: BriefUpdate = {
    fields,
    addConstraints: items("addConstraints", BRIEF_LIMITS.constraints),
    retireConstraints: retirements("retireConstraints", BRIEF_LIMITS.constraints),
    addVisualDecisions: items("addVisualDecisions", BRIEF_LIMITS.visualDecisions),
    retireVisualDecisions: retirements("retireVisualDecisions", BRIEF_LIMITS.visualDecisions),
    assetRelationships: relationships,
  };
  return errors.length > 0 ? { ok: false, errors } : { ok: true, update };
}

const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();

/** May `incoming` replace or retire `existing`? Inferred never overrides explicit. */
const mayOverride = (existing: Provenance, incoming: Provenance) => existing === "inferred" || incoming === "explicit";

function mergeItems(
  existing: BriefItem[],
  add: { text: string; source: Provenance }[],
  retire: { text: string; source: Provenance }[],
  max: number,
  at: string
): BriefItem[] {
  const retired = new Map(retire.map((r) => [normalize(r.text), r.source]));
  const kept = existing.filter((item) => {
    const by = retired.get(normalize(item.text));
    return by === undefined || !mayOverride(item.source, by);
  });
  for (const item of add) {
    const same = kept.findIndex((k) => normalize(k.text) === normalize(item.text));
    if (same === -1) kept.push({ ...item, at });
    // Restating an inferred item explicitly confirms it.
    else if (item.source === "explicit") kept[same] = { ...item, at };
  }
  // Explicit items are kept first when the list is full; the oldest inferred go.
  if (kept.length <= max) return kept;
  const explicit = kept.filter((k) => k.source === "explicit");
  const inferred = kept.filter((k) => k.source === "inferred");
  return [...explicit, ...inferred].slice(0, max);
}

/**
 * Merges a validated update into a brief. Pure: returns a new brief.
 * Unmentioned values are kept, so earlier decisions survive a revision that
 * does not address them.
 */
export function mergeBrief(existing: CreativeBrief | undefined, update: BriefUpdate, at: string): CreativeBrief {
  const base = existing ?? emptyBrief(at);
  const next: CreativeBrief = {
    ...base,
    constraints: mergeItems(base.constraints, update.addConstraints, update.retireConstraints, BRIEF_LIMITS.constraints, at),
    visualDecisions: mergeItems(
      base.visualDecisions,
      update.addVisualDecisions,
      update.retireVisualDecisions,
      BRIEF_LIMITS.visualDecisions,
      at
    ),
    assetRelationships: [...base.assetRelationships],
    updatedAt: at,
  };
  for (const name of BRIEF_FIELDS) {
    const incoming = update.fields[name];
    const current = base[name];
    if (!incoming) continue;
    if (!current || mayOverride(current.source, incoming.source)) next[name] = { ...incoming, at };
  }
  for (const rel of update.assetRelationships) {
    const index = next.assetRelationships.findIndex((r) => r.id === rel.id);
    if (index === -1) next.assetRelationships.push({ ...rel, at });
    else if (mayOverride(next.assetRelationships[index].source, rel.source)) next.assetRelationships[index] = { ...rel, at };
  }
  next.assetRelationships = next.assetRelationships.slice(0, BRIEF_LIMITS.assetRelationships);
  return next;
}

/**
 * The brief with relationships to references or assets the carousel no longer
 * has removed, so the Director is never told about something it cannot see.
 */
export function briefForCarousel(brief: CreativeBrief | undefined, knownIds: ReadonlySet<string>): CreativeBrief | null {
  if (!brief) return null;
  return { ...brief, assetRelationships: brief.assetRelationships.filter((r) => knownIds.has(r.id)) };
}
