/**
 * Building blocks for admitting untrusted production JSON.
 *
 * Every check reads its input and never writes to it. Problems are collected
 * as issues with a path and a stable code, so a caller sees every problem at
 * once instead of fixing them one by one. Messages may be logged and shown to
 * users, so they never quote a value from the document unless that value has
 * already been validated as an identifier, a number or a member of a fixed set.
 */

import { isBoundedText, unknownFieldViolation } from "@/lib/creative-brief";

export type AdmissionCode =
  | "not_object"
  | "unsupported_schema_version"
  | "schema_version_too_new"
  | "migration_failed"
  | "unknown_field"
  | "missing_field"
  | "invalid_type"
  | "invalid_value"
  | "invalid_id"
  | "duplicate_id"
  | "dangling_reference"
  | "out_of_range"
  | "overlap"
  | "inconsistent"
  | "workflow_mismatch"
  | "limit_exceeded";

export interface AdmissionIssue {
  /** Where in the document, e.g. `timeline.tracks[1].clips[0].source.outUs`. */
  path: string;
  code: AdmissionCode;
  message: string;
}

/** A bound on how many issues one admission reports, so a hostile document cannot flood a log. */
export const MAX_REPORTED_ISSUES = 200;

export class Issues {
  readonly list: AdmissionIssue[] = [];
  private truncated = false;

  add(path: string, code: AdmissionCode, message: string): void {
    if (this.list.length < MAX_REPORTED_ISSUES) {
      this.list.push({ path, code, message });
    } else if (!this.truncated) {
      this.truncated = true;
      this.list.push({ path: "", code: "limit_exceeded", message: "too many problems; later ones are not listed" });
    }
  }

  get empty(): boolean {
    return this.list.length === 0;
  }
}

export type Rec = Record<string, unknown>;

/** Join a path and a key or index into the path notation used in issues. */
export function at(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

/** A plain JSON object: not null, not an array, not a class instance. */
export function isPlainObject(value: unknown): value is Rec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Checks that `value` is a plain object holding every required field and no
 * field outside `required` and `optional`. Returns the object when it is one,
 * so field checks can continue even after a missing or unknown field.
 */
export function shape(
  issues: Issues,
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[] = []
): Rec | null {
  if (!isPlainObject(value)) {
    issues.add(path, "not_object", "expected an object");
    return null;
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) issues.add(at(path, key), "missing_field", "required field is missing");
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) issues.add(path, "unknown_field", unknownFieldViolation(key));
  }
  return value;
}

/** Whether an optional field is present (absent and `undefined` both count as absent). */
export function has(obj: Rec, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

/** A dense array of at most `max` items, or null after reporting why not. */
export function array(issues: Issues, value: unknown, path: string, max: number): unknown[] | null {
  if (!Array.isArray(value)) {
    issues.add(path, "invalid_type", "expected an array");
    return null;
  }
  if (value.length > max) {
    issues.add(path, "limit_exceeded", `at most ${max} items are allowed`);
    return null;
  }
  for (let i = 0; i < value.length; i++) {
    if (!(i in value)) {
      issues.add(at(path, i), "invalid_value", "arrays may not have holes");
      return null;
    }
  }
  return value;
}

/** Identifiers of things inside a production: short, URL-safe and unambiguous. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Content-addressed media ids: lower-case SHA-256 hex. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** Capability ids such as `captions.kinetic-pop` or `graphic.architecture-diagram`. */
export const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}(\.[a-z0-9][a-z0-9-]{0,31}){1,3}$/;
/** Capability versions: semantic versions without build metadata. */
export const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,32})?$/;
/** ISO 8601 UTC timestamps as written by `new Date().toISOString()` (milliseconds optional). */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function id(issues: Issues, value: unknown, path: string): value is string {
  if (typeof value === "string" && ID_PATTERN.test(value)) return true;
  issues.add(path, "invalid_id", "expected an identifier of letters, digits, '-' or '_' (at most 64 characters)");
  return false;
}

