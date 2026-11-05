#!/usr/bin/env node
// Pair a browser with the Video Studio, or revoke every Studio session.
//
// Pure Node, no dependencies. Run it in a terminal, as the account that owns
// this checkout:
//
//   npm run studio:pair                  print a one-time pairing code
//   npm run studio:pair -- --revoke-all  sign out every paired browser
//
// The code is printed to this terminal only, never written to a log or served
// over HTTP. Only its SHA-256 hash is stored, in an owner-only file under
// data/video-auth/pairing/, with a five-minute expiry; the server deletes it
// when it is redeemed, so it works once. The format is read by
// src/lib/video/production/api/sessions.ts.
//
// The script refuses to print a code unless its output is a terminal, so a
// tool whose output is captured or logged does not record a code by
// accident. That is a guard against mistakes, not a security boundary: any
// process running as this account can read and write data/ directly.
//
// Options: --data-dir <dir> (default: the checkout's data/), --no-tty-check.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: 32 symbols, 5 bits each
const PAIRING_TTL_MS = 5 * 60_000;

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};
const dataDir = path.resolve(option("--data-dir") ?? path.join(ROOT, "data"));
const authDir = path.join(dataDir, "video-auth");
const pairingDir = path.join(authDir, "pairing");
const sessionDir = path.join(authDir, "sessions");

function ownerOnlyDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function removeAll(dir) {
  let removed = 0;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    fs.rmSync(path.join(dir, name), { force: true });
    removed++;
  }
  return removed;
}

if (args.includes("--revoke-all")) {
  const sessions = removeAll(sessionDir);
  const codes = removeAll(pairingDir);
  console.log(`Signed out ${sessions} Studio session(s) and cancelled ${codes} unused pairing code(s).`);
  process.exit(0);
}

if (!process.stdout.isTTY && !args.includes("--no-tty-check")) {
  console.error("studio:pair prints a pairing code only to a terminal. Run it in a terminal, as the owner of this checkout.");
  process.exit(2);
}

ownerOnlyDir(authDir);
ownerOnlyDir(pairingDir);

// Drop expired codes so the folder does not grow.
const now = Date.now();
for (const name of fs.readdirSync(pairingDir)) {
  const file = path.join(pairingDir, name);
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!(Date.parse(record.expiresAt) > now)) fs.rmSync(file, { force: true });
  } catch {
    fs.rmSync(file, { force: true });
  }
}

const code = Array.from(randomBytes(20), (b) => ALPHABET[b & 31]).join("");
const hash = createHash("sha256").update(code, "utf-8").digest("hex");
const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
const fd = fs.openSync(path.join(pairingDir, `${hash}.json`), "wx", 0o600);
try {
  fs.writeSync(fd, JSON.stringify({ v: 1, createdAt: new Date(now).toISOString(), expiresAt }));
  fs.fsyncSync(fd);
} finally {
  fs.closeSync(fd);
}

const shown = code.match(/.{5}/g).join("-");
console.log("Video Studio pairing code (works once, for 5 minutes):\n");
console.log(`    ${shown}\n`);
console.log("Enter it in the Studio page on this computer. Do not share it.");
console.log("To sign out every paired browser: npm run studio:pair -- --revoke-all");
