/**
 * Every host-side read and write of a run's records goes through here (#225).
 * A records folder holds files that machines the subject ran on produced, so
 * the host treats it as untrusted: it never follows a link (each folder on the
 * way down from the records root is checked, the final component is opened
 * without following links, and only regular files are read), caps what it
 * reads, and writes through a temporary file and a rename so a half-written
 * record never replaces a good one and a planted link is replaced, not
 * written through. Node built-ins only.
 */
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parentChainProblem, safeReadFile, type SafeRead } from "./scrub";

/** A file read of 512 MiB is more than any record the harness writes. */
export const MAX_RECORD_BYTES = 512 * 1024 * 1024;

export class RecordsDir {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    const st = lstatSync(this.root);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("the records folder is not a plain folder");
  }

  private resolve(rel: string): string {
    if (rel === "" || path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error("a record path must be relative and stay inside the records folder");
    return path.join(this.root, rel);
  }

  /** One file, or why it cannot be read. Never through a link, never past a link in a parent folder. */
  read(rel: string, maxBytes = MAX_RECORD_BYTES): SafeRead {
    return safeReadFile(this.resolve(rel), maxBytes, { root: this.root });
  }

  text(rel: string, maxBytes = MAX_RECORD_BYTES): string | null {
    const r = this.read(rel, maxBytes);
    return r.ok ? r.data.toString("utf8") : null;
  }

  /** The names of regular files in a folder (links and everything else are left out), sorted. */
  list(relDir: string): string[] {
    const dir = relDir === "" ? this.root : this.resolve(relDir);
    if (relDir !== "" && parentChainProblem(path.join(dir, "x"), this.root) !== null) return [];
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return [];
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => e.name)
      .sort();
  }

  /** Every regular file under a folder (default: the whole records folder), as relative paths, sorted; links and everything else are left out. */
  walk(relDir = ""): string[] {
    const out: string[] = [];
    const go = (dir: string, rel: string) => {
      let st;
      try {
        st = lstatSync(dir);
      } catch {
        return;
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return;
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) go(path.join(dir, e.name), r);
        else if (e.isFile()) out.push(r);
      }
    };
    go(relDir === "" ? this.root : this.resolve(relDir), relDir);
    return out.sort();
  }

  /** A gzip file's text, decompressed with a cap; null when it cannot be read or is not gzip. */
  gunzipText(rel: string, maxBytes = MAX_RECORD_BYTES): string | null {
    const r = this.read(rel, maxBytes);
    if (!r.ok) return null;
    try {
      return gunzipSync(r.data, { maxOutputLength: maxBytes }).toString("utf8");
    } catch {
      return null;
    }
  }

  /** Writes through a temporary file and a rename. An existing link at the destination is replaced, never followed. */
  write(rel: string, data: string | Buffer, mode = 0o600): void {
    const file = this.resolve(rel);
    const dir = path.dirname(file);
    if (dir !== this.root) {
      if (parentChainProblem(path.join(dir, "x"), this.root) === "symlink") throw new Error("a record's folder is a link");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (parentChainProblem(file, this.root) !== null) throw new Error("a record's folder is not a plain folder");
    }
    const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    try {
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
      let off = 0;
      while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
      fsyncSync(fd);
    } catch (err) {
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw err;
    }
    closeSync(fd);
    renameSync(tmp, file);
  }

  /**
   * Replaces a folder with another folder the host just made (both inside the
   * records root), keeping the old one until the new one is in place. If the
   * replacement is not there (an archive that held no such folder), nothing is
   * touched and the existing folder stays, and the call throws so the caller
   * can say why; if the swap fails half way, the old folder is put back.
   */
  replaceFolder(rel: string, fromAbsolute: string): void {
    const dest = this.resolve(rel);
    if (path.dirname(path.resolve(fromAbsolute)) !== path.dirname(dest) && !path.resolve(fromAbsolute).startsWith(`${this.root}${path.sep}`)) throw new Error("the replacement must be inside the records folder");
    let st;
    try {
      st = lstatSync(fromAbsolute);
    } catch {
      throw new Error(`the replacement for ${rel} is not there, so the existing ${rel} was kept`);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`the replacement for ${rel} is not a plain folder, so the existing ${rel} was kept`);
    const old = `${dest}.old-${process.pid}`;
    let hadOld = false;
    try {
      renameSync(dest, old);
      hadOld = true;
    } catch {
      // Nothing there yet.
    }
    try {
      renameSync(fromAbsolute, dest);
    } catch (err) {
      if (hadOld) renameSync(old, dest);
      throw err;
    }
    if (hadOld) rmSync(old, { recursive: true, force: true });
  }
}

export interface TreeCheck {
  files: number;
  folders: number;
  bytes: number;
  problems: string[];
}

/**
 * Walks a records folder and reports every entry that is not a plain folder or
 * a regular file with a single link: a symbolic link, a hard link shared with
 * something elsewhere, a device, a FIFO or a socket. A clean tree is what the
 * host then reads and rewrites.
 */
export function checkRecordsTree(root: string, limit = 50_000): TreeCheck {
  const out: TreeCheck = { files: 0, folders: 0, bytes: 0, problems: [] };
  let seen = 0;
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir)) {
      if (++seen > limit) {
        out.problems.push(`more than ${limit} entries`);
        return;
      }
      const full = path.join(dir, name);
      const here = rel ? `${rel}/${name}` : name;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) out.problems.push(`${here.slice(0, 120)} is a symbolic link`);
      else if (st.isDirectory()) {
        out.folders++;
        walk(full, here);
      } else if (st.isFile()) {
        out.files++;
        out.bytes += st.size;
        if (st.nlink > 1) out.problems.push(`${here.slice(0, 120)} has ${st.nlink} hard links`);
      } else out.problems.push(`${here.slice(0, 120)} is not a regular file`);
      if (out.problems.length > 50) return;
    }
  };
  walk(root, "");
  return out;
}
