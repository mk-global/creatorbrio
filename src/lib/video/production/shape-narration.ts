/**
 * Structural checks for narration directions and voice settings (spec 07 §3).
 * Shared by the script (per-line delivery), the storyboard (per-scene voice
 * direction) and the production's voice settings.
 */

import { LIMITS } from "./limits";
import { array, at, has, id, int, isPlainObject, num, oneOf, shape, text, type Issues } from "./primitives";

const T = LIMITS.text;
const C = LIMITS.count;

export function checkNarrationDirection(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["rate"], ["pitchShift", "energy", "pausesMs", "emphasis", "pronunciations"]);
  if (!o) return;
  num(issues, o.rate, at(path, "rate"), 0.8, 1.25);
  if (has(o, "pitchShift")) num(issues, o.pitchShift, at(path, "pitchShift"), -12, 12);
  if (has(o, "energy")) oneOf(issues, o.energy, at(path, "energy"), ["calm", "neutral", "energetic"]);
  if (has(o, "pausesMs")) {
    array(issues, o.pausesMs, at(path, "pausesMs"), C.pauses)?.forEach((p, i) => {
      const pp = at(at(path, "pausesMs"), i);
      const pause = shape(issues, p, pp, ["afterWordIndex", "ms"]);
      if (!pause) return;
      int(issues, pause.afterWordIndex, at(pp, "afterWordIndex"), 0, 100_000);
      int(issues, pause.ms, at(pp, "ms"), 1, 10_000);
    });
  }
  if (has(o, "emphasis")) {
    array(issues, o.emphasis, at(path, "emphasis"), C.emphasis)?.forEach((w, i) =>
      int(issues, w, at(at(path, "emphasis"), i), 0, 100_000)
    );
  }
  if (has(o, "pronunciations")) {
    const pr = o.pronunciations;
    if (!isPlainObject(pr)) {
      issues.add(at(path, "pronunciations"), "not_object", "expected an object of word to pronunciation");
    } else {
      const entries = Object.entries(pr);
      if (entries.length > C.pronunciations) {
        issues.add(at(path, "pronunciations"), "limit_exceeded", `at most ${C.pronunciations} entries are allowed`);
      }
      for (const [word, said] of entries.slice(0, C.pronunciations)) {
        text(issues, word, at(path, "pronunciations"), T.short);
        text(issues, said, at(path, "pronunciations"), T.pronunciation);
      }
    }
  }
}

export function checkVoice(issues: Issues, value: unknown, path: string): void {
  const o = shape(issues, value, path, ["voiceId", "defaultDirection", "lexiconId"]);
  if (!o) return;
  id(issues, o.voiceId, at(path, "voiceId"));
  checkNarrationDirection(issues, o.defaultDirection, at(path, "defaultDirection"));
  if (o.lexiconId !== null) id(issues, o.lexiconId, at(path, "lexiconId"));
}
