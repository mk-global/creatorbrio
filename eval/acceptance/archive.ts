import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertOutsideCheckout, CHECKOUT_ROOT, ensurePrivateDir, expandHome } from "./ledger";

/**
 * A durable private copy of a run (#224): results.json, summary.md, the
 * server logs and every exported PNG, copied out of the worktree into an
 * owner-only folder, so a baseline outlives the checkout that recorded it.
 */

export const DEFAULT_ARCHIVE_LABEL = "~/.local/share/creatorbrio-m1-eval/acceptance";

/** `<EVAL_ARCHIVE_DIR or the default>/<run id>`; always absolute and outside the checkout. */
export function archiveDir(runId: string, env: Record<string, string | undefined> = process.env, home = os.homedir(), root = CHECKOUT_ROOT): string {
  const base = expandHome(env.EVAL_ARCHIVE_DIR?.trim() || DEFAULT_ARCHIVE_LABEL, home);
  if (!path.isAbsolute(base)) throw new Error("EVAL_ARCHIVE_DIR must be an absolute path (or start with ~/)");
  assertOutsideCheckout(base, "EVAL_ARCHIVE_DIR", root);
  if (!/^\w[\w.-]*$/.test(runId)) throw new Error("Invalid run id for the archive");
  return path.join(base, runId);
}

/** Whether a run-folder file belongs in the archive. */
export const archived = (rel: string) =>
  rel === "results.json" || rel === "summary.md" || /^server-\d+\.log$/.test(rel) || /^\w[\w#.-]*\/[^/]+\.png$/i.test(rel);

/**
 * Copies the run's evidence into `dest` (mode 700, files 600); returns the
 * relative paths copied. Folders it creates are mode 700; one that already
 * exists must already be owner-only (see `ensurePrivateDir`).
 */
export function archiveRun(runDir: string, dest: string): string[] {
  const files = (readdirSync(runDir, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join("/"))
    .filter((rel) => archived(rel) && statSync(path.join(runDir, rel)).isFile())
    .sort();
  ensurePrivateDir(dest);
  for (const rel of files) {
    const to = path.join(dest, rel);
    ensurePrivateDir(path.dirname(to));
    // Created mode 600 and never over an existing file: the copy is made by this code or not at all.
    writeFileSync(to, readFileSync(path.join(runDir, rel)), { flag: "wx", mode: 0o600 });
  }
  return files;
}
