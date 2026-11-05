/**
 * Admission of production documents.
 *
 * `admitProduction()` is the only way an untrusted value (a file read from
 * disk, a request body, an agent's proposal) becomes a `Production`. It is
 * pure: it never writes to its input, touches the file system or calls the
 * network. It either returns a deep copy of the accepted document, or every
 * problem it found with its path and a stable code.
 *
 * Versioning: every change to the persisted shape increments
 * `PRODUCTION_SCHEMA_VERSION` and registers a migration from the previous
 * version. Older documents are migrated step by step, on a copy, and the
 * result is admitted as the current version. Documents newer than this
 * CreatorBrio are refused rather than guessed at, so an older install never
 * silently drops fields it does not understand.
 */

import { PRODUCTION_SCHEMA_VERSION, type Production } from "@/types/production";
import { checkDocument } from "./shape-document";
import { checkInvariants, type InvariantContext } from "./invariants";
import { Issues, isPlainObject, type AdmissionIssue } from "./primitives";

export interface ProductionMigration {
  from: number;
  to: number;
  /** Receives a private copy of the document; returns the document at version `to`. */
  migrate(doc: Record<string, unknown>): unknown;
}

/**
 * Registered migrations, oldest first. There are none yet: version 1 was the
 * merged research's design sketch (`VideoProject`) and was never persisted, so
 * no stored document can be at version 1.
 */
export const PRODUCTION_MIGRATIONS: readonly ProductionMigration[] = [];

export interface AdmissionOptions extends InvariantContext {
  /** Overrides the registered migrations; for tests of the migration path. */
  migrations?: readonly ProductionMigration[];
}

export type AdmissionResult =
  | { ok: true; production: Production; migratedFrom: number | null }
  | { ok: false; issues: AdmissionIssue[] };

/** A deep copy of plain JSON data that shares nothing with the original. */
function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function admitProduction(input: unknown, options: AdmissionOptions = {}): AdmissionResult {
  const issues = new Issues();
  if (!isPlainObject(input)) {
    issues.add("", "not_object", "a production document must be a JSON object");
    return { ok: false, issues: issues.list };
  }

  const version = input.schemaVersion;
  if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
    issues.add("schemaVersion", "unsupported_schema_version", "expected a positive whole schema version");
    return { ok: false, issues: issues.list };
  }
  if (version > PRODUCTION_SCHEMA_VERSION) {
    issues.add(
      "schemaVersion",
      "schema_version_too_new",
      `this document was written by a newer CreatorBrio (schema ${version}; this version reads up to ${PRODUCTION_SCHEMA_VERSION})`
    );
    return { ok: false, issues: issues.list };
  }

  let doc: Record<string, unknown> = input;
  let migratedFrom: number | null = null;
  if (version < PRODUCTION_SCHEMA_VERSION) {
    const migrated = migrate(input, version, options.migrations ?? PRODUCTION_MIGRATIONS, issues);
    if (!migrated) return { ok: false, issues: issues.list };
    doc = migrated;
    migratedFrom = version;
  }

  checkDocument(issues, doc);
  if (issues.empty) checkInvariants(issues, doc as unknown as Production, options);
  if (!issues.empty) return { ok: false, issues: issues.list };

  return { ok: true, production: copyJson(doc) as unknown as Production, migratedFrom };
}

function migrate(
  input: Record<string, unknown>,
  from: number,
  migrations: readonly ProductionMigration[],
  issues: Issues
): Record<string, unknown> | null {
  let version = from;
  let doc: unknown;
  try {
    doc = copyJson(input);
  } catch {
    issues.add("", "migration_failed", "the document is not plain JSON and cannot be migrated");
    return null;
  }
  while (version < PRODUCTION_SCHEMA_VERSION) {
    const step = migrations.find((m) => m.from === version);
    if (!step || step.to <= version) {
      issues.add("schemaVersion", "unsupported_schema_version", `there is no migration from schema version ${version}`);
      return null;
    }
    try {
      doc = step.migrate(doc as Record<string, unknown>);
    } catch {
      issues.add("schemaVersion", "migration_failed", `the migration from schema version ${version} failed`);
      return null;
    }
    if (!isPlainObject(doc) || doc.schemaVersion !== step.to) {
      issues.add("schemaVersion", "migration_failed", `the migration from schema version ${version} did not produce version ${step.to}`);
      return null;
    }
    version = step.to;
  }
  return doc as Record<string, unknown>;
}
