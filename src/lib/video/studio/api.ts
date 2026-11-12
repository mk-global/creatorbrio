/**
 * The Studio page's client for the Video Studio API (#150). Every request is
 * same-origin with the paired session's cookie and the Studio header, as the
 * cookie rules in `docs/architecture/video-production-api.md` require; the
 * page never sees the human key or the session token.
 *
 * Every refusal becomes a `StudioApiError` carrying the server's stable code
 * and details (issues, revisions, generations), so callers branch on codes,
 * never on messages. A request that never reached the server is
 * `network_error`.
 */
import type { Production } from "@/types/production";
import type {
  AppliedView,
  DerivedFileName,
  MediaView,
  PreviewView,
  ProductionOp,
  ProductionSummary,
  ProductionView,
  RenderView,
  PairingStatusView,
  SessionView,
} from "./types";

export const STUDIO_HEADER = { name: "x-creatorbrio-request", value: "studio" } as const;

export class StudioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Every other field of the error body, e.g. `issues`, `actualRevision`, `generation`. */
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "StudioApiError";
  }
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

const enc = encodeURIComponent;

export class StudioApi {
  constructor(private readonly fetchImpl: Fetch = (input, init) => fetch(input, init)) {}

  /** Sends one request with the Studio header and the session cookie; a refusal becomes a `StudioApiError`. */
  private async send(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { [STUDIO_HEADER.name]: STUDIO_HEADER.value };
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(path, { method, headers, credentials: "same-origin", cache: "no-store", body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new StudioApiError(0, "network_error", "The app did not answer. Check that CreatorBrio is still running.");
    }
    if (!res.ok) throw await refusalOf(res);
    return res;
  }

  private async call<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    return parseJson(await (await this.send(method, path, body)).text()) as T;
  }

  // -- session ----------------------------------------------------------------

  session(): Promise<SessionView> {
    return this.call("GET", "/api/video/session");
  }

  /** Whether this browser is paired, without a 401 when it is not (#175). */
  pairingStatus(): Promise<PairingStatusView> {
    return this.call("GET", "/api/video/session?status=1");
  }

  pair(code: string): Promise<{ status: "paired"; expiresAt: string }> {
    return this.call("POST", "/api/video/session", { code });
  }

  signOut(): Promise<unknown> {
    return this.call("DELETE", "/api/video/session");
  }

  // -- productions --------------------------------------------------------------

  async listProductions(): Promise<ProductionSummary[]> {
    return (await this.call<{ productions: ProductionSummary[] }>("GET", "/api/video/productions")).productions;
  }

  createProduction(production: Production): Promise<{ status: "created"; productionId: string; revision: number; generation: number }> {
    return this.call("POST", "/api/video/productions", { production });
  }

  production(id: string): Promise<ProductionView> {
    return this.call("GET", `/api/video/productions/${enc(id)}`);
  }

  preview(id: string): Promise<PreviewView> {
    return this.call("GET", `/api/video/productions/${enc(id)}/preview`);
  }

  change(id: string, change: { baseRevision: number; summary: string; ops: ProductionOp[] }): Promise<AppliedView> {
    return this.call("POST", `/api/video/productions/${enc(id)}/changes`, change);
  }

  undo(id: string, expectedGeneration: number): Promise<AppliedView> {
    return this.call("POST", `/api/video/productions/${enc(id)}/undo`, { expectedGeneration });
  }

  redo(id: string, expectedGeneration: number): Promise<AppliedView> {
    return this.call("POST", `/api/video/productions/${enc(id)}/redo`, { expectedGeneration });
  }

  // -- media ----------------------------------------------------------------------

  async listMedia(): Promise<MediaView[]> {
    return (await this.call<{ media: MediaView[] }>("GET", "/api/video/media")).media;
  }

  importMedia(path: string): Promise<{ status: "created" | "existing"; media: MediaView }> {
    return this.call("POST", "/api/video/media", { path });
  }

  retryMedia(mediaId: string): Promise<unknown> {
    return this.call("POST", `/api/video/media/${enc(mediaId)}/proxy`, {});
  }

  // -- renders -------------------------------------------------------------------

  async listRenders(productionId: string): Promise<RenderView[]> {
    return (await this.call<{ renders: RenderView[] }>("GET", `/api/video/productions/${enc(productionId)}/renders`)).renders;
  }

  requestRender(productionId: string): Promise<{ status: "queued" | "existing"; render: RenderView }> {
    return this.call("POST", `/api/video/productions/${enc(productionId)}/renders`, {});
  }

  render(productionId: string, renderId: string): Promise<RenderView> {
    return this.call("GET", `/api/video/productions/${enc(productionId)}/renders/${enc(renderId)}`);
  }

  cancelRender(productionId: string, renderId: string): Promise<{ status: "cancelled" | "cancelling"; render: RenderView }> {
    return this.call("POST", `/api/video/productions/${enc(productionId)}/renders/${enc(renderId)}/cancel`, {});
  }

  retryRender(productionId: string, renderId: string): Promise<{ status: "queued"; render: RenderView }> {
    return this.call("POST", `/api/video/productions/${enc(productionId)}/renders/${enc(renderId)}/retry`, {});
  }

  /**
   * One file of a succeeded render, for the page to save. A plain link cannot
   * carry the Studio header, so downloads go through here; the whole file is
   * read into memory, which a reel of at most 90 seconds allows.
   */
  async renderFile(productionId: string, renderId: string, name: RenderView["files"][number]): Promise<Blob> {
    try {
      return await (await this.send("GET", renderFileUrl(productionId, renderId, name))).blob();
    } catch (error) {
      if (error instanceof StudioApiError) throw error;
      throw new StudioApiError(0, "network_error", "The download was interrupted. Check that CreatorBrio is still running.");
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The `StudioApiError` for a response that is not 2xx: the server's stable code and details, or a generic one. */
async function refusalOf(res: Response): Promise<StudioApiError> {
  const json = parseJson(await res.text().catch(() => ""));
  const error = (json as { error?: Record<string, unknown> } | null)?.error;
  if (error && typeof error.code === "string") {
    const { code, message, ...details } = error;
    // How long to wait, from the header the server sends with 429 and 503.
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) details.retryAfterSeconds = retryAfter;
    return new StudioApiError(res.status, code, typeof message === "string" ? message : code, details);
  }
  return new StudioApiError(res.status, "unexpected_response", `The app answered ${res.status} without an explanation.`);
}

/** Where a media element reads a derived file; the media-element rule lets it omit the Studio header. */
export function mediaFileUrl(mediaId: string, name: DerivedFileName): string {
  return `/api/video/media/${enc(mediaId)}/files/${enc(name)}`;
}

/** Where a render's file is downloaded (or, for `video.mp4`, played). */
export function renderFileUrl(productionId: string, renderId: string, name: RenderView["files"][number]): string {
  return `/api/video/productions/${enc(productionId)}/renders/${enc(renderId)}/files/${enc(name)}`;
}
