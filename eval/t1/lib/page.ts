/**
 * The hostile page as the web server serves it (#225): read from the run's
 * config folder on every request, never cached at start, because the runners
 * write the real page only after the app's own setup has made the ids it names.
 * A placeholder is never served, and the file must be a plain regular file in
 * a plain folder (the folder is the harness's own, but it is read as untrusted).
 */
import { createHash } from "node:crypto";
import { safeReadFile } from "./scrub";

/** The text the runner writes as the page before the real one exists. */
export const PLACEHOLDER = "t1-placeholder";

export type ServedPage = { ok: true; body: Buffer; sha256: string } | { ok: false; reason: string };

export function currentPage(file: string, root: string, maxBytes = 1024 * 1024): ServedPage {
  const r = safeReadFile(file, maxBytes, { root });
  if (!r.ok) return { ok: false, reason: r.reason };
  if (r.data.subarray(0, 256).toString("utf8").includes(PLACEHOLDER)) return { ok: false, reason: "placeholder" };
  return { ok: true, body: r.data, sha256: createHash("sha256").update(r.data).digest("hex") };
}
