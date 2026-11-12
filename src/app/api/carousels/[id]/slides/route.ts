import { NextResponse } from "next/server";
import { addSlide, reorderSlides, getCarousel } from "@/lib/carousels";
import { dataErrorResponse } from "@/lib/api-errors";
import { slideLimitOf, slideLimitRefusal } from "@/lib/formats";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const { html, notes } = body as { html?: string; notes?: string };

    if (!html || typeof html !== "string") {
      return NextResponse.json(
        { error: "HTML content is required" },
        { status: 400 }
      );
    }

    const slide = await addSlide(id, html, notes);
    if (!slide) {
      // Same status as always; the message now says which limit applies, so
      // the design agent and a person both learn that a Reel cover has one
      // slide (#175). The limit itself is enforced inside addSlide, under the
      // file's lock.
      const carousel = await getCarousel(id);
      const atLimit = carousel && carousel.slides.length >= slideLimitOf(carousel);
      return NextResponse.json(
        { error: atLimit ? slideLimitRefusal(carousel) : "Carousel not found or max slides reached" },
        { status: 400 }
      );
    }
    return NextResponse.json(slide, { status: 201 });
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const { slideIds } = body as { slideIds?: string[] };

    if (!Array.isArray(slideIds)) {
      return NextResponse.json(
        { error: "slideIds array is required" },
        { status: 400 }
      );
    }

    const success = await reorderSlides(id, slideIds);
    if (!success) {
      return NextResponse.json(
        { error: "Carousel not found or invalid slide IDs" },
        { status: 400 }
      );
    }

    const carousel = await getCarousel(id);
    return NextResponse.json({ slides: carousel?.slides ?? [] });
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
