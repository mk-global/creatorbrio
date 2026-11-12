import { NextResponse } from "next/server";
import { getCarousel, updateCarousel, deleteCarousel } from "@/lib/carousels";
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
    return NextResponse.json(carousel);
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
    return NextResponse.json(updated);
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
  const deleted = await deleteCarousel(id);
  if (!deleted) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ success: true });
}
