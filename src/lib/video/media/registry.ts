/**
 * The media registry (WS2 #79 slice, #140): immutable originals named by their
 * SHA-256, the facts probed from them, provenance, and the files derived from
 * them for preview. It is also the asset ledger production admission checks
 * media references against (`InvariantContext.ledger`).
 *
 * Layout under the registry root (`data/video-media/`):
 *
 *   objects/<sha256>/original.<ext>   the imported bytes, read-only
 *   objects/<sha256>/record.json      MediaRecord
 *   objects/<sha256>/job.json         the derived-files job (see jobs.ts)
 *   objects/<sha256>/proxy.mp4 | proxy.m4a | proxy.png, poster.jpg, peaks.json
 *   tmp/                              imports and outputs being written
 *
 * An import is built completely in its own folder under `tmp/` and published
 * with one directory rename onto `objects/<sha256>`. A crash before the rename
 * leaves only temporary files; two imports of the same bytes race on the
 * rename, and the loser returns the winner's record. Nothing here ever
 * rewrites or deletes a published original.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { MediaKind } from "@/types/production";
import type { LedgerMedia } from "../production/invariants";
import { probeFile, UnsupportedMedia, type MediaFacts } from "./facts";

export const MEDIA_RECORD_VERSION = 1;
/** Large enough for half an hour of iPhone 4K HDR; larger files are refused rather than half-copied. */
export const MAX_IMPORT_BYTES = 32 * 1024 ** 3;
const SHA256 = /^[0-9a-f]{64}$/;
const EXTENSION = /^\.[a-z0-9]{1,5}$/;

export interface MediaRecord {
  version: typeof MEDIA_RECORD_VERSION;
  mediaId: string;
  kind: MediaKind;
  /** The file's name when imported, without its folder. */
  originalName: string;
  /** Extension of the stored original, e.g. ".mov". */
  extension: string;
  sizeBytes: number;
  importedAt: string;
  facts: MediaFacts;
  provenance: { source: "local-file"; rights: "user-supplied" };
}

export type ImportFailureCode = "invalid_path" | "not_found" | "not_a_file" | "inside_data_directory" | "too_large" | "unsupported_media" | "tool_missing";

export class ImportFailure extends Error {
  constructor(
    readonly code: ImportFailureCode,
    message: string
  ) {
    super(message);
    this.name = "ImportFailure";
  }
}

export interface ImportResult {
  record: MediaRecord;
  /** False when identical bytes were already registered. */
  created: boolean;
}

export interface RegistryOptions {
  /** CreatorBrio's data directory; files inside it can never be imported. */
  dataDir: string;
  /** Defaults to `<dataDir>/video-media`. */
  root?: string;
  now?: () => string;
  maxImportBytes?: number;
}

/** The derived files a media can have, by name. */
export const DERIVED_FILES = {
  "proxy.mp4": "video/mp4",
  "proxy.m4a": "audio/mp4",
  "proxy.png": "image/png",
  "poster.jpg": "image/jpeg",
  "peaks.json": "application/json",
} as const;
export type DerivedFile = keyof typeof DERIVED_FILES;

export class MediaRegistry {
  readonly root: string;
  readonly dataDir: string;
  private readonly now: () => string;
  private readonly maxImportBytes: number;
  private cache: { mtimeMs: number; records: Map<string, MediaRecord> } | null = null;
  /** Called after a new media is published, e.g. to queue its derived files. */
  onPublished: ((record: MediaRecord) => void) | null = null;

  constructor(options: RegistryOptions) {
    this.dataDir = path.resolve(/*turbopackIgnore: true*/ options.dataDir);
    this.root = path.resolve(/*turbopackIgnore: true*/ options.root ?? path.join(/*turbopackIgnore: true*/ this.dataDir, "video-media"));
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxImportBytes = options.maxImportBytes ?? MAX_IMPORT_BYTES;
  }

  objectDir(mediaId: string): string {
    if (!SHA256.test(mediaId)) throw new Error("not a media id");
    return path.join(/*turbopackIgnore: true*/ this.root, "objects", mediaId);
  }

  originalPath(record: MediaRecord): string {
    return path.join(/*turbopackIgnore: true*/ this.objectDir(record.mediaId), `original${record.extension}`);
  }

  derivedPath(mediaId: string, file: DerivedFile): string {
    return path.join(/*turbopackIgnore: true*/ this.objectDir(mediaId), file);
  }

  /** A folder under `tmp/` for one piece of work; the caller removes it. */
  async scratch(): Promise<string> {
    const dir = path.join(/*turbopackIgnore: true*/ this.root, "tmp", randomUUID());
    await mkdir(dir, { recursive: true });
    return dir;
  }

