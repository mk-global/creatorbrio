import { NextResponse } from "next/server";
import { getTemplate } from "@/lib/templates";
import { createCarousel, addSlide } from "@/lib/carousels";
import { brandIdOf, getDefaultBrandId } from "@/lib/brand";
import { dataErrorResponse } from "@/lib/api-errors";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const template = await getTemplate(id);
    if (!template) {
      return NextResponse.json({ error: "Template not found" }, { status: 404 });
    }

    // An optional name (#175). Without a body, or without a name, the
    // project is named after the template as it always was.
    const body = await request.json().catch(() => ({}));
    const given = body && typeof body === "object" ? (body as { name?: unknown }).name : undefined;
    if (given !== undefined && (typeof given !== "string" || given.length > 200)) {
      return NextResponse.json({ error: "The name must be text of at most 200 characters." }, { status: 400 });
    }
    const name = typeof given === "string" && given.trim() ? given.trim() : `${template.name} (from template)`;

    // The new carousel belongs to the template's brand: the template's slides
    // are that brand's design. It takes the template's format too.
    const carousel = await createCarousel(
      name,
      template.aspectRatio,
      brandIdOf(template, await getDefaultBrandId()),
      template.format
    );

    // Copy all slides
    for (const slide of template.slides) {
      await addSlide(carousel.id, slide.html, slide.notes);
    }

    return NextResponse.json(carousel, { status: 201 });
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    throw err;
  }
}
