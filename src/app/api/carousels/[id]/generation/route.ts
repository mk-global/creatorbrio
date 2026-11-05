import { NextResponse } from "next/server";
import {
  acceptInterruptedSlides,
  getInterruption,
  isGenerating,
} from "@/lib/generation-status";
import { dataErrorResponse } from "@/lib/api-errors";
import { continuationOffer, discardContinuation } from "@/lib/assets";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

type Params = { params: Promise<{ id: string }> };

/**
 * `{ generating, interrupted, continuation }`: whether a design-agent run is
 * still writing this carousel's slides; if not, whether the last one was
 * stopped, failed or timed out after changing them; and whether its
 * unfinished design can be continued (`{ runId, saved, expected }`). The
 * editor polls it so every open tab knows when export is safe.
 */
export async function GET(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const generating = isGenerating(id);
    const interrupted = await getInterruption(id);
    const continuation = generating || isGenerating(id) ? null : await continuationOffer(id);
    return NextResponse.json({ generating, interrupted, continuation }, { headers: NO_STORE });
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    throw err;
  }
}

/**
 * The user confirms an interrupted carousel's slides as they are, which makes
 * it exportable again. Refused while a run is still live.
 */
export async function DELETE(_request: Request, { params }: Params) {
  const { id } = await params;
  try {
    if (!(await acceptInterruptedSlides(id))) {
      return NextResponse.json(
        { error: "Slides are still being generated." },
        { status: 409, headers: NO_STORE }
      );
    }
    // The slides are accepted as finished, so there is nothing left to continue.
    await discardContinuation(id);
    return NextResponse.json(
      { generating: false, interrupted: null, continuation: null },
      { headers: NO_STORE }
    );
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    throw err;
  }
}