  /**
   * Imports a local file by absolute path. The file is probed before anything
   * is copied, so a file that is not media is never copied; the stored copy is
   * probed again, and that is the record's truth.
   */
  async importPath(input: unknown, originalName?: string): Promise<ImportResult> {
    if (typeof input !== "string" || !path.isAbsolute(input) || input.length > 4096 || input.includes("\0")) {
      throw new ImportFailure("invalid_path", "give the absolute path of a file on this computer");
    }
    const source = path.normalize(input);
    let info;
    try {
      info = await lstat(source);
    } catch {
      throw new ImportFailure("not_found", "no file exists at that path");
    }
    if (!info.isFile()) throw new ImportFailure("not_a_file", "the path must name a regular file, not a folder, link or device");
    let real: string;
    try {
      real = await realpath(source);
    } catch {
      throw new ImportFailure("not_found", "the file cannot be opened");
    }
    const dataReal = await realpath(this.dataDir).catch(() => this.dataDir);
    if (real === dataReal || real.startsWith(dataReal + path.sep)) {
      throw new ImportFailure("inside_data_directory", "files inside CreatorBrio's own data folder cannot be imported");
    }
    if (info.size > this.maxImportBytes) throw new ImportFailure("too_large", `files over ${Math.round(this.maxImportBytes / 1024 ** 3)} GiB cannot be imported`);
    await probeOrFail(real);

    const work = await this.scratch();
    try {
      const name = (originalName ?? path.basename(source)).slice(0, 255);
      const ext = path.extname(name).toLowerCase();
      const extension = EXTENSION.test(ext) ? ext : ".bin";
      const stored = path.join(/*turbopackIgnore: true*/ work, `original${extension}`);
      // A copy-on-write clone where the filesystem supports it (APFS), a full copy elsewhere.
      await copyFile(real, stored, constants.COPYFILE_FICLONE);
      await chmod(stored, 0o444);
      const { sha256, size } = await hashFile(stored);
      if (size > this.maxImportBytes) throw new ImportFailure("too_large", "the file grew past the import limit while it was being copied");
      const facts = await probeOrFail(stored);
      const record: MediaRecord = {
        version: MEDIA_RECORD_VERSION,
        mediaId: sha256,
        kind: facts.kind,
        originalName: name,
        extension,
        sizeBytes: size,
        importedAt: this.now(),
        facts,
        provenance: { source: "local-file", rights: "user-supplied" },
      };
      await writeFile(path.join(/*turbopackIgnore: true*/ work, "record.json"), JSON.stringify(record, null, 2) + "\n", { mode: 0o644 });
      await mkdir(path.join(/*turbopackIgnore: true*/ this.root, "objects"), { recursive: true });
      try {
        await rename(work, this.objectDir(sha256));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
        const existing = await this.get(sha256);
        if (!existing) throw error;
        return { record: existing, created: false };
      }
      this.cache = null;
      this.onPublished?.(record);
      return { record, created: true };
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  /** One media's record, or null when it is not registered. */
  async get(mediaId: string): Promise<MediaRecord | null> {
    if (!SHA256.test(mediaId)) return null;
    return (await this.records()).get(mediaId) ?? null;
  }

  async list(): Promise<MediaRecord[]> {
    return [...(await this.records()).values()].sort((a, b) => a.importedAt.localeCompare(b.importedAt) || a.mediaId.localeCompare(b.mediaId));
  }

  /** The asset ledger for production admission. */
  async ledger(): Promise<ReadonlyMap<string, LedgerMedia>> {
    const ledger = new Map<string, LedgerMedia>();
    for (const [id, record] of await this.records()) {
      ledger.set(id, record.facts.durationUs === undefined ? { kind: record.kind } : { kind: record.kind, durationUs: record.facts.durationUs });
    }
    return ledger;
  }

  /** Published records, re-read when the objects folder changes (an import from another process included). */
  private async records(): Promise<Map<string, MediaRecord>> {
    const objects = path.join(/*turbopackIgnore: true*/ this.root, "objects");
    const mtimeMs = await stat(objects).then((s) => s.mtimeMs, () => -1);
    if (this.cache && this.cache.mtimeMs === mtimeMs) return this.cache.records;
    const records = new Map<string, MediaRecord>();
    const names = mtimeMs < 0 ? [] : await readdir(objects);
    for (const name of names) {
      if (!SHA256.test(name)) continue;
      const record = await readRecord(path.join(/*turbopackIgnore: true*/ objects, name, "record.json"));
      if (record && record.mediaId === name) records.set(name, record);
    }
    this.cache = { mtimeMs, records };
    return records;
  }
}

async function probeOrFail(file: string): Promise<MediaFacts> {
  try {
    return await probeFile(file);
  } catch (error) {
    if (error instanceof UnsupportedMedia) throw new ImportFailure("unsupported_media", error.message);
    if ((error as { reason?: string }).reason === "missing") throw new ImportFailure("tool_missing", "FFmpeg's ffprobe is not installed, so media cannot be imported");
    throw error;
  }
}

export async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest("hex"), size };
}

const KINDS = new Set<MediaKind>(["video", "audio", "image"]);

/** Reads a record written by this registry, checking its shape; anything else is ignored. */
async function readRecord(file: string): Promise<MediaRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as Partial<MediaRecord>;
    const facts = parsed.facts as Partial<MediaFacts> | undefined;
    if (
      parsed.version !== MEDIA_RECORD_VERSION ||
      typeof parsed.mediaId !== "string" ||
      !SHA256.test(parsed.mediaId) ||
      !KINDS.has(parsed.kind as MediaKind) ||
      typeof parsed.originalName !== "string" ||
      typeof parsed.extension !== "string" ||
      !EXTENSION.test(parsed.extension) ||
      !Number.isSafeInteger(parsed.sizeBytes) ||
      typeof parsed.importedAt !== "string" ||
      !facts ||
      facts.kind !== parsed.kind ||
      (facts.durationUs !== undefined && !(Number.isSafeInteger(facts.durationUs) && facts.durationUs > 0))
    ) {
      return null;
    }
    return parsed as MediaRecord;
  } catch {
    return null;
  }
}
