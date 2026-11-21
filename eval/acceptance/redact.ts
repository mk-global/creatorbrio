import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Replaces a home folder in a path with `~`, so a recorded path names no
 * account. This module imports nothing from the harness, so any of its modules
 * can use it without a cycle.
 *
 * Two folders can name the account. `os.homedir()` follows `HOME`, which an
 * operator or a test may point elsewhere, and the account's own home folder is
 * what the system lists for the user (`os.userInfo().homedir`). A recorded
 * path may lie under either, so both are redacted (#232), and only whether they
 * differ is ever recorded, never either path.
 */

/** The account's own home folder as the system lists it, whatever `HOME` says; null when it cannot be read. */
export function accountHome(): string | null {
  try {
    return os.userInfo().homedir || null;
  } catch {
    return null;
  }
}

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

/** Every home folder a recorded path may lie under: `HOME`'s and the account's own, once each. */
export function homeFolders(home: string = os.homedir(), account: string | null = accountHome()): string[] {
  return [...new Set([home, account].filter((h): h is string => typeof h === "string" && h.length > 1))];
}

/**
 * Whether `HOME` names another folder than the account's own: true when it
 * does, null when the account's home cannot be read, so nothing can be said.
 * A boolean only, never either path.
 */
export function homeDiffersFromAccount(home: string = os.homedir(), account: string | null = accountHome()): boolean | null {
  if (!account) return null;
  return real(home) !== real(account);
}

/** `p` relative to `home` as `~/...`, or null when it is not inside `home`. */
function underHome(p: string, home: string): string | null {
  const rel = path.relative(home, p);
  if (rel === "") return "~";
  return !rel.startsWith("..") && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join("/")}` : null;
}

/**
 * `p` with the home folder replaced by `~`. `home` is one folder or the list
 * `homeFolders` returns; when a path lies under several (a `HOME` inside the
 * account's home), the shortest result wins. A path under none is returned as it is.
 */
export function redactPath(p: string, home: string | readonly string[]): string {
  let best: string | null = null;
  for (const h of typeof home === "string" ? [home] : home) {
    const shown = underHome(p, h);
    if (shown !== null && (best === null || shown.length < best.length)) best = shown;
  }
  return best ?? p;
}
