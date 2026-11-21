/**
 * A tar reader for the one archive the host takes from a machine the subject
 * ran on (the macOS VM's records folder, or a Docker volume's), written so a
 * hostile archive can do nothing but become regular files in a fresh folder
 * the host made. The host never runs `tar -x` on it: this parses the bytes,
 * refuses every entry that is not a regular file or a folder, every absolute
 * path and `..` component, every extension header, any duplicate name, and
 * anything beyond the caps, and only then writes, creating each file
 * exclusively and without following links. Node built-ins only.
 */
import { closeSync, constants, fsyncSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";

export interface TarLimits {
  /** Entries of any kind. */
  maxEntries: number;
  /** Sum of every file's size. */
  maxTotalBytes: number;
  /** One file's size. */
  maxFileBytes: number;
  /** Folders between the root and a file. */
  maxDepth: number;
  /** One path component, bytes. */
  maxNameBytes: number;
}

/** The caps for a records archive: a real run's is a few megabytes (snapshots, logs, a capture summary); these are generous and still bounded. */
export const RECORDS_TAR_LIMITS: TarLimits = {
  maxEntries: 20_000,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 256 * 1024 * 1024,
  maxDepth: 6,
  maxNameBytes: 255,
};

export type UnsafeTarReason =
  | "malformed"
  | "checksum"
  | "symlink"
  | "hardlink"
  | "device_or_fifo"
  | "extension_header"
  | "unknown_type"
  | "absolute_path"
  | "dot_dot"
  | "bad_name"
  | "too_deep"
  | "duplicate"
  | "too_many_entries"
  | "too_large"
  | "outside_allowed_top";

export class UnsafeTarError extends Error {
  readonly reason: UnsafeTarReason;
  constructor(reason: UnsafeTarReason, detail: string) {
    super(`unsafe archive (${reason}): ${detail}`);
    this.reason = reason;
  }
}

export interface TarEntry {
  /** Normalized relative path: no leading `./`, no trailing slash. */
  path: string;
  type: "file" | "dir";
  size: number;
  data: Buffer;
}

const BLOCK = 512;

function cstring(b: Buffer, from: number, len: number): string {
  const slice = b.subarray(from, from + len);
  const z = slice.indexOf(0);
  return slice.subarray(0, z < 0 ? len : z).toString("utf8");
}

/** An octal header field; a base-256 (high bit set) size is refused, which no records archive needs. */
function octal(b: Buffer, from: number, len: number): number {
  if (b[from] & 0x80) throw new UnsafeTarError("too_large", "a binary-encoded size field");
  const text = cstring(b, from, len).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) throw new UnsafeTarError("malformed", "a numeric field is not octal");
  return parseInt(text, 8);
}

/** The path a header names, as a list of components, or an error for anything unsafe. */
function safePath(raw: string, limits: TarLimits): string[] {
  if (raw.includes("\0") || raw.includes("\\")) throw new UnsafeTarError("bad_name", "a path with a NUL or a backslash");
  if (raw.startsWith("/")) throw new UnsafeTarError("absolute_path", raw.slice(0, 80));
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new UnsafeTarError("dot_dot", raw.slice(0, 80));
    if (Buffer.byteLength(part) > limits.maxNameBytes) throw new UnsafeTarError("bad_name", "a path component over the length cap");
    parts.push(part);
  }
  if (parts.length === 0) throw new UnsafeTarError("bad_name", "an empty path");
  return parts;
}

