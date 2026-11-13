import { NextResponse } from "next/server";
import { duplicateCarousel, carouselResponse } from "@/lib/carousels";
import { dataErrorResponse } from "@/lib/api-errors";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const duplicate = await duplicateCarousel(id);
    if (!duplicate) {
      return NextResponse.json({ error: "Carousel not found" }, { status: 404 });
    }
    return NextResponse.json(carouselResponse(duplicate), { status: 201 });
  } catch (err) {
    const dataError = dataErrorResponse(err);
    if (dataError) return dataError;
    return NextResponse.json({ error: "Failed to duplicate" }, { status: 500 });
  }
}
