/**
 * The on-disk format of the production store (format version 1).
 *
 * ```text
 * <root>/<productionId>/
 *   journal/<generation>.json   immutable state records; the highest one is current
 *   snapshots/<sha256>.json     immutable production documents, named by content hash
 *   tmp/                        files being written; never read
 *   quarantine/                 copies of unreadable records, kept by explicit recovery
 * ```
 *
 * A journal record is the complete persisted state of one production: the
 * current document, the bounded undo and redo stacks, named versions and any
 * open agent run, with every document referenced by hash. Records are small,
 * and a document shared by several records is stored once.
 */

import { createHash } from "node:crypto";
import { MAX_HISTORY_STEPS } from "../changes";
import { LIMITS } from "../limits";
import { array, at, id, int, Issues, isPlainObject, oneOf, sha256, shape, text, timestamp, type Rec } from "../primitives";

export const STORE_FORMAT = "creatorbrio.production-store";
export const STORE_FORMAT_VERSION = 1;

/** Twelve digits keep names sortable; a generation is one persisted transition. */
export const GENERATION_DIGITS = 12;
const GENERATION_FILE = /^(\d{12})\.json$/;

export const EVENT_KINDS = [
  "create",
  "change",
  "undo",
  "redo",
  "label",
  "restore_label",
  "begin_run",
  "end_run",
  "resume_run",
  "recover",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface StoredStep {
  label: string;
  changeSetIds: string[];
  runId: string | null;
  before: string;
  after: string;
}

export interface RunOwner {
  /** The store instance that began or resumed the run; one per process normally. */
  instance: string;
  pid: number;
  host: string;
}

export interface StoredRun {
  runId: string;
  scope: string[] | null;
  base: string;
  changeSetIds: string[];
  owner: RunOwner;
  startedAt: string;
}

export interface JournalRecord {
  format: typeof STORE_FORMAT;
  formatVersion: typeof STORE_FORMAT_VERSION;
  productionId: string;
  generation: number;
  at: string;
  event: { kind: EventKind; id: string };
  /** Copied from the current document so listing needs no document reads. */
  name: string;
  revision: number;
  current: string;
  undo: StoredStep[];
  redo: StoredStep[];
  labels: { name: string; revision: number; production: string }[];
  run: StoredRun | null;
}

export function generationFile(generation: number): string {
  return `${String(generation).padStart(GENERATION_DIGITS, "0")}.json`;
}

export function parseGenerationFile(name: string): number | null {
  const match = GENERATION_FILE.exec(name);
  return match ? Number(match[1]) : null;
}

export function contentHash(data: string): string {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/** Every document hash a record refers to. */
export function referencedHashes(record: JournalRecord): string[] {
  const steps = [...record.undo, ...record.redo].flatMap((s) => [s.before, s.after]);
  return [record.current, ...steps, ...record.labels.map((l) => l.production), ...(record.run ? [record.run.base] : [])];
}

const MAX_STEPS = MAX_HISTORY_STEPS;
const MAX_LABELS = 1_000;
const MAX_CHANGE_SETS_PER_STEP = 10_000;

export type DecodedRecord =
  | { ok: true; record: JournalRecord }
  | { ok: false; kind: "corrupt" | "unsupported_version"; message: string };

/** Parses and strictly checks one journal record's bytes. */
export function decodeRecord(raw: string): DecodedRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, kind: "corrupt", message: "the record is not valid JSON" };
  }
  if (!isPlainObject(parsed) || parsed.format !== STORE_FORMAT) {
    return { ok: false, kind: "corrupt", message: "the record is not a production store record" };
  }
  const version = parsed.formatVersion;
  if (typeof version === "number" && Number.isSafeInteger(version) && version > STORE_FORMAT_VERSION) {
    return { ok: false, kind: "unsupported_version", message: `format version ${version} is newer than this CreatorBrio supports (${STORE_FORMAT_VERSION})` };
  }
  const issues = new Issues();
  checkRecord(issues, parsed);
  if (!issues.empty) {
    const first = issues.list[0];
    return { ok: false, kind: "corrupt", message: `invalid record at ${first.path || "(root)"}: ${first.message}` };
  }
  return { ok: true, record: parsed as unknown as JournalRecord };
}

