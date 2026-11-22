/**
 * Gives each test file its own parent for the contained Design Agent's
 * temporary folders (#241), so no test creates or changes the real per-user
 * one (`systemServerTempRoot`), and fails the file if it did.
 *
 * The parent is a fresh name directly under `/tmp`, never longer than the
 * longest real parent (`testParentName`), so a run's folder in it fits the
 * CLI's path limit for every user id the real parent fits, and never a name
 * the real parent can have. It is set through the test seam
 * (`SERVER_TEMP_ROOT_OVERRIDE`) before any test runs, created owner-only by
 * the app only if a test uses it (a skipped file creates nothing), and removed
 * after the file's tests.
 */
import { afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OVERRIDE_KEY, realParent, serverFolderName, testParentName } from "../helpers/server-temp-parent";

const real = realParent(process.platform, process.getuid?.() ?? 0);
// Only what this test run itself could have created in the real parent is
// checked: this process's own server folder, which the app makes before any run
// folder or copy of its own. Another server of the same user may legitimately
// use the real parent while the tests run, and that is not a failure.
const ownFolder = path.join(real, serverFolderName(process.pid));
const listing = (dir: string): string[] | null => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return null;
  }
};
const before = listing(ownFolder);
// Windows has no contained profile; its parent is only ever an unused name.
const tempBase = realpathSync(process.platform === "win32" ? tmpdir() : "/tmp");
const taken = (candidate: string): boolean => {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
};
// Few characters are left for the random part, so a name is drawn again while
// one with it exists, such as a leftover of an earlier process that had this id.
const drawParent = (): string => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const candidate = path.join(tempBase, testParentName(tempBase, process.platform, process.pid, randomBytes(4).toString("hex")));
    if (!taken(candidate)) return candidate;
  }
  throw new Error(`No unused name for this test file's temporary parent under ${tempBase}.`);
};
const parent = drawParent();
(globalThis as Record<symbol, unknown>)[OVERRIDE_KEY] = parent;

afterAll(() => {
  delete (globalThis as Record<symbol, unknown>)[OVERRIDE_KEY];
  // Folders a test made unremovable are made removable again first.
  // A file that never created its parent has nothing to make removable.
  if (existsSync(parent)) {
    try {
      if (process.platform !== "win32") execFileSync("chmod", ["-R", "u+rwx", parent], { stdio: "ignore" });
      if (process.platform === "darwin") execFileSync("chflags", ["-R", "nouchg,nouappnd", parent], { stdio: "ignore" });
    } catch {
      // Removed below, or reported by the removal.
    }
  }
  rmSync(parent, { recursive: true, force: true });
  const after = listing(ownFolder);
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error(`A test created or changed this process's folder in the real per-user temporary parent ${real}; tests must use the injected parent.`);
  }
});
