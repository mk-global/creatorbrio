import { NextResponse } from "next/server";
import { addReferenceImage, removeReferenceImage, getCarousel } from "@/lib/carousels";
import { confineUploadedPng, REFERENCE_REJECTION_MESSAGES } from "@/lib/reference-images";
import { generateId, now } from "@/lib/utils";
import { dataErrorResponse } from "@/lib/api-errors";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const carousel = await getCarousel(id);
  if (!carousel) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ references: carousel.referenceImages || [] });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const { url, name } = body as { url?: string; name?: string };

    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }

    // The path is derived by the server from the URL, and only for a regular
    // PNG upload inside public/uploads; nothing else is stored or advertised.
    const confined = await confineUploadedPng(url);
    if (!confined.ok) {
      return NextResponse.json(
        { error: REFERENCE_REJECTION_MESSAGES[confined.reason], reason: confined.reason },
        { status: 400 }
      );
    }

    const ref = {
      id: generateId(),
      url: confined.url,
      absPath: confined.absPath,
      name: name || "Reference image",
      addedAt: now(),
    };

    const result = await addReferenceImage(id, ref);
    if (!result) {
      return NextResponse.json({ error: "Carousel not found" }, { status: 404 });
    }

    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { searchParams } = new URL(request.url);
    const imageId = searchParams.get("imageId");
    if (!imageId) {
      return NextResponse.json({ error: "imageId is required" }, { status: 400 });
    }

    const deleted = await removeReferenceImage(id, imageId);
    if (!deleted) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
