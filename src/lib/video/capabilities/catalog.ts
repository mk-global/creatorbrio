/**
 * The capability catalog (#144): the native capabilities this process knows,
 * looked up by id and exact version. Commit-time admission parses every
 * graphics clip whose capability the catalog knows (`InvariantContext.capabilities`);
 * the compiler refuses clips whose capability it does not know, and the
 * overlay document is emitted from the catalog's definitions alone.
 *
 * First-party definitions, all version 1.0.0:
 *   - `captions.timed`        (captions) timed caption cues, kinetic or sentence
 *   - `graphics.lower-third`  (graphic)  a name and a second line, bottom left
 *   - `graphics.title-card`   (graphic)  a large title, centred or at the top
 */
import { CAPABILITY_ID_PATTERN, VERSION_PATTERN } from "@/lib/video/production/primitives";
import { TIMED_CAPTIONS } from "./captions";
import { LOWER_THIRD } from "./lower-third";
import { TITLE_CARD } from "./title-card";
import type { CapabilityCatalog, CapabilityDefinition } from "./types";

export { escapeHtml } from "./emit";

/**
 * A catalog of the given definitions. Throws when a definition's id or
 * version is malformed or the same id and version appear twice, since either
 * is a programming error that would make lookups ambiguous.
 */
export function createCatalog(defs: CapabilityDefinition[]): CapabilityCatalog {
  const byKey = new Map<string, CapabilityDefinition>();
  for (const def of defs) {
    if (!CAPABILITY_ID_PATTERN.test(def.id)) throw new Error("capability definition with a malformed id");
    if (!VERSION_PATTERN.test(def.version)) throw new Error(`capability ${def.id} has a malformed version`);
    const key = `${def.id}@${def.version}`;
    if (byKey.has(key)) throw new Error(`capability ${key} is defined twice`);
    byKey.set(key, def);
  }
  const list = Object.freeze([...byKey.values()]);
  return {
    get: (id, version) => byKey.get(`${id}@${version}`),
    list: () => list,
  };
}

export const DEFAULT_CATALOG: CapabilityCatalog = createCatalog([
  TIMED_CAPTIONS,
  LOWER_THIRD,
  TITLE_CARD,
]);
