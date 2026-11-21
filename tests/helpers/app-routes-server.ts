/**
 * A loopback HTTP server that serves the app's real carousel route handlers,
 * standing in for the running app that the agent-only listener forwards to.
 * It records every request it receives: what the listener forwarded.
 */
import http from "node:http";
import { GET as getCarouselRoute, DELETE as deleteCarouselRoute } from "@/app/api/carousels/[id]/route";
import { POST as addSlideRoute, PUT as reorderRoute } from "@/app/api/carousels/[id]/slides/route";
import { PUT as updateSlideRoute, DELETE as deleteSlideRoute } from "@/app/api/carousels/[id]/slides/[slideId]/route";
import { PUT as captionRoute } from "@/app/api/carousels/[id]/caption/route";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const ROUTES: { method: string; pattern: RegExp; handler: Handler }[] = [
  { method: "GET", pattern: /^\/api\/carousels\/([^/]+)$/, handler: getCarouselRoute as unknown as Handler },
  { method: "DELETE", pattern: /^\/api\/carousels\/([^/]+)$/, handler: deleteCarouselRoute as unknown as Handler },
  { method: "POST", pattern: /^\/api\/carousels\/([^/]+)\/slides$/, handler: addSlideRoute as unknown as Handler },
  { method: "PUT", pattern: /^\/api\/carousels\/([^/]+)\/slides$/, handler: reorderRoute as unknown as Handler },
  { method: "PUT", pattern: /^\/api\/carousels\/([^/]+)\/slides\/([^/]+)$/, handler: updateSlideRoute as unknown as Handler },
  { method: "DELETE", pattern: /^\/api\/carousels\/([^/]+)\/slides\/([^/]+)$/, handler: deleteSlideRoute as unknown as Handler },
  { method: "PUT", pattern: /^\/api\/carousels\/([^/]+)\/caption$/, handler: captionRoute as unknown as Handler },
];

export interface ReceivedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

export interface AppRoutesServer {
  origin: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

export async function startAppRoutesServer(): Promise<AppRoutesServer> {
  const received: ReceivedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    received.push({ method: req.method ?? "", path: url.pathname, headers: req.headers });
    const route = ROUTES.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    const [, id, slideId] = route.pattern.exec(url.pathname)!;
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await route.handler(
      new Request(`http://127.0.0.1${url.pathname}`, { method: req.method, headers: req.headers as Record<string, string>, body }),
      { params: Promise.resolve<Record<string, string>>(slideId ? { id, slideId } : { id }) }
    );
    res.writeHead(response.status, { "content-type": "application/json" }).end(await response.text());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
