/**
 * Production v2 domain core (WS1). Pure functions only: no file system,
 * network, renderer or model access. Persistence, operations and revisions
 * build on this in later WS1 changes.
 */

export { admitProduction, PRODUCTION_MIGRATIONS } from "./admit";
export type { AdmissionOptions, AdmissionResult, ProductionMigration } from "./admit";
export type { AdmissionCode, AdmissionIssue } from "./primitives";
export { MEDIA_ROLE_KIND, WORKFLOW_STAGES } from "./invariants";
export type { InvariantContext, LedgerMedia } from "./invariants";
export { LIMITS } from "./limits";
export * from "./time";
