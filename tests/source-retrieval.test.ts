import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { isPublicAddress, parseSourceUrl } from "@/lib/source-address";
import { extractText, MAX_SOURCE_TEXT_CHARS } from "@/lib/source-text";
import { findSourceLinks, retrieveSources, type Dial, type RetrievalOptions } from "@/lib/source-retrieval";

// No real network: every "remote" host is one local test server. A stub
// resolver gives hostnames public (or not) addresses, and a stub dial
// connects each validated address to the test server, recording the address
// it was asked for.
const PUBLIC_A = "93.184.216.34";
const PUBLIC_B = "2606:4700:4700::1111";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let routes: Record<string, Handler>;
let seen: { path: string; headers: IncomingMessage["headers"] }[];
let server: Server;
let port: number;
let dialed: string[];
let resolved: string[];
let logs: unknown[][];

const ARTICLE_TEXT =
  "Calm teams ship more because they protect focus time and make decisions in writing, which keeps context available to everyone who joins later. ";

function article(title = "Five habits of calm teams") {
  return `<!doctype html><html><head><title>${title}</title><style>body{color:red}</style>
<script>window.secret = "SCRIPT TEXT";</script></head><body>
<h1>Five habits</h1><p>${ARTICLE_TEXT}</p><p>${ARTICLE_TEXT}</p>
<ul><li>Write it down</li><li>Protect focus</li></ul></body></html>`;
}

const html = (body: string, status = 200, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", ...headers });
  res.end(body);
};
const redirect = (location: string, headers: Record<string, string> = {}): Handler => (_req, res) => {
  res.writeHead(302, { Location: location, ...headers });
  res.end();
};

const resolver = (table: Record<string, string[] | (() => string[])>) => async (host: string) => {
  resolved.push(host);
  const entry = table[host];
  if (!entry) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  return typeof entry === "function" ? entry() : entry;
};

const dial: Dial = ({ address }) => {
  dialed.push(address);
  return net.connect({ host: "127.0.0.1", port });
};

function options(table: Record<string, string[] | (() => string[])> = { "news.example": [PUBLIC_A] }, limits = {}): RetrievalOptions {
  return { resolve: resolver(table), dial, limits };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    const handler = routes[req.url ?? ""];
    if (handler) handler(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  routes = {};
  seen = [];
  dialed = [];
  resolved = [];
  logs = [];
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => void logs.push(args));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public address policy", () => {
  it.each([
    "127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "192.0.2.1", "198.51.100.7", "203.0.113.9", "198.18.0.1",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:93.184.216.34", "64:ff9b::7f00:1", "2002:7f00:1::1", "2001:0:4136:e378::1",
    "::127.0.0.1", "not-an-address",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "2a00:1450:4001::200e"])(
    "accepts %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    }
  );

  it.each([
    ["ftp://news.example/a", "unsupported_scheme"],
    ["http://user:secret@news.example/", "credentials_in_url"],
    ["http://news.example:8080/", "non_default_port"],
    ["https://news.example:80/", "non_default_port"],
    ["http://", "invalid_url"],
  ])("refuses the URL %s", (raw, reason) => {
    expect(parseSourceUrl(raw)).toEqual({ ok: false, reason });
  });

  it("accepts default ports and drops the fragment", () => {
    const parsed = parseSourceUrl("https://news.example:443/a?b=1#c");
    expect(parsed.ok && parsed.url.href).toBe("https://news.example/a?b=1");
  });
});

