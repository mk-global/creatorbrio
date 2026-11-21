/**
 * Gives each test file its own parent for the contained Design Agent's
 * temporary folders (#241), so no test creates or changes the real per-user
 * one (`systemServerTempRoot`), and fails the file if it did.
 *
 * The parent is a fresh name directly under `/tmp`, short enough that a run's
 * folder in it still fits the CLI's path limit for this user. It is set
 * through the test seam (`SERVER_TEMP_ROOT_OVERRIDE`) before any test runs,
 * created owner-only by the app only if a test uses it (a skipped file
 * creates nothing), and removed after the file's tests.
 */
import { afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OVERRIDE_KEY, realParent } from "../helpers/server-temp-parent";

const real = realParent(process.platform, process.getuid?.() ?? 0);
const listing = (dir: string): string[] | null => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return null;
  }
};
const before = listing(real);
// Windows has no contained profile; its parent is only ever an unused name.
const parent = path.join(realpathSync(process.platform === "win32" ? tmpdir() : "/tmp"), `cbt-${process.pid.toString(36)}${randomBytes(2).toString("hex")}`);
(globalThis as Record<symbol, unknown>)[OVERRIDE_KEY] = parent;

afterAll(() => {
  delete (globalThis as Record<symbol, unknown>)[OVERRIDE_KEY];
  // Folders a test made unremovable are made removable again first.
  try {
    if (process.platform !== "win32") execFileSync("chmod", ["-R", "u+rwx", parent]);
    if (process.platform === "darwin") execFileSync("chflags", ["-R", "nouchg,nouappnd", parent]);
  } catch {
    // Removed below, or reported by the removal.
  }
  rmSync(parent, { recursive: true, force: true });
  const after = listing(real);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`A test created or changed the real per-user temporary parent ${real}; tests must use the injected parent.`);
  }
});
