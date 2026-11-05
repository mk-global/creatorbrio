/**
 * The durable production store (WS1 #118): productions, their bounded history,
 * named versions and agent runs persisted as immutable journal records, with a
 * cross-process compare-and-swap commit. Every change goes through the
 * change-set engine and `admitProduction()`.
 */

export { ProductionStore } from "./store";
export type {
  GcOptions,
  ListResult,
  LoadedProduction,
  LoadResult,
  MutationResult,
  Precondition,
  ProductionSummary,
  RunStatus,
  StoreFailure,
  StoreOptions,
} from "./store";
export { nodeFs } from "./fs";
export type { StoreFs } from "./fs";
export { decodeRecord, generationFile, STORE_FORMAT, STORE_FORMAT_VERSION } from "./format";
export type { JournalRecord } from "./format";