describe("refusing non-public destinations", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://[::1]/",
    "http://2130706433/",
    "http://0x7f.1/",
    "http://[::ffff:7f00:1]/",
    "http://169.254.169.254/latest/meta-data",
    "http://10.0.0.1/",
    "http://100.64.1.1/",
    "http://0.0.0.0/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
  ])("refuses the literal %s before connecting", async (link) => {
    const result = await retrieveSources(`Use ${link} please`, options());
    expect(result).toMatchObject({ status: "retrieved", sources: [{ ok: false, reason: "non_public_address" }] });
    expect(dialed).toEqual([]);
  });

  it.each([
    [["127.0.0.1"]],
    [["10.0.0.5"]],
    [["::1"]],
    [["fe80::2"]],
    [["100.64.0.9"]],
    [["::ffff:192.168.0.1"]],
    [[PUBLIC_A, "10.0.0.5"]],
  ])("refuses a hostname resolving to %j", async (addresses) => {
    const result = await retrieveSources("https://intranet.example/x", options({ "intranet.example": addresses }));
    expect(result).toMatchObject({ sources: [{ ok: false, reason: "non_public_address", host: "intranet.example" }] });
    expect(dialed).toEqual([]);
  });

  it("refuses a public page that redirects to a non-public address, at the redirect", async () => {
    routes["/start"] = redirect("http://127.0.0.1/admin");
    const result = await retrieveSources("http://news.example/start", options());
    expect(result).toMatchObject({ sources: [{ ok: false, reason: "non_public_address" }] });
    expect(dialed).toEqual([PUBLIC_A]);
    expect(seen.map((s) => s.path)).toEqual(["/start"]);
  });

  it("refuses a redirect to a hostname that resolves to a private address", async () => {
    routes["/start"] = redirect("http://internal.example/secrets");
    const result = await retrieveSources(
      "http://news.example/start",
      options({ "news.example": [PUBLIC_A], "internal.example": ["192.168.1.20"] })
    );
    expect(result).toMatchObject({ sources: [{ ok: false, reason: "non_public_address" }] });
    expect(seen.map((s) => s.path)).toEqual(["/start"]);
  });

  it("connects to the validated address even if the resolver later answers privately", async () => {
    routes["/a"] = html(article());
    const answers = [[PUBLIC_A], ["127.0.0.1"]];
    const result = await retrieveSources(
      "http://rebind.example/a",
      options({ "rebind.example": () => answers.shift() ?? ["127.0.0.1"] })
    );
    expect(result).toMatchObject({ sources: [{ ok: true }] });
    expect(resolved).toEqual(["rebind.example"]);
    expect(dialed).toEqual([PUBLIC_A]);
  });

  it("validates every redirect hop again, so a rebinding host is refused on its second hop", async () => {
    routes["/a"] = redirect("/b");
    routes["/b"] = html(article());
    const answers = [[PUBLIC_A], ["127.0.0.1"]];
    const result = await retrieveSources(
      "http://rebind.example/a",
      options({ "rebind.example": () => answers.shift() ?? ["127.0.0.1"] })
    );
    expect(result).toMatchObject({ sources: [{ ok: false, reason: "non_public_address" }] });
    expect(dialed).toEqual([PUBLIC_A]);
  });

  it("refuses an unresolvable host", async () => {
    const result = await retrieveSources("http://missing.example/", options({}));
    expect(result).toMatchObject({ sources: [{ ok: false, reason: "unresolvable_host" }] });
  });
});