/** Parses an uncompressed tar archive into entries; throws `UnsafeTarError` for the first thing that is not a plain file or folder within the caps. */
export function parseTar(buf: Buffer, limits: TarLimits = RECORDS_TAR_LIMITS, options: { allowedTop?: string[] } = {}): TarEntry[] {
  const entries: TarEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let off = 0;
  let zeroBlocks = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((x) => x === 0)) {
      zeroBlocks++;
      off += BLOCK;
      if (zeroBlocks >= 2) break;
      continue;
    }
    zeroBlocks = 0;
    // The checksum is the sum of the header's bytes with its own field read as spaces.
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (octal(h, 148, 8) !== sum) throw new UnsafeTarError("checksum", "a header does not match its checksum");
    if (entries.length >= limits.maxEntries) throw new UnsafeTarError("too_many_entries", `more than ${limits.maxEntries} entries`);

    const typeflag = String.fromCharCode(h[156] || 0x30);
    const name = cstring(h, 0, 100);
    const ustar = cstring(h, 257, 6).startsWith("ustar");
    const prefix = ustar ? cstring(h, 345, 155) : "";
    const raw = prefix ? `${prefix}/${name}` : name;
    const size = octal(h, 124, 12);
    off += BLOCK;

    if (typeflag === "2") throw new UnsafeTarError("symlink", raw.slice(0, 80));
    if (typeflag === "1") throw new UnsafeTarError("hardlink", raw.slice(0, 80));
    if (typeflag === "3" || typeflag === "4" || typeflag === "6") throw new UnsafeTarError("device_or_fifo", raw.slice(0, 80));
    if (typeflag === "x" || typeflag === "g" || typeflag === "L" || typeflag === "K" || typeflag === "X") throw new UnsafeTarError("extension_header", `type ${typeflag}`);
    if (typeflag !== "0" && typeflag !== "5") throw new UnsafeTarError("unknown_type", `type ${typeflag}`);
    const isDir = typeflag === "5";
    if (isDir && size !== 0) throw new UnsafeTarError("malformed", "a folder with a size");

    // `tar -c .` starts with the folder itself.
    if (isDir && (raw === "./" || raw === "." || raw === "")) continue;
    const parts = safePath(raw, limits);
    if (parts.length - (isDir ? 0 : 1) > limits.maxDepth) throw new UnsafeTarError("too_deep", raw.slice(0, 80));
    if (options.allowedTop && !options.allowedTop.includes(parts[0])) throw new UnsafeTarError("outside_allowed_top", parts[0].slice(0, 40));
    const rel = parts.join("/");
    if (seen.has(rel)) throw new UnsafeTarError("duplicate", rel.slice(0, 80));
    seen.add(rel);

    let data: Buffer = Buffer.alloc(0);
    if (!isDir) {
      if (size > limits.maxFileBytes) throw new UnsafeTarError("too_large", `${rel.slice(0, 60)} is ${size} bytes`);
      total += size;
      if (total > limits.maxTotalBytes) throw new UnsafeTarError("too_large", `more than ${limits.maxTotalBytes} bytes in all`);
      const end = off + size;
      if (end > buf.length) throw new UnsafeTarError("malformed", "an entry runs past the end of the archive");
      data = buf.subarray(off, end);
      off += Math.ceil(size / BLOCK) * BLOCK;
    }
    entries.push({ path: rel, type: isDir ? "dir" : "file", size, data });
  }
  return entries;
}

/** Gunzips with a cap on the output, so a small archive cannot expand without bound. */
export function gunzipCapped(gz: Buffer, maxBytes: number): Buffer {
  try {
    return gunzipSync(gz, { maxOutputLength: maxBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) throw new UnsafeTarError("too_large", `more than ${maxBytes} bytes once uncompressed`);
    throw new UnsafeTarError("malformed", "not a gzip stream");
  }
}

/** Creates one file exclusively, never through a link, owner-only, and flushes it. */
function writeNewFile(file: string, data: Buffer) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let off = 0;
    while (off < data.length) off += writeSync(fd, data, off, data.length - off);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface Extracted {
  files: number;
  folders: number;
  bytes: number;
}

/**
 * Writes validated entries into `dest`, a folder that must not exist yet and
 * that this call creates (owner-only). Everything is validated before any file
 * is written; if writing fails, `dest` is removed. Only regular files and
 * folders are ever created, and no path can leave `dest`.
 */
export function extractTarInto(tar: Buffer, dest: string, limits: TarLimits = RECORDS_TAR_LIMITS, options: { allowedTop?: string[] } = {}): Extracted {
  const entries = parseTar(tar, limits, options);
  mkdirSync(dest, { mode: 0o700 });
  const root = path.resolve(dest);
  const out: Extracted = { files: 0, folders: 0, bytes: 0 };
  try {
    for (const e of entries) {
      const target = path.join(root, ...e.path.split("/"));
      if (path.relative(root, target).startsWith("..")) throw new UnsafeTarError("dot_dot", e.path.slice(0, 80));
      if (e.type === "dir") {
        mkdirSync(target, { recursive: true, mode: 0o700 });
        out.folders++;
        continue;
      }
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeNewFile(target, e.data);
      out.files++;
      out.bytes += e.size;
    }
  } catch (err) {
    rmSync(dest, { recursive: true, force: true });
    throw err;
  }
  return out;
}

/** The whole path for a gzip tar from a machine the subject ran on: capped gunzip, validation, extraction into a new folder. */
export function extractTgzInto(tgz: Buffer, dest: string, limits: TarLimits = RECORDS_TAR_LIMITS, options: { allowedTop?: string[] } = {}): Extracted {
  return extractTarInto(gunzipCapped(tgz, limits.maxTotalBytes + limits.maxEntries * 1024), dest, limits, options);
}
