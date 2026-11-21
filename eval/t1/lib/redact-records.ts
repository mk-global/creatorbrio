/**
 * Redacts every record the host holds, in place, and then proves the token is
 * gone (#225). A subject can put a credential anywhere it chooses its own names:
 * a file name in a snapshot manifest, a sink path, a user agent. So every
 * regular file in the records folder is redacted, including the gzip snapshots
 * (decompressed, redacted, compressed again), and the result is scanned for
 * the token in every shape the host knows: the value, base64 with and without
 * padding, base64url, hexadecimal and URL-encoded forms. All reads and writes
 * go through `RecordsDir`: never through a link, written by temporary file and
 * rename.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import type { RecordsDir } from "./records-io";
import { redact, secretForms, type RedactionContext } from "./scrub";

const MAX = 256 * 1024 * 1024;

const WINDOW = 16;
const alnum = (s: string) => s.replace(/[^A-Za-z0-9]/g, "");

/** Every run of 16 letters and digits in the token, taken with the separators removed: the pieces a token cut over path segments, names or any other separators still leaves, whatever the cuts. */
export function tokenWindows(token: string | undefined): Set<string> {
  const out = new Set<string>();
  const a = alnum(token ?? "");
  for (let i = 0; i + WINDOW <= a.length; i++) out.add(a.slice(i, i + WINDOW));
  return out;
}

/** Whether a text, with its separators removed, holds one of the windows: a token cut into pieces and joined by anything that is not a letter or a digit (a `/`, a `.`, a `-`, a space) is found. */
export function holdsSplitForm(text: string, windows: Set<string>): boolean {
  if (windows.size === 0) return false;
  const a = alnum(text);
  for (let i = 0; i + WINDOW <= a.length; i++) if (windows.has(a.slice(i, i + WINDOW))) return true;
  return false;
}

const SPLIT_MARK = "<redacted: part of the token>";

/**
 * Replaces, in a JSON document or lines of JSON, every string (and key) that holds a split form of the token with a marker, keeping the record around it: the observation or the change is still there,
 * only what it said of the subject's text is not. A line that is not JSON and holds one is replaced whole.
 */
export function redactSplitForms(text: string, token: string | undefined): string {
  const windows = tokenWindows(token);
  if (windows.size === 0 || !holdsSplitForm(text, windows)) return text;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return holdsSplitForm(v, windows) ? SPLIT_MARK : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [holdsSplitForm(k, windows) ? SPLIT_MARK : k, walk(x)]));
    return v;
  };
  try {
    return JSON.stringify(walk(JSON.parse(text)));
  } catch {
    // Lines of JSON.
  }
  return text
    .split("\n")
    .map((line) => {
      if (!holdsSplitForm(line, windows)) return line;
      try {
        return JSON.stringify(walk(JSON.parse(line)));
      } catch {
        return SPLIT_MARK;
      }
    })
    .join("\n");
}

export interface RedactionReport {
  files: number;
  changed: number;
  unreadable: string[];
}

export function redactRecords(rd: RecordsDir, ctx: RedactionContext): RedactionReport {
  const report: RedactionReport = { files: 0, changed: 0, unreadable: [] };
  for (const rel of rd.walk()) {
    if (rel.startsWith(".ssh/")) continue;
    const r = rd.read(rel, MAX);
    if (!r.ok) {
      report.unreadable.push(`${rel} (${r.reason})`);
      continue;
    }
    report.files++;
    if (rel.endsWith(".gz")) {
      let text: string;
      try {
        text = gunzipSync(r.data, { maxOutputLength: MAX }).toString("utf8");
      } catch {
        report.unreadable.push(`${rel} (not gzip)`);
        continue;
      }
      const out = redactSplitForms(redact(text, ctx), ctx.token);
      if (out !== text) {
        rd.write(rel, gzipSync(out));
        report.changed++;
      }
      continue;
    }
    const text = r.data.toString("utf8");
    const out = redactSplitForms(redact(text, ctx), ctx.token);
    if (out !== text) {
      rd.write(rel, out);
      report.changed++;
    }
  }
  return report;
}

/** Files that still hold the token in any recognized shape, decompressing gzip ones; the empty list is the proof. */
export function filesHoldingToken(rd: RecordsDir, token: string | undefined): string[] {
  if (!token || token.length < 8) return [];
  const forms = secretForms(token).map((f) => Buffer.from(f));
  const windows = tokenWindows(token);
  const hits: string[] = [];
  for (const rel of rd.walk()) {
    const r = rd.read(rel, MAX);
    if (!r.ok) continue;
    let data = r.data;
    if (rel.endsWith(".gz")) {
      try {
        data = gunzipSync(r.data, { maxOutputLength: MAX });
      } catch {
        // Scanned as it is.
      }
    }
    if (forms.some((f) => data.includes(f)) || holdsSplitForm(data.toString("utf8"), windows)) hits.push(rel);
  }
  return hits;
}
