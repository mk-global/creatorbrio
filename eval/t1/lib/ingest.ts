/**
 * Takes a records archive from a machine the subject ran on (a Docker volume,
 * the macOS VM's records folder) into the host's records folder (#225), the
 * only way anything from those machines becomes a host file. The archive is
 * parsed by `safe-tar.ts` (regular files and folders only, within the caps)
 * into a new, empty folder the host creates, the result is checked once more
 * as a tree, and only then does its `raw` folder replace the host's, by rename.
 * A refused archive leaves the previous `raw` in place and names why.
 */
import { rmSync } from "node:fs";
import path from "node:path";
import { checkRecordsTree, type RecordsDir } from "./records-io";
import { extractTarInto, extractTgzInto, RECORDS_TAR_LIMITS, UnsafeTarError, type Extracted, type TarLimits } from "./safe-tar";

export interface IngestResult {
  ok: boolean;
  extracted?: Extracted;
  /** Why the archive was refused, for the record and the operator. */
  refused?: string;
}

let counter = 0;

/** The top-level folders of a records archive; anything else in it is refused. */
export const RECORDS_TOP = ["raw", "config"];

export function ingestRecords(rd: RecordsDir, archive: Buffer, kind: "tar" | "tgz", limits: TarLimits = RECORDS_TAR_LIMITS): IngestResult {
  const stage = path.join(rd.root, `.stage-${process.pid}-${++counter}`);
  try {
    const extracted = (kind === "tgz" ? extractTgzInto : extractTarInto)(archive, stage, limits, { allowedTop: RECORDS_TOP });
    const tree = checkRecordsTree(stage);
    if (tree.problems.length > 0) {
      rmSync(stage, { recursive: true, force: true });
      return { ok: false, refused: `the extracted tree has ${tree.problems.length} problem(s): ${tree.problems.slice(0, 3).join("; ")}` };
    }
    rd.replaceFolder("raw", path.join(stage, "raw"));
    rmSync(stage, { recursive: true, force: true });
    return { ok: true, extracted };
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    return { ok: false, refused: err instanceof UnsafeTarError ? err.message : `could not take the archive: ${err instanceof Error ? err.message : String(err)}` };
  }
}
