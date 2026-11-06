/**
 * Strict parsing of capability parameters (#144).
 *
 * Capability parameters are untrusted JSON from a change set. A capability
 * reads them through a `Reader`, which collects every problem as a
 * `CapabilityIssue` whose path is a JSON pointer into `params` ("" for the
 * whole value, `/cues/3/text` for one field), so the caller sees them all at
 * once. Messages never quote a value from the parameters: they reach logs and
 * API responses. Unknown fields are named only when the name is a short
 * identifier that cannot carry a user's words.
 */
import { unknownFieldViolation } from "@/lib/creative-brief";
import type { JsonValue } from "@/types/production";
import type { CapabilityIssue } from "./types";

/** A bound on the issues one parse reports, so a hostile call cannot flood a log or a response. */
export const MAX_CAPABILITY_ISSUES = 50;

/** C0 controls (tab and newline included: layout owns line breaks), DEL, C1 controls and the Unicode line and paragraph separators. */
const FORBIDDEN_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/** The only colour form a capability accepts; anything else could carry CSS. */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export type Obj = { [key: string]: JsonValue };

/** Joins a JSON pointer and a key or index, escaping `~` and `/` in keys. */
export function pointer(base: string, key: string | number): string {
  return `${base}/${typeof key === "number" ? key : key.replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

/** The length a person counts: code points, so an emoji is one character. */
export function textLength(text: string): number {
  return Array.from(text).length;
}

export class Reader {
  readonly issues: CapabilityIssue[] = [];

  add(path: string, message: string): void {
    if (this.issues.length < MAX_CAPABILITY_ISSUES) this.issues.push({ path, message });
    else if (this.issues.length === MAX_CAPABILITY_ISSUES) this.issues.push({ path: "", message: "too many problems; later ones are not listed" });
  }

  get ok(): boolean {
    return this.issues.length === 0;
  }

  /** A plain object with every required field and nothing outside `required` and `optional`. */
  object(value: JsonValue | undefined, path: string, required: readonly string[], optional: readonly string[] = []): Obj | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.add(path, "expected an object");
      return null;
    }
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) this.add(pointer(path, key), "required field is missing");
    }
    for (const key of Object.keys(value)) {
      if (!required.includes(key) && !optional.includes(key)) this.add(path, unknownFieldViolation(key));
    }
    return value;
  }

  array(value: JsonValue | undefined, path: string, max: number): JsonValue[] | null {
    if (!Array.isArray(value)) {
      this.add(path, "expected an array");
      return null;
    }
    if (value.length > max) {
      this.add(path, `at most ${max} items are allowed`);
      return null;
    }
    return value;
  }

  oneOf<T extends string>(value: JsonValue | undefined, path: string, allowed: readonly T[]): T | null {
    if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
    this.add(path, `expected one of: ${allowed.join(", ")}`);
    return null;
  }

  int(value: JsonValue | undefined, path: string, min: number, max: number): number | null {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      this.add(path, "expected a whole number");
      return null;
    }
    if (value < min || value > max) {
      this.add(path, `expected a whole number from ${min} to ${max}`);
      return null;
    }
    return value;
  }

  bool(value: JsonValue | undefined, path: string): boolean | null {
    if (typeof value === "boolean") return value;
    this.add(path, "expected true or false");
    return null;
  }

  /**
   * Text of `min` to `max` characters (code points) once leading and trailing
   * spaces are removed, without control characters. Returns the trimmed text.
   * With `min` 0, an empty or all-space string is accepted and returned as "".
   */
  text(value: JsonValue | undefined, path: string, min: number, max: number): string | null {
    if (typeof value !== "string") {
      this.add(path, "expected text");
      return null;
    }
    if (FORBIDDEN_TEXT.test(value)) {
      this.add(path, "text may not contain control characters, tabs or line breaks");
      return null;
    }
    const trimmed = value.trim();
    const length = textLength(trimmed);
    if (length < min || length > max) {
      this.add(path, min > 0 ? `expected ${min} to ${max} characters` : `expected at most ${max} characters`);
      return null;
    }
    return trimmed;
  }

  color(value: JsonValue | undefined, path: string): string | null {
    if (typeof value === "string" && HEX_COLOR.test(value)) return value.toLowerCase();
    this.add(path, "expected a colour written as #rrggbb");
    return null;
  }
}
