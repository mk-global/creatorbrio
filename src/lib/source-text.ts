/**
 * Turns a retrieved page into plain text for planning: the title, headings,
 * paragraphs and list items, in document order. Script, style and template
 * content is dropped, entities are decoded and whitespace is collapsed. The
 * result is untrusted data, never markup or instructions.
 */

export const MAX_SOURCE_TEXT_CHARS = 20_000;

export interface ExtractedText {
  title: string;
  text: string;
  truncated: boolean;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©",
  reg: "®", trade: "™", middot: "·", bull: "•", deg: "°",
  times: "×", divide: "÷", euro: "€", pound: "£", yen: "¥", cent: "¢",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (match, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      // Out-of-range and surrogate code points are not characters.
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " ";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/** Text content of an HTML fragment: tags removed, entities decoded, whitespace collapsed. */
function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Removes elements whose content is never page text, with that content. */
function dropNonText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(-->|$)/g, " ")
    .replace(/<(script|style|template|noscript|svg|iframe|object)\b[\s\S]*?(<\/\1\s*>|$)/gi, " ");
}

const BLOCK = /<(h[1-6]|p|li)\b[^>]*>([\s\S]*?)(?=<\/\1\s*>|<(?:h[1-6]|p|li)\b|$)/gi;

export function extractText(html: string): ExtractedText {
  const cleaned = dropNonText(html);
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(cleaned);
  const title = titleMatch ? textOf(titleMatch[1]) : "";
  const body = cleaned.replace(/<head\b[\s\S]*?<\/head\s*>/i, " ");

  const lines: string[] = [];
  for (const match of body.matchAll(BLOCK)) {
    const text = textOf(match[2]);
    if (!text) continue;
    const tag = match[1].toLowerCase();
    if (tag[0] === "h") lines.push(`${"#".repeat(Number(tag[1]))} ${text}`);
    else if (tag === "li") lines.push(`- ${text}`);
    else lines.push(text);
  }

  const full = [title, ...lines].filter(Boolean).join("\n");
  const truncated = full.length > MAX_SOURCE_TEXT_CHARS;
  const text = truncated ? full.slice(0, MAX_SOURCE_TEXT_CHARS) : full;
  return { title, text, truncated };
}

/** Plain text pages are kept as they are, with whitespace collapsed per line. */
export function extractPlainText(body: string): ExtractedText {
  const full = body
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  const truncated = full.length > MAX_SOURCE_TEXT_CHARS;
  return { title: "", text: truncated ? full.slice(0, MAX_SOURCE_TEXT_CHARS) : full, truncated };
}
