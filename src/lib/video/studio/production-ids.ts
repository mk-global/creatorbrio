/**
 * Identifiers and names the Studio page makes for new things (#150). Ids
 * follow the production document's `ID_PATTERN` (letters, digits, `-` and
 * `_`, at most 64 characters, starting with a letter or digit); the store
 * and admission remain the judges of what is valid, so these only make
 * values that will pass.
 *
 * Pure: the time and the random source are arguments, so tests are
 * deterministic and the page passes the real ones.
 */
import type { Production } from "@/types/production";
import type { ProductionSummary } from "./types";

/** The same pattern as the production document's ids. */
export const STUDIO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The longest production name the page accepts; the document allows more, but a name is a short title. */
export const PRODUCTION_NAME_MAX = 120;

/** Random values in [0, 1); `Math.random` in the page, a fixed sequence in tests. */
export type RandomSource = () => number;

/** The browser's and Node's cryptographic generator, as `RandomSource`. */
export const cryptoRandom: RandomSource = () => {
  const word = new Uint32Array(1);
  globalThis.crypto.getRandomValues(word);
  return word[0] / 2 ** 32;
};

function randomBase36(random: RandomSource, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += Math.floor(random() * 36).toString(36);
  return out;
}

/** `prod-` plus the time and random base36, e.g. `prod-mh2x8k1c-4f9q2z`. */
export function newProductionId(now: number, random: RandomSource): string {
  return `prod-${Math.max(0, Math.floor(now)).toString(36)}-${randomBase36(random, 6)}`;
}

/** Every id the production's timeline and review already use; ids must be unique across them. */
export function usedIds(production: Production): Set<string> {
  const ids = new Set<string>();
  for (const track of production.timeline.tracks) {
    ids.add(track.id);
    for (const clip of track.clips) {
      ids.add(clip.id);
      if (clip.kind === "video" || clip.kind === "still") for (const effect of clip.effects ?? []) ids.add(effect.id);
    }
  }
  for (const marker of production.timeline.markers) ids.add(marker.id);
  for (const comment of production.review.comments) ids.add(comment.id);
  for (const scene of production.storyboard?.scenes ?? []) ids.add(scene.id);
  return ids;
}

/** A clip id the production does not use yet, e.g. `clip-mh2x8k1c-4f9q`. */
export function newClipId(taken: ReadonlySet<string>, now: number, random: RandomSource): string {
  const time = Math.max(0, Math.floor(now)).toString(36);
  for (;;) {
    const id = `clip-${time}-${randomBase36(random, 4)}`;
    if (!taken.has(id)) return id;
  }
}

export type NameCheck = { ok: true; name: string } | { ok: false; message: string };

/** A production name as typed: trimmed, required, at most 120 characters, no control characters. */
export function checkProductionName(raw: string): NameCheck {
  const name = raw.trim();
  if (name.length === 0) return { ok: false, message: "Give the production a name." };
  if (name.length > PRODUCTION_NAME_MAX) return { ok: false, message: `Use at most ${PRODUCTION_NAME_MAX} characters.` };
  if (hasControlCharacter(name)) return { ok: false, message: "Remove the line breaks or tabs from the name." };
  return { ok: true, name };
}

/** C0 and C1 control characters, which the document refuses in text. */
export function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

type Openable = Extract<ProductionSummary, { status: "ok" }>;

/** Productions that open first, newest change first; damaged or incomplete ones after them, by id. */
export function sortProductions(list: readonly ProductionSummary[]): ProductionSummary[] {
  const ok = list.filter((p): p is Openable => p.status === "ok").sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : a.productionId.localeCompare(b.productionId)));
  const other = list.filter((p) => p.status !== "ok").sort((a, b) => a.productionId.localeCompare(b.productionId));
  return [...ok, ...other];
}
