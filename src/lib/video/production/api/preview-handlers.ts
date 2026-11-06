/**
 * `GET /api/video/productions/[id]/preview` (#150): what the Studio page needs
 * to show the current revision as the export will draw it. The revision is
 * compiled with the same compiler, catalog and profile a render request uses,
 * and its overlay is built for the preview target (fonts inside, meta CSP),
 * so the page lays out picture with the plan's `layerBox()` and shows the
 * overlay with `previewOverlayAt()` instead of an approximation of its own.
 *
 * A revision that cannot be exported is not an error here: the answer carries
 * the compiler's issues in place of the plan, so the page can keep showing
 * the timeline and point at the clip to fix. Only a person may read it; the
 * answer contains no paths.
 */
import { DEFAULT_CATALOG } from "../../capabilities/catalog";
import { compile } from "../../render/compile";
import { bundledFonts } from "../../render/fonts";
import { RenderFailure } from "../../render/execute-types";
import { buildOverlay } from "../../render/overlay";
import { INSTAGRAM_PROFILE } from "../../render/profile";
import { authorize, run } from "./handlers";
import { errorResponse, failureResponse, okResponse } from "./http";

export function getPreview(request: Request, productionId: string): Promise<Response> {
  return run(async () => {
    const { ctx } = await authorize(request, productionId, { human: true });
    const loaded = await ctx.store.load(productionId);
    if (loaded.status !== "ok") return failureResponse(loaded);
    const production = loaded.state.history.current;
    const head = { productionId, revision: production.revision, generation: loaded.state.generation };

    const media = new Map((await ctx.media.list()).map((record) => [record.mediaId, record]));
    const compiled = compile(production, media, { profile: INSTAGRAM_PROFILE, catalog: DEFAULT_CATALOG });
    if (!compiled.ok) return okResponse({ ...head, preview: { ok: false, issues: compiled.issues } });

    let overlay;
    try {
      overlay = buildOverlay(compiled.plan, { catalog: DEFAULT_CATALOG, fonts: await bundledFonts(), target: "preview" });
    } catch (error) {
      // A missing or different font bundle is the operator's to fix; say which, as a render would.
      if (!(error instanceof RenderFailure)) throw error;
      console.error("[video preview] overlay_failed", { productionId, code: error.code });
      return errorResponse(error.failureClass === "configuration" ? 503 : 500, { code: error.code, message: error.message });
    }
    return okResponse({ ...head, preview: { ok: true, plan: compiled.plan, overlay: { html: overlay.html, activeRanges: overlay.activeRanges } } });
  });
}