describe("bounded retrieval", () => {
  it("retrieves a public page as extracted text, over IPv4 or IPv6", async () => {
    routes["/a"] = html(article());
    const result = await retrieveSources(
      "See http://news.example/a and https://v6.example/a.",
      options({ "news.example": [PUBLIC_A], "v6.example": [PUBLIC_B] })
    );
    expect(result.status).toBe("retrieved");
    const sources = result.status === "retrieved" ? result.sources : [];
    expect(sources).toHaveLength(2);
    expect(sources[0]).toMatchObject({ ok: true, host: "news.example", title: "Five habits of calm teams", truncated: false });
    expect(dialed).toContain(PUBLIC_B);
  });

  it("follows up to three redirects and refuses a fourth", async () => {
    routes["/r1"] = redirect("/r2");
    routes["/r2"] = redirect("/r3");
    routes["/r3"] = redirect("/final");
    routes["/final"] = html(article());
    expect(await retrieveSources("http://news.example/r1", options())).toMatchObject({ sources: [{ ok: true }] });

    routes["/r0"] = redirect("/r1");
    expect(await retrieveSources("http://news.example/r0", options())).toMatchObject({
      sources: [{ ok: false, reason: "too_many_redirects" }],
    });
  });

  it.each([
    ["a non-200 status", html(article(), 404), "http_status"],
    ["a server error", html(article(), 500), "http_status"],
    ["JSON", html("{}", 200, { "Content-Type": "application/json" }), "unsupported_content_type"],
    ["an image", html("png", 200, { "Content-Type": "image/png" }), "unsupported_content_type"],
    ["a missing content type", (_req: IncomingMessage, res: ServerResponse) => { res.writeHead(200); res.end(article()); }, "unsupported_content_type"],
    ["an unknown content encoding", html(article(), 200, { "Content-Encoding": "compress" }), "unsupported_encoding"],
    ["too little text", html("<p>Short page.</p>"), "too_little_text"],
  ])("makes %s unavailable", async (_label, handler, reason) => {
    routes["/a"] = handler as Handler;
    expect(await retrieveSources("http://news.example/a", options())).toMatchObject({
      sources: [{ ok: false, reason }],
    });
  });

  it("refuses a body declared larger than the limit, and one that grows past it", async () => {
    routes["/declared"] = html("x".repeat(4096));
    expect(
      await retrieveSources("http://news.example/declared", options(undefined, { maxBodyBytes: 1024 }))
    ).toMatchObject({ sources: [{ ok: false, reason: "too_large" }] });

    routes["/chunked"] = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      for (let i = 0; i < 8; i++) res.write("x".repeat(512));
      res.end();
    };
    expect(
      await retrieveSources("http://news.example/chunked", options(undefined, { maxBodyBytes: 1024 }))
    ).toMatchObject({ sources: [{ ok: false, reason: "too_large" }] });
  });

  it.each([
    ["gzip", zlib.gzipSync],
    ["deflate", zlib.deflateSync],
    ["br", zlib.brotliCompressSync],
  ] as const)("refuses a %s body that expands past 2 MiB", async (encoding, compress) => {
    const bomb = compress(Buffer.alloc(3 * 1024 * 1024, 0x61));
    expect(bomb.length).toBeLessThan(64 * 1024);
    routes["/bomb"] = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": encoding, "Content-Length": bomb.length });
      res.end(bomb);
    };
    expect(await retrieveSources("http://news.example/bomb", options())).toMatchObject({
      sources: [{ ok: false, reason: "too_large" }],
    });
  });

  it("decodes a compressed page within the limit", async () => {
    const body = zlib.gzipSync(Buffer.from(article()));
    routes["/gz"] = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      res.end(body);
    };
    expect(await retrieveSources("http://news.example/gz", options())).toMatchObject({ sources: [{ ok: true }] });
  });

  it("gives up on a body slower than the per-source limit", async () => {
    routes["/slow"] = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.write("<p>Starting");
      // Never finishes.
    };
    const started = Date.now();
    expect(
      await retrieveSources("http://news.example/slow", options(undefined, { perSourceMs: 300 }))
    ).toMatchObject({ sources: [{ ok: false, reason: "timed_out" }] });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("bounds the whole stage, whatever the per-source limit", async () => {
    for (const route of ["/hang", "/hang?2", "/hang?3"]) routes[route] = () => {};
    const result = await retrieveSources(
      "http://news.example/hang http://news.example/hang?2 http://news.example/hang?3",
      options(undefined, { perSourceMs: 10_000, stageMs: 300 })
    );
    expect(result).toMatchObject({
      sources: [
        { ok: false, reason: "stage_timed_out" },
        { ok: false, reason: "stage_timed_out" },
        { ok: false, reason: "stage_timed_out" },
      ],
    });
  });

  it("decodes the declared charset", async () => {
    const latin1 = Buffer.from(`<p>Café crème. ${ARTICLE_TEXT}${ARTICLE_TEXT}</p>`, "latin1");
    routes["/latin1"] = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=ISO-8859-1" });
      res.end(latin1);
    };
    const result = await retrieveSources("http://news.example/latin1", options());
    expect(result.status === "retrieved" && result.sources[0].ok && result.sources[0].text).toContain("Café crème.");
  });

  it("refuses a fourth link before any request", async () => {
    const result = await retrieveSources(
      "http://news.example/1 http://news.example/2 http://news.example/3 http://news.example/4",
      options()
    );
    expect(result).toEqual({ status: "too_many_sources", count: 4 });
    expect(resolved).toEqual([]);
    expect(dialed).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("sends no cookie or authorization, even one a redirect tried to set", async () => {
    routes["/login"] = redirect("/a", { "Set-Cookie": "session=abc" });
    routes["/a"] = html(article());
    await retrieveSources("http://news.example/login", options());
    expect(seen).toHaveLength(2);
    for (const { headers } of seen) {
      expect(headers.cookie).toBeUndefined();
      expect(headers.authorization).toBeUndefined();
      expect(headers["user-agent"]).toBe("CreatorBrio-SourceRetrieval/1.0");
      expect(headers.host).toBe("news.example");
    }
  });

  it("logs hosts and counts, never paths, queries or page text", async () => {
    routes["/private/path?token=s3cret"] = html(article());
    await retrieveSources("http://news.example/private/path?token=s3cret", options());
    const text = JSON.stringify(logs);
    expect(text).toContain("news.example");
    expect(text).toContain('"outcome":"retrieved"');
    expect(text).not.toContain("/private/path");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("Calm teams");
  });
});

