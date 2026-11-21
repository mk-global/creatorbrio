import { forgetAgentSessions } from "@/lib/agent-sessions";
import { removeCarouselWorkDir } from "@/lib/agent-workspace";
import { designAgentProfileName } from "@/lib/design-agent-profile";
import { isGenerating } from "@/lib/generation-status";
import { NextResponse } from "next/server";
import { getCarousel, updateCarousel, deleteCarousel, carouselResponse } from "@/lib/carousels";
import { dataErrorResponse } from "@/lib/api-errors";
import { pickCarouselUpdate } from "@/lib/api-input";
import { formatAllowsSize, formatOf, sizeRefusal } from "@/lib/formats";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const carousel = await getCarousel(id);
    if (!carousel) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(carouselResponse(carousel));
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    throw err;
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json();
    // Only the fields this endpoint defines as mutable. Everything else,
    // including id, slides, referenceImages, isTemplate and the timestamps, is
    // server-owned and is never taken from the request.
    const update = pickCarouselUpdate(body);
    // A size the project's format does not allow is refused on the server,
    // so a Reel cover stays 9:16 whatever a client sends (#175). Projects
    // without a format are carousels, which allow every size as before.
    if (update.aspectRatio) {
      const existing = await getCarousel(id);
      if (!existing) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const format = formatOf(existing);
      if (!formatAllowsSize(format, update.aspectRatio)) {
        return NextResponse.json({ error: sizeRefusal(format) }, { status: 400 });
      }
    }
    const updated = await updateCarousel(id, update);
    if (!updated) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json(carouselResponse(updated));
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // A contained run's processes can still write its folder, so the folder is
  // never removed while the run is live (#227). The legacy profile has no folder.
  const profile = designAgentProfileName();
  if (profile.ok && profile.name === "contained" && isGenerating(id)) {
    return NextResponse.json({ error: "A design run is still working on this project. Stop it, then delete the project." }, { status: 409 });
  }
  const deleted = await deleteCarousel(id);
  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // The contained Design Agent's folder goes with its carousel (#227).
  await removeCarouselWorkDir(id).catch((err) => {
    console.error("[carousels] could not remove the design agent's folder", { carouselId: id, message: (err as Error)?.message });
  });
  // So are the sessions its contained runs may resume (#237).
  await forgetAgentSessions(id).catch((err) => {
    console.error("[carousels] could not forget the design agent's sessions", { carouselId: id, message: (err as Error)?.message });
  });
  return NextResponse.json({ success: true });
}
