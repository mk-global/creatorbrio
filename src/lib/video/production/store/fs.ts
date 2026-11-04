/**
 * The file-system calls the production store makes, behind one small
 * interface so tests can inject failures at every write boundary.
 *
 * Why not `src/lib/data.ts`: it writes through a fixed `<file>.tmp` name that
 * two processes would share, does not fsync, replaces files in place with
 * `rename()` (last writer wins), and serialises with an in-process mutex
 * only. The store needs a durable write, a compare-and-swap that holds across
 * processes, and immutable files. Carousel storage keeps using `data.ts`.
 */

import { link, mkdir, open, readdir, readFile, stat, unlink, utimes } from "node:fs/promises";

export interface StoreFs {
  readFile(file: string): Promise<Buffer>;
  /** Creates `file` (which must not exist), writes `data` and fsyncs it before returning. */
  writeNewFileDurable(file: string, data: string): Promise<void>;
  /**
   * Hard-links `existing` as `target`. Fails with EEXIST when `target` exists:
   * this is the store's atomic, cross-process compare-and-swap.
   */
  link(existing: string, target: string): Promise<void>;
  unlink(file: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  mkdirp(dir: string): Promise<void>;
  /** Makes directory entries (new links) durable. */
  syncDir(dir: string): Promise<void>;
  mtimeMs(file: string): Promise<number>;
  touch(file: string): Promise<void>;
}

/** Errors a directory fsync can raise on platforms that do not support it (Windows). */
const UNSUPPORTED_DIR_SYNC = new Set(["EPERM", "EISDIR", "EBADF", "EINVAL"]);

export const nodeFs: StoreFs = {
  readFile: (file) => readFile(file),
  async writeNewFileDurable(file, data) {
    const handle = await open(file, "wx");
    try {
      await handle.writeFile(data, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  link: (existing, target) => link(existing, target),
  unlink: (file) => unlink(file),
  readdir: (dir) => readdir(dir),
  mkdirp: async (dir) => void (await mkdir(dir, { recursive: true })),
  async syncDir(dir) {
    let handle;
    try {
      handle = await open(dir, "r");
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!(process.platform === "win32" && UNSUPPORTED_DIR_SYNC.has(code))) throw error;
    } finally {
      await handle?.close();
    }
  },
  mtimeMs: async (file) => (await stat(file)).mtimeMs,
  async touch(file) {
    const now = new Date();
    await utimes(file, now, now);
  },
};

export function errorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : null;
}
