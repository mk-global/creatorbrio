import { NextResponse } from "next/server";
import { listCarousels, createCarousel, carouselResponse } from "@/lib/carousels";
import type { AspectRatio } from "@/types/carousel";
import { dataErrorResponse } from "@/lib/api-errors";
import { isAspectRatio } from "@/lib/api-input";
import { getBrandById, getDefaultBrandId } from "@/lib/brand";
import { FORMATS, formatAllowsSize, isProjectFormat, sizeRefusal } from "@/lib/formats";
import { byRecentEdit, summarizeProject } from "@/lib/project-summary";

export async function GET(request: Request) {
  try {
    // `?brandId=` lists one brand's carousels; without it, all of them.
    const params = new URL(request.url).searchParams;
    const brandId = params.get("brandId") ?? undefined;
    const view = params.get("view");
    if (view !== null && view !== "summary") {
      return NextResponse.json({ error: 'Unknown view; the only view is "summary".' }, { status: 400 });
    }
    const carousels = await listCarousels(brandId);
    // `?view=summary` is what the library shows (#175): each project's
    // format, size, slide count and first slide only, most recently edited
    // first. Without it the response is exactly what it always was.
    if (view === "summary") {
      const defaultBrandId = await getDefaultBrandId();
      const projects = carousels.map((c) => summarizeProject(c, defaultBrandId)).sort(byRecentEdit);
      return NextResponse.json({ projects });
    }
    return NextResponse.json({ carousels: carousels.map(carouselResponse) });
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    throw err;
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, aspectRatio, brandId, format } = body as {
      name?: string;
      aspectRatio?: AspectRatio;
      brandId?: unknown;
      format?: unknown;
    };

    if (!name || typeof name !== "string" || !name.trim()) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    // An optional format (#175). Unknown values are refused rather than
    // silently made into a carousel, since the format sets the project's
    // limits and default export for its whole life.
    if (format !== undefined && !isProjectFormat(format)) {
      return NextResponse.json(
        { error: "Unknown format. Use instagram-carousel, linkedin-document or reel-cover." },
        { status: 400 }
      );
    }

    // Same validator the update route uses, so the two cannot drift apart.
    // Without a format, any supported size is accepted as before; with one,
    // the size must be one the format allows, and defaults to its usual size.
    const ratio: AspectRatio = isAspectRatio(aspectRatio)
      ? aspectRatio
      : format !== undefined
        ? FORMATS[format].defaultSize
        : "4:5";
    if (format !== undefined && !formatAllowsSize(format, ratio)) {
      return NextResponse.json({ error: sizeRefusal(format) }, { status: 400 });
    }

    // A named brand must exist: falling back to another brand would generate
    // this carousel with the wrong identity for its whole life.
    if (
      brandId !== undefined &&
      (typeof brandId !== "string" || !(await getBrandById(brandId)))
    ) {
      return NextResponse.json({ error: "Unknown brand" }, { status: 400 });
    }

    const carousel = await createCarousel(name.trim(), ratio, brandId, format);
    return NextResponse.json(carouselResponse(carousel), { status: 201 });
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
