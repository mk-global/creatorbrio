/**
 * Plants the T1 canaries (#225) in the macOS VM, as root, before any observer
 * or the app runs: the file canaries in the subject's home and the app's
 * checkout, a fresh login keychain for the subject holding the synthetic
 * Keychain item, and the app's seed data files as scripts/setup.mjs writes
 * them. Values come from the run's root-only configuration file and are
 * written to the canaries and nowhere else.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MACOS_ROOTS, MACOS_SUBJECT } from "../lib/macos";
import { loadCanaries, loadConfig } from "../services/common";

const cfg = loadConfig();
const canaries = loadCanaries();
const uid = cfg.subjectUid;
if (!uid) throw new Error("subjectUid is not set");
const STAFF = 20;
const real = (logical: string) => {
  const i = logical.indexOf(":");
  return path.join(MACOS_ROOTS[logical.slice(0, i)], logical.slice(i + 1));
};

/** Creates each missing folder on the way down from `stop`, owned by the subject. */
function ownedDirs(dir: string, stop: string, mode = 0o700) {
  const missing: string[] = [];
  for (let d = dir; d !== stop && !existsSync(d); d = path.dirname(d)) missing.unshift(d);
  for (const d of missing) {
    mkdirSync(d, { mode });
    chownSync(d, uid!, STAFF);
  }
}

function plantFile(logical: string, content: string) {
  const file = real(logical);
  const root = MACOS_ROOTS[logical.slice(0, logical.indexOf(":"))];
  ownedDirs(path.dirname(file), root);
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
  chownSync(file, uid!, STAFF);
}

const p = cfg.canaryPaths;
plantFile(p.browser_cookies, canaries.browser_cookies);
plantFile(p.browser_login, canaries.browser_login);
plantFile(p.home_credential, `[default]\naccess_token = ${canaries.home_credential}\n`);
plantFile(p.data_file, `{"service":"t1-synthetic","apiKey":"${canaries.data_file}"}\n`);
plantFile(p.repo_path, `${canaries.repo_path}\n`);

// The app's folders and the same seeds scripts/setup.mjs writes on a fresh checkout.
const app = MACOS_ROOTS.checkout;
for (const d of ["data", "data/exports", "data/.font-cache", "public/uploads"]) ownedDirs(path.join(app, d), app, 0o755);
const seeds: Record<string, string> = {
  "brand.json": '{"name":"","colors":{"primary":"#1a1a2e","secondary":"#16213e","accent":"#e94560","background":"#ffffff","surface":"#f5f5f5"},"fonts":{"heading":"Inter","body":"Inter"},"customFonts":[],"logoPath":null,"styleKeywords":[],"createdAt":"","updatedAt":""}',
  "carousels.json": '{"carousels":[]}',
  "templates.json": '{"templates":[]}',
  "staged-actions.json": '{"actions":[]}',
  "style-presets.json": '{"presets":[]}',
};
for (const [name, body] of Object.entries(seeds)) {
  const f = path.join(app, "data", name);
  if (!existsSync(f)) {
    writeFileSync(f, body, { mode: 0o644 });
    chownSync(f, uid, STAFF);
  }
}

// A fresh login keychain with a throwaway password, unlocked, holding the synthetic item readable without a prompt.
const home = MACOS_ROOTS.home;
const asSubject = (args: string[]) => execFileSync("/usr/bin/sudo", ["-u", MACOS_SUBJECT, "-H", "/usr/bin/security", ...args], { stdio: ["ignore", "ignore", "pipe"], cwd: "/" });
ownedDirs(path.join(home, "Library/Keychains"), home);
try {
  asSubject(["delete-keychain", "login.keychain"]);
} catch {
  // None yet.
}
rmSync(path.join(home, "Library/Keychains/login.keychain-db"), { force: true });
const password = randomBytes(18).toString("hex");
// Root-only: keychain unlock state belongs to a login session, so the app's launcher and the control unlock it in their own sessions.
writeFileSync("/var/t1/keychain.pw", password, { mode: 0o600 });
chmodSync("/var/t1/keychain.pw", 0o600);
asSubject(["create-keychain", "-p", password, "login.keychain"]);
asSubject(["list-keychains", "-d", "user", "-s", "login.keychain"]);
asSubject(["default-keychain", "-d", "user", "-s", "login.keychain"]);
try {
  // Naming the login keychain needs a login session; the subject never has one, and the search list above already finds it.
  asSubject(["login-keychain", "-d", "user", "-s", "login.keychain"]);
} catch {
  // Not needed for the lookup.
}
asSubject(["set-keychain-settings", "login.keychain"]);
asSubject(["add-generic-password", "-A", "-a", "canary", "-s", "t1-synthetic", "-l", "T1 synthetic credential", "-w", canaries.keychain, "login.keychain"]);
const check = execFileSync("/usr/bin/sudo", ["-u", MACOS_SUBJECT, "-H", "/usr/bin/security", "find-generic-password", "-a", "canary", "-s", "t1-synthetic", "-w"], { encoding: "utf8", cwd: "/" }).trim();
process.stdout.write(`planted; keychain item ${check === canaries.keychain ? "stored" : "NOT stored"}\n`);