function checkStep(issues: Issues, value: unknown, path: string): void {
  const s = shape(issues, value, path, ["label", "changeSetIds", "runId", "before", "after"]);
  if (!s) return;
  text(issues, s.label, at(path, "label"), LIMITS.text.reason + 64);
  array(issues, s.changeSetIds, at(path, "changeSetIds"), MAX_CHANGE_SETS_PER_STEP)?.forEach((v, i) => id(issues, v, at(at(path, "changeSetIds"), i)));
  if (s.runId !== null) id(issues, s.runId, at(path, "runId"));
  sha256(issues, s.before, at(path, "before"));
  sha256(issues, s.after, at(path, "after"));
}

function checkRun(issues: Issues, value: unknown, path: string): void {
  const r = shape(issues, value, path, ["runId", "scope", "base", "changeSetIds", "owner", "startedAt"]);
  if (!r) return;
  id(issues, r.runId, at(path, "runId"));
  if (r.scope !== null) array(issues, r.scope, at(path, "scope"), LIMITS.count.scenes)?.forEach((v, i) => id(issues, v, at(at(path, "scope"), i)));
  sha256(issues, r.base, at(path, "base"));
  array(issues, r.changeSetIds, at(path, "changeSetIds"), MAX_CHANGE_SETS_PER_STEP)?.forEach((v, i) => id(issues, v, at(at(path, "changeSetIds"), i)));
  const o = shape(issues, r.owner, at(path, "owner"), ["instance", "pid", "host"]);
  if (o) {
    text(issues, o.instance, at(path, "owner.instance"), 64);
    int(issues, o.pid, at(path, "owner.pid"), 0, 2 ** 32);
    text(issues, o.host, at(path, "owner.host"), 255);
  }
  timestamp(issues, r.startedAt, at(path, "startedAt"));
}

function checkRecord(issues: Issues, value: Rec): void {
  const o = shape(issues, value, "", [
    "format",
    "formatVersion",
    "productionId",
    "generation",
    "at",
    "event",
    "name",
    "revision",
    "current",
    "undo",
    "redo",
    "labels",
    "run",
  ]);
  if (!o) return;
  oneOf(issues, o.formatVersion, "formatVersion", [STORE_FORMAT_VERSION]);
  id(issues, o.productionId, "productionId");
  int(issues, o.generation, "generation", 1, Number.MAX_SAFE_INTEGER);
  timestamp(issues, o.at, "at");
  const e = shape(issues, o.event, "event", ["kind", "id"]);
  if (e) {
    oneOf(issues, e.kind, "event.kind", EVENT_KINDS);
    id(issues, e.id, "event.id");
  }
  text(issues, o.name, "name", LIMITS.text.name);
  int(issues, o.revision, "revision", 0, Number.MAX_SAFE_INTEGER);
  sha256(issues, o.current, "current");
  array(issues, o.undo, "undo", MAX_STEPS)?.forEach((s, i) => checkStep(issues, s, at("undo", i)));
  array(issues, o.redo, "redo", MAX_STEPS)?.forEach((s, i) => checkStep(issues, s, at("redo", i)));
  const labels = array(issues, o.labels, "labels", MAX_LABELS);
  const names = new Set<string>();
  labels?.forEach((l, i) => {
    const lp = at("labels", i);
    const label = shape(issues, l, lp, ["name", "revision", "production"]);
    if (!label) return;
    if (id(issues, label.name, at(lp, "name"))) {
      if (names.has(label.name)) issues.add(at(lp, "name"), "duplicate_id", "label names are unique");
      names.add(label.name);
    }
    int(issues, label.revision, at(lp, "revision"), 0, Number.MAX_SAFE_INTEGER);
    sha256(issues, label.production, at(lp, "production"));
  });
  if (o.run !== null) checkRun(issues, o.run, "run");
}