export function sha256(issues: Issues, value: unknown, path: string): value is string {
  if (typeof value === "string" && SHA256_PATTERN.test(value)) return true;
  issues.add(path, "invalid_id", "expected a lower-case SHA-256 hex digest");
  return false;
}

export function text(issues: Issues, value: unknown, path: string, max: number): value is string {
  if (isBoundedText(value, max)) return true;
  issues.add(path, "invalid_value", `expected non-empty text of at most ${max} characters without control characters`);
  return false;
}

export function int(issues: Issues, value: unknown, path: string, min: number, max: number): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    issues.add(path, "invalid_type", "expected a whole number");
    return false;
  }
  if (value < min || value > max) {
    issues.add(path, "out_of_range", `expected a whole number from ${min} to ${max}`);
    return false;
  }
  return true;
}

export function num(issues: Issues, value: unknown, path: string, min: number, max: number): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.add(path, "invalid_type", "expected a finite number");
    return false;
  }
  if (value < min || value > max) {
    issues.add(path, "out_of_range", `expected a number from ${min} to ${max}`);
    return false;
  }
  return true;
}

export function bool(issues: Issues, value: unknown, path: string): value is boolean {
  if (typeof value === "boolean") return true;
  issues.add(path, "invalid_type", "expected true or false");
  return false;
}

export function oneOf<T extends string | number>(
  issues: Issues,
  value: unknown,
  path: string,
  allowed: readonly T[]
): value is T {
  if ((allowed as readonly unknown[]).includes(value)) return true;
  issues.add(path, "invalid_value", `expected one of: ${allowed.join(", ")}`);
  return false;
}

export function timestamp(issues: Issues, value: unknown, path: string): value is string {
  if (typeof value === "string" && TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value))) return true;
  issues.add(path, "invalid_value", "expected an ISO 8601 UTC timestamp");
  return false;
}

export function pattern(issues: Issues, value: unknown, path: string, re: RegExp, what: string): value is string {
  if (typeof value === "string" && re.test(value)) return true;
  issues.add(path, "invalid_value", `expected ${what}`);
  return false;
}

/** Limits on capability parameters, which are free-form JSON. */
export const JSON_LIMITS = { depth: 16, nodes: 5_000, string: 20_000 } as const;

/**
 * Plain JSON data only: null, booleans, finite numbers, strings, arrays and
 * plain objects, within the size limits. No functions, dates, class instances,
 * NaN or Infinity, so the value survives a JSON round trip unchanged.
 */
export function jsonValue(issues: Issues, value: unknown, path: string): boolean {
  let nodes = 0;
  const visit = (v: unknown, p: string, depth: number): boolean => {
    if (++nodes > JSON_LIMITS.nodes) {
      issues.add(path, "limit_exceeded", `at most ${JSON_LIMITS.nodes} values are allowed`);
      return false;
    }
    if (depth > JSON_LIMITS.depth) {
      issues.add(p, "limit_exceeded", `nesting deeper than ${JSON_LIMITS.depth} levels`);
      return false;
    }
    if (v === null || typeof v === "boolean") return true;
    if (typeof v === "number") {
      if (Number.isFinite(v)) return true;
      issues.add(p, "invalid_value", "numbers must be finite");
      return false;
    }
    if (typeof v === "string") {
      if (v.length <= JSON_LIMITS.string) return true;
      issues.add(p, "limit_exceeded", `strings may be at most ${JSON_LIMITS.string} characters`);
      return false;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) {
          issues.add(at(p, i), "invalid_value", "arrays may not have holes");
          return false;
        }
        if (!visit(v[i], at(p, i), depth + 1)) return false;
      }
      return true;
    }
    if (isPlainObject(v)) {
      for (const [k, child] of Object.entries(v)) if (!visit(child, at(p, k), depth + 1)) return false;
      return true;
    }
    issues.add(p, "invalid_type", "expected plain JSON data");
    return false;
  };
  return visit(value, path, 0);
}
