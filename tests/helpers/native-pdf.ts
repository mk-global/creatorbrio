import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer from "puppeteer";
import sharp from "sharp";
import type { Slide } from "@/types/carousel";

/**
 * Shared fixtures and independent PDF readers for the tests that print real
 * slides with Chromium. They need Chromium, which CI does not install, and
 * read the PDFs back with poppler and qpdf rather than with the code under
 * test, so the evidence does not depend on CreatorBrio's own PDF reading.
 */

export function chromiumPath(): string | null {
  try {
    const candidate = process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath();
    return candidate && existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function hasCommand(command: string, flag = "-v"): boolean {
  try {
    execFileSync(command, [flag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** poppler's command-line tools and qpdf, which every assertion on PDF bytes uses. */
export const pdfTools =
  ["pdftocairo", "pdfimages", "pdfinfo", "pdffonts", "pdftotext"].every((c) => hasCommand(c)) &&
  hasCommand("qpdf", "--version");

export function slide(html: string, index = 0): Slide {
  return { id: `s${index + 1}`, html, previousVersions: [], order: index, notes: "" };
}

/** Runs a PDF tool on `pdf` (written to a temporary file) and returns its stdout. */
export async function withPdfFile<T>(pdf: Uint8Array, read: (file: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), "creatorbrio-pdf-read-"));
  try {
    const file = path.join(dir, "doc.pdf");
    await writeFile(file, pdf);
    return await read(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "latin1", maxBuffer: 256 * 1024 * 1024 });
}

export interface PdfInfo {
  pages: number;
  encrypted: boolean;
  /** Each page's MediaBox and CropBox as [x0, y0, x1, y1]. */
  boxes: { media: number[]; crop: number[] }[];
}

export function pdfInfo(file: string): PdfInfo {
  const summary = run("pdfinfo", [file]);
  const pages = Number(summary.match(/^Pages:\s+(\d+)/m)![1]);
  const boxes = Array.from({ length: pages }, (_, i) => {
    const out = run("pdfinfo", ["-box", "-f", String(i + 1), "-l", String(i + 1), file]);
    const box = (name: string) =>
      out.match(new RegExp(`${name}:\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)\\s+([-\\d.]+)`))!
        .slice(1)
        .map(Number);
    return { media: box("MediaBox"), crop: box("CropBox") };
  });
  return { pages, encrypted: !/^Encrypted:\s+no/m.test(summary), boxes };
}

/** The words `pdftotext` extracts from one page, in reading order. */
export function pageWords(file: string, page: number): string[] {
  // Decoded as UTF-8 before splitting: read as latin1, a byte such as 0xA0
  // inside a character's UTF-8 encoding (Cyrillic Р, French à) would count as
  // a space and cut the character in two.
  return Buffer.from(run("pdftotext", ["-f", String(page), "-l", String(page), "-enc", "UTF-8", file, "-"]), "latin1")
    .toString("utf8")
    .replace(/\f/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export interface PdfFont {
  name: string;
  type: string;
  embedded: boolean;
  subset: boolean;
  unicode: boolean;
}

/** The fonts `pdffonts` reports for one page. */
export function pageFonts(file: string, page: number): PdfFont[] {
  const rows = run("pdffonts", ["-f", String(page), "-l", String(page), file]).split("\n").slice(2);
  return rows
    .filter((l) => l.trim())
    .map((line) => {
      // name, type (which may hold spaces), encoding, emb, sub, uni, object
      // number and generation. A long name can overflow its column, so the
      // row is read by tokens from both ends rather than by position.
      const cols = line.trim().split(/\s+/);
      const [emb, sub, uni] = cols.slice(-5, -2);
      return {
        name: cols[0],
        type: cols.slice(1, -6).join(" "),
        embedded: emb === "yes",
        subset: sub === "yes",
        unicode: uni === "yes",
      };
    });
}

export interface PdfImage {
  page: number;
  width: number;
  height: number;
  encoding: string;
}

/** Every image `pdfimages` finds, with the page it is on and its pixel size. */
export function pdfImages(file: string): PdfImage[] {
  return run("pdfimages", ["-list", file])
    .split("\n")
    .slice(2)
    .filter((l) => l.trim())
    .map((line) => {
      const c = line.trim().split(/\s+/);
      return { type: c[2], image: { page: Number(c[0]), width: Number(c[3]), height: Number(c[4]), encoding: c[8] } };
    })
    // Soft masks are an image's transparency, not separate pictures.
    .filter(({ type }) => type === "image")
    .map(({ image }) => image);
}

/** The document with every stream decompressed, as qpdf writes it. */
export function uncompressed(file: string): string {
  return run("qpdf", ["--qdf", "--object-streams=disable", file, "-"]);
}

/** One page rasterised by poppler at 96 dpi, the slide's own pixel size. */
export async function rasterisePage(file: string, page: number): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "creatorbrio-pdf-raster-"));
  try {
    const out = path.join(dir, "page");
    run("pdftocairo", ["-png", "-r", "96", "-f", String(page), "-l", String(page), "-singlefile", file, out]);
    return await readFile(`${out}.png`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Share of 8 x 8 blocks allowed to differ between a PDF page, as poppler draws
 * it, and the PNG export of the same slide. Matching pages measure 0 to 0.013%
 * and the smallest real change tried measures 0.3% (see `changedBlocks`);
 * 0.1% sits well clear of both.
 */
export const MAX_CHANGED_BLOCKS = 0.001;

/**
 * How much two renderings of one slide differ, as the share of 8 x 8 pixel
 * blocks whose average colour moved by more than 40 levels in any channel.
 *
 * Averaging over a block absorbs what legitimately differs between Chrome's
 * screen rendering and a PDF reader's: anti-aliasing and the weight of glyph
 * edges. A word that changed, a line that moved or vanished, a different font
 * or a missing shape changes whole blocks. Calibrated on the ten-page fixture:
 * matching pages score 0 to 0.013%, the smallest real change tried (one word
 * swapped) 0.3%.
 */
export async function changedBlocks(a: Buffer, b: Buffer): Promise<number> {
  const read = (png: Buffer) =>
    sharp(png).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
  const [ra, rb] = await Promise.all([read(a), read(b)]);
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) {
    throw new Error(`Sizes differ: ${ra.info.width}x${ra.info.height} vs ${rb.info.width}x${rb.info.height}`);
  }
  const { width, height } = ra.info;
  const BLOCK = 8;
  const LEVELS = 40;
  let blocks = 0;
  let changed = 0;
  for (let by = 0; by + BLOCK <= height; by += BLOCK) {
    for (let bx = 0; bx + BLOCK <= width; bx += BLOCK) {
      const sum = [0, 0, 0, 0, 0, 0];
      for (let y = by; y < by + BLOCK; y++) {
        for (let x = bx; x < bx + BLOCK; x++) {
          const o = (y * width + x) * 3;
          for (let c = 0; c < 3; c++) {
            sum[c] += ra.data[o + c];
            sum[c + 3] += rb.data[o + c];
          }
        }
      }
      blocks++;
      const n = BLOCK * BLOCK;
      if ([0, 1, 2].some((c) => Math.abs(sum[c] - sum[c + 3]) / n > LEVELS)) changed++;
    }
  }
  return changed / blocks;
}

/** The colour of one pixel of a PNG, as "#rrggbb". */
export async function pixelAt(png: Buffer, x: number, y: number): Promise<string> {
  const { data } = await sharp(png)
    .removeAlpha()
    .extract({ left: x, top: y, width: 1, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return `#${[...data].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** A photograph-like JPEG: smooth gradients with fine noise, which no vector can stand in for. */
export async function photoJpeg(width: number, height: number, seed: number): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  let state = seed;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      const noise = (state >> 16) % 24;
      const o = (y * width + x) * 3;
      pixels[o] = Math.min(255, 60 + (x * 140) / width + noise);
      pixels[o + 1] = Math.min(255, 80 + (y * 100) / height + noise);
      pixels[o + 2] = Math.min(255, 120 + ((x + y) * 60) / (width + height) + noise);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
}