describe("finding links in a message", () => {
  it("finds distinct http and https links without trailing punctuation", () => {
    expect(
      findSourceLinks(
        "Read https://news.example/a, then (http://blog.example/post). Again: https://news.example/a! And https://en.wikipedia.org/wiki/Calm_(film)."
      )
    ).toEqual(["https://news.example/a", "http://blog.example/post", "https://en.wikipedia.org/wiki/Calm_(film)"]);
  });

  it("ignores other schemes and text without links", () => {
    expect(findSourceLinks("ftp://files.example/a and mailto:a@b.example and plain text")).toEqual([]);
  });

  it("returns none for a message without links, without any request", async () => {
    expect(await retrieveSources("Make a carousel about focus", options())).toEqual({ status: "none" });
    expect(resolved).toEqual([]);
  });
});

describe("extracting page text", () => {
  it("keeps the title, headings, paragraphs and list items, and drops script, style and template content", () => {
    const { title, text } = extractText(`<html><head><title>T &amp; C</title><style>.x{}</style></head><body>
      <script>var hidden = "SCRIPT";</script><template><p>TEMPLATE</p></template><!-- <p>COMMENT</p> -->
      <nav>Menu</nav><h2>Why   it
      matters</h2><p>First &ldquo;point&rdquo; &#x2014; <b>bold</b> &#39;text&#39;.</p><p>Unclosed paragraph
      <ol><li>One</li><li>Two<ul><li>Nested</li></ul></li></ol></body></html>`);
    expect(title).toBe("T & C");
    expect(text.split("\n")).toEqual([
      "T & C",
      "## Why it matters",
      "First “point” — bold 'text'.",
      "Unclosed paragraph",
      "- One",
      "- Two",
      "- Nested",
    ]);
    expect(text).not.toMatch(/SCRIPT|TEMPLATE|COMMENT|Menu|\.x\{\}/);
  });

  it("caps the text at 20,000 characters", () => {
    const { text, truncated } = extractText(`<p>${"word ".repeat(10_000)}</p>`);
    expect(text).toHaveLength(MAX_SOURCE_TEXT_CHARS);
    expect(truncated).toBe(true);
  });
});

describe("no new dependency", () => {
  it("uses only Node built-ins and local modules", () => {
    for (const file of ["source-address.ts", "source-text.ts", "source-retrieval.ts"]) {
      const source = readFileSync(path.join(__dirname, "..", "src", "lib", file), "utf8");
      const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
      expect(specifiers.filter((s) => !s.startsWith("node:") && !s.startsWith("./"))).toEqual([]);
    }
  });
});
