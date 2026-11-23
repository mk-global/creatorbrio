/**
 * A local stand-in for Google Fonts (#249), so font tests touch no network.
 * `fetchThrough()` is a test-only `fetch` that rewrites Google's two hosts to
 * it, as the export's font tests do. It serves one family, `Probe Sans`, with
 * an upright and an italic face made from the bundled Inter files; any other
 * family is answered 400, as Google answers a family it does not have.
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

export const PROBE_FAMILY = "Probe Sans";

const FACES: Record<string, { style: string; file: string }> = {
  "/s/probe/normal.woff2": { style: "normal", file: "inter-latin-400-normal.woff2" },
  "/s/probe/italic.woff2": { style: "italic", file: "inter-latin-400-italic.woff2" },
};

export interface FakeFontSource {
  origin: string;
  /** Every path and query asked of it, in order. */
  requests: string[];
  close(): Promise<void>;
}

export async function startFakeFontSource(): Promise<FakeFontSource> {
  const files = path.resolve(__dirname, "..", "..", "node_modules", "@fontsource", "inter", "files");
  const requests: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, "http://local");
    requests.push(url.pathname + url.search);
    if (url.pathname === "/css2") {
      const [family, axis = ""] = (url.searchParams.get("family") ?? "").split(":");
      if (family !== PROBE_FAMILY) {
        res.writeHead(400);
        return void res.end();
      }
      const style = axis.startsWith("ital") ? "italic" : "normal";
      res.writeHead(200, { "content-type": "text/css" });
      return void res.end(
        `@font-face { font-family: '${PROBE_FAMILY}'; font-style: ${style}; font-weight: 300 800; font-display: swap; src: url(https://fonts.gstatic.com/s/probe/${style}.woff2) format('woff2'); }`
      );
    }
    const face = FACES[url.pathname];
    if (face) {
      res.writeHead(200, { "content-type": "font/woff2" });
      return void res.end(readFileSync(path.join(files, face.file)));
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A `fetch` that sends Google Fonts requests to `origin` instead. */
export function fetchThrough(origin: string, realFetch: typeof fetch = globalThis.fetch): typeof fetch {
  return ((input: string | URL, init?: RequestInit) =>
    realFetch(
      String(input).replace("https://fonts.googleapis.com", origin).replace("https://fonts.gstatic.com", origin),
      init
    )) as typeof fetch;
}
